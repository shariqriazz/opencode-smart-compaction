import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildCheckpoint, completeSummary, isCompleteSummary, RETAINED_IDENTIFIERS_HEADING, semanticSummary } from "../src/checkpoint.ts";
import { getGitEngineeringState } from "../src/git-state.ts";
import { parseCheckpoint, readSessionFacts, summarizesRecent } from "../src/session.ts";
import { extractProtectedFacts, formatFileOperationsXml } from "../src/prompt.ts";
import { adaptKeptMessages, boundRecent, keptMessages, RECENT_OMITTED_NOTE, trimRecentContext } from "../src/recent.ts";
import { carriedSubagents, carriedSubagentsVerified, formatSubagent, runningSubagents } from "../src/subagents.ts";
import plugin from "../src/index.ts";
import { createThresholdWatcher } from "../src/threshold.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const noGit = { available: false, files: [], patch: "", lockfilesAndGeneratedAssets: [] };
const open = (name: string) => `<${name}>`;
const close = (name: string) => `</${name}>`;
const TOUCHED = "touched-files";

type Messages = Parameters<typeof readSessionFacts>[0];
type Message = Messages[number];
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const call = (id: string, name: string, input: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "tool-call", id, name, input }],
});
const result = (id: string, name: string, value: string, type = "text") => ({
  role: "tool",
  content: [{ type: "tool-result", id, name, result: { type, value } }],
});
const checkpointMessage = (summary: string, recent?: string) =>
  user(
    [
      open("conversation-checkpoint"),
      "The following is a summary and serialized record of earlier conversation.",
      "",
      `${open("summary")}\n${summary}\n${close("summary")}`,
      ...(recent ? ["", `${open("recent-context")}\n${recent}\n${close("recent-context")}`] : []),
      close("conversation-checkpoint"),
    ].join("\n"),
  );

