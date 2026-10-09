/**
 * Bounds the recent context OpenCode keeps verbatim beside a checkpoint.
 *
 * OpenCode keeps the newest `compaction.keep.tokens` of the session, but moves the boundary back to the latest user
 * message, so after a long autonomous run the kept turns can be most of the window. The compaction hook summarizes
 * those turns too (`keptMessages`, `asTranscriptMessages`) and marks the checkpoint; the `context` hook then keeps
 * only the newest part of a marked checkpoint's recent context in each request (`trimRecentContext`). Stored
 * messages are never changed, so the next compaction still reads the whole recent context.
 */

import type { SessionCompaction } from "@opencode/plugin/promise/session";
import { CHECKPOINT_OPEN, parseCheckpoint, RECENT_CLOSE, RECENT_OPEN, summarizesRecent, truncateHeadAndTail } from "./session.ts";
import type { ContextMessage } from "./subagents.ts";

type Message = SessionCompaction["messages"][number];

export const DEFAULT_MAX_RECENT_TOKENS = 40_000;
/** OpenCode estimates tokens as characters divided by four; the bound uses the same measure. */
const CHARS_PER_TOKEN = 4;
export const RECENT_OMITTED_NOTE = "[Earlier turns of this recent context are omitted here; the summary above covers them.]";
// The labels that start a turn in OpenCode's serialized recent context. A cut never starts on a tool result.
const TURN_START = /\n(?=\[(?:User|Assistant|Assistant reasoning|Assistant tool call|Synthetic context|Shell)\]: |\[Skill activated: [^\]\n]*\]\n)/g;

/** Plugin option `maxRecentTokens`: the recent-context bound in tokens, or 0 to keep it whole and skip the summary of it. */
export function readMaxRecentTokens(options: Readonly<Record<string, unknown>>): number {
  const value = options.maxRecentTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_MAX_RECENT_TOKENS;
}

/**
 * The stored messages OpenCode will keep verbatim: those after the last message being summarized, matched by ID,
 * or after a completed compaction whose summary exactly matches a request checkpoint. Undefined without a match,
 * so the caller doesn't claim coverage it lacks.
 */
export function keptMessages(summarized: readonly Message[], context: readonly ContextMessage[]): ContextMessage[] | undefined {
  const ids = new Set(summarized.flatMap((message) => (message.id ? [message.id] : [])));
  for (let index = context.length - 1; index >= 0; index--) {
    if (ids.has(context[index]!.id)) return context.slice(index + 1);
  }
  const summaries = new Set(summarized.flatMap((message) => {
    if (message.role !== "user") return [];
    const text = message.content.flatMap((part) => (part.type === "text" ? [part.text.trim()] : [])).join("\n");
    const summary = parseCheckpoint(text)?.summary;
    return summary ? [summary.trim()] : [];
  }));
  for (let index = context.length - 1; index >= 0; index--) {
    const message = context[index]!;
    if (message.type === "compaction" && message.status === "completed" && summaries.has(message.summary.trim())) {
      return context.slice(index + 1);
    }
  }
  return undefined;
}

/** Whether every content-bearing kept turn is adapted, so trimming it after summarization is safe. */
export function canSummarizeKept(stored: readonly ContextMessage[]): boolean {
  return stored.every((message) => {
    switch (message.type) {
      case "skill":
      case "system":
      case "shell":
      case "synthetic":
      case "idle":
        return true;
      case "compaction":
        // Manual compaction stores its empty running placeholder before invoking the hook. It isn't conversation.
        // Failed earlier attempts carry an error that the adapter includes; completed checkpoints still need a boundary.
        return message.status === "failed" || (message.status === "running" && !message.summary.trim() && !message.recent.trim());
      case "user":
        return !message.files?.length && !message.agents?.length && !message.skills?.length;
      case "assistant":
        return message.content.every((part) => {
          if (part.type === "text" || part.type === "reasoning") return true;
          if (part.type !== "tool") return false;
          switch (part.state.status) {
            case "running":
              return true;
            case "completed":
            case "error":
              return part.state.content?.every((item) => item.type === "text") ?? true;
            default:
              return false;
          }
        });
      default:
        return false;
    }
  });
}

