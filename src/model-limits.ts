import type { Plugin } from "@opencode/plugin";
import type { ServerEvent } from "./events.ts";

export type ModelRef = NonNullable<Parameters<Plugin.Context["generate"]["text"]>[0]["model"]>;
export interface ModelLimits {
  context: number;
  input?: number;
  output?: number;
}

export const modelKey = (model: Pick<ModelRef, "providerID" | "id">) => `${model.providerID}/${model.id}`;
export const modelLabel = (model: ModelRef) => `${modelKey(model)}#${model.variant ?? ""}`;

/** One cached registry read shared by the threshold watcher and cache-reuse guard. */
export function createModelLimits(ctx: Pick<Plugin.Context, "model">) {
  let limits: Promise<Map<string, ModelLimits>> | undefined;
  return {
    async get(model: string): Promise<ModelLimits | undefined> {
      limits ??= ctx.model.list().then((result) => new Map(result.data.map((item) => [modelKey(item), item.limit])));
      try {
        return (await limits).get(model);
      } catch (error) {
        limits = undefined;
        throw error;
      }
    },
    handle(event: ServerEvent) {
      if (event.type === "model.updated" || event.type === "provider.updated") limits = undefined;
    },
  };
}