test("session facts keep user words, the previous checkpoint, files touched by tools, and a bounded transcript", () => {
  const previous = `latest checkpoint\n\n${open("read-files")}\n/repo/old-read.ts\n${close("read-files")}\n\n${open(TOUCHED)}\n/repo/old &amp; edited.ts\n${close(TOUCHED)}`;
  const recent = [
    "[User]: Keep 10.0.0.9 reachable",
    '[Assistant tool call]: edit({"path":"/repo/recent.ts","oldString":"a","newString":"b"})',
    "[Tool result]: ok",
    '[Assistant tool call]: write({"path":"/repo/denied.ts","content":"x"})',
    "[Tool error]: denied",
    "[Assistant]: Checked 10.0.0.10",
  ].join("\n");
  const failure = `${"setup\n".repeat(1_000)}FATAL: the real error`;
  const facts = readSessionFacts([
    checkpointMessage(previous, recent),
    user(`Deploy ${SHA} to https://example.com/api`),
    call("1", "read", { path: "/repo/src/a.ts" }),
    result("1", "read", "x".repeat(5_000)),
    call("2", "read", { path: "/repo/src/b.ts" }),
    call("3", "edit", { path: "/repo/src/b.ts", newString: "y".repeat(5_000) }),
    call("4", "write", { path: "/repo/src/c.ts" }),
    result("4", "write", "denied", "error"),
    call("5", "patch", { patchText: "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n*** Move to: src/moved.ts\n*** End Patch" }),
    result("6", "shell", `\x1b[31m${failure}\x1b[0m`, "error"),
  ] as unknown as Messages);
  assert.deepEqual(facts.userTexts, ["Keep 10.0.0.9 reachable", `Deploy ${SHA} to https://example.com/api`]);
  assert.ok(facts.previousSummary?.startsWith("latest checkpoint"));
  assert.deepEqual(facts.readFiles, ["/repo/old-read.ts", "/repo/src/a.ts"], "read files accumulate across compactions");
  assert.deepEqual(
    facts.modifiedFiles,
    ["/repo/old & edited.ts", "/repo/recent.ts", "/repo/src/b.ts", "src/new.ts", "src/old.ts", "src/moved.ts"],
    "changed files are listed in the order they were last used",
  );
  assert.ok(facts.transcript.startsWith("[User]: Keep 10.0.0.9 reachable\n"), "the verbatim recent context is summarized first");
  assert.match(facts.transcript, /\[User\]: Deploy/);
  assert.match(facts.transcript, /\[Assistant tool call\]: read\(path="\/repo\/src\/a\.ts"\)/);
  assert.match(facts.transcript, /\[Tool result: read\]: x+\n\n\[\.\.\. \d+ characters omitted/);
  assert.ok(!facts.transcript.includes("y".repeat(1_000)), "large tool arguments are bounded");
  assert.match(facts.transcript, /\[Tool error: write\]: denied/);
  assert.match(facts.transcript, /FATAL: the real error/, "the end of a failed command survives truncation");
  assert.ok(!facts.transcript.includes("\x1b["), "terminal escape sequences are stripped");
  assert.ok(!facts.transcript.includes("latest checkpoint"), "the previous checkpoint is carried separately");
});

test("carried-over file lists keep only the most recently used paths", () => {
  const oldReads = Array.from({ length: 50 }, (_, i) => `/repo/old-${String(i).padStart(2, "0")}.ts`);
  const previous = `latest checkpoint\n\n${open("read-files")}\n${oldReads.join("\n")}\n${close("read-files")}`;
  const facts = readSessionFacts([
    checkpointMessage(previous),
    call("1", "read", { path: "/repo/new.ts" }),
    call("2", "read", { path: "/repo/old-00.ts" }),
  ] as unknown as Messages);
  assert.equal(facts.readFiles.length, 40);
  assert.ok(facts.readFiles.includes("/repo/new.ts"), "a newly read file is kept");
  assert.ok(facts.readFiles.includes("/repo/old-00.ts"), "re-reading a file makes it recent again");
  assert.ok(!facts.readFiles.includes("/repo/old-01.ts"), "the oldest carried-over paths are dropped");

  // A second compaction evicts by recency, not by name: old-00.ts was used last before it, so it outlives new.ts.
  const appendix = buildCheckpoint(facts, noGit).appendix;
  const next = readSessionFacts([
    checkpointMessage(`latest checkpoint${appendix}`),
    ...Array.from({ length: 39 }, (_, i) => call(`n${i}`, "read", { path: `/repo/a-${String(i).padStart(2, "0")}.ts` })),
  ] as unknown as Messages);
  assert.deepEqual(next.readFiles.slice(0, 1), ["/repo/old-00.ts"], "the most recently used carried path survives");
  assert.ok(!next.readFiles.includes("/repo/new.ts"), "an older path is evicted even though it sorts first");

  const touched = readSessionFacts([
    call("r", "read", { path: "/repo/kept-read.ts" }),
    call("e", "edit", { path: "/repo/kept-read.ts" }),
    ...Array.from({ length: 60 }, (_, i) => call(`w${i}`, "write", { path: `/repo/w-${i}.ts` })),
    call("r2", "read", { path: "/repo/kept-read.ts" }),
  ] as unknown as Messages);
  assert.equal(touched.modifiedFiles.length, 60);
  assert.ok(!touched.modifiedFiles.includes("/repo/kept-read.ts"));
  assert.ok(touched.readFiles.includes("/repo/kept-read.ts"), "a file evicted from the changed list still shows as read");
});

test("the prompt carries the conversation, previous checkpoint, and protected facts, without regenerated state", () => {
  const previous = `## 1. Primary Goal & Nuanced Intent\n- keep ${SHA}\n\n${open(TOUCHED)}\nold.ts\n${close(TOUCHED)}`;
  const checkpoint = buildCheckpoint(
    {
      userTexts: ["Use https://example.com/v1 and 10.0.0.5"],
      previousSummary: previous,
      readFiles: [],
      modifiedFiles: ["src/x.ts"],
      transcript: "[User]: Use https://example.com/v1 and 10.0.0.5",
    },
    noGit,
  );
  assert.match(checkpoint.prompt, /high-fidelity context continuity synthesizer/);
  assert.ok(checkpoint.prompt.includes(`${open("conversation")}\n[User]: Use https://example.com/v1`));
  assert.ok(checkpoint.prompt.includes(`${open("previous-summary")}\n## 1. Primary Goal`));
  assert.doesNotMatch(checkpoint.prompt, /old\.ts/, "regenerated state is not fed back");
  assert.ok(checkpoint.prompt.includes(`The ${open("conversation")} tags above contain NEW conversation turns`));
  assert.deepEqual(checkpoint.protectedFacts.sort(), ["10.0.0.5", SHA, "https://example.com/v1"].sort());
  assert.ok(checkpoint.appendix.includes(`${open(TOUCHED)}\nsrc/x.ts\n${close(TOUCHED)}`));
  assert.ok(checkpoint.appendix.includes("<uncommitted-state-unavailable"));

  const first = buildCheckpoint({ userTexts: ["start"], readFiles: [], modifiedFiles: [], transcript: "[User]: start" }, noGit);
  assert.ok(first.prompt.includes(`in the ${open("conversation")} tags above`));
  assert.ok(!first.prompt.includes(open("previous-summary")));
  const unavailable = buildCheckpoint({
    userTexts: [], readFiles: [], modifiedFiles: [], transcript: "[User]: Next",
    previousSummary: `Keep https://goal.example.com\n\n<uncommitted-state-unavailable />\nhttps://state-only.example.com`,
  }, noGit);
  assert.deepEqual(unavailable.protectedFacts, ["https://goal.example.com"], "identifier extraction uses the caller's semantic summary");
});

test("a finished summary gets dropped identifiers back verbatim and the exact file state", () => {
  const appendix = `\n\n${open(TOUCHED)}\na.ts\n${close(TOUCHED)}`;
  const done = completeSummary("## 1. Primary Goal\nwork on kept\n", { protectedFacts: [SHA, "kept"], appendix });
  assert.ok(done.includes(`${RETAINED_IDENTIFIERS_HEADING}\n- ${SHA}\n\n${open(TOUCHED)}`));
  assert.ok(!done.includes("- kept"), "facts already present are not repeated");
  assert.equal(semanticSummary(done).includes(open(TOUCHED)), false);
  assert.equal(completeSummary(`has ${SHA}`, { protectedFacts: [SHA], appendix: "" }), `has ${SHA}`);
});

test("dirty-file and generated-asset appendices are bounded with explicit omission counts", () => {
  const files = Array.from({ length: 75 }, (_, i) => `dist/file-${String(i).padStart(2, "0")}.js`);
  const block = formatFileOperationsXml({ activeDirtyFiles: [...files].reverse(), lockfilesAndGeneratedAssets: files });
  for (const tag of ["uncommitted-dirty-files", "modified-lockfiles-and-assets"]) {
    assert.ok(block.includes(`${open(tag)}\n${files.slice(0, 60).join("\n")}\n… 15 more omitted\n${close(tag)}`));
  }
  assert.ok(!block.includes(files[60]!));
  const exact = formatFileOperationsXml({ activeDirtyFiles: files.slice(0, 60), lockfilesAndGeneratedAssets: files.slice(0, 60) });
  assert.ok(!exact.includes("omitted"), "a list that fits has no omission note");
});

test("protected URLs retain balanced parentheses through extraction and restoration", () => {
  const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
  const nested = "https://example.com/a_(b_(c))";
  assert.deepEqual(extractProtectedFacts([`Read [function](${url}), (${url}). Also ${nested}!`]), [url, nested]);
  assert.deepEqual(extractProtectedFacts(["See https://example.com/path)."]), ["https://example.com/path"]);
  const checkpoint = buildCheckpoint({ userTexts: [`Read ${url}`], readFiles: [], modifiedFiles: [], transcript: "[User]: Read it" }, noGit);
  assert.ok(completeSummary("Summary", checkpoint).includes(`- ${url}\n`));
  const carried = buildCheckpoint({ userTexts: [], previousSummary: `Keep ${url}`, readFiles: [], modifiedFiles: [], transcript: "[User]: Next" }, noGit);
  assert.deepEqual(carried.protectedFacts, [url]);
});

test("protected URLs stop at unmatched markdown closers before emphasis", () => {
  const wikipedia = "https://en.wikipedia.org/wiki/Function_(mathematics)";
  for (const [source, expected] of [
    ["**[docs](https://example.com)**", "https://example.com"],
    ["[x](https://a.b/c)", "https://a.b/c"],
    [wikipedia, wikipedia],
    [`See ${wikipedia}).`, wikipedia],
  ]) {
    assert.deepEqual(extractProtectedFacts([source!]), [expected]);
    const checkpoint = buildCheckpoint({ userTexts: [source!], readFiles: [], modifiedFiles: [], transcript: "[User]: Read the docs" }, noGit);
    assert.ok(completeSummary("Summary", checkpoint).includes(`- ${expected}\n`), "restoration keeps only the exact URL");
  }
});

test("git state covers tracked diffs and bounded untracked previews, never following symlinks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osc-git-"));
  const outside = path.join(os.tmpdir(), `osc-secret-${process.pid}.txt`);
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(root, "tracked.ts"), "export const v = 1;\n");
    git("add", "tracked.ts");
    git("commit", "-qm", "init");
    assert.equal((await getGitEngineeringState(root)).patch, "", "a clean worktree gets no empty diff block");
    fs.writeFileSync(path.join(root, "tracked.ts"), "export const v = 2;\n");
    fs.writeFileSync(path.join(root, "fresh.ts"), "export const fresh = true;\n");
    fs.writeFileSync(outside, "OUTSIDE-SECRET\n");
    fs.symlinkSync(outside, path.join(root, "link.txt"));
    const state = await getGitEngineeringState(root);
    assert.equal(state.available, true);
    assert.ok(state.patch.includes("export const v = 2"));
    assert.ok(state.patch.includes("export const fresh = true"));
    assert.ok(!state.patch.includes("OUTSIDE-SECRET"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
  assert.equal((await getGitEngineeringState(os.tmpdir())).available, false);
});

