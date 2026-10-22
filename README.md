# opencode2api — Bun port

A Bun/TypeScript rewrite of the Go gateway in this repository. It serves the
**keyless OpenCode free tier**: the local API accepts your own client keys, and
every upstream request goes out anonymously (`Authorization: Bearer public`).

The Go implementation stays in the repository as the reference; this directory
is the port.

## Run it

```bash
cd bun
bun install
cp ../config.example.json config.json   # or write your own
bun run start -- -config config.json
```

| Flag | Meaning |
|---|---|
| `-config <path>` | Configuration file (default `config.json`). |
| `-listen <addr>` | Override the API listen address. |
| `-web-listen <addr>` | Override the WebUI listen address. |

`SERVER_KEYS` (comma separated) overrides `server_keys` from the environment.

```bash
bun run test        # 45 tests
bun run typecheck   # tsc --noEmit
bun run build       # standalone binary in dist/ + the WebUI next to it
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
  "upstream": { "anonymous": "https://opencode.ai/inference" },
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
- **Management API** — login, sessions, CSRF, masked configuration, monitor,
  logs and a live log stream, plus the existing WebUI served as-is.

See [PORTING.md](./PORTING.md) for the coverage matrix and the known gaps.
