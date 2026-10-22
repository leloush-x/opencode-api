// Upstream identity: session ids, request ids and the client User-Agents the
// free-tier gates inspect.

import { createHash, randomBytes } from "node:crypto"

export interface RequestIDs {
  session: string
  childSession: string
  request: string
  message: string
  project: string
  parentSession: string
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** randomId returns prefix + "_" + size random bytes in hex. */
export function randomId(prefix: string, size = 12): string {
  return `${prefix}_${randomBytes(size).toString("hex")}`
}

function randomBase62(length: number): string {
  const bytes = randomBytes(length)
  let out = ""
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

let ascendingCounter = 0
let ascendingLast = 0

/** ascendingId mints an id in the official client's Identifier.ascending() layout. */
export function ascendingId(prefix: string): string {
  const ms = Date.now()
  if (ms !== ascendingLast) {
    ascendingLast = ms
    ascendingCounter = 0
  }
  ascendingCounter++
  const value = (BigInt(ms) << 12n) | BigInt(ascendingCounter)
  const hex = value.toString(16).padStart(12, "0").slice(-12)
  return `${prefix}_${hex}${randomBase62(14)}`
}

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-zA-Z]{22}$/
const DESCENDING_TIME_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

export function isOfficialSessionId(signal: string): boolean {
  return CANONICAL_SESSION_PATTERN.test(signal) && DESCENDING_TIME_PATTERN.test(signal.slice(4, 16))
}

/** canonicalSessionId re-encodes a signal into the official descending layout. */
export function canonicalSessionId(signal: string): string {
  if (isOfficialSessionId(signal)) return signal
  const sum = createHash("sha256").update(`ses\x00${signal}`).digest()
  const timePart = descendingTimePart(sum.subarray(0, 6))
  return `ses_${timePart}${base62Fixed(sum.subarray(6, 16), 14)}`
}

function descendingTimePart(hash: Uint8Array): string {
  let current =
    (BigInt(hash[0]) << 28n) | (BigInt(hash[1]) << 20n) | (BigInt(hash[2]) << 12n) | (BigInt(hash[3]) << 4n) | (BigInt(hash[4]) >> 4n)
  current <<= 12n
  current |= 1n
  const inverted = (~current) & 0xffffffffffffn
  return inverted.toString(16).padStart(12, "0")
}

function base62Fixed(bytes: Uint8Array, width: number): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  const base = 62n
  const out: string[] = []
  for (let i = 0; i < width; i++) {
    out.unshift(BASE62[Number(value % base)])
    value /= base
  }
  return out.join("")
}

/** scopedSessionId keeps an official client session verbatim and re-encodes the rest. */
export function scopedSessionId(scope: string, signal: string): string {
  if (isOfficialSessionId(signal)) return signal
  return canonicalSessionId(scope ? `${scope}\x00${signal}` : signal)
}

const CLAUDE_CODE_SESSION_PATTERN = /_session_([0-9A-Fa-f-]{36})$/

function claudeCodeSessionId(userId: string): string {
  const match = CLAUDE_CODE_SESSION_PATTERN.exec(userId)
  return match ? match[1] : ""
}

function header(headers: Record<string, string | undefined>, name: string): string {
  const value = headers[name.toLowerCase()]
  return typeof value === "string" ? value.trim() : ""
}

