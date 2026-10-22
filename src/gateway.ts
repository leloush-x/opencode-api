// The gateway: the local inference API and the keyless free-tier lane.

import { type Config, fingerprint, runtimeProxies } from "./config.ts";
import { deriveRequestIds } from "./identity.ts";
import { ModelCatalog, fetchCapabilities, fetchModels } from "./models.ts";
import {
  ANTHROPIC,
  CHAT,
  RESPONSES,
  SYSTEM_ONE,
  type Json,
  type Protocol,
  forcedEffort,
  prepareRequest,
  protocolPath,
  stringAt,
} from "./protocol.ts";
import { convertResponse, responseUsage } from "./response.ts";
import { collapseStream, forwardStream, transcodeStream } from "./stream.ts";
import { logger, monitor } from "./telemetry.ts";
import {
  ANONYMOUS_KEY,
  V1_BASE,
  isV1Upstream,
  prepareAnonymousBody,
  upstreamHeaders,
  upstreamURL,
} from "./upstream.ts";

const MAX_REQUEST_BODY = 32 << 20;
const MAX_RESPONSE_BODY = 64 << 20;
const STATUS_CLIENT_CLOSED_REQUEST = 499;

export interface Proxy {
  name: string;
  clean: string;
  pool: boolean;
  blockedUntil: number;
  healthy: boolean;
}

/** Exit is one egress path: a direct connection or a proxy. */
export class ExitPool {
  readonly exits: Proxy[] = [];
  private cursors = new Map<string, number>();

  constructor(proxies: string[]) {
    for (const entry of proxies) {
      const { clean, pool } = parseEntry(entry);
      this.exits.push({
        name: entry,
        clean,
        pool,
        blockedUntil: 0,
        healthy: true,
      });
    }
  }

  /** next draws the next exit for a session, skipping blocked ones. */
  next(session: string): Proxy | undefined {
    if (!this.exits.length) return undefined;
    const start = this.cursors.get(session) ?? 0;
    for (let step = 0; step < this.exits.length; step++) {
      const index = (start + step) % this.exits.length;
      const exit = this.exits[index];
      if (exit.blockedUntil > Date.now()) continue;
      this.cursors.set(session, index + 1);
      return exit;
    }
    return undefined;
  }

  blockedExits(): boolean {
    return (
      this.exits.length > 0 &&
      this.exits.every((exit) => exit.blockedUntil > Date.now())
    );
  }

  healthyCount(): number {
    return this.exits.filter(
      (exit) => exit.healthy && exit.blockedUntil <= Date.now(),
    ).length;
  }
}

function parseEntry(entry: string): { clean: string; pool: boolean } {
  const trimmed = entry.trim();
  if (trimmed === "" || trimmed === "direct")
    return { clean: "direct", pool: false };
  let pool = false;
  let clean = trimmed;
  if (clean.toLowerCase().startsWith("pool+")) {
    clean = clean.slice(5).trim();
    pool = true;
  }
  const index = clean.lastIndexOf("#");
  if (
    index >= 0 &&
    clean
      .slice(index + 1)
      .trim()
      .toLowerCase() === "pool"
  ) {
    clean = clean.slice(0, index).trim();
    pool = true;
  }
  return { clean, pool };
}

export interface Attempt {
  status: number;
  response?: Response;
  error?: Error;
  exit?: Proxy;
}

export class Gateway {
  config: Config;
  catalog = new ModelCatalog();
  exits: ExitPool;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private breaker = {
    failures: 0,
    pausedUntil: 0,
    threshold: 0,
    baseMs: 0,
    maxMs: 0,
  };

  constructor(config: Config) {
    this.config = config;
    this.exits = new ExitPool(runtimeProxies(config));
    const backoff = config.models.anonymous_backoff;
    if (backoff) {
      this.breaker.threshold = backoff.threshold;
      this.breaker.baseMs = backoff.base_hours * 60 * 60 * 1000;
      this.breaker.maxMs = backoff.max_hours * 60 * 60 * 1000;
    }
  }

  /** refreshModels reloads the model catalog from the upstream. */
  async refreshModels(): Promise<void> {
    const upstream = this.config.upstream.anonymous;
    try {
      const [ids, capabilities] = await Promise.all([
        fetchModels(upstream, ANONYMOUS_KEY, { timeoutMs: 30_000 }),
        fetchCapabilities({ timeoutMs: 30_000 }),
      ]);
      const models = ids.map((id) => {
        const meta = capabilities.models.get(id);
        return (
          meta ?? {
            id,
            protocol: "chat" as Protocol,
            contextWindow: 0,
            maxOutput: 0,
            reasoning: false,
            toolCall: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            deprecated: false,
            free: id.toLowerCase().includes("free"),
          }
        );
      });
      this.catalog.replace(models);
      logger.info("models", "catalog_refreshed", "model catalog refreshed", {
        models: models.length,
      });
    } catch (error) {
      this.catalog.setError((error as Error).message);
      logger.warn(
        "models",
        "catalog_refresh_failed",
        "model catalog refresh failed",
        { error: (error as Error).message },
      );
    }
  }