test("an oversized tracked diff keeps the status inventory and generated-file list", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osc-large-diff-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    fs.writeFileSync(path.join(root, "large.ts"), "before\n");
    fs.writeFileSync(path.join(root, "bun.lock"), "before\n");
    git("add", ".");
    git("-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-qm", "init");
    fs.writeFileSync(path.join(root, "large.ts"), "export const large = true;\n".repeat(100_000));
    fs.writeFileSync(path.join(root, "bun.lock"), "after\n");
    fs.writeFileSync(path.join(root, "fresh.ts"), "export const fresh = true;\n");
    assert.throws(() => execFileSync("git", ["diff", "--", "large.ts"], { cwd: root, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }), /ENOBUFS/, "the fixture actually exceeds the git output limit");
    const state = await getGitEngineeringState(root);
    assert.equal(state.available, true);
    assert.deepEqual(state.files.map((file) => file.path).sort(), ["bun.lock", "fresh.ts", "large.ts"]);
    assert.deepEqual(state.lockfilesAndGeneratedAssets, ["bun.lock"]);
    assert.match(state.patch, /Patch.*(?:unavailable|omitted).*output/i);
    assert.ok(state.patch.includes("export const fresh = true"), "a failed tracked diff does not discard untracked previews");
    assert.ok(state.patch.length <= 16_000, "the failure notice and patch stay bounded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const launch = (sessionID: string, agent: string, description: string, status = "running") => ({
  type: "assistant",
  content: [
    {
      type: "tool",
      name: "subagent",
      state: { status: "completed", input: { agent, description, prompt: "..." }, content: [{ type: "text", text: "..." }], metadata: { sessionID, status } },
    },
  ],
});
const reported = (childID: string, state = "completed") => ({
  type: "synthetic",
  text: `<subagent sessionID="${childID}" state="${state}">done</subagent>`,
  metadata: { source: "subagent", childID, state },
});

test("running subagents are background launches that have not reported back, carried across compactions", () => {
  const previous = `summary\n\n${open("running-subagents")}\nBackground subagents still running.\nses_old (general): Mine the logs\nses_early: Earlier job\n${close("running-subagents")}`;
  const carried = carriedSubagents(previous);
  assert.equal(carriedSubagentsVerified(previous), true);
  assert.equal(carriedSubagentsVerified(undefined), true);
  assert.deepEqual(carried, [
    { sessionID: "ses_old", agent: "general", description: "Mine the logs" },
    { sessionID: "ses_early", agent: undefined, description: "Earlier job" },
  ]);
  const running = runningSubagents(
    [
      launch("ses_a", "worker", "Write docs"),
      launch("ses_fg", "explore", "Map code", "completed"),
      launch("ses_b", "reviewer", "Review"),
      reported("ses_a"),
      reported("ses_early", "error"),
      { type: "user", text: "keep going" },
    ] as never,
    carried,
  );
  assert.deepEqual(
    running.map((subagent) => subagent.sessionID),
    ["ses_old", "ses_b"],
    "finished, failed, and foreground subagents are left out",
  );
  const awkward = { sessionID: "ses_x1", agent: "worker (fast)", description: "Fix <a> & b\nses_phantom (x): no" };
  const block = formatFileOperationsXml({ runningSubagents: [formatSubagent(awkward)] });
  assert.equal(carriedSubagentsVerified(`summary${block}`), true);
  const unverified = formatFileOperationsXml({ runningSubagents: [formatSubagent(awkward)], subagentsVerified: false });
  assert.equal(carriedSubagentsVerified(`summary${unverified}`), false);
  assert.deepEqual(carriedSubagents(`summary${block}`), [
    { sessionID: "ses_x1", agent: "worker fast", description: "Fix <a> & b ses_phantom (x): no" },
  ], "labels survive the appendix round trip as one line each");
  assert.deepEqual(runningSubagents([launch("ses_a", "worker", "Again"), reported("ses_a"), launch("ses_a", "worker", "Follow-up")] as never), [
    { sessionID: "ses_a", agent: "worker", description: "Follow-up" },
  ], "a resumed subagent is running again until its next report");
});

test("completed foreground results remove carried and running subagents", () => {
  const carried = [{ sessionID: "ses_carried", agent: "worker", description: "Earlier work" }];
  assert.deepEqual(runningSubagents([
    launch("ses_carried", "worker", "Finished", "completed"),
    launch("ses_running", "worker", "Start"),
    launch("ses_running", "worker", "Finished", "completed"),
    launch("ses_untouched", "worker", "Keep running"),
    launch("ses_untouched", "worker", "Unverified status", "cancelled"),
  ] as never, carried), [{ sessionID: "ses_untouched", agent: "worker", description: "Keep running" }]);
});

test("rendered checkpoint completion reports reconcile only unverified carried IDs", () => {
  const carried = [{ sessionID: "ses_carried", agent: "worker", description: "Earlier work" }];
  for (const state of ["completed", "error", "cancelled"]) {
    const report = reported("ses_carried", state).text;
    assert.deepEqual(runningSubagents([], carried, [`Checkpoint\n${report}`], false), []);
    assert.deepEqual(runningSubagents([], carried, [`Checkpoint\n${report}`], true), carried);
    for (const field of ["summary", "recent"]) {
      const checkpoint = [{ type: "compaction", status: "completed", summary: "", recent: "", [field]: report }];
      assert.deepEqual(runningSubagents(checkpoint as never, carried, [], false), []);
      assert.deepEqual(runningSubagents(checkpoint as never, carried, [], true), carried);
    }
    const checkpoint21 = [{ type: "compaction", status: "completed", summary: "", metadata: { keepID: "msg_1", recent: report } }];
    assert.deepEqual(runningSubagents(checkpoint21 as never, carried, [], false), [], "OpenCode 2.1 keeps recent text in metadata");
    assert.deepEqual(runningSubagents([{ type: "compaction", status: "completed", summary: "" }] as never, carried, [], false), carried);
    assert.deepEqual(runningSubagents([{ type: "synthetic", text: report }] as never, carried), [], "newer synthetic text still ends a verified carried entry");
    assert.deepEqual(runningSubagents([launch("ses_carried", "worker", "Resumed")] as never, carried, [report], false), [
      { sessionID: "ses_carried", agent: "worker", description: "Resumed" },
    ], "a newer launch can resume a child after its older report");
  }
  assert.deepEqual(runningSubagents([], carried, ['<subagent sessionID="ses_carried" state="running">'], false), carried);
});