/** Stored messages in the request-message shape `readSessionFacts` reads: user text, assistant parts, tool results. */
export function asTranscriptMessages(stored: readonly ContextMessage[]): Message[] {
  const text = (role: "user" | "assistant", value: string) => ({ role, content: [{ type: "text", text: value }] });
  return stored.flatMap((message): unknown[] => {
    switch (message.type) {
      case "user":
        return message.text.trim() ? [text("user", message.text)] : [];
      case "synthetic": {
        const source = typeof message.metadata?.source === "string" ? ` (source: ${message.metadata.source})` : "";
        return message.text.trim() ? [text("assistant", `[Synthetic context]${source}: ${message.text}`)] : [];
      }
      case "skill":
        return [text("assistant", `[Historical skill context: ${message.name} (${message.skill})]: ${message.text}`)];
      case "system":
        return message.text.trim() ? [text("assistant", `[Historical system context]: ${message.text}`)] : [];
      case "compaction":
        return message.status === "failed"
          ? [text("assistant", `[Historical compaction failure]: ${message.error.type}: ${truncateHeadAndTail(message.error.message, 1_500, 1_500)}`)]
          : [];
      case "shell":
        return [
          {
            role: "assistant",
            content: [{ type: "tool-call", id: message.id, name: "shell", input: { command: message.command, status: message.status, exit: message.exit } }],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", id: message.id, name: "shell", result: { type: "content", value: [{ type: "text", text: `status=${message.status}, exit=${message.exit ?? "unknown"}\n${message.output?.output ?? ""}` }] } }],
          },
        ];
      case "assistant": {
        const content: unknown[] = [];
        const results: unknown[] = [];
        for (const part of message.content) {
          if (part.type === "text" || part.type === "reasoning") {
            if (part.text) content.push({ type: part.type, text: part.text });
            continue;
          }
          if (part.type !== "tool" || part.state.status === "streaming") continue;
          content.push({ type: "tool-call", id: part.id, name: part.name, input: part.state.input });
          if (part.state.status === "running") {
            content.push({ type: "text", text: `[Tool status: ${part.name} (${part.id})]: running` });
          }
          const result =
            part.state.status === "completed"
              ? { type: "content", value: part.state.content }
              : part.state.status === "error"
                ? { type: "error", value: [part.state.error.message, ...(part.state.content?.flatMap((item) => item.type === "text" ? [item.text] : []) ?? [])].join("\n") }
                : undefined;
          if (result) results.push({ role: "tool", content: [{ type: "tool-result", id: part.id, name: part.name, result }] });
        }
        return content.length > 0 ? [{ role: "assistant", content }, ...results] : results;
      }
      default:
        return [];
    }
  }) as Message[];
}

/** The newest part of a serialized recent context that fits `maxChars`, starting at a turn, or undefined if it fits. */
export function boundRecent(recent: string, maxChars: number): string | undefined {
  const budget = Math.max(0, Math.floor(maxChars));
  if (recent.length <= budget) return undefined;
  if (budget <= RECENT_OMITTED_NOTE.length) return RECENT_OMITTED_NOTE.slice(0, budget);
  const earliest = recent.length - (budget - RECENT_OMITTED_NOTE.length - 1);
  let cut: number | undefined;
  for (const match of recent.matchAll(TURN_START)) {
    if (match.index + 1 >= earliest) {
      cut = match.index + 1;
      break;
    }
  }
  if (cut === undefined) {
    const lineBreak = recent.indexOf("\n", earliest);
    cut = lineBreak === -1 ? earliest : lineBreak + 1;
  }
  return `${RECENT_OMITTED_NOTE}\n${recent.slice(cut)}`;
}

/** A copy of a message or part with some fields replaced, keeping its prototype. */
const withFields = <T extends object>(value: T, fields: Partial<T>): T =>
  Object.assign(Object.create(Object.getPrototypeOf(value) as object | null) as T, value, fields);

/**
 * Bounds the recent context of each checkpoint the plugin marked as summarizing it, in place in the request
 * messages. Returns how many checkpoints were shortened.
 */
export function trimRecentContext(messages: Message[], maxTokens: number): number {
  if (maxTokens <= 0) return 0;
  let trimmed = 0;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") continue;
    const content = message.content.map((part) => {
      if (part.type !== "text" || !part.text.trimStart().startsWith(CHECKPOINT_OPEN)) return part;
      const recentStart = part.text.indexOf(RECENT_OPEN);
      const recentEnd = part.text.lastIndexOf(RECENT_CLOSE);
      if (recentStart === -1 || recentEnd <= recentStart) return part;
      if (!summarizesRecent(part.text.slice(0, recentStart))) return part;
      const bodyStart = recentStart + RECENT_OPEN.length;
      const bounded = boundRecent(part.text.slice(bodyStart, recentEnd), maxTokens * CHARS_PER_TOKEN);
      if (bounded === undefined) return part;
      trimmed++;
      return withFields(part, { text: part.text.slice(0, bodyStart) + bounded + part.text.slice(recentEnd) });
    });
    if (content.some((part, i) => part !== message.content[i])) {
      messages[index] = withFields(message, { content } as Partial<Message>);
    }
  }
  return trimmed;
}