  start(): void {
    void this.refreshModels();
    this.refreshTimer = setInterval(
      () => void this.refreshModels(),
      this.config.models.refresh_seconds * 1000,
    );
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /** anonymousUpstreams returns the ordered origins of the keyless lane. */
  anonymousUpstreams(): string[] {
    const primary = this.config.upstream.anonymous.replace(/\/+$/, "");
    if (primary === "" || primary.toLowerCase() === V1_BASE.toLowerCase())
      return [V1_BASE];
    return [primary, V1_BASE];
  }

  lanePaused(): boolean {
    return this.breaker.pausedUntil > Date.now();
  }

  noteFailure(): void {
    if (!this.breaker.threshold) return;
    this.breaker.failures++;
    if (this.breaker.failures >= this.breaker.threshold) {
      const current = this.breaker.pausedUntil;
      const window =
        current > Date.now()
          ? Math.min((current - Date.now()) * 2, this.breaker.maxMs)
          : this.breaker.baseMs;
      this.breaker.pausedUntil = Date.now() + window;
      this.breaker.failures = 0;
      logger.warn(
        "upstream",
        "anonymous_breaker_open",
        "anonymous lane paused",
        { paused_for_ms: window },
      );
    }
  }

  noteSuccess(): void {
    this.breaker.failures = 0;
  }

  // -------------------------------------------------------------------------
  // HTTP handling

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") return this.handleHealth();
    if (path === "/v1/models" && request.method === "GET")
      return this.handleModels(request);
    if (
      (path === "/v1/chat/completions" ||
        path === "/v1/responses" ||
        path === "/v1/messages" ||
        path === "/v1/systemone") &&
      request.method === "POST"
    ) {
      const protocol =
        path === "/v1/responses"
          ? RESPONSES
          : path === "/v1/messages"
            ? ANTHROPIC
            : path === "/v1/systemone"
              ? SYSTEM_ONE
              : CHAT;
      const caller = this.authenticate(request, protocol);
      if (!caller)
        return this.writeError(
          protocol,
          401,
          "invalid local API key",
          "authentication_error",
          "",
        );
      return this.handleInference(request, protocol, caller);
    }
    return this.writeError(CHAT, 404, "not found", "invalid_request_error", "");
  }

  private authenticate(
    request: Request,
    protocol: Protocol,
  ): string | undefined {
    const header = request.headers;
    const candidates: string[] = [];
    const apiKey = header.get("x-api-key")?.trim();
    if (apiKey) candidates.push(apiKey);
    const authorization = header.get("authorization") ?? "";
    if (authorization.toLowerCase().startsWith("bearer "))
      candidates.push(authorization.slice(7).trim());
    for (const key of this.config.server_keys) {
      if (this.config.server_key_metadata?.[fingerprint(key)]?.disabled)
        continue;
      for (const candidate of candidates) {
        if (candidate.length === key.length && candidate === key)
          return fingerprint(key);
      }
    }
    return undefined;
  }

  private handleHealth(): Response {
    const snapshot = this.catalog.snapshot();
    const healthy = this.exits.healthyCount();
    const ready =
      snapshot.status !== "starting" && snapshot.freeModels > 0 && healthy > 0;
    const status =
      snapshot.status === "stale" ? "degraded" : ready ? "ready" : "starting";
    return Response.json(
      {
        status,
        version: Bun.env.OPENCODE2API_VERSION ?? "bun-port",
        models: snapshot,
        exits: { total: this.exits.exits.length, healthy },
        lanePaused: this.lanePaused(),
      },
      { status: ready ? 200 : 503 },
    );
  }

