import type { ServerEvent } from "./events.ts";
import { modelLabel, type ModelLimits, type ModelRef } from "./model-limits.ts";
import type { ContextMessage } from "./subagents.ts";
import { contextTokens, type TokenUsage } from "./threshold.ts";

export interface CachedStep {
  /** `provider/id#variant`, the model whose cache the step warmed. */
  model: string;
  /** When the step's request was sent, which is when the provider last used the cache. */
  startedAt: number;
  assistantMessageID: string;
  tokens: TokenUsage;
}

/** The most recent ended step, not an older warm step hidden by a newer cold one. */
export function createCacheTracker() {
  const started = new Map<string, { model: string; startedAt: number }>();
  const steps = new Map<string, CachedStep>();
  return {
    get: (sessionID: string) => steps.get(sessionID),
    handle(event: ServerEvent) {
      switch (event.type) {
        case "session.step.started":
          started.set(event.data.sessionID, { model: modelLabel(event.data.model), startedAt: Date.now() });
          break;
        case "session.step.ended": {
          const step = started.get(event.data.sessionID);
          if (step) steps.set(event.data.sessionID, { ...step, assistantMessageID: event.data.assistantMessageID, tokens: event.data.tokens });
          else steps.delete(event.data.sessionID);
          break;
        }
        case "session.compaction.ended":
          steps.delete(event.data.sessionID);
          break;
        case "session.deleted":
          steps.delete(event.data.sessionID);
          started.delete(event.data.sessionID);
          break;
      }
    },
  };
}

/** Pure guard: a full-history request is worthwhile only with a warm, matching prefix and output room. */
export function cacheReusePlan(input: {
  enabled: boolean;
  model: ModelRef;
  context: readonly ContextMessage[] | undefined;
  step?: CachedStep;
  limits?: ModelLimits;
  prompt: string;
  now: number;
}): { maxTokens: number } | string {
  const { enabled, model, context, step, limits, prompt, now } = input;
  if (!enabled) return "disabled";
  if (!context) return "context-unavailable";
  if (context.some((message) => message.type === "assistant" && message.time?.completed === undefined)) return "incomplete-assistant";
  if (!step) return "no-recent-step";
  // A compaction model other than the one the session just used has no warm cache to reuse.
  if (step.model !== modelLabel(model)) return "model-mismatch";
  if (now - step.startedAt >= 270_000) return "cache-expired";
  if (step.tokens.cache.read + step.tokens.cache.write <= 0) return "cache-cold";
  const window = limits?.context || limits?.input || 0;
  if (window <= 0) return "unknown-model-window";
  const index = context.findIndex((message) => message.id === step.assistantMessageID);
  const assistant = context[index];
  if (!assistant || assistant.type !== "assistant") return "step-not-in-context";
  const chars = (value: unknown) => JSON.stringify(value)?.length ?? 0;
  let pendingChars = 0;
  for (const part of assistant.content) {
    if (part.type !== "tool") continue;
    if (part.state.status === "completed" || part.state.status === "error") pendingChars += chars(part.state.content);
    if (part.state.status === "error") pendingChars += chars(part.state.error);
  }
  for (const message of context.slice(index + 1)) pendingChars += chars(message);
  const projected = contextTokens(step.tokens) + Math.ceil(pendingChars / 4) + Math.ceil(prompt.length / 4);
  if (limits?.input && limits.input > 0 && projected + 8_000 > limits.input) return "insufficient-room";
  const room = window - projected - 8_000;
  if (room < 4_096) return "insufficient-room";
  return { maxTokens: Math.min(32_000, limits?.output && limits.output > 0 ? limits.output : 32_000, room) };
}
