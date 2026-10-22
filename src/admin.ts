// Management API and the static WebUI.
//
// The WebUI assets are served by Bun's own directory routes (see index.ts),
// so this module only answers the /api/* calls.

import { existsSync } from "bun:fs";
import { dirname, join, resolve } from "bun:path";
import {
  type Config,
  fingerprint,
  maskValue,
  redactUrl,
  runtimeProxies,
  verifyPassword,
} from "./config.ts";
import { logger, monitor } from "./telemetry.ts";

const SESSION_COOKIE = "oc2api_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  token: string;
  csrf: string;
  expiresAt: number;
}

export class Admin {
  private sessions = new Map<string, Session>();

  constructor(
    private config: Config,
    private onConfigChange: (config: Config) => void,
  ) {}

  get sessionTtlMs(): number {
    return this.config.webui.session_ttl_minutes * 60 * 1000;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/"))
      return this.handleApi(request, url.pathname);
    return new Response("not found", { status: 404 });
  }

  private async handleApi(request: Request, path: string): Promise<Response> {
    switch (`${request.method} ${path}`) {
      case "POST /api/auth/login":
        return this.login(request);
      case "GET /api/auth/session":
        return this.session(request);
      case "POST /api/auth/logout":
        return this.logout(request);
      case "GET /api/config":
        return this.requireSession(request, () =>
          Response.json(this.maskedConfig()),
        );
      case "PUT /api/config":
        return this.requireSession(
          request,
          () => this.saveConfig(request),
          true,
        );
      case "POST /api/config/reload":
        return this.requireSession(
          request,
          () => Response.json({ ok: true }),
          true,
        );
      case "GET /api/monitor":
        return this.requireSession(request, () =>
          Response.json({
            metrics: monitor.snapshot(),
            recent: logger.recent(200),
          }),
        );
      case "GET /api/logs":
        return this.requireSession(request, () =>
          Response.json({ logs: logger.recent(500) }),
        );
      case "GET /api/logs/stream":
        return this.requireSession(request, () => this.logStream());
      case "GET /api/api-keys":
        return this.requireSession(request, () =>
          Response.json({
            keys: this.config.server_keys.map((key) => ({
              id: fingerprint(key),
              display: maskValue(key),
              disabled:
                this.config.server_key_metadata?.[fingerprint(key)]?.disabled ??
                false,
              name:
                this.config.server_key_metadata?.[fingerprint(key)]?.name ?? "",
            })),
          }),
        );
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  private async login(request: Request): Promise<Response> {
    let body: { username?: string; password?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid request" }, { status: 400 });
    }
    if (body.username !== this.config.webui.username)
      return Response.json({ error: "invalid credentials" }, { status: 401 });
    const hash = this.config.webui.password_hash;
    if (!hash)
      return Response.json(
        { error: "no password configured" },
        { status: 500 },
      );
    if (!(await verifyPassword(hash, body.password ?? "")))
      return Response.json({ error: "invalid credentials" }, { status: 401 });
    const token = crypto.randomUUID();
    const csrf = crypto.randomUUID();
    this.sessions.set(token, {
      token,
      csrf,
      expiresAt: Date.now() + this.sessionTtlMs,
    });
    return Response.json(
      { ok: true, csrf },
      {
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}`,
        },
      },
    );
  }

  private session(request: Request): Response {
    const session = this.sessionFrom(request);
    if (!session)
      return Response.json({ authenticated: false }, { status: 401 });
    return Response.json({ authenticated: true, csrf: session.csrf });
  }

  private logout(request: Request): Response {
    const session = this.sessionFrom(request);
    if (session) this.sessions.delete(session.token);
    return Response.json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        },
      },
    );
  }

  private sessionFrom(request: Request): Session | undefined {
    const cookie = request.headers.get("cookie") ?? "";
    const match = /(?:^|;\s*)oc2api_session=([^;]+)/.exec(cookie);
    if (!match) return undefined;
    const session = this.sessions.get(match[1]);
    if (!session) return undefined;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(session.token);
      return undefined;
    }
    return session;
  }

  private requireSession(
    request: Request,
    handler: () => Response | Promise<Response>,
    csrf = false,
  ): Response | Promise<Response> {
    const session = this.sessionFrom(request);
    if (!session)
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    if (csrf) {
      const token = request.headers.get("x-csrf-token");
      if (!token || token !== session.csrf)
        return Response.json({ error: "invalid csrf token" }, { status: 403 });
    }
    return handler();
  }

  private maskedConfig(): Record<string, unknown> {
    const config = this.config;
    return {
      listen: config.listen,
      server_keys: config.server_keys.map((key) => maskValue(key)),
      proxies: runtimeProxies(config).map((entry) => redactUrl(entry)),
      proxyfile: config.proxyfile,
      upstream: { anonymous: redactUrl(config.upstream.anonymous) },
      retry: config.retry,
      models: config.models,
      performance: config.performance,
      logging: config.logging,
      webui: {
        enabled: config.webui.enabled,
        listen: config.webui.listen,
        username: config.webui.username,
        session_ttl_minutes: config.webui.session_ttl_minutes,
      },
      reasoning: config.reasoning,
    };
  }

  private async saveConfig(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid request" }, { status: 400 });
    }
    const candidate: Config = {
      ...this.config,
      ...(body as Partial<Config>),
      effectiveProxies: this.config.effectiveProxies,
    };
    try {
      this.onConfigChange(candidate);
      return Response.json({ ok: true, config: this.maskedConfig() });
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: 400 },
      );
    }
  }

  private logStream(): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (): void => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(logger.recent(50))}\n\n`),
          );
        };
        push();
        const timer = setInterval(push, 2000);
        return () => clearInterval(timer);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }
}

/** webuiDir resolves the directory the static WebUI assets live in. */
export function webuiDir(): string {
  const candidates = [
    Bun.env.WEBUI_DIR,
    // A compiled binary keeps the assets next to itself.
    resolve(dirname(process.execPath), "webui"),
    resolve(process.cwd(), "webui"),
    // The source checkout, when the port runs from the repository.
    resolve(import.meta.dir, "../../webui"),
    resolve(import.meta.dir, "../webui"),
  ].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return candidates[0] ?? "webui";
}