function stringAt(body: Record<string, unknown> | undefined, ...path: string[]): string {
  let current: unknown = body
  for (const key of path) {
    if (!current || typeof current !== "object") return ""
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === "string" ? current : ""
}

/** deriveRequestIds derives the upstream identity of one request. */
export function deriveRequestIds(headers: Record<string, string | undefined>, body: Record<string, unknown>, scope: string): RequestIDs {
  const candidates = [
    header(headers, "x-opencode-session"),
    header(headers, "x-opencode-session-id"),
    header(headers, "x-session-affinity"),
    header(headers, "x-session-id"),
    header(headers, "session_id"),
    header(headers, "conversation-id"),
    header(headers, "conversation_id"),
    stringAt(body, "conversation_id"),
    stringAt(body, "metadata", "session_id"),
    claudeCodeSessionId(stringAt(body, "metadata", "user_id")),
  ]
  let signal = candidates.find((value) => value !== "") ?? ""
  if (signal === "") signal = conversationSeed(body)
  if (signal === "") signal = stringAt(body, "previous_response_id")
  if (signal === "" || signal === "{}") signal = randomId("fallback", 16)

  const session = scopedSessionId(scope, signal)
  const rawChild = header(headers, "x-opencode-session-id")
  const childSession = rawChild ? scopedSessionId(scope, rawChild) : ""

  let project = header(headers, "x-opencode-project") || stringAt(body, "metadata", "project_id")
  if (project === "") project = scope ? `opencode2api:default-project:${scope}` : "opencode2api:default-project"

  const rawParent = header(headers, "x-parent-session-id") || stringAt(body, "metadata", "parent_session_id")
  const parentSession = rawParent ? scopedSessionId(scope, rawParent) : ""

  return {
    session,
    childSession,
    request: randomId("req", 16),
    message: header(headers, "x-opencode-message-id") || ascendingId("msg"),
    project,
    parentSession,
  }
}

/** conversationSeed keeps a multi-turn conversation stable as its history grows. */
function conversationSeed(body: Record<string, unknown>): string {
  const messages = body.messages
  if (Array.isArray(messages) && messages.length) {
    const first = messages[0] as Record<string, unknown> | undefined
    if (first && typeof first.content === "string") return `${stringAt(first, "role")}:${first.content}`
    if (first) return JSON.stringify(first)
  }
  const input = body.input
  if (typeof input === "string") return `user:${input}`
  return ""
}

const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/

/** projectId renders the project header in the shape both lanes use. */
export function projectId(project: string): string {
  if (project === "global" || GIT_COMMIT_PATTERN.test(project)) return project
  return createHash("sha256").update(`opencode-project\x00${project}`).digest("hex").slice(0, 40)
}

// ---------------------------------------------------------------------------
// client versions and User-Agents

const V1_CLIENT_VERSION = "1.19.3"
const V1_BUN_VERSION = "1.3.14"
const V2_CLIENT_VERSION = "2.1.2"
const CLI_UPDATE_URL = "https://opencode.ai/update/api/latest/cli"

export const V1_CHAT_SDK = "4.0.23"
export const V1_RESPONSES_SDK = "4.0.40"
export const V1_ANTHROPIC_SDK = "4.0.46"

let cliVersion = V2_CLIENT_VERSION
let cliVersionAt = 0

/** cliVersionNow returns the client version to claim and refreshes it in the background. */
export function cliVersionNow(): string {
  if (Date.now() - cliVersionAt > 30 * 60 * 1000) {
    cliVersionAt = Date.now()
    void refreshCliVersion()
  }
  return cliVersion
}

async function refreshCliVersion(): Promise<void> {
  try {
    const response = await fetch(CLI_UPDATE_URL, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return
    const payload = (await response.json()) as { artifacts?: { distribution?: string; version?: string; active?: boolean }[] }
    const artifacts = payload.artifacts ?? []
    const npm = artifacts.find((artifact) => artifact.distribution === "npm" && artifact.version)
    const fallback = artifacts.find((artifact) => artifact.version && artifact.active !== false)
    const resolved = (npm?.version ?? fallback?.version ?? "").trim()
    if (resolved && compareVersions(resolved, cliVersion) > 0) cliVersion = resolved
  } catch {
    /* the claimed version stays at the bundled fallback */
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function v2UserAgent(): string {
  return `opencode/latest/${cliVersionNow()}/cli`
}

export function v1UserAgent(): string {
  return `opencode/${V1_CLIENT_VERSION}`
}

export function v1ModelUserAgent(providerUtils: string): string {
  return `${v1UserAgent()} ai-sdk/provider-utils/${providerUtils} runtime/bun/${V1_BUN_VERSION}`
}
