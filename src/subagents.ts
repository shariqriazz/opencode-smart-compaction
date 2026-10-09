import type { Plugin } from "@opencode/plugin";
import { appendedList } from "./session.ts";

export type ContextMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number];

export interface RunningSubagent {
  sessionID: string;
  agent?: string;
  description?: string;
}

export const RUNNING_SUBAGENTS_TAG = "running-subagents";

const CARRIED_ID = /^(ses_[^\s():]+)/;
const CARRIED_LINE = /^ses_[^\s():]+(?: \(([^()]*)\))?(?:: (.*))?$/;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** One line per subagent: `sessionID (agent): description`, with line breaks and parentheses in the agent removed. */
export function formatSubagent({ sessionID, agent, description }: RunningSubagent): string {
  const name = agent && oneLine(agent.replace(/[()]/g, ""));
  const about = description && oneLine(description);
  return `${sessionID}${name ? ` (${name})` : ""}${about ? `: ${about}` : ""}`;
}

/** The running subagents a previous checkpoint listed, which may have been launched before its context began. */
export function carriedSubagents(previousSummary: string | undefined): RunningSubagent[] {
  return appendedList(previousSummary, RUNNING_SUBAGENTS_TAG).flatMap((line) => {
    const sessionID = line.match(CARRIED_ID)?.[1];
    if (!sessionID) return [];
    const match = line.match(CARRIED_LINE);
    return [{ sessionID, agent: match?.[1] || undefined, description: match?.[2] || undefined }];
  });
}

/**
 * Background subagents that have not reported back, from the session's active context (every stored message since
 * the last compaction, including the turns OpenCode keeps verbatim). The `subagent` tool returns at once with
 * `metadata.status` "running" when it backgrounds a child session, and OpenCode later delivers a synthetic message
 * with `metadata.source` "subagent" and the child's ID when that session completes, fails, or is cancelled.
 * A foreground result with `metadata.status` "completed" also ends a carried or running entry.
 */
export function runningSubagents(messages: readonly ContextMessage[], carried: readonly RunningSubagent[] = []): RunningSubagent[] {
  const running = new Map(carried.map((subagent) => [subagent.sessionID, subagent]));
  for (const message of messages) {
    if (message.type === "assistant") {
      for (const part of message.content) {
        if (part.type !== "tool" || part.name !== "subagent" || part.state.status !== "completed") continue;
        const { input, metadata } = part.state;
        const sessionID = text(metadata?.sessionID);
        if (!sessionID) continue;
        if (metadata?.status === "completed") {
          running.delete(sessionID);
          continue;
        }
        if (metadata?.status !== "running") continue;
        running.delete(sessionID);
        running.set(sessionID, { sessionID, agent: text(input.agent), description: text(input.description) });
      }
    } else if (message.type === "synthetic" && message.metadata?.source === "subagent") {
      const childID = text(message.metadata.childID);
      if (childID) running.delete(childID);
    }
  }
  return [...running.values()];
}
