// Upstream request shaping: the OpenCode 1.x (/zen) and 2.x (/inference) lanes.
//
// The free tier gates fingerprint the request, so the gateway reproduces the
// official client's headers, routes and body shape per lane.

import { ANTHROPIC, CHAT, RESPONSES, SYSTEM_ONE, type Json, type Protocol, protocolPath } from "./protocol.ts"
import { V1_ANTHROPIC_SDK, V1_CHAT_SDK, V1_RESPONSES_SDK, type RequestIDs, projectId, v1ModelUserAgent, v2UserAgent } from "./identity.ts"
import toolDefinitions from "./opencode_tools.json" with { type: "json" }

/** The v1 lane's origin (the /zen console serving /zen/v1/*). */
export const V1_BASE = "https://opencode.ai/zen"

/** The credential the keyless free tier sends. */
export const ANONYMOUS_KEY = "public"

/** The single tool the v1 free-tier gate requires. */
export const V1_READ_TOOL = "read"

const V1_DEPRECATED_READ_DESCRIPTION =
  "DEPRECATED: This tool is deprecated and disabled. Do NOT call or reference this tool under any circumstances; ignore it completely."

/** The tool names the v2 free-tier gate expects on an agent-shaped request. */
export const V2_CORE_TOOLS = ["shell", "edit", "glob", "grep", "read"]

/** The max_completion_tokens a 2.x client puts on every chat body. */
const V2_COMPLETION_LIMIT = 32000

export function isV1Upstream(baseURL: string): boolean {
  const trimmed = baseURL.trim().replace(/\/+$/, "").toLowerCase()
  if (trimmed === V1_BASE.replace(/\/+$/, "").toLowerCase()) return true
  return trimmed.endsWith("/zen")
}

/** isInferenceOrigin reports whether baseURL targets the v2 /inference gateway. */
export function isInferenceOrigin(baseURL: string): boolean {
  try {
    const path = new URL(baseURL.trim()).pathname.replace(/\/+$/, "")
    return path === "/inference" || path.startsWith("/inference/")
  } catch {
    return false
  }
}

/** v2EndpointPath returns the route a 2.1 client posts to on a v2 origin. */
export function v2EndpointPath(baseURL: string, protocol: Protocol): string {
  if (!isInferenceOrigin(baseURL)) return protocolPath(protocol)
  const family = protocol === ANTHROPIC ? "anthropic" : "openai"
  return `/${family}${protocolPath(protocol)}`
}

function withAnthropicBeta(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (url.searchParams.get("beta") === "true") return endpoint
    url.searchParams.set("beta", "true")
    return url.toString()
  } catch {
    return endpoint
  }
}

/** upstreamURL builds the endpoint of one attempt. */
export function upstreamURL(baseURL: string, protocol: Protocol): string {
  const trimmed = baseURL.replace(/\/+$/, "")
  const endpoint = isV1Upstream(baseURL) ? trimmed + protocolPath(protocol) : trimmed + v2EndpointPath(baseURL, protocol)
  if (protocol === ANTHROPIC && !isV1Upstream(baseURL)) return withAnthropicBeta(endpoint)
  return endpoint
}

/** upstreamHeaders renders the lane's header set. */
export function upstreamHeaders(baseURL: string, protocol: Protocol, ids: RequestIDs, key: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (isV1Upstream(baseURL)) {
    setV1Headers(headers, protocol, ids)
  } else {
    setV2Headers(headers, protocol, ids)
  }
  if (protocol === ANTHROPIC) {
    headers["x-api-key"] = key
    headers["anthropic-version"] = "2023-06-01"
  } else {
    headers.Authorization = `Bearer ${key}`
  }
  return headers
}

function setV1Headers(headers: Record<string, string>, protocol: Protocol, ids: RequestIDs): void {
  headers.Accept = "*/*"
  headers["User-Agent"] = v1ModelUserAgent(v1ProviderUtils(protocol))
  headers["x-opencode-client"] = "cli"
  headers["x-opencode-session"] = ids.session
  headers["x-opencode-session-id"] = ids.session
  headers["x-opencode-request"] = ids.message
  headers["x-opencode-project"] = projectId(ids.project)
  if (ids.parentSession) {
    headers["x-opencode-parent-session-id"] = ids.parentSession
    headers["x-parent-session-id"] = ids.parentSession
  }
}

function setV2Headers(headers: Record<string, string>, protocol: Protocol, ids: RequestIDs): void {
  headers["x-opencode-client"] = "cli"
  let rootSession = ids.session
  if (ids.parentSession) {
    rootSession = ids.parentSession
    headers["x-opencode-parent-session-id"] = ids.parentSession
    headers["x-parent-session-id"] = ids.parentSession
  }
  const childSession = ids.childSession || ids.session
  headers["x-session-affinity"] = rootSession
  headers["X-Session-Id"] = rootSession
  headers["x-opencode-session"] = rootSession
  headers["x-opencode-session-id"] = childSession
  headers["User-Agent"] = v2UserAgent()
  headers["x-opencode-project"] = projectId(ids.project)
  if (protocol === ANTHROPIC) headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
}

