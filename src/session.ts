/**
 * Reads what compaction needs from the messages OpenCode is about to summarize:
 * the previous checkpoint, the user's own words (for protected facts), the files
 * the session read or changed through tools, and a flattened transcript.
 */

import type { SessionCompaction } from "@opencode/plugin/promise/session";

type Message = SessionCompaction["messages"][number];

// Tag names are assembled so the literal markup never appears in this source.
export const tag = (name: string, close = false) => `<${close ? "/" : ""}${name}>`;
export const CHECKPOINT_OPEN = tag("conversation-checkpoint");
const SUMMARY_OPEN = tag("summary");
export const SUMMARY_CLOSE = tag("summary", true);
export const RECENT_OPEN = `${SUMMARY_CLOSE}\n\n${tag("recent-context")}\n`;
export const RECENT_CLOSE = `\n${tag("recent-context", true)}`;
export const RECENT_SUMMARIZED_TAG = "recent-context-summarized";
// A user turn in OpenCode's serialized recent context runs until the next speaker label.
const RECENT_USER_TURN =
  /^\[User\]: ([\s\S]*?)(?=^\[(?:User|Assistant|Assistant reasoning|Assistant tool call|Tool result|Tool error|Shell|Synthetic context|Skill activated: [^\]\n]*|Attached [^\]\n]*)\]|(?![\s\S]))/gm;

const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
const RECENT_TOOL_CALL = /^\[Assistant tool call\]: (read|edit|write|patch)\((.*)\)$/;

// Transcript budgets, adapted from the Pi extension's serializer: long text keeps its beginning and end, failures
// and the newest messages get more room, and large tool arguments are bounded.
const RECENT_MESSAGES = 14;
const LARGE_ARGUMENT_CHARS = 1_200;
const LARGE_ARGUMENT_KEYS = /^(?:content|text|oldText|newText|oldString|newString|patch|patchText|input|data)$/i;
// The appended file lists carry over across compactions; keep only the most recently used paths so they stay bounded.
const MAX_READ_FILES = 40;
const MAX_MODIFIED_FILES = 60;

/** Moves a path to the most-recent end of an insertion-ordered set. */
function touchPath(paths: Set<string>, file: string): void {
  paths.delete(file);
  paths.add(file);
}

/** The most recently used paths, oldest first, so a carried-over list keeps its recency order. */
function newestPaths(paths: Iterable<string>, limit: number): string[] {
  return [...paths].slice(-limit);
}

export interface SessionFacts {
  userTexts: string[];
  previousSummary?: string;
  readFiles: string[];
  modifiedFiles: string[];
  /** The conversation since the previous summary, including its verbatim recent context, as text. */
  transcript: string;
}

type Part = Message["content"][number];

function textOf(message: Message): string {
  return message.content
    .flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
    .join("\n");
}

/** Whether a checkpoint summary marks its recent context as already summarized, so it isn't summarized again. */
export function summarizesRecent(summary: string | undefined): boolean {
  return summary?.includes(`\n${tag(RECENT_SUMMARIZED_TAG)}\n`) ?? false;
}

export interface PreviousCheckpoint {
  summary?: string;
  /** The conversation OpenCode kept verbatim beside the summary, already serialized as transcript text. */
  recent?: string;
}

/**
 * The summary and verbatim recent context inside a previous checkpoint message, or undefined when the text is not
 * one. The recent context covers turns that are no longer stored after the checkpoint, so it must be summarized too.
 */
export function parseCheckpoint(text: string): PreviousCheckpoint | undefined {
  if (!text.trimStart().startsWith(CHECKPOINT_OPEN)) return undefined;
  const start = text.indexOf(SUMMARY_OPEN);
  if (start === -1) return undefined;
  const recentStart = text.indexOf(RECENT_OPEN, start);
  const recentEnd = text.lastIndexOf(RECENT_CLOSE);
  const end = recentStart === -1 ? text.lastIndexOf(SUMMARY_CLOSE) : recentStart;
  if (end <= start) return undefined;
  const summary = text.slice(start + SUMMARY_OPEN.length, end).trim() || undefined;
  const recent =
    recentStart !== -1 && recentEnd > recentStart
      ? text.slice(recentStart + RECENT_OPEN.length, recentEnd).trim() || undefined
      : undefined;
  return { summary, recent };
}

function recentUserTexts(recent: string): string[] {
  return [...recent.matchAll(RECENT_USER_TURN)].map((match) => match[1]!.trim()).filter(Boolean);
}

function lineSafeHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const boundary = text.lastIndexOf("\n", limit);
  return text.slice(0, boundary > 0 ? boundary : limit);
}

function lineSafeTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = text.length - limit;
  const boundary = text.indexOf("\n", start);
  return text.slice(boundary >= 0 && boundary < text.length - 1 ? boundary + 1 : start);
}

