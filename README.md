# opencode2api — Bun port

A Bun/TypeScript rewrite of the Go gateway in this repository. It serves the
**keyless OpenCode free tier**: the local API accepts your own client keys, and
every upstream request goes out anonymously (`Authorization: Bearer public`).

The Go implementation stays in the repository as the reference; this directory
is the port. Built and tested against **Bun 1.4.4**.

## Run it

```bash
cd bun
bun run setup      # bun install --backend=symlink
cp ../config.example.json config.json   # or write your own
bun run start -- -config config.json
```

`bun run setup` exists because on some filesystems bun's default hardlink
backend writes scoped packages with mangled file names, which breaks the type
check; the symlink backend installs them correctly.

| Flag | Meaning |
|---|---|
| `-config <path>` | Configuration file (default `config.json`). |
| `-listen <addr>` | Override the API listen address. |
| `-web-listen <addr>` | Override the WebUI listen address. |

`SERVER_KEYS` (comma separated) overrides `server_keys` from the environment.

```bash
bun run test        # 45 tests, in parallel worker processes
bun run typecheck   # bun check
bun run verify      # typecheck and tests concurrently
bun run format      # bun fmt (Prettier-compatible)
bun run build       # standalone binary in dist/ + the WebUI next to it
bun run profile:cpu # an LLM-ready Markdown CPU profile
bun run profile:heap # an LLM-ready Markdown heap profile
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/v1/models` | The free models the upstream offers, with limits and cost. |
| POST | `/v1/chat/completions` | Chat Completions. |
| POST | `/v1/responses` | Responses. |
| POST | `/v1/messages` | Anthropic Messages. |
| GET | `/healthz` | Readiness and resource summary. |
| — | `:8081/api/*` | Management API and the WebUI (`webui.enabled`). |

Client authentication uses `Authorization: Bearer <server_key>` or
`x-api-key: <server_key>`; `/healthz` is open.

## Configuration

The file is JSON with `//` and `/* */` comments; unknown fields are rejected.
Fields of the Go implementation that only mattered for the keyed tiers
(`zen_keys`, `go_keys`, `prefer`, `anonymous`, `rotation`, `free_only`) are
accepted and ignored, so an existing `config.json` keeps loading.

```json
{
  "listen": "127.0.0.1:8080",
  "server_keys": ["change-this-local-key"],
  "proxies": ["direct"],
  "proxyfile": "",
  "upstream": { "anonymous": "https://opencode.ai/inference", "fallback": "https://opencode.ai/zen" },
  "retry": { "max_attempts": 3, "timeout_seconds": 300, "stream_timeout_seconds": 0 },
  "models": { "refresh_seconds": 300, "protocols": {}, "anonymous_backoff": { "threshold": 6, "base_hours": 1, "max_hours": 24 } },
  "performance": { "max_idle_conns": 2048, "max_idle_conns_per_host": 256, "max_conns_per_host": 0, "idle_conn_timeout_seconds": 120, "connect_timeout_seconds": 5, "failure_cooldown_seconds": 15, "attempt_timeout_seconds": 0, "first_event_timeout_seconds": 0, "max_anonymous_exits": 8, "free_tier_block_seconds": 900 },
  "logging": { "level": "info", "ring_size": 2000, "dump_request_bodies": false },
  "webui": { "enabled": true, "listen": "0.0.0.0:8081", "username": "admin", "password": "change-this-admin-password", "session_ttl_minutes": 720 },
  "reasoning": { "effort": "", "effort_by_model": {} }
}
```

## What the port does

- **Protocol bridge** — Chat Completions, Responses and Anthropic Messages are
  converted both ways, including tool calls, tool results, images, files,
  reasoning blocks and the effort ladder (`minimal`…`max`, `none`, `auto`).
- **Streaming** — upstream SSE is forwarded byte for byte in the same protocol
  and transcoded event by event across protocols. A non-streaming client is
  served by forcing `stream: true` upstream and collapsing the events back.
- **The OpenCode 2.x shape** — the free tier fingerprints the request, so the
  port reproduces the official client's headers (`opencode/latest/<v>/cli`,
  `x-opencode-session`, `x-opencode-project`, …), the `/inference/openai/…`
  and `/inference/anthropic/…` routes, the core tool set with the genuine CLI
  definitions, and the 2.x client's key order.
- **Model catalog** — `/v1/models` and the OpenCode capability catalog are
  merged, so limits, cost and the native protocol of every model are known.
- **Exits** — direct, HTTP, HTTPS, SOCKS5 and rotating `#pool` proxies, with a
  per-session cursor, cool-downs and a free-tier IP block guard.
- **Two lanes** — the v2 `/inference` console first, the v1 `/zen` origin
  (`upstream.fallback`) as the fallback.
- **Management API** — login, sessions, CSRF, masked configuration, monitor,
  logs and a live log stream, plus the existing WebUI served by Bun's own
  directory routes.

## Bun 1.4 features in use

| Feature | Where |
|---|---|
| `Bun.JSONC.parse` | The configuration file, comments and all — the hand-rolled comment stripper is gone. |
| `Bun.serve` directory routes (`{ dir }`) | The WebUI: `sendfile`, `ETag`/`Last-Modified`, `304`, `Range`/`206`, and `openat2(RESOLVE_IN_ROOT)` path clamping (a traversal attempt answers `404`). |
| `Bun.serve` backpressure | The SSE path pauses when the client is slow instead of buffering the whole stream on the heap. |
| `fetch` proxy with headers | `proxy: { url, headers }` sends `Proxy-Authorization` for an authenticated HTTP proxy. |
| `bun check` | The type check (`bun run typecheck`); it replaces `tsc`. |
| `bun fmt` | The formatter (`bun run format`). |
| `bun test --parallel` | The tests run in parallel worker processes. |
| `bun run --parallel "check:*"` | `bun run verify` runs the type check and the tests concurrently. |
| `--cpu-prof-md` / `--heap-prof-md` | `bun run profile:cpu` / `profile:heap` write Markdown profiles meant to be read by a human or an LLM. |
| `bun:fs`, `bun:path` | Bun's own modules instead of the Node compatibility layer; `src/shims.d.ts` declares the handful of functions used, so the project needs no `@types/node`. |
| `Bun.CryptoHasher` | SHA-256 for the key fingerprints and the session ids. |
| `Bun.env`, `Bun.argv`, `Bun.main` | The runtime globals. |

Not adopted: `Bun.WebView`, `Bun.Image`, `Bun.markdown`, `Bun.cron`,
`Bun.Terminal` (nothing in a proxy gateway needs them), HTTP/3 in `Bun.serve`
and HTTP/2/3 in `fetch` (experimental; the free tier expects the client's own
request shape and a 1.4 client is safer over HTTP/1.1).

See [PORTING.md](./PORTING.md) for the coverage matrix and the known gaps.
