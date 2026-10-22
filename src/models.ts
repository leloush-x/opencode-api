// Model catalog: what the upstream offers, how it is priced and which wire
// protocol each model speaks.
//
// The catalog is built from two sources: the origin's /v1/models list (the
// models that can actually be requested) and the OpenCode capability catalog
// (https://models.opencode.ai/api.json) for limits, cost and the native
// protocol.

import { type Protocol, type Json } from "./protocol.ts";

export const CAPABILITIES_URL = "https://models.opencode.ai/api.json";

export interface ModelInfo {
  id: string;
  protocol: Protocol;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
  toolCall: boolean;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  deprecated: boolean;
  free: boolean;
}

export interface CatalogSnapshot {
  status: "ready" | "stale" | "starting";
  models: number;
  freeModels: number;
  refreshedAt: number;
  lastError: string;
}

const NPM_PROTOCOL: Record<string, Protocol> = {
  "@ai-sdk/openai-compatible": "chat",
  "@ai-sdk/openai": "responses",
  "@ai-sdk/anthropic": "anthropic",
};

export class ModelCatalog {
  private models = new Map<string, ModelInfo>();
  private refreshedAt = 0;
  private lastError = "";
  private started = false;

  /** replace installs a fresh model list. */
  replace(models: ModelInfo[]): void {
    this.models = new Map(models.map((model) => [model.id, model]));
    this.refreshedAt = Date.now();
    this.started = true;
    this.lastError = "";
  }

  get(model: string): ModelInfo | undefined {
    return this.models.get(model);
  }

  known(model: string): boolean {
    return this.models.has(model);
  }

  /** list returns the sorted model ids. */
  list(): string[] {
    return [...this.models.keys()].sort();
  }

  infos(): ModelInfo[] {
    return this.list().map((id) => this.models.get(id)!);
  }

  snapshot(): CatalogSnapshot {
    return {
      status: this.started ? (this.isStale() ? "stale" : "ready") : "starting",
      models: this.models.size,
      freeModels: this.infos().filter((model) => model.free).length,
      refreshedAt: this.refreshedAt,
      lastError: this.lastError,
    };
  }

  isStale(): boolean {
    return (
      this.refreshedAt > 0 && Date.now() - this.refreshedAt > 15 * 60 * 1000
    );
  }

  setError(message: string): void {
    this.lastError = message;
  }

  /** protocolFor returns the native protocol of a model. */
  protocolFor(model: string, overrides: Record<string, string>): Protocol {
    const override = overrides[model];
    if (
      override === "chat" ||
      override === "responses" ||
      override === "anthropic"
    )
      return override;
    return this.models.get(model)?.protocol ?? "chat";
  }

  /** isFree reports whether the free tier may serve the model. */
  isFree(model: string): boolean {
    const info = this.models.get(model);
    if (info) return info.free;
    return model.toLowerCase().includes("free");
  }
}

// ---------------------------------------------------------------------------
// discovery

export interface FetchOptions {
  proxy?: string;
  timeoutMs?: number;
}

/** fetchModels lists the model ids at baseURL's /v1/models. */
export async function fetchModels(
  baseURL: string,
  key: string,
  options: FetchOptions = {},
): Promise<string[]> {
  const url = `${baseURL.replace(/\/+$/, "")}/v1/models`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    proxy:
      options.proxy && options.proxy !== "direct" ? options.proxy : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok)
    throw new Error(`model list failed with status ${response.status}`);
  const payload = (await response.json()) as { data?: { id?: string }[] };
  const models = payload.data ?? [];
  return models.map((model) => model.id ?? "").filter((id) => id !== "");
}

export interface Capabilities {
  models: Map<string, ModelInfo>;
}

/** fetchCapabilities reads the OpenCode capability catalog. */
export async function fetchCapabilities(
  options: FetchOptions = {},
): Promise<Capabilities> {
  const response = await fetch(CAPABILITIES_URL, {
    headers: { Accept: "application/json" },
    proxy:
      options.proxy && options.proxy !== "direct" ? options.proxy : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok)
    throw new Error(`capability catalog failed with status ${response.status}`);
  const payload = (await response.json()) as Record<string, Json>;
  const models = new Map<string, ModelInfo>();
  for (const [providerId, provider] of Object.entries(payload)) {
    if (!provider || typeof provider !== "object") continue;
    const providerRecord = provider as Record<string, Json>;
    const providerNpm =
      typeof providerRecord.npm === "string" ? providerRecord.npm : "";
    const entries = providerRecord.models;
    if (!entries || typeof entries !== "object") continue;
    for (const [modelId, raw] of Object.entries(
      entries as Record<string, Json>,
    )) {
      if (!raw || typeof raw !== "object") continue;
      const model = raw as Record<string, Json>;
      const cost = (model.cost ?? {}) as Record<string, number>;
      const limit = (model.limit ?? {}) as Record<string, number>;
      const modelProvider = (model.provider ?? {}) as Record<string, string>;
      const npm = modelProvider.npm || providerNpm;
      const protocol: Protocol = NPM_PROTOCOL[npm] ?? "chat";
      const info: ModelInfo = {
        id: modelId,
        protocol,
        contextWindow: Number(limit.context ?? 0),
        maxOutput: Number(limit.output ?? 0),
        reasoning: model.reasoning === true,
        toolCall: model.tool_call === true,
        cost: {
          input: Number(cost.input ?? 0),
          output: Number(cost.output ?? 0),
          cacheRead: Number(cost.cache_read ?? 0),
          cacheWrite: Number(cost.cache_write ?? 0),
        },
        deprecated: model.status === "deprecated",
        free:
          modelId.toLowerCase().includes("free") ||
          (Number(cost.input ?? 0) === 0 &&
            Number(cost.output ?? 0) === 0 &&
            model.status !== "deprecated"),
      };
      // The opencode provider describes the Zen models; it wins over a
      // same-named model of another provider.
      const existing = models.get(modelId);
      if (!existing || providerId === "opencode") models.set(modelId, info);
    }
  }
  return { models };
}
