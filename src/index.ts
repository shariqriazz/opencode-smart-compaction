import type { Plugin } from "@opencode/plugin";
import { cacheReusePlan, createCacheTracker } from "./cache.ts";
import { buildCheckpoint, completeSummary, isCompleteSummary, stripAppendedState } from "./checkpoint.ts";
import { subscribe } from "./events.ts";
import { getGitEngineeringState } from "./git-state.ts";
import { createModelLimits, modelKey, modelLabel, type ModelRef } from "./model-limits.ts";
import { adaptKeptMessages, keptMessages, readMaxRecentTokens, trimRecentContext } from "./recent.ts";
import { readSessionFacts } from "./session.ts";
import { createShellTracker } from "./shells.ts";
import { carriedSubagents, carriedSubagentsVerified, formatSubagent, runningSubagents, type ContextMessage } from "./subagents.ts";
import { createThresholdWatcher, readThresholdConfig } from "./threshold.ts";

const PLUGIN_ID = "opencode-smart-compaction";
const warn = (message: string) => console.warn(`[${PLUGIN_ID}] ${message}`);

/** The session's stored messages since the last compaction, or undefined when they can't be read. */
async function readContext(ctx: Pick<Plugin.Context, "session">, sessionID: string): Promise<ContextMessage[] | undefined> {
  try {
    return await ctx.session.context({ sessionID });
  } catch (error) {
    warn(`session context unavailable: new subagent launches unavailable, previously recorded children unverified, recent context left untrimmed: ${String(error)}`);
    return undefined;
  }
}