function v1ProviderUtils(protocol: Protocol): string {
  switch (protocol) {
    case RESPONSES:
      return V1_RESPONSES_SDK
    case ANTHROPIC:
      return V1_ANTHROPIC_SDK
    default:
      return V1_CHAT_SDK
  }
}

// ---------------------------------------------------------------------------
// anonymous body shaping

type ToolDefinition = { description?: string; parameters?: Json }

/** knownOpencodeTool returns the genuine CLI 2.x definition of a tool. */
export function knownOpencodeTool(name: string): ToolDefinition | undefined {
  const definitions = toolDefinitions as Record<string, ToolDefinition>
  return definitions[name]
}

function v2Tool(protocol: Protocol, name: string): Json {
  const definition = knownOpencodeTool(name)
  const description = definition?.description ?? `Agent tool ${name}`
  const parameters = definition?.parameters ?? { type: "object", properties: {} }
  switch (protocol) {
    case CHAT:
      return { type: "function", function: { name, description, parameters, strict: false } }
    case ANTHROPIC:
      return { name, description, input_schema: parameters }
    default:
      return { type: "function", name, description, parameters }
  }
}

function v2Toolset(protocol: Protocol, names: string[]): Json[] {
  return names.map((name) => v2Tool(protocol, name))
}

function anonymousToolName(protocol: Protocol, item: Json): string {
  if (!item || typeof item !== "object") return ""
  const entry = item as Record<string, Json>
  if (protocol === CHAT) {
    const fn = entry.function as Record<string, Json> | undefined
    return typeof fn?.name === "string" ? fn.name : ""
  }
  return typeof entry.name === "string" ? entry.name : ""
}

function setAnonymousToolName(protocol: Protocol, item: Json, name: string): void {
  if (!item || typeof item !== "object") return
  const entry = item as Record<string, Json>
  if (protocol === CHAT) {
    const fn = entry.function as Record<string, Json> | undefined
    if (fn) fn.name = name
    return
  }
  entry.name = name
}

function isV1ReadToolCandidate(name: string): boolean {
  const lower = name.trim().toLowerCase()
  if (lower === "") return false
  if (lower === "read") return true
  const normalized = lower.replace(/[_\-.]/g, "")
  if (["readfile", "fileread", "readfiles", "readtext", "readtextfile", "readcontent", "viewfile"].includes(normalized)) return true
  return lower.startsWith("read_") || lower.startsWith("read-") || lower.endsWith("_read") || lower.endsWith("-read")
}

function v1DeprecatedReadTool(protocol: Protocol): Json {
  const parameters = { type: "object", properties: {} }
  if (protocol === CHAT) {
    return { type: "function", function: { name: V1_READ_TOOL, description: V1_DEPRECATED_READ_DESCRIPTION, parameters } }
  }
  if (protocol === ANTHROPIC) {
    return { name: V1_READ_TOOL, description: V1_DEPRECATED_READ_DESCRIPTION, input_schema: parameters }
  }
  return { type: "function", name: V1_READ_TOOL, description: V1_DEPRECATED_READ_DESCRIPTION, parameters }
}

function rewriteToolReferences(payload: Record<string, Json>, protocol: Protocol, fromName: string, toName: string): void {
  if (!fromName || fromName === toName) return
  if (protocol === CHAT) {
    const choice = payload.tool_choice as Record<string, Json> | undefined
    const fn = choice?.function as Record<string, Json> | undefined
    if (fn && fn.name === fromName) fn.name = toName
    for (const raw of (payload.messages as Json[] | undefined) ?? []) {
      const message = raw as Record<string, Json>
      for (const rawCall of (message?.tool_calls as Json[] | undefined) ?? []) {
        const call = rawCall as Record<string, Json>
        const fn = call.function as Record<string, Json> | undefined
        if (fn && fn.name === fromName) fn.name = toName
      }
    }
    return
  }
  if (protocol === RESPONSES) {
    const choice = payload.tool_choice as Record<string, Json> | undefined
    if (choice && choice.name === fromName) choice.name = toName
    for (const raw of (payload.input as Json[] | undefined) ?? []) {
      const item = raw as Record<string, Json>
      if (item?.type === "function_call" && item.name === fromName) item.name = toName
    }
    return
  }
  const choice = payload.tool_choice as Record<string, Json> | undefined
  if (choice && choice.name === fromName) choice.name = toName
  for (const raw of (payload.messages as Json[] | undefined) ?? []) {
    const message = raw as Record<string, Json>
    for (const rawBlock of (message?.content as Json[] | undefined) ?? []) {
      const block = rawBlock as Record<string, Json>
      if (block?.type === "tool_use" && block.name === fromName) block.name = toName
    }
  }
}

