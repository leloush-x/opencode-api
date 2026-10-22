# Porting notes: Go → Bun

Scope: the Go gateway in `internal/` and `cmd/` rewritten in TypeScript for the
Bun runtime. The Go code stays in the repository as the reference.

## What changed on purpose

**The keyed tiers are gone.** `zen_keys`, `go_keys`, `prefer` and the rotation
groups (`sota`/`sweet`, which the Go implementation served from the Go tier)
were removed: this port serves the keyless free tier only, so there is one lane,
one credential (`public`) and no tier fallback. The removed fields are still
accepted (and ignored) in `config.json`, so an existing file keeps loading.

`server_keys` — the local keys clients authenticate with — are unchanged.

## Coverage

| Go package | Port | State |
|---|---|---|
| `internal/config` | `src/config.ts` | Ported: JSONC parsing, strict decoding, defaults, validation, env override, secret redaction, Argon2id WebUI password, atomic save with `.bak`, proxy file, proxy pool markers. |
| `internal/protocol` | `src/protocol.ts`, `src/response.ts`, `src/stream.ts` | Ported: the bridge model, request decode/encode for the three message protocols, response conversion, SSE parsing, forwarding, transcoding and collapsing, tool images, the effort ladder. |
| `internal/models` | `src/models.ts` | Ported in part: the catalog, the capability/metadata merge, the native protocol per model, the free-tier eligibility rule. Availability probing and the pricing registry are **not** ported (see gaps). |
| `internal/gateway` | `src/gateway.ts`, `src/upstream.ts` | Ported in part: routing, the anonymous lane, the exit cursor, the free-tier IP block guard, the lane circuit breaker, retries, the v1/v2 request shaping, the anonymous body shaping. The key pools, the rotation groups, the diagnostics Playground and the per-key selection are **not** ported. |
| `internal/httpx` | inline in `src/upstream.ts` | Ported in part: the header sets and routes. The uTLS-fingerprinted transport is **not** ported (see gaps). |
| `internal/identity` | `src/identity.ts` | Ported: the session layout, the request ids, the project id, the client version resolver, the User-Agents. |
| `internal/telemetry` | `src/telemetry.ts` | Ported in part: the structured log ring and the counters. The per-request attempt records and the live SSE log subscription are simplified. |
| `internal/admin` | `src/admin.ts` | Ported in part: login, sessions, CSRF, the masked configuration, the monitor, the logs, the log stream, the static WebUI. The API-key editor, the diagnostics Playground and the quota dashboard are **not** ported. |
| `webui/` | served as-is | The static assets are reused; the pages that talk to the removed management endpoints do not work. |

## Known gaps

1. **No uTLS.** The Go implementation ships a TLS-fingerprinted transport
   (`internal/httpx/bun.go`, `utls`) that mimics the OpenCode client's
   ClientHello. Bun's `fetch` uses its own TLS stack, so the fingerprint
   differs. The free tier gates inspect the request shape, not the TLS
   fingerprint, and the port works against the live free tier — but a gate
   that starts fingerprinting TLS would reject it.
2. **No availability probing.** The Go port probes free models hourly and
   disables the ones the upstream retired. The Bun port trusts the catalog.
3. **No pricing registry, no quota dashboard, no Playground, no API-key
   editor.** The management pages for them are gone with the endpoints.
4. **Simplified telemetry.** The per-request attempt records, the leg chain
   and the request history window are not ported; the counters and the log
   ring are.
5. **The password hash format differs.** Bun writes
   `$argon2id$v=19$m=…,t=…,p=…$salt$hash` with padded base64; the Go
   implementation wrote the same layout with unpadded base64. `verifyPassword`
   accepts both, but a hash written by one implementation is not a drop-in
   for a reader of the other.

## Verification

- `bun test` — 51 tests in parallel worker processes: configuration, the
  protocol bridge, the streaming parser/emitter/transcoder/collapser, the
  upstream request shaping, and the gateway against a stub upstream (auth,
  unknown and paid models, a tool-call round trip, the Anthropic envelope,
  malformed bodies and an upstream failure).
- `bun run typecheck` (`bun check`) — clean, 17 files.
- `scripts/verify-live.sh` — 15 checks against the **real** free tier
  (`glm-5.3-flash-free`): health, auth, the model list, streaming and
  non-streaming chat, Anthropic Messages, Responses, the 404 for an unknown
  model, the WebUI and the admin login. All pass for the dev server and for
  the compiled standalone binary.
- `bun run build` — a single `bun build --compile` binary with the WebUI
  staged next to it.