/** Keeps the beginning and end of long text, where commands and their errors usually are. */
export function truncateHeadAndTail(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text;
  const head = lineSafeHead(text, headChars);
  const tail = lineSafeTail(text, tailChars);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n[... ${omitted} characters omitted; showing beginning and end of output ...]\n\n${tail}`;
}

/** Strips terminal escape sequences and carriage-return redraws, and collapses repeated lines. */
export function cleanTerminalOutput(text: string): string {
  const withoutAnsi = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines: string[] = [];
  let repeated = 0;
  const flush = () => {
    if (repeated > 0) lines.push(`[previous line repeated ${repeated} more time${repeated === 1 ? "" : "s"}]`);
    repeated = 0;
  };
  for (const rawLine of withoutAnsi.split("\n")) {
    const segments = rawLine.split("\r");
    const line = segments.at(-1) || [...segments].reverse().find(Boolean) || "";
    if (lines.length > 0 && line && lines.at(-1) === line) {
      repeated++;
      continue;
    }
    flush();
    lines.push(line);
  }
  flush();
  return lines.join("\n");
}

function formatToolInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return truncateHeadAndTail(JSON.stringify(input) ?? "", 2_000, 2_000);
  }
  return Object.entries(input)
    .map(([key, value]) => {
      const serialized = JSON.stringify(value) ?? "undefined";
      const half = LARGE_ARGUMENT_KEYS.test(key) ? LARGE_ARGUMENT_CHARS / 2 : 2_000;
      return `${key}=${truncateHeadAndTail(serialized, half, half)}`;
    })
    .join(", ");
}

function toolResultBudget(tool: string, isError: boolean, isRecent: boolean): number {
  if (isError) return isRecent ? 2_500 : 1_500;
  if (["write", "edit", "patch", "shell"].includes(tool)) return isRecent ? 1_200 : 700;
  if (["read", "grep", "glob"].includes(tool)) return isRecent ? 1_000 : 400;
  return isRecent ? 1_500 : 500;
}

function resultText(part: Extract<Part, { type: "tool-result" }>): string {
  const { result } = part;
  if (result.type === "content") {
    return result.value
      .map((item) => (item.type === "text" ? item.text : `[Attached ${item.mime}${item.name ? `: ${item.name}` : ""}]`))
      .join("\n");
  }
  return typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? "");
}

function flatten(message: Message, isRecent: boolean): string {
  if (message.role === "system") return "";
  const speaker = message.role === "user" ? "User" : "Assistant";
  return message.content
    .flatMap((part): string[] => {
      switch (part.type) {
        case "text":
          return part.text ? [`[${speaker}]: ${part.text}`] : [];
        case "reasoning": {
          const budget = isRecent ? 800 : 400;
          return part.text.trim() ? [`[Assistant reasoning]: ${truncateHeadAndTail(part.text.trim(), budget, budget)}`] : [];
        }
        case "media":
          return [`[${part.media.mediaType} omitted]`];
        case "tool-call":
          return [`[Assistant tool call]: ${part.name}(${formatToolInput(part.input)})`];
        case "tool-result": {
          const isError = part.result.type === "error";
          const text = part.name === "shell" ? cleanTerminalOutput(resultText(part)) : resultText(part);
          const budget = toolResultBudget(part.name, isError, isRecent);
          return [`[${isError ? "Tool error" : "Tool result"}: ${part.name}]: ${truncateHeadAndTail(text, budget, budget)}`];
        }
        default:
          return [];
      }
    })
    .join("\n");
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const unescapeXml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** A list the plugin appended to a previous checkpoint, so file activity and running subagents carry across compactions. */
export function appendedList(summary: string | undefined, name: string): string[] {
  const block = summary?.match(new RegExp(`\\n${tag(name)}\\n([\\s\\S]*?)\\n${tag(name, true)}`))?.[1];
  return block ? block.split("\n").map(unescapeXml).filter(Boolean) : [];
}

/** Successful file tool calls in OpenCode's serialized recent context. */
function recentToolCalls(recent: string): Array<{ name: string; input: unknown }> {
  const lines = recent.split("\n");
  return lines.flatMap((line, index) => {
    const match = line.match(RECENT_TOOL_CALL);
    if (!match || lines[index + 1]?.startsWith("[Tool error]")) return [];
    try {
      return [{ name: match[1]!, input: JSON.parse(match[2]!) as unknown }];
    } catch {
      return [];
    }
  });
}

export function readSessionFacts(messages: readonly Message[]): SessionFacts {
  const userTexts: string[] = [];
  const lines: string[] = [];
  const failed = new Set<string>();
  const calls: Array<{ id?: string; name: string; input: unknown }> = [];
  let previousSummary: string | undefined;

  for (const [index, message] of messages.entries()) {
    for (const part of message.content) {
      if (part.type === "tool-result" && part.result.type === "error") failed.add(part.id);
      if (part.type === "tool-call") calls.push(part);
    }
    if (message.role === "user") {
      const text = textOf(message);
      const checkpoint = parseCheckpoint(text);
      if (checkpoint !== undefined) {
        previousSummary = checkpoint.summary ?? previousSummary;
        if (checkpoint.recent) {
          userTexts.push(...recentUserTexts(checkpoint.recent));
          calls.push(...recentToolCalls(checkpoint.recent));
          if (!summarizesRecent(checkpoint.summary)) lines.push(checkpoint.recent);
        }
        continue;
      }
      if (text) userTexts.push(text);
    }
    const line = flatten(message, messages.length - index <= RECENT_MESSAGES);
    if (line) lines.push(line);
  }

  const read = new Set(appendedList(previousSummary, "read-files"));
  const modified = new Set(appendedList(previousSummary, "touched-files"));
  for (const call of calls) {
    if (call.id !== undefined && failed.has(call.id)) continue;
    if (READ_TOOLS.has(call.name)) {
      const file = stringField(call.input, "path");
      if (file) touchPath(read, file);
    } else if (WRITE_TOOLS.has(call.name)) {
      const file = stringField(call.input, "path");
      if (file) touchPath(modified, file);
    } else if (call.name === "patch") {
      for (const match of (stringField(call.input, "patchText") ?? "").matchAll(PATCH_FILE_LINE)) {
        const file = (match[1] ?? match[2])?.trim();
        if (file) touchPath(modified, file);
      }
    }
  }

  const modifiedFiles = newestPaths(modified, MAX_MODIFIED_FILES);
  return {
    userTexts,
    previousSummary,
    readFiles: newestPaths([...read].filter((file) => !modifiedFiles.includes(file)), MAX_READ_FILES),
    modifiedFiles,
    transcript: lines.join("\n\n"),
  };
}