/** ensureV1ReadTool satisfies the v1 free-tier gate with a single "read" tool. */
export function ensureV1ReadTool(payload: Record<string, Json>, protocol: Protocol): { alias: string; changed: boolean } {
  const raw = payload.tools
  if (raw === undefined) {
    payload.tools = [v1DeprecatedReadTool(protocol)]
    return { alias: "", changed: true }
  }
  if (!Array.isArray(raw)) return { alias: "", changed: false }
  let candidateIndex = -1
  let candidateName = ""
  let caseFoldCandidate = false
  for (let index = 0; index < raw.length; index++) {
    const name = anonymousToolName(protocol, raw[index])
    if (name === "") continue
    if (name === V1_READ_TOOL) return { alias: "", changed: false }
    if (name.toLowerCase() === V1_READ_TOOL) {
      if (!caseFoldCandidate) {
        candidateIndex = index
        candidateName = name
        caseFoldCandidate = true
      }
      continue
    }
    if (candidateIndex < 0 && isV1ReadToolCandidate(name)) {
      candidateIndex = index
      candidateName = name
    }
  }
  if (candidateIndex >= 0) {
    setAnonymousToolName(protocol, raw[candidateIndex], V1_READ_TOOL)
    rewriteToolReferences(payload, protocol, candidateName, V1_READ_TOOL)
    payload.tools = raw
    return { alias: candidateName, changed: true }
  }
  raw.push(v1DeprecatedReadTool(protocol))
  payload.tools = raw
  return { alias: "", changed: true }
}

/** ensureV2Tools makes the tool list read as an OpenCode 2.x agent session. */
export function ensureV2Tools(payload: Record<string, Json>, protocol: Protocol): boolean {
  const raw = payload.tools
  if (raw === undefined) {
    payload.tools = v2Toolset(protocol, V2_CORE_TOOLS)
    return true
  }
  if (!Array.isArray(raw)) return false
  let changed = false
  const present = new Set<string>()
  for (let index = 0; index < raw.length; index++) {
    const name = anonymousToolName(protocol, raw[index])
    if (name === "") continue
    present.add(name)
    if (knownOpencodeTool(name)) {
      raw[index] = v2Tool(protocol, name)
      changed = true
    }
  }
  const missing = V2_CORE_TOOLS.filter((name) => !present.has(name))
  if (missing.length) {
    raw.push(...v2Toolset(protocol, missing))
    changed = true
  }
  if (!changed) return false
  payload.tools = raw
  return true
}

function ensureChatUsage(payload: Record<string, Json>, protocol: Protocol): boolean {
  if (protocol !== CHAT) return false
  const options = payload.stream_options as Record<string, Json> | undefined
  if (!options) {
    payload.stream_options = { include_usage: true }
    return true
  }
  if (options.include_usage === true) return false
  options.include_usage = true
  return true
}

function ensureCompletionLimit(payload: Record<string, Json>): boolean {
  if (payload.max_completion_tokens !== undefined || payload.max_tokens !== undefined) return false
  payload.max_completion_tokens = V2_COMPLETION_LIMIT
  return true
}

/** v2ChatKeyOrder is the key order the 2.x client's JSON.stringify emits. */
const V2_CHAT_KEY_ORDER = ["model", "messages", "tools", "stream", "stream_options", "max_completion_tokens"]

/** marshalV2ChatBody encodes a chat payload in the 2.x client's key order. */
export function marshalV2ChatBody(payload: Record<string, Json>): string {
  const written = new Set<string>()
  const parts: string[] = []
  const write = (key: string): void => {
    if (!(key in payload)) return
    written.add(key)
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(payload[key])}`)
  }
  for (const key of V2_CHAT_KEY_ORDER) write(key)
  for (const key of Object.keys(payload).sort()) if (!written.has(key)) write(key)
  return `{${parts.join(",")}}`
}

/** prepareAnonymousBody normalizes a request body for the free tier. */
export function prepareAnonymousBody(
  body: Uint8Array,
  protocol: Protocol,
  v1: boolean,
): { body: Uint8Array; text: string; alias: string; changed: boolean } {
  if (protocol === SYSTEM_ONE) return { body, text: new TextDecoder().decode(body), alias: "", changed: false }
  let payload: Record<string, Json>
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return { body, text: new TextDecoder().decode(body), alias: "", changed: false }
  }
  let changed = false
  if (payload.stream !== true) {
    payload.stream = true
    changed = true
  }
  if (ensureChatUsage(payload, protocol)) changed = true
  let alias = ""
  if (v1) {
    const result = ensureV1ReadTool(payload, protocol)
    alias = result.alias
    if (result.changed) changed = true
  } else if (ensureV2Tools(payload, protocol)) changed = true
  if (!v1 && protocol === CHAT && ensureCompletionLimit(payload)) changed = true
  if (!changed) return { body, text: new TextDecoder().decode(body), alias, changed: false }
  const encoded = !v1 && protocol === CHAT ? marshalV2ChatBody(payload) : JSON.stringify(payload)
  return { body: new TextEncoder().encode(encoded), text: encoded, alias, changed: true }
}
