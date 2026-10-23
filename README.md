# opencode2api — Bun port

A Bun/TypeScript rewrite of the OpenCode gateway. It serves the **keyless OpenCode
free tier**: you supply your own local client keys, and every upstream request goes
out anonymously (`Authorization: Bearer public`). No Zen/Go API keys needed.

Built and tested on **Bun 1.4.4**.

## 30-second deploy

### Option A — Docker (easiest)

```bash
git clone --depth 1 --branch bun-port https://github.com/leloush-x/opencode-api.git
cd opencode-api
cp bun/config.example.json config.json
# Edit config.json: set server_keys and webui.password
docker compose up -d
```

The API listens on `127.0.0.1:8080` and the WebUI on `127.0.0.1:8081` (change to
`0.0.0.0` in `config.json` if you need remote access).

### Option B — Bun directly

```bash
git clone --depth 1 --branch bun-port https://github.com/leloush-x/opencode-api.git
cd opencode-api
bun run setup          # installs deps (--backend=symlink)
cp config.example.json config.json
# Edit config.json: set server_keys and webui.password
bun run start -- -config config.json
```

Then open `http://localhost:8080` (API) and `http://localhost:8081` (WebUI).

## Configuration (`config.json`)

JSON with `//` and `/* */` comments allowed. The only fields you must set:

| Field | What it is | Example |
|---|---|---|
| `listen` | API bind address | `"0.0.0.0:8080"` |
| `server_keys` | Keys clients send to authenticate | `["my-secret-key"]` |
| `webui.password` | WebUI admin password (≥10 chars) | `"ChangeMe123456"` |
| `webui.username` | WebUI admin login | `"admin"` |
| `upstream.anonymous` | Free tier origin | `"https://opencode.ai/inference"` |
| `upstream.fallback` | v1 origin fallback | `"https://opencode.ai/zen"` |

Minimal working example:

```json
{
  "listen": "0.0.0.0:8080",
  "server_keys": ["my-secret-key"],
  "upstream": {
    "anonymous": "https://opencode.ai/inference",
    "fallback": "https://opencode.ai/zen"
  },
  "webui": {
    "enabled": true,
    "listen": "0.0.0.0:8081",
    "username": "admin",
    "password": "ChangeMe123456"
  }
}
```

`SERVER_KEYS` (comma-separated) overrides `server_keys` from the environment.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/healthz` | none | Readiness + model catalog summary |
| GET | `/v1/models` | key | Free models the upstream offers |
| POST | `/v1/chat/completions` | key | Chat Completions |
| POST | `/v1/responses` | key | OpenAI Responses |
| POST | `/v1/messages` | key | Anthropic Messages |
| POST | `/v1/systemone` | key | System One structured decisions |
| GET/POST | `/api/*` | session | WebUI management API |

Clients authenticate with `Authorization: Bearer <server_key>` or `x-api-key:
<server_key>`.

## Rate limits (important)

The OpenCode free tier is **per IP, per model, per day**. When you hit it the
upstream answers `429` with a `Retry-After` header, and the port relays both
to the client unchanged. Wait for the retry time (or use a different IP / a
paid key) before trying again.

## Develop

```bash
bun run setup          # install deps
bun run test           # 52 tests, parallel workers
bun run typecheck      # bun check (no @types/node)
bun run format         # bun fmt
bun run verify         # typecheck + tests together
bun run build          # standalone binary in dist/
bun run bench          # measure startup + reply latency
```

## What's in this branch

Branch `bun-port` contains only the Bun port (no Go code):

- `src/` — gateway, protocol bridge, config, catalog, identity, telemetry
- `tests/` — config, protocol, streaming, gateway, upstream tests
- `scripts/` — build, bench, live verification against the real free tier
- `Dockerfile`, `docker-compose.yml`, `.dockerignore` — deployment

See [PORTING.md](./PORTING.md) for what was ported from Go and what's not.