type CompactionHook = (event: Record<string, unknown>) => Promise<void>;
type Generate = (input: { prompt: string; model: unknown }) => Promise<{ text: string }>;

const SIX_SECTIONS = [
  "## 1. Primary Goal & Nuanced Intent\nship it",
  "## 2. Progress Ledger",
  "## 3. Code Changes & In-Progress Snippets",
  "## 4. Errors, Root Causes & Fixes",
  "## 5. Key Decisions & Hypotheses",
  "## 6. Resume Anchor & Immediate Next Action\nContinue the release.",
].join("\n");

test("summary validation requires ordered line headings outside fences and a resume body", () => {
  assert.equal(isCompleteSummary(SIX_SECTIONS), true);
  assert.equal(isCompleteSummary(SIX_SECTIONS.replace("\nContinue the release.", "")), false, "a cut-off resume heading is incomplete");
  assert.equal(isCompleteSummary(`${SIX_SECTIONS.replace("\nContinue the release.", "")}\n \t\n`), false);
  for (const fence of ["```", "~~~~"]) {
    assert.equal(isCompleteSummary(`${fence}markdown\n${SIX_SECTIONS}\n${fence}`), false, "headings in fenced code are not sections");
    assert.equal(isCompleteSummary(`${fence}markdown\n## 6. Resume Anchor\n${fence}\n${SIX_SECTIONS}`), true, "an example before real headings is ignored");
  }
  assert.equal(isCompleteSummary(SIX_SECTIONS.replace(/^## /gm, "inline ## ")), false, "headings are line anchored");
  assert.equal(isCompleteSummary(SIX_SECTIONS.replace("## 2. Progress Ledger", "## 4. Errors").replace("## 4. Errors, Root Causes & Fixes", "## 2. Progress Ledger")), false, "sections must be in order");
});

test("summary validation ignores inline triple-backtick lines as fence openers", () => {
  assert.equal(isCompleteSummary(`\`\`\`const x = 1\`\`\`\n${SIX_SECTIONS}`), true);
});

test("summary validation accepts heading levels two through four with up to three spaces", () => {
  for (const hashes of ["##", "###", "####"]) {
    for (const indent of ["", " ", "  ", "   "]) {
      assert.equal(isCompleteSummary(SIX_SECTIONS.replace(/^## /gm, `${indent}${hashes}\t`)), true);
    }
  }
});

test("threshold checks discard token usage when compaction changes during a model lookup", async () => {
  for (const outcome of ["started", "ended", "failed"] as const) {
    let resolve!: (value: { data: unknown[] }) => void;
    const promise = new Promise<{ data: unknown[] }>((done) => { resolve = done; });
    const compacted: string[] = [];
    const warnings: string[] = [];
    const handle = createThresholdWatcher({
      model: { list: () => promise },
      session: { compact: async ({ sessionID }: { sessionID: string }) => { compacted.push(sessionID); } },
    } as never, { mode: "percent", percent: 95, hardLimitTokens: 600_000 }, (warning) => warnings.push(warning));
    const tokens = { input: 99, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    handle({ type: "session.step.started", data: { sessionID: "ses_race", model: { providerID: "p", id: "m" } } } as never);
    handle({ type: "session.step.ended", data: { sessionID: "ses_race", tokens } } as never);
    handle({ type: "session.compaction.started", data: { sessionID: "ses_race" } } as never);
    if (outcome !== "started") handle({ type: `session.compaction.${outcome}`, data: { sessionID: "ses_race" } } as never);
    resolve({ data: [{ providerID: "p", id: "m", limit: { input: 100, context: 100 } }] });
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(compacted, [], `a compaction that ${outcome} invalidates the old step`);
    assert.deepEqual(warnings, []);
    if (outcome === "started") handle({ type: "session.compaction.ended", data: { sessionID: "ses_race" } } as never);
    handle({ type: "session.step.ended", data: { sessionID: "ses_race", tokens } } as never);
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(compacted, outcome === "failed" ? [] : ["ses_race"], "fresh steps still compact unless the last compaction failed");
  }
});

async function loadHooks(generate: Generate, events: unknown[] = [], context: unknown[] | Error | (() => unknown[]) = [], options: Record<string, unknown> = {}) {
  const hooks = new Map<string, CompactionHook>();
  const ctx = {
    location: { directory: os.tmpdir() },
    options: { thresholdMode: "off", ...options },
    event: {
      subscribe: async function* () {
        yield* events;
      },
    },
    session: {
      hook: async (name: string, callback: CompactionHook) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
      get: async () => ({ location: { directory: os.tmpdir() }, model: { providerID: "cliproxy", id: "factory/claude-sonnet-5-5" } }),
      context: async () => {
        if (context instanceof Error) throw context;
        return typeof context === "function" ? context() : context;
      },
    },
    generate: { text: generate },
  };
  const stop = await plugin.setup(ctx as never);
  await new Promise((resolve) => setImmediate(resolve));
  if (typeof stop === "function") await stop();
  return hooks;
}

async function load(generate: Generate, events: unknown[] = [], context: unknown[] = []) {
  const hook = (await loadHooks(generate, events, context)).get("compaction");
  assert.ok(hook, "the plugin registers a compaction hook");
  return hook;
}

const compactionEvent = () => ({
  sessionID: "ses_1",
  model: { providerID: "cliproxy", id: "factory/claude-opus-5-5", variant: "high" },
  messages: [user(`Ship ${SHA}`), call("1", "edit", { path: "src/app.ts" })],
  result: undefined as { summary: string } | undefined,
});

test("the compaction hook writes the checkpoint with the session's model and completes it", async () => {
  let request: { prompt: string; model: unknown } | undefined;
  const shell = (id: string, sessionID: string) => ({
    type: "shell.created",
    data: { info: { id, status: "running", command: `dev ${id}`, cwd: "/repo", file: `/tmp/${id}.log`, pid: 7, metadata: { sessionID } } },
  });
  const hook = await load(
    async (input) => {
      request = input;
      return { text: SIX_SECTIONS };
    },
    [shell("sh_live", "ses_1"), shell("sh_other", "ses_2"), shell("sh_done", "ses_1"), { type: "shell.exited", data: { id: "sh_done", status: "exited" } }],
    [launch("ses_child", "reviewer", "Review the diff")],
  );
  assert.equal(plugin.id, "opencode-smart-compaction");

  const event = compactionEvent();
  await hook(event);
  assert.deepEqual(request?.model, event.model, "the session's variant is inherited");
  assert.match(request?.prompt ?? "", /## 6\. Resume Anchor/);
  assert.ok(request?.prompt.includes(`[User]: Ship ${SHA}`));
  assert.ok(event.result?.summary.startsWith("## 1. Primary Goal & Nuanced Intent\nship it"));
  assert.ok(event.result?.summary.includes(`- ${SHA}`));
  assert.ok(event.result?.summary.includes(`${open(TOUCHED)}\nsrc/app.ts\n${close(TOUCHED)}`));
  assert.match(event.result?.summary ?? "", /dev sh_live \(shell sh_live, pid 7/, "running background shells are listed");
  assert.doesNotMatch(event.result?.summary ?? "", /sh_other|sh_done/);
  assert.ok(event.result?.summary.includes("\nses_child (reviewer): Review the diff\n"), "running subagents are listed");
});

test("an incomplete summary is retried with default settings, then the session model", async () => {
  const models: unknown[] = [];
  const hook = await load(async (input) => {
    models.push(input.model);
    return { text: models.length < 3 ? "## 1. Primary Goal\ncut off" : SIX_SECTIONS };
  });
  const event = compactionEvent();
  await hook(event);
  assert.deepEqual(models, [
    event.model,
    { providerID: "cliproxy", id: "factory/claude-opus-5-5" },
    { providerID: "cliproxy", id: "factory/claude-sonnet-5-5" },
  ]);
  assert.ok(event.result?.summary.startsWith(SIX_SECTIONS));
});

test("a failed, empty, or incomplete generation leaves OpenCode's own compaction in place", async () => {
  let attempts = 0;
  const failing = await load(async () => {
    attempts++;
    throw new Error("offline");
  });
  const failed = compactionEvent();
  await failing(failed);
  assert.equal(failed.result, undefined);
  assert.equal(attempts, 3, "retryable errors try every model");

  attempts = 0;
  const fatal = await load(async () => {
    attempts++;
    throw new Error("401 Unauthorized");
  });
  await fatal(compactionEvent());
  assert.equal(attempts, 1, "authentication errors stop the retries");

  const empty = await load(async () => ({ text: "  " }));
  const blank = compactionEvent();
  await empty(blank);
  assert.equal(blank.result, undefined);

  const partial = await load(async () => ({ text: "## 1. Primary Goal\ncut off" }));
  const cut = compactionEvent();
  await partial(cut);
  assert.equal(cut.result, undefined);
});
const summarized = (summary: string) => `${summary}\n\n${open("recent-context-summarized")}\nnote\n${close("recent-context-summarized")}`;
const withID = <T extends object>(id: string, message: T) => ({ id, ...message });

test("the turns OpenCode keeps verbatim are found by ID and read like the summarized ones", () => {
  const summarizedMessages = [withID("m1", user("start")), withID("m2", call("c1", "read", { path: "/repo/a.ts" }))] as unknown as Messages;
  const stored = [
    { id: "m1", type: "user", text: "start" },
    { id: "m2", type: "assistant", content: [] },
    { id: "m3", type: "user", text: "Now deploy to https://kept.example.com" },
    {
      id: "m4",
      type: "assistant",
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "tool", id: "t1", name: "edit", state: { status: "completed", input: { path: "/repo/kept.ts" }, content: [{ type: "text", text: "ok" }] } },
        { type: "tool", id: "t2", name: "write", state: { status: "error", input: { path: "/repo/denied.ts" }, error: { message: "denied" } } },
        { type: "text", text: "Done." },
      ],
    },
    { id: "m5", type: "synthetic", text: "background job finished", metadata: { source: "subagent" } },
  ];
  const kept = keptMessages(summarizedMessages, stored as never);
  assert.deepEqual(kept?.map((message) => message.id), ["m3", "m4", "m5"]);
  assert.equal(keptMessages([user("no ids")] as unknown as Messages, stored as never), undefined, "no match means no coverage");

  const adapted = adaptKeptMessages(kept!);
  const facts = readSessionFacts([...summarizedMessages, ...adapted.messages]);
  assert.ok(facts.userTexts.includes("Now deploy to https://kept.example.com"), "kept user words are protected");
  assert.ok(!facts.userTexts.includes("background job finished"), "synthetic text is not user-authored");
  assert.deepEqual(facts.modifiedFiles, ["/repo/kept.ts"], "failed calls in kept turns don't count");
  assert.match(facts.transcript, /\[Tool error: write\]: denied/);
  assert.match(facts.transcript, /\[Assistant\]: Done\.\n\n\[Tool result: edit\]: ok\n\n\[Tool error: write\]: denied\n\n\[Assistant\]: \[Synthetic context\] \(source: subagent\): background job finished$/);
  assert.ok(adapted.complete);

  const covered = readSessionFacts([checkpointMessage(summarized("old"), "[User]: Keep 10.0.0.9\n[Assistant tool call]: read({\"path\":\"/repo/r.ts\"})\n[Tool result]: x"), user("next")] as unknown as Messages);
  assert.equal(covered.transcript, "[User]: next", "a recent context the previous summary covered is not summarized again");
  assert.ok(covered.userTexts.includes("Keep 10.0.0.9"));
  assert.deepEqual(covered.readFiles, ["/repo/r.ts"]);
});

test("a long recent context keeps its newest turns, starting at a turn", () => {
  assert.equal(boundRecent("[User]: short", 100), undefined);
  const recent = ["[User]: first", `[Assistant tool call]: read({"path":"/a"})`, `[Tool result]: ${"r".repeat(200)}`, "[Assistant]: newest"].join("\n");
  const cap = RECENT_OMITTED_NOTE.length + 1 + 60;
  const bounded = boundRecent(recent, cap)!;
  assert.equal(bounded, `${RECENT_OMITTED_NOTE}\n[Assistant]: newest`, "a cut never starts on a tool result");
  assert.ok(bounded.length <= cap, "the omission note counts toward the cap");
  const single = boundRecent(`[User]: ${"line\n".repeat(50)}end`, RECENT_OMITTED_NOTE.length + 1 + 30)!;
  assert.ok(single.startsWith(`${RECENT_OMITTED_NOTE}\nline\n`) && single.endsWith("end"), "one huge turn is cut at a line");
  assert.ok(single.length <= RECENT_OMITTED_NOTE.length + 1 + 30);
});

test("recent context obeys exact character budgets for huge turns and tiny caps", () => {
  const singleLine = `[User]: ${"x".repeat(1_000)}end`;
  const multiline = `[Assistant]: ${"line\n".repeat(300)}end`;
  const normalTurns = Array.from({ length: 50 }, (_, i) => `[User]: turn ${i}`).join("\n");
  for (const recent of [singleLine, multiline, normalTurns]) {
    for (const cap of [-1, 0, 1, 20, RECENT_OMITTED_NOTE.length, RECENT_OMITTED_NOTE.length + 1, 200, 400]) {
      const bounded = boundRecent(recent, cap)!;
      assert.ok(bounded.length <= Math.max(0, cap), `budget ${cap} includes the omission note`);
      assert.equal(boundRecent(recent, cap), bounded, "cuts are deterministic");
      assert.equal(boundRecent(bounded, cap), undefined, "a bounded block needs no second trim");
      if (cap <= RECENT_OMITTED_NOTE.length) assert.equal(bounded, RECENT_OMITTED_NOTE.slice(0, Math.max(0, cap)));
      if (cap >= 200 && recent !== normalTurns) assert.ok(bounded.endsWith("end"));
    }
  }
  assert.equal(boundRecent(singleLine, 200), `${RECENT_OMITTED_NOTE}\n${singleLine.slice(-(200 - RECENT_OMITTED_NOTE.length - 1))}`);
  assert.equal(boundRecent("fits exactly", "fits exactly".length), undefined);
});

test("the context hook bounds only recent context the checkpoint summarized, without touching the stored message", async () => {
  const long = Array.from({ length: 50 }, (_, i) => `[User]: turn ${i} ${"x".repeat(100)}`).join("\n");
  const marked = checkpointMessage(summarized("summary"), long);
  const unmarked = checkpointMessage("summary", long);
  const messages = [marked, unmarked, user("latest")] as unknown as Message[];
  assert.equal(trimRecentContext(messages, 300), 1);
  const text = (messages[0] as unknown as typeof marked).content[0]!.text;
  assert.ok(text.includes(`${open("recent-context")}\n${RECENT_OMITTED_NOTE}\n[User]: turn `));
  assert.ok(text.endsWith(`[User]: turn 49 ${"x".repeat(100)}\n${close("recent-context")}\n${close("conversation-checkpoint")}`));
  assert.ok(text.length < 1_800 && text.includes(open("recent-context-summarized")));
  assert.equal(messages[1], unmarked, "an unmarked checkpoint is left whole");
  assert.equal(marked.content[0]!.text.length > 5_000, true, "the original message object is unchanged");
  assert.ok((parseCheckpoint(text)?.recent?.length ?? Infinity) <= 1_200, "the complete recent block fits the token budget");
  const boundedMessage = messages[0];
  assert.equal(trimRecentContext(messages, 300), 0, "repeated trimming is idempotent");
  assert.equal(messages[0], boundedMessage, "an already bounded object is unchanged");
  const repeated = [marked] as unknown as Message[];
  assert.equal(trimRecentContext(repeated, 300), 1);
  assert.equal((repeated[0] as unknown as typeof marked).content[0]!.text, text, "the same stored checkpoint produces the same request");
  assert.equal(trimRecentContext(messages, 0), 0);

  const hooks = await loadHooks(async () => ({ text: SIX_SECTIONS }), [], [], { maxRecentTokens: 75 });
  const event = { messages: [checkpointMessage(summarized("summary"), long)] };
  await hooks.get("context")?.(event);
  assert.ok(event.messages[0]!.content[0]!.text.length < 1_000, "the plugin registers the context hook with its option");
  assert.equal((await loadHooks(async () => ({ text: SIX_SECTIONS }), [], [], { maxRecentTokens: 0 })).has("context"), false);
});

test("the compaction hook summarizes the kept turns and marks the checkpoint", async () => {
  let prompt = "";
  const hook = await load(
    async (input) => {
      prompt = input.prompt;
      return { text: SIX_SECTIONS };
    },
    [],
    [
      { id: "u1", type: "user", text: `Ship ${SHA}` },
      { id: "a1", type: "assistant", content: [] },
      { id: "u2", type: "user", text: "kept instruction" },
    ],
  );
  const event = compactionEvent();
  event.messages = [withID("u1", user(`Ship ${SHA}`)), withID("a1", call("1", "edit", { path: "src/app.ts" }))] as never;
  await hook(event);
  assert.ok(prompt.includes("[User]: kept instruction"), "kept turns are in the conversation to summarize");
  assert.ok(event.result?.summary.includes(`\n${open("recent-context-summarized")}\n`));

  const unmatched = compactionEvent();
  await (await load(async () => ({ text: SIX_SECTIONS }), [], [])).call(undefined, unmatched);
  assert.ok(!unmatched.result?.summary.includes(open("recent-context-summarized")), "no marker without kept-turn coverage");
});

test("checkpoint-only requests find kept turns by an exact completed-compaction summary", async () => {
  const summary = summarized(SIX_SECTIONS);
  const stored = [
    { id: "old", type: "user", text: "older turn" },
    { id: "checkpoint", type: "compaction", status: "completed", summary: `  ${summary}\n`, recent: "" },
    { id: "tail", type: "user", text: "checkpoint-only kept turn" },
    { id: "unknown", type: "model-switched", model: { providerID: "p", id: "m" } },
  ];
  const request = [checkpointMessage(summary, "[User]: earlier recent turn")] as unknown as Messages;
  assert.deepEqual(keptMessages(request, stored as never), stored.slice(2), "the wrapper has no request ID");
  assert.equal(keptMessages([checkpointMessage(`${summary}\nchanged`)] as unknown as Messages, stored as never), undefined);
  assert.equal(keptMessages(request, [{ ...stored[1], status: "running" }] as never), undefined, "only completed compactions match");
  assert.deepEqual(keptMessages([withID("tail", checkpointMessage(summary))] as unknown as Messages, stored as never), stored.slice(3), "ID matching takes priority");

  let prompt = "";
  const hooks = await loadHooks(async (input) => {
    prompt = input.prompt;
    return { text: SIX_SECTIONS };
  }, [], stored.slice(0, 3));
  const matched = compactionEvent();
  matched.messages = request as never;
  await hooks.get("compaction")!(matched);
  assert.ok(prompt.includes("[User]: checkpoint-only kept turn"));
  assert.ok(summarizesRecent(matched.result?.summary));

  const mismatched = compactionEvent();
  mismatched.messages = [checkpointMessage(`${SIX_SECTIONS}\nchanged`, "[User]: earlier recent turn")] as never;
  await hooks.get("compaction")!(mismatched);
  assert.ok(mismatched.result, "an unmatched boundary still allows a summary of the known request");
  assert.ok(!summarizesRecent(mismatched.result.summary));
  assert.ok(!prompt.includes("checkpoint-only kept turn"));
  const untouched = checkpointMessage(mismatched.result.summary, `[User]: ${"x".repeat(2_000)}`);
  const contextEvent = { messages: [untouched] };
  await hooks.get("context")!(contextEvent);
  assert.equal(contextEvent.messages[0], untouched, "a mismatched checkpoint is never trimmed");
});

test("skill, system, synthetic, and shell history reach the prompt without becoming user text", async () => {
  const tail = [
    { id: "skill", type: "skill", skill: "skills/deploy", name: "Deploy", text: "Skill instructions: verify the release" },
    { id: "system", type: "system", text: "Historical system directive" },
    { id: "synthetic", type: "synthetic", text: "Synthetic completion", metadata: { source: "subagent", childID: "ses_child" } },
    {
      id: "shell", type: "shell", shellID: "sh_check", command: "bun run check", status: "exited", exit: 1,
      output: { output: `\x1b[31mstarting\x1b[0m\n${"build output\n".repeat(600)}${Array.from({ length: 400 }, (_, i) => `build step ${i}\n`).join("")}checking\rdone\nFATAL: release failed`, cursor: 1, size: 10_000, truncated: false },
    },
    { id: "shell_running", type: "shell", shellID: "sh_watch", command: "bun run dev", status: "running" },
    {
      id: "assistant", type: "assistant", content: [
        { type: "tool", id: "t_running", name: "read", state: { status: "running", input: { path: "/repo/live.ts" }, metadata: {} } },
        { type: "tool", id: "t_error", name: "shell", state: { status: "error", input: { command: "bun test" }, error: { message: "failed" }, content: [{ type: "text", text: "Detailed test failure" }] } },
      ],
    },
    { id: "idle", type: "idle", outcome: "succeeded" },
    { id: "user", type: "user", text: "Only these are user words", files: [], agents: [], skills: [] },
  ];
  const adapted = adaptKeptMessages(tail as never);
  assert.ok(adapted.complete);
  const transcriptMessages = adapted.messages;
  const facts = readSessionFacts(transcriptMessages);
  assert.deepEqual(facts.userTexts, ["Only these are user words"]);
  assert.match(facts.transcript, /\[Assistant\]: \[Historical skill context: Deploy \(skills\/deploy\)\]: Skill instructions/);
  assert.match(facts.transcript, /\[Assistant\]: \[Historical system context\]: Historical system directive/);
  assert.match(facts.transcript, /\[Assistant\]: \[Synthetic context\] \(source: subagent\): Synthetic completion/);
  assert.match(facts.transcript, /shell\(command="bun run check", status="exited", exit=1\)/);
  assert.match(facts.transcript, /\[Tool result: shell\]: status=exited, exit=1\nstarting/);
  assert.match(facts.transcript, /done\nFATAL: release failed/);
  assert.match(facts.transcript, /previous line repeated \d+ more times/);
  assert.match(facts.transcript, /\[\.\.\. \d+ characters omitted; showing beginning and end of output \.\.\.\]/);
  assert.ok(!facts.transcript.includes("build step 200"), "stored shell output uses the existing result budget");
  assert.doesNotMatch(facts.transcript, /\x1b|checking|build output\nbuild output/);
  assert.match(facts.transcript, /shell\(command="bun run dev", status="running", exit=undefined\)/);
  assert.match(facts.transcript, /\[Tool result: shell\]: status=running, exit=unknown/);
  assert.match(facts.transcript, /\[Tool status: read \(t_running\)\]: running/);
  assert.ok(!transcriptMessages.some((message) => message.content.some((part) => part.type === "tool-result" && part.id === "t_running")), "a running tool has no completed result");
  assert.match(facts.transcript, /\[Tool error: shell\]: failed\nDetailed test failure/);

  let prompt = "";
  const hooks = await loadHooks(async (input) => {
    prompt = input.prompt;
    return { text: SIX_SECTIONS };
  }, [], [{ id: "boundary", type: "user", text: "start" }, ...tail]);
  const event = compactionEvent();
  event.messages = [withID("boundary", user("start"))] as never;
  await hooks.get("compaction")!(event);
  for (const expected of ["Skill instructions: verify the release", "Historical system directive", "Synthetic completion", "FATAL: release failed", "status=running, exit=unknown", "[Tool status: read (t_running)]: running"]) {
    assert.ok(prompt.includes(expected), `${expected} reaches summary generation`);
  }
  assert.ok(summarizesRecent(event.result?.summary));
});

test("unsupported stored content and attachments withhold the kept-tail marker", async () => {
  const unsupported = [
    { type: "compaction", status: "completed", summary: "other checkpoint", recent: "unknown recent content" },
    { type: "compaction", status: "running", summary: "unfinished", recent: "unknown recent content" },
    { type: "agent-switched", agent: "worker" },
    { type: "model-switched", model: { providerID: "p", id: "m" } },
    { type: "location-switched", directory: "/other" },
    { type: "future-message", text: "unrecognized content" },
    { type: "user", text: "inline attachment", files: [{ data: "ZmlsZQ==", mime: "text/plain", source: { type: "inline" } }] },
    { type: "user", text: "URI attachment", files: [{ data: "", mime: "image/png", source: { type: "uri", uri: "file:///repo/picture.png" } }] },
    { type: "user", text: "agent attachment", agents: [{ name: "worker" }] },
    { type: "user", text: "skill attachment", skills: [{ id: "skills/deploy", name: "Deploy", text: "inline skill" }] },
    { type: "assistant", content: [{ type: "text", text: "partial assistant" }, { type: "tool", id: "stream", name: "shell", state: { status: "streaming", input: "{\"command\":" } }] },
    { type: "assistant", content: [{ type: "future-part", text: "unrecognized part" }] },
    { type: "assistant", content: [{ type: "tool", id: "future", name: "shell", state: { status: "future-status", input: {} } }] },
    { type: "assistant", content: [{ type: "tool", id: "file", name: "read", state: { status: "completed", input: {}, content: [{ type: "file", uri: "file:///repo/picture.png", mime: "image/png" }] } }] },
    { type: "assistant", content: [{ type: "tool", id: "file_error", name: "read", state: { status: "error", input: {}, error: { message: "failed" }, content: [{ type: "file", uri: "file:///repo/picture.png", mime: "image/png" }] } }] },
  ];
  for (const [index, message] of unsupported.entries()) {
    assert.equal(adaptKeptMessages([message] as never).complete, false, `unsupported fixture ${index} is not covered`);
    let prompt = "";
    const hooks = await loadHooks(async (input) => {
      prompt = input.prompt;
      return { text: SIX_SECTIONS };
    }, [], [
      { id: "boundary", type: "user", text: "start" },
      { id: "partial", type: "user", text: "partially adapted tail" },
      { id: `unsupported-${index}`, ...message },
    ], { maxRecentTokens: 50 });
    const event = compactionEvent();
    event.messages = [withID("boundary", user("start"))] as never;
    await hooks.get("compaction")!(event);
    assert.ok(prompt.includes("[User]: partially adapted tail"), "known portions still enrich the summary");
    assert.ok(event.result, `unsupported fixture ${index} still generates a summary`);
    assert.ok(!summarizesRecent(event.result.summary), `unsupported fixture ${index} withholds the marker`);
    const original = checkpointMessage(event.result.summary, `[User]: ${"x".repeat(1_000)}`);
    const contextEvent = { messages: [original] };
    await hooks.get("context")!(contextEvent);
    assert.equal(contextEvent.messages[0], original, "unsupported tails are left whole");
  }
  assert.deepEqual(adaptKeptMessages([]), { messages: [], complete: true }, "an empty matched tail has no unsupported content");
});

test("compaction lifecycle records do not prevent safe coverage of the kept conversation", async () => {
  const tail = [
    { id: "failed", type: "compaction", status: "failed", reason: "manual", error: { type: "compaction.failed", message: "No older conversation to summarize" } },
    { id: "kept", type: "user", text: "Keep working on the release" },
    { id: "pending", type: "compaction", status: "running", reason: "manual", summary: "", recent: "" },
  ];
  const adapted = adaptKeptMessages(tail as never);
  assert.ok(adapted.complete);
  const facts = readSessionFacts(adapted.messages);
  assert.deepEqual(facts.userTexts, ["Keep working on the release"]);
  assert.match(facts.transcript, /Historical compaction failure.*No older conversation to summarize/);
  assert.doesNotMatch(facts.transcript, /pending|running/, "the current empty placeholder is not a task to resume");
  assert.equal(adaptKeptMessages([{ ...tail[2], summary: "uncovered summary" }] as never).complete, false);
  assert.equal(adaptKeptMessages([{ ...tail[2], recent: "uncovered recent turns" }] as never).complete, false);
  const { recent: _legacy, ...placeholder21 } = tail[2] as Record<string, unknown>;
  assert.ok(adaptKeptMessages([placeholder21] as never).complete, "OpenCode 2.1 placeholders have no recent field");
  assert.equal(adaptKeptMessages([{ ...placeholder21, metadata: { recent: "uncovered recent turns" } }] as never).complete, false);

  let prompt = "";
  const hooks = await loadHooks(async (input) => {
    prompt = input.prompt;
    return { text: SIX_SECTIONS };
  }, [], [{ id: "boundary", type: "user", text: "start" }, ...tail]);
  const event = compactionEvent();
  event.messages = [withID("boundary", user("start"))] as never;
  await hooks.get("compaction")!(event);
  assert.ok(prompt.includes("No older conversation to summarize"));
  assert.ok(prompt.includes("[User]: Keep working on the release"));
  assert.ok(summarizesRecent(event.result?.summary));
});

test("a context-read failure retains carried subagents and never marks or trims the kept tail", async () => {
  const previous = `${SIX_SECTIONS}\n\n${open("running-subagents")}\nBackground subagents still running.\nses_carried (worker): Preserve this child\n${close("running-subagents")}`;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    let attempts = 0;
    const hooks = await loadHooks(async () => {
      attempts++;
      return { text: SIX_SECTIONS };
    }, [], new Error("context offline"), { maxRecentTokens: 50 });
    const event = compactionEvent();
    event.messages = [checkpointMessage(previous, "[User]: earlier recent turn"), user("Keep working")] as never;
    await hooks.get("compaction")!(event);
    assert.equal(attempts, 1, "the plugin generates rather than handing off to a built-in summary");
    assert.ok(event.result?.summary.includes("\nses_carried (worker): Preserve this child\n"));
    assert.match(event.result?.summary ?? "", /unverified/i, "a failed scan cannot assert a carried child is still running");
    assert.ok(!summarizesRecent(event.result?.summary));
    const original = checkpointMessage(event.result!.summary, `[User]: ${"x".repeat(1_000)}`);
    const contextEvent = { messages: [original] };
    await hooks.get("context")!(contextEvent);
    assert.equal(contextEvent.messages[0], original, "a context-read failure leaves the recent block untrimmed");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /new subagent launches unavailable, previously recorded children unverified, recent context left untrimmed: Error: context offline/);
  } finally {
    console.warn = originalWarn;
  }
});

test("verified checkpoints keep resumed subagents despite older rendered completion reports", async () => {
  const report = reported("ses_resumed");
  let context: unknown[] = [launch("ses_resumed", "worker", "Original work"), report, launch("ses_resumed", "worker", "Follow-up work")];
  const hooks = await loadHooks(async () => ({ text: `${SIX_SECTIONS}\n${report.text}` }), [], () => context);
  const first = compactionEvent();
  await hooks.get("compaction")!(first);
  assert.ok(first.result);
  assert.deepEqual(carriedSubagents(first.result.summary), [{ sessionID: "ses_resumed", agent: "worker", description: "Follow-up work" }]);
  assert.doesNotMatch(first.result.summary, /unverified/);

  context = [{ id: "checkpoint", type: "compaction", status: "completed", summary: first.result.summary, recent: report.text }];
  const second = compactionEvent();
  second.messages = [checkpointMessage(first.result.summary, report.text), user("Continue the follow-up")] as never;
  await hooks.get("compaction")!(second);
  assert.ok(second.result);
  assert.deepEqual(carriedSubagents(second.result.summary), [{ sessionID: "ses_resumed", agent: "worker", description: "Follow-up work" }], "the verified carried list supersedes old reports in the summary and recent context");
});

test("subagent tracking recovers after a failed scan and completion records move into a checkpoint", async () => {
  let context: unknown[] | undefined;
  const hooks = await loadHooks(async () => ({ text: SIX_SECTIONS }), [], () => {
    if (!context) throw new Error("context temporarily offline");
    return context;
  });
  const previous = `${summarized(SIX_SECTIONS)}${formatFileOperationsXml({ runningSubagents: ["ses_carried (worker): Earlier work", "ses_active (reviewer): Still working", "ses_early (worker): Already reported"], subagentsVerified: false })}`;
  const first = compactionEvent();
  first.messages = [checkpointMessage(previous, `[Synthetic context]: ${reported("ses_early").text}`), user("Continue")] as never;
  await hooks.get("compaction")!(first);
  assert.ok(first.result);
  assert.match(first.result.summary, /unverified/);
  assert.deepEqual(carriedSubagents(first.result.summary).map((child) => child.sessionID), ["ses_carried", "ses_active"], "a report in covered recent context is reconciled even while the context read fails");

  const recent = `[Synthetic context]: ${reported("ses_carried").text}`;
  context = [{ id: "checkpoint", type: "compaction", status: "completed", summary: first.result.summary, recent }];
  const recovered = compactionEvent();
  recovered.messages = [checkpointMessage(first.result.summary, recent), user("Continue again")] as never;
  await hooks.get("compaction")!(recovered);
  assert.ok(recovered.result);
  assert.deepEqual(carriedSubagents(recovered.result.summary).map((child) => child.sessionID), ["ses_active"], "the original synthetic completion is no longer in the active context");
  assert.doesNotMatch(recovered.result.summary, /unverified/);
});