  private handleModels(request: Request): Response {
    if (!this.authenticate(request, CHAT))
      return this.writeError(
        CHAT,
        401,
        "invalid local API key",
        "authentication_error",
        "",
      );
    const models = this.catalog.infos().filter((model) => model.free);
    const created = Math.floor(Date.now() / 1000);
    return Response.json({
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        created,
        owned_by: "opencode",
        context_window: model.contextWindow,
        context_length: model.contextWindow,
        max_input: model.contextWindow,
        max_output: model.maxOutput,
        native_protocol: model.protocol,
        supported_endpoints: [protocolPath(model.protocol)],
        reasoning: model.reasoning,
        reasoning_efforts: model.reasoning
          ? ["minimal", "low", "medium", "high", "xhigh", "max"]
          : undefined,
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cache_read: model.cost.cacheRead,
          cache_write: model.cost.cacheWrite,
        },
      })),
    });
  }

  private async handleInference(
    request: Request,
    external: Protocol,
    caller: string,
  ): Promise<Response> {
    const raw = await request.arrayBuffer().catch(() => undefined);
    if (!raw || raw.byteLength > MAX_REQUEST_BODY) {
      return this.writeError(
        external,
        400,
        "request body is too large or unreadable",
        "invalid_request_error",
        "",
      );
    }
    let payload: Record<string, Json>;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return this.writeError(
        external,
        400,
        "request body must be a JSON object",
        "invalid_request_error",
        "",
      );
    }
    const model = stringAt(payload, "model");
    if (!model)
      return this.writeError(
        external,
        400,
        "model is required",
        "invalid_request_error",
        "model",
      );

    if (!this.catalog.known(model)) {
      return this.writeError(
        external,
        404,
        `model "${model}" was not found in the upstream model catalog`,
        "model_not_found",
        "model",
      );
    }
    if (!this.catalog.isFree(model)) {
      return this.writeError(
        external,
        400,
        "this port serves the keyless free tier; only free models are routable",
        "invalid_request_error",
        "model",
      );
    }

    const upstreamProtocol = this.catalog.protocolFor(
      model,
      this.config.models.protocols,
    );
    const ids = deriveRequestIds(
      Object.fromEntries(request.headers.entries()),
      payload,
      caller,
    );

    let body: Record<string, Json>;
    try {
      body = prepareRequest(
        external,
        upstreamProtocol,
        payload,
        this.config.upstream.anonymous,
      );
    } catch (error) {
      return this.writeError(
        external,
        400,
        (error as Error).message,
        "invalid_request_error",
        "",
      );
    }
    const effort =
      this.config.reasoning.effort_by_model?.[model] ??
      this.config.reasoning.effort ??
      "";
    if (effort && effort !== "auto")
      forcedEffort(upstreamProtocol, body, effort);

    const stream = payload.stream === true;
    const attempt = await this.attemptUpstream(
      body,
      upstreamProtocol,
      model,
      ids,
    );
    if (!attempt.response) {
      const status = attempt.error?.message.includes("paused") ? 503 : 502;
      monitor.recordRequest("failed");
      return this.writeError(
        external,
        status,
        attempt.error?.message ?? "all upstream attempts failed",
        "upstream_error",
        ids.request,
      );
    }

    const response = attempt.response;
    if (response.status / 100 !== 2) {
      const text = await response.text();
      monitor.recordRequest("failed");
      return this.writeError(
        external,
        response.status,
        extractErrorMessage(text) || response.statusText,
        "upstream_error",
        ids.request,
      );
    }

    const headers = new Headers({ "x-request-id": ids.request });
    if (!stream) {
      // The free tier always streams upstream; collapse the events back into
      // the single document a non-streaming client asked for.
      const collapsed = await collapseStream(
        response.body!,
        upstreamProtocol,
        model,
      );
      let document = collapsed;
      if (upstreamProtocol !== external) {
        try {
          document = convertResponse(upstreamProtocol, external, collapsed);
        } catch (error) {
          logger.warn(
            "conversion",
            "response_conversion_failed",
            "response protocol conversion failed",
            {
              request_id: ids.request,
              model,
              error: (error as Error).message,
            },
          );
          return this.writeError(
            external,
            502,
            "unsupported upstream response",
            "upstream_error",
            ids.request,
          );
        }
      }
      headers.set("Content-Type", "application/json");
      const usage = responseUsage(external, document);
      monitor.recordRequest(
        "ok",
        usage.reported
          ? {
              input: usage.usage.input,
              output: usage.usage.output,
              cached: usage.usage.cached,
            }
          : undefined,
      );
      return new Response(document as unknown as BodyInit, {
        status: 200,
        headers,
      });
    }

    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    headers.set("Cache-Control", "no-cache");
    headers.set("X-Accel-Buffering", "no");
    const stream2 = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (chunk: string): void => {
          controller.enqueue(new TextEncoder().encode(chunk));
        };
        const result =
          upstreamProtocol === external
            ? await forwardStream(
                response.body!,
                write,
                upstreamProtocol,
                model,
              )
            : await transcodeStream(
                response.body!,
                write,
                upstreamProtocol,
                external,
                model,
              );
        if (result.error) {
          monitor.recordRequest(
            result.error.name === "AbortError"
              ? "client_canceled"
              : "stream_error",
          );
        } else {
          monitor.recordRequest(
            "ok",
            result.reported
              ? {
                  input: result.usage.input,
                  output: result.usage.output,
                  cached: result.usage.cached,
                }
              : undefined,
          );
        }
        controller.close();
      },
    });
    return new Response(stream2, { status: 200, headers });
  }

  /** attemptUpstream walks the exits until one accepts the request. */
  private async attemptUpstream(
    body: Record<string, Json>,
    protocol: Protocol,
    model: string,
    ids: ReturnType<typeof deriveRequestIds>,
  ): Promise<Attempt> {
    if (this.lanePaused())
      return {
        status: 0,
        error: new Error(
          "the anonymous lane is paused after repeated failures",
        ),
      };
    const upstreams = this.anonymousUpstreams();
    const limit = Math.min(
      this.exits.exits.length,
      this.config.performance.max_anonymous_exits || 8,
    );
    let lastError = "all upstream attempts failed";
    let lastStatus = 0;

    for (let proxyIndex = 0; proxyIndex < limit; proxyIndex++) {
      const exit = this.exits.next(ids.session);
      if (!exit) {
        lastError = this.exits.blockedExits()
          ? "every exit is under the free tier's IP block"
          : "no healthy exit available";
        break;
      }
      for (const baseURL of upstreams) {
        const v1 = isV1Upstream(baseURL);
        const shaped = prepareAnonymousBody(
          new TextEncoder().encode(JSON.stringify(body)),
          protocol,
          v1,
        );
        const requestBody = shaped.body;
        const endpoint = upstreamURL(baseURL, protocol);
        const headers = upstreamHeaders(baseURL, protocol, ids, ANONYMOUS_KEY);
        monitor.recordAttempt(false);
        let response: Response | undefined;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: shaped.text,
            proxy: proxyOption(exit.clean),
            signal: AbortSignal.timeout(
              this.config.retry.timeout_seconds * 1000,
            ),
          });
        } catch (error) {
          lastError = (error as Error).message;
          continue;
        }
        lastStatus = response.status;
        if (response.status / 100 === 2) {
          monitor.recordAttempt(true);
          this.noteSuccess();
          logger.debug(
            "upstream",
            "attempt_succeeded",
            "upstream accepted the request",
            {
              request_id: ids.request,
              model,
              status: response.status,
              exit: exit.name,
            },
          );
          return { status: response.status, response, exit };
        }
        // A request-level rejection is identical on every exit: stop here.
        if (
          response.status === 400 ||
          response.status === 413 ||
          response.status === 422
        ) {
          this.noteFailure();
          return { status: response.status, response, exit };
        }
        // The free tier flagged this egress IP: cool the exit and move on.
        if (response.status === 403 && (await isAbuseBlock(response))) {
          exit.blockedUntil =
            Date.now() + this.config.performance.free_tier_block_seconds * 1000;
          lastError = "the free tier blocked this egress IP";
          this.noteFailure();
          continue;
        }
        lastError = `upstream returned ${response.status}`;
        this.noteFailure();
      }
    }
    return { status: lastStatus, error: new Error(lastError) };
  }

  private writeError(
    protocol: Protocol,
    status: number,
    message: string,
    kind: string,
    requestId: string,
  ): Response {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (requestId) headers.set("x-request-id", requestId);
    const body =
      protocol === ANTHROPIC
        ? { type: "error", error: { type: kind, message } }
        : { error: { message, type: kind, param: null, code: null } };
    return new Response(JSON.stringify(body), { status, headers });
  }
}

