/**
 * Builds the checkpoint prompt and completes the model's summary.
 *
 * The prompt carries the whole request: the directives, the conversation being
 * summarized, the previous checkpoint, and the protected facts. After the model
 * writes the summary, completeSummary restores any protected identifier the
 * model dropped and appends the exact file and worktree state.
 */

import {
  cachedCompactionPrompt,
  extractProtectedFacts,
  formatFileOperationsXml,
  sanitizeTagContent,
  SMART_COMPACTION_INITIAL_PROMPT,
  SMART_COMPACTION_SYSTEM_PROMPT,
  SMART_COMPACTION_UPDATE_PROMPT,
} from "./prompt.ts";
import type { GitEngineeringState } from "./git-state.ts";
import type { SessionFacts } from "./session.ts";

export const RETAINED_IDENTIFIERS_HEADING = "### Retained Identifiers";

const REQUIRED_SECTIONS = [
  /^ {0,3}#{2,4}[ \t]+1\.[ \t]+Primary Goal\b/i,
  /^ {0,3}#{2,4}[ \t]+2\.[ \t]+Progress Ledger\b/i,
  /^ {0,3}#{2,4}[ \t]+3\.[ \t]+Code Changes\b/i,
  /^ {0,3}#{2,4}[ \t]+4\.[ \t]+Errors\b/i,
  /^ {0,3}#{2,4}[ \t]+5\.[ \t]+Key Decisions\b/i,
  /^ {0,3}#{2,4}[ \t]+6\.[ \t]+Resume Anchor\b/i,
];

/** All six ordered headings must be outside code fences, with content after the resume heading. */
export function isCompleteSummary(text: string): boolean {
  let section = 0;
  let resumeContent = false;
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    // CommonMark forbids backticks in a backtick fence's info string.
    if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      if (!fence) fence = marker[1];
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (!fence) {
      const heading = REQUIRED_SECTIONS.findIndex((pattern) => pattern.test(line));
      if (heading !== -1) {
        if (heading !== section) return false;
        section++;
        continue;
      }
    }
    if (section === REQUIRED_SECTIONS.length && line.trim()) resumeContent = true;
  }
  return section === REQUIRED_SECTIONS.length && resumeContent;
}

const CONVERSATION_OPEN = "<conversation>";
const CONVERSATION_CLOSE = "</conversation>";

// Everything from the first appended state block on is regenerated each time,
// so it is not fed back to the model as part of the previous checkpoint.
const APPENDED_STATE = ["read-files", "touched-files", "uncommitted-dirty-files", "modified-lockfiles-and-assets", "active-background-processes", "running-subagents", "uncommitted-diff", "uncommitted-state-unavailable", "recent-context-summarized"];
const APPENDED_START = new RegExp(`\\n\\n<(?:${APPENDED_STATE.join("|")})\\b`, "i");

/** Remove only whole reserved blocks outside fenced examples; inline mentions are ordinary prose. */
export function stripAppendedState(text: string): string {
  const block = new RegExp(`^<(${APPENDED_STATE.join("|")})(?=[\\s/>])[^>\\r\\n]*?(?:/[ \\t]*>|>[\\s\\S]*?</\\1[ \\t]*>)[ \\t]*\\r?$`, "gim");
  const output: string[] = [];
  let plain: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (plain.length) output.push(...plain.join("\n").replace(block, "").replace(/\n(?:[ \t]*\n){2,}/g, "\n\n").split("\n"));
    plain = [];
  };
  for (const line of text.split("\n")) {
    const marker = line.replace(/\r$/, "").match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(line);
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      flush();
      output.push(line);
      fence = marker[1];
    } else plain.push(line);
  }
  flush();
  if (fence) output.push(fence);
  return output.join("\n").trimEnd();
}

export function semanticSummary(summary: string): string {
  return summary.split(APPENDED_START)[0]!.trim();
}

export interface Checkpoint {
  prompt: string;
  cachedPrompt: string;
  protectedFacts: string[];
  appendix: string;
  cachedAppendix: string;
}

/** Session state appended after the summary beside the file and worktree state. */
export interface CheckpointState {
  backgroundProcesses?: string[];
  runningSubagents?: string[];
  subagentsVerified?: boolean;
  /** The summary also covers the turns OpenCode keeps verbatim, so the recent context may be shortened in requests. */
  recentSummarized?: boolean;
  cachedRecentSummarized?: boolean;
}

export function buildCheckpoint(
  facts: SessionFacts,
  git: GitEngineeringState,
  { backgroundProcesses = [], runningSubagents = [], subagentsVerified = true, recentSummarized = false, cachedRecentSummarized = false }: CheckpointState = {},
): Checkpoint {
  const previousSummary = facts.previousSummary ? semanticSummary(facts.previousSummary) : undefined;
  const protectedFacts = extractProtectedFacts(facts.userTexts, previousSummary);

  const sections = [
    SMART_COMPACTION_SYSTEM_PROMPT,
    `${CONVERSATION_OPEN}\n${sanitizeTagContent(facts.transcript)}\n${CONVERSATION_CLOSE}`,
  ];
  if (previousSummary) {
    sections.push(`<previous-summary>\n${sanitizeTagContent(previousSummary)}\n</previous-summary>`);
  }
  const protectedBlock = protectedFacts.length > 0 ? `<protected-facts>\n${protectedFacts.map(sanitizeTagContent).join("\n")}\n</protected-facts>` : undefined;
  if (protectedBlock) sections.push(protectedBlock);
  sections.push(previousSummary ? SMART_COMPACTION_UPDATE_PROMPT : SMART_COMPACTION_INITIAL_PROMPT);

  const appendix = formatFileOperationsXml({
    readFiles: facts.readFiles,
    touchedModifiedFiles: facts.modifiedFiles,
    activeDirtyFiles: git.files.map((file) => file.path),
    dirtyPatch: git.patch,
    dirtyStateAvailable: git.available,
    lockfilesAndGeneratedAssets: git.lockfilesAndGeneratedAssets,
    activeBackgroundProcesses: backgroundProcesses,
    runningSubagents,
    subagentsVerified,
  });
  const marker = recentSummarized || cachedRecentSummarized ? formatFileOperationsXml({ recentSummarized: true }) : "";
  return {
    prompt: sections.join("\n\n"),
    cachedPrompt: cachedCompactionPrompt(!!previousSummary, protectedBlock),
    protectedFacts,
    appendix: appendix + (recentSummarized ? marker : ""),
    cachedAppendix: appendix + (cachedRecentSummarized ? marker : ""),
  };
}

/** Restore dropped protected identifiers verbatim, then append the file and worktree state. */
export function completeSummary(text: string, checkpoint: Pick<Checkpoint, "protectedFacts" | "appendix">): string {
  let summary = stripAppendedState(text);
  const dropped = checkpoint.protectedFacts.filter((fact) => fact && !summary.includes(fact));
  if (dropped.length > 0) {
    summary = [summary, "", RETAINED_IDENTIFIERS_HEADING, ...dropped.map((fact) => `- ${fact}`)].join("\n");
  }
  return `${summary}${checkpoint.appendix}`;
}