type Mode = "cached" | "stateless";
interface Attempt {
  mode: Mode;
  model: string;
  ms: number;
  outcome: string;
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const attemptList = (attempts: Attempt[]) => attempts.map(({ mode, model, outcome }) => `${mode}/${model}: ${outcome}`).join("; ");

/**
 * The models to try, in order: the compaction model with its variant, the same model with its default settings,
 * then the session's model with its default settings when it differs.
 */
export function summaryModels(compaction: ModelRef, session?: ModelRef): ModelRef[] {
  const base = ({ providerID, id }: ModelRef): ModelRef => ({ providerID, id });
  const candidates = [compaction, base(compaction), ...(session ? [base(session)] : [])];
  const seen = new Set<string>();
  return candidates.filter((model) => {
    const key = `${model.providerID}/${model.id}#${model.variant ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Errors that another attempt cannot fix: cancellation, authentication, permission, and quota. */
export function isFatalGenerationError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("invalid_request") && /reasoning|effort|budget/.test(message)) return false;
  return /aborted|cancelled|\b40[123]\b|unauthorized|invalid_api_key|authentication|forbidden|insufficient_quota|billing/.test(message);
}

/**
 * OpenCode plugin. The session `compaction` hook writes the checkpoint itself:
 * it builds the Smart Compaction prompt from the messages being summarized,
 * generates the summary with the session's model and variant, checks that it
 * has all six sections, completes it, and returns it as the hook result so
 * OpenCode skips its own summary request. If no attempt yields a complete
 * summary, the result stays unset and OpenCode compacts with its built-in
 * prompt. A warm, matching session request is tried before stateless attempts.
 * An event watcher adds the hybrid threshold and tracks cache usage and running shells;
 * background subagents that have not reported back are read from the session's context.
 * The checkpoint also summarizes the turns OpenCode keeps verbatim, and the
 * session `context` and `generate` hooks bound that recent context in each request.
 */
export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const shells = createShellTracker();
    const maxRecentTokens = readMaxRecentTokens(ctx.options);
    const cacheReuse = ctx.options.cacheReuse !== false;
    const cache = createCacheTracker();
    const limits = createModelLimits(ctx);
    const inFlight = new Map<string, { maxTokens: number; prompt: string; model: string }>();

    await ctx.session.hook("compaction", async (event) => {
      if (event.result) return;
      const started = Date.now();
      const attempts: Attempt[] = [];
      try {
        const context = await readContext(ctx, event.sessionID);
        // The turns OpenCode keeps verbatim are summarized too, so requests can carry only the newest of them.
        const kept = context && maxRecentTokens > 0 ? keptMessages(event.messages, context) : undefined;
        const adapted = kept === undefined ? undefined : adaptKeptMessages(kept);
        const facts = readSessionFacts(adapted ? [...event.messages, ...adapted.messages] : event.messages);
        if (!facts.transcript.trim()) return;
        const session = await ctx.session.get({ sessionID: event.sessionID });
        const git = await getGitEngineeringState(session.location.directory || ctx.location.directory);
        const carriedVerified = carriedSubagentsVerified(facts.previousSummary);
        const checkpoint = buildCheckpoint(facts, git, {
          backgroundProcesses: shells.running(event.sessionID),
          runningSubagents: runningSubagents(context ?? [], carriedSubagents(facts.previousSummary), carriedVerified ? [] : [
            facts.transcript,
            ...event.messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])),
          ], carriedVerified).map(formatSubagent),
          subagentsVerified: context !== undefined,
          recentSummarized: adapted?.complete === true,
          cachedRecentSummarized: maxRecentTokens > 0,
        });
        const modelLimits = cacheReuse ? await limits.get(modelKey(event.model)).catch(() => undefined) : undefined;
        const plan = cacheReusePlan({
          enabled: cacheReuse,
          model: event.model,
          context,
          step: cache.get(event.sessionID),
          limits: modelLimits,
          prompt: checkpoint.cachedPrompt,
          now: Date.now(),
        });
        const skipped = typeof plan === "string" ? ` cache-reuse-skipped=${plan}` : "";
        const attempt = async (mode: Mode, model: ModelRef, prompt: string, generate: () => Promise<{ text: string }>) => {
          const start = Date.now();
          const label = modelLabel(model);
          try {
            const { text } = await generate();
            const outcome = isCompleteSummary(stripAppendedState(text)) ? "ok" : text.trim() ? "incomplete" : "empty";
            attempts.push({ mode, model: label, ms: Date.now() - start, outcome });
            if (outcome !== "ok") return false;
            const summary = completeSummary(text, {
              protectedFacts: checkpoint.protectedFacts,
              appendix: mode === "cached" ? checkpoint.cachedAppendix : checkpoint.appendix,
            });
            const durationMs = Date.now() - started;
            event.result = {
              summary,
              metadata: { smartCompaction: {
                mode, model: label, durationMs, summaryChars: summary.length, promptChars: prompt.length,
                ...(typeof plan === "string" ? { cacheSkipped: plan } : {}),
                attempts,
              } },
            };
            console.info(`[${PLUGIN_ID}] checkpoint: mode=${mode} model=${label} attempts=${attempts.length} ${(durationMs / 1_000).toFixed(1)}s summary=${summary.length} chars${skipped}`);
            return true;
          } catch (error) {
            attempts.push({ mode, model: label, ms: Date.now() - start, outcome: errorMessage(error) });
            if (isFatalGenerationError(error)) throw error;
            return false;
          }
        };
        if (typeof plan !== "string") {
          if (await attempt("cached", event.model, checkpoint.cachedPrompt, async () => {
            const request = { maxTokens: plan.maxTokens, prompt: checkpoint.cachedPrompt, model: modelLabel(event.model) };
            inFlight.set(event.sessionID, request);
            try {
              return await ctx.session.generate({ sessionID: event.sessionID, prompt: checkpoint.cachedPrompt });
            } finally {
              if (inFlight.get(event.sessionID) === request) inFlight.delete(event.sessionID);
            }
          })) return;
        }
        for (const model of summaryModels(event.model, session.model)) {
          if (await attempt("stateless", model, checkpoint.prompt, () => ctx.generate.text({ prompt: checkpoint.prompt, model }))) return;
        }
        warn(`using OpenCode's compaction: ${attemptList(attempts)}${skipped}`);
      } catch (error) {
        warn(`using OpenCode's compaction: ${attemptList(attempts) || errorMessage(error)}`);
      }
    });

    if (maxRecentTokens > 0) {
      await ctx.session.hook("context", (event) => {
        trimRecentContext(event.messages, maxRecentTokens);
      });
    }
    if (maxRecentTokens > 0 || cacheReuse) {
      await ctx.session.hook("generate", (event) => {
        if (maxRecentTokens > 0) trimRecentContext(event.messages, maxRecentTokens);
        const request = inFlight.get(event.sessionID);
        const last = event.messages.at(-1);
        const part = last?.content[0];
        if (!request || last?.role !== "user" || last.content.length !== 1 || part?.type !== "text" || part.text !== request.prompt) return;
        if (modelLabel(event.model) !== request.model) throw new Error("session model changed since the cached-path check");
        event.options.maxTokens = Math.min(event.options.maxTokens ?? request.maxTokens, request.maxTokens);
      });
    }

    const threshold = readThresholdConfig(ctx.options);
    return subscribe(
      ctx,
      [shells.handle, cache.handle, threshold ? createThresholdWatcher(ctx, threshold, warn, limits) : limits.handle],
      warn,
    );
  },
} satisfies Plugin.Plugin;