function extractErrorMessage(text: string): string {
  try {
    const payload = JSON.parse(text) as Record<string, Json>;
    const nested = payload.error as Record<string, Json> | undefined;
    if (nested && typeof nested.message === "string") return nested.message;
    if (typeof payload.message === "string") return payload.message;
  } catch {
    /* not a JSON body */
  }
  return "";
}

/**
 * proxyOption builds the fetch proxy option for an exit. Bun 1.4 accepts
 * { url, headers }, so an HTTP proxy with credentials gets a
 * Proxy-Authorization header instead of the credentials in the URL. SOCKS
 * proxies keep their credentials in the URL, where the SOCKS handshake
 * expects them.
 */
function proxyOption(
  clean: string,
): string | { url: string; headers: Record<string, string> } | undefined {
  if (!clean || clean === "direct") return undefined;
  try {
    const url = new URL(clean);
    const httpProxy = url.protocol === "http:" || url.protocol === "https:";
    if (!httpProxy || (!url.username && !url.password)) return clean;
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    url.username = "";
    url.password = "";
    return {
      url: url.toString(),
      headers: { "Proxy-Authorization": `Basic ${btoa(credentials)}` },
    };
  } catch {
    return clean;
  }
}

/** isAbuseBlock reports whether an upstream 403 is an IP-level abuse answer. */ async function isAbuseBlock(
  response: Response,
): Promise<boolean> {
  const text = await response.clone().text();
  if (!text) return false;
  const lowered = text.toLowerCase();
  return (
    lowered.includes("free tier") ||
    lowered.includes("ip") ||
    lowered.includes("abuse") ||
    lowered.includes("blocked")
  );
}

export { STATUS_CLIENT_CLOSED_REQUEST };
