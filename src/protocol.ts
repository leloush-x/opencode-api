// Protocol bridge: converts request bodies between Chat Completions,
// Responses and Anthropic Messages.
//
// System One is recognized but never translated: it has no bridge encoding,
// so a decision payload is relayed verbatim.

export type Protocol = "chat" | "responses" | "anthropic" | "systemone"

export const CHAT: Protocol = "chat"
export const RESPONSES: Protocol = "responses"
export const ANTHROPIC: Protocol = "anthropic"
export const SYSTEM_ONE: Protocol = "systemone"

export function isValidProtocol(value: string): value is Protocol {
  return value === CHAT || value === RESPONSES || value === ANTHROPIC || value === SYSTEM_ONE
}

/** path returns the endpoint path that serves a protocol. */
export function protocolPath(protocol: Protocol): string {
  switch (protocol) {
    case RESPONSES:
      return "/v1/responses"
    case ANTHROPIC:
      return "/v1/messages"
    case SYSTEM_ONE:
      return "/v1/systemone"
    default:
      return "/v1/chat/completions"
  }
}

// ---------------------------------------------------------------------------
// JSON accessors (the Go jsonutil package)

export type Json = any

export function anyAt(object: Json, ...path: string[]): Json {
  let current: Json = object
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined
    current = current[key]
  }
  return current
}

export function stringAt(object: Json, ...path: string[]): string {
  const value = anyAt(object, ...path)
  return typeof value === "string" ? value : ""
}

export function boolAt(object: Json, ...path: string[]): boolean {
  const value = anyAt(object, ...path)
  return typeof value === "boolean" ? value : false
}

export function intAt(object: Json, ...path: string[]): number {
  const value = anyAt(object, ...path)
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  return 0
}

export function mapAt(object: Json, ...path: string[]): Record<string, Json> | undefined {
  const value = anyAt(object, ...path)
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined
}

export function sliceAt(object: Json, ...path: string[]): Json[] | undefined {
  const value = anyAt(object, ...path)
  return Array.isArray(value) ? value : undefined
}

export function asSlice(value: Json): Json[] | undefined {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return undefined
  return [value]
}

export function firstString(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed !== "") return trimmed
  }
  return ""
}

export function firstAny(...values: Json[]): Json {
  for (const value of values) if (value !== undefined && value !== null) return value
  return undefined
}

export function put(object: Record<string, Json>, key: string, value: Json): void {
  if (value !== undefined && value !== null) object[key] = value
}

export function cloneMap<T>(input: T): T {
  if (Array.isArray(input)) return input.map((item) => cloneMap(item)) as unknown as T
  if (input && typeof input === "object") {
    const out: Record<string, Json> = {}
    for (const [key, value] of Object.entries(input as Record<string, Json>)) out[key] = cloneMap(value)
    return out as unknown as T
  }
  return input
}

export function parseJsonOrString(value: string): Json {
  if (value === "") return {}
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// bridge model

export interface BridgeBlock {
  kind: "text" | "image" | "file" | "reasoning" | "tool_call" | "tool_result"
  text?: string
  signature?: string
  encrypted?: string
  url?: string
  mediaType?: string
  data?: string
  fileId?: string
  filename?: string
  id?: string
  name?: string
  arguments?: Json
  argumentsJson?: string
  callId?: string
  result?: Json
  isError?: boolean
}

export interface BridgeMessage {
  role: string
  blocks: BridgeBlock[]
}

export interface BridgeTool {
  name: string
  description: string
  schema: Json
  strict: boolean
}

export interface BridgeToolChoice {
  mode: string
  name: string
}

export interface BridgeRequest {
  model: string
  system: BridgeBlock[]
  developer: BridgeBlock[]
  messages: BridgeMessage[]
  tools: BridgeTool[]
  toolChoice: BridgeToolChoice
  stream: boolean
  temperature: Json
  topP: Json
  maxTokens: Json
  stop: Json
  reasoning: Json
  metadata: Json
  responseFormat: Json
  parallelToolCalls: Json
  frequencyPenalty: Json
  presencePenalty: Json
  seed: Json
  promptCacheKey: Json
  safetyIdentifier: Json
  serviceTier: Json
  store: Json
}

export interface Usage {
  input: number
  output: number
  total: number
  cached: number
  cacheCreation: number
  reasoning: number
}

export interface BridgeResponse {
  id: string
  model: string
  text: string
  reasoning: BridgeBlock[]
  tools: BridgeBlock[]
  stop: string
  error: string
  usage: Usage
  created: number
}

const TOOL_REASONING_PLACEHOLDER = "tool call"
const ANTHROPIC_REDACTED_THINKING_PLACEHOLDER = "[redacted thinking]"
const REASONING_VENDOR_HINTS = ["moonshot", "kimi", "deepseek", "mimo", "xiaomimimo"]

// ---------------------------------------------------------------------------
// reasoning levels

export function normalizeEffortValue(value: Json): { effort: string | undefined; stated: boolean } {
  if (typeof value !== "string") return { effort: undefined, stated: false }
  const mode = value.trim().toLowerCase()
  if (mode === "none" || mode === "disabled") return { effort: undefined, stated: true }
  if (mode === "") return { effort: undefined, stated: false }
  return { effort: value, stated: true }
}

function explicitEffort(object: Record<string, Json>): { effort: string | undefined; stated: boolean } {
  for (const key of ["effort", "reasoning_effort"]) {
    if (key in object) {
      const result = normalizeEffortValue(object[key])
      if (result.stated) return result
    }
  }
  return { effort: undefined, stated: false }
}

/** budgetForEffort synthesizes a thinking budget for a level. */
export function budgetForEffort(value: Json): number {
  const text = typeof value === "string" ? value.trim().toLowerCase() : ""
  switch (text) {
    case "minimal":
    case "low":
      return 1024
    case "medium":
      return 4096
    case "high":
      return 8192
    case "xhigh":
      return 16384
    case "max":
      return 32768
    default:
      return 4096
  }
}

/** effortForThinkingBudget buckets an Anthropic thinking budget onto a level. */
export function effortForThinkingBudget(budget: number): string {
  if (budget <= 0) return "high"
  if (budget >= 32768) return "max"
  if (budget >= 16384) return "xhigh"
  if (budget > 8192) return "high"
  if (budget >= 8192) return "high"
  if (budget > 2048) return "medium"
  return "low"
}

export function reasoningEffort(value: Json): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, Json>
    const explicit = explicitEffort(object)
    if (explicit.stated) return explicit.effort
    switch (stringAt(object, "type")) {
      case "disabled":
        return undefined
      case "enabled":
      case "adaptive":
        return effortForThinkingBudget(intAt(object, "budget_tokens"))
      default:
        return object.type
    }
  }
  const normalized = normalizeEffortValue(value)
  if (normalized.stated) return normalized.effort
  return value
}

export function reasoningBudget(value: Json): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0
  const object = value as Record<string, Json>
  const budget = intAt(object, "budget_tokens")
  if (budget > 0) return budget
  if (!explicitEffort(object).stated) return 0
  const named = object.reasoning_budget_tokens
  return typeof named === "number" ? Math.trunc(named) : 0
}

export function withReasoningBudget(value: Json, budget: number): Json {
  if (budget <= 0) return value
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, Json>), budget_tokens: budget }
  }
  return { budget_tokens: budget, effort: value }
}

export function anthropicThinking(value: Json): { thinking: Json; outputConfig: Json } {
  if (value === undefined || value === null) return { thinking: undefined, outputConfig: undefined }
  let budget = 0
  let source: Json = value
  if (typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, Json>
    const kind = stringAt(object, "type")
    budget = intAt(object, "budget_tokens")
    const explicit = explicitEffort(object)
    if (explicit.stated) {
      if (explicit.effort === undefined) return { thinking: undefined, outputConfig: undefined }
      return { thinking: thinkingFor(explicit.effort, budget), outputConfig: { effort: explicit.effort } }
    }
    if (kind === "disabled") return { thinking: undefined, outputConfig: undefined }
    if (kind === "enabled" || kind === "adaptive") {
      const effort = effortForThinkingBudget(budget)
      return { thinking: thinkingFor(effort, budget), outputConfig: { effort } }
    }
    const typed = normalizeEffortValue(object.type)
    if (typed.stated) {
      if (typed.effort === undefined) return { thinking: undefined, outputConfig: undefined }
      return { thinking: thinkingFor(typed.effort, budget), outputConfig: { effort: typed.effort } }
    }
    if (budget > 0) {
      const effort = effortForThinkingBudget(budget)
      return { thinking: thinkingFor(effort, budget), outputConfig: { effort } }
    }
    source = object.type
  }
  const normalized = normalizeEffortValue(source)
  if (!normalized.stated) {
    if (typeof source === "number" && Number.isFinite(source)) {
      if (source <= 0) return { thinking: undefined, outputConfig: undefined }
      const effort = effortForThinkingBudget(source)
      return { thinking: thinkingFor(effort, source), outputConfig: { effort } }
    }
    return { thinking: undefined, outputConfig: undefined }
  }
  if (normalized.effort === undefined) return { thinking: undefined, outputConfig: undefined }
  return { thinking: thinkingFor(normalized.effort, budget), outputConfig: { effort: normalized.effort } }
}

function thinkingFor(effort: Json, budget: number): Record<string, Json> {
  const tokens = budget > 0 ? budget : budgetForEffort(effort)
  return { type: "enabled", budget_tokens: tokens }
}

function chatResponseFormat(format: Json): Json {
  if (!format || typeof format !== "object" || Array.isArray(format)) return undefined
  const object = format as Record<string, Json>
  switch (stringAt(object, "type")) {
    case "json_object":
      return { type: "json_object" }
    case "json_schema": {
      const nested = mapAt(object, "json_schema")
      if (nested) return { type: "json_schema", json_schema: nested }
      const out: Record<string, Json> = {}
      for (const key of ["name", "description", "schema", "strict"]) if (key in object) out[key] = object[key]
      return Object.keys(out).length ? { type: "json_schema", json_schema: out } : undefined
    }
    default:
      return undefined
  }
}

function responsesTextFormat(format: Json): Json {
  if (!format || typeof format !== "object" || Array.isArray(format)) return undefined
  const object = format as Record<string, Json>
  switch (stringAt(object, "type")) {
    case "text":
    case "json_object":
      return object
    case "json_schema": {
      const nested = mapAt(object, "json_schema")
      if (!nested) return object
      return { ...nested, type: "json_schema" }
    }
    default:
      return undefined
  }
}

function schemaOrDefault(value: Json): Json {
  if (value === undefined || value === null) return { type: "object", properties: {} }
  return value
}

function asPrefix(id: string, prefix: string): string {
  if (id.startsWith(`${prefix}_`)) return id
  let out = id
  for (const current of ["chatcmpl_", "resp_", "msg_"]) if (out.startsWith(current)) out = out.slice(current.length)
  return `${prefix}_${out}`
}

// ---------------------------------------------------------------------------
// content decoding

export function decodeOpenAIBlocksChecked(value: Json): BridgeBlock[] {
  if (typeof value === "string") return value === "" ? [] : [{ kind: "text", text: value }]
  if (value && typeof value === "object" && !Array.isArray(value)) return decodeOpenAIBlocksChecked([value])
  if (!Array.isArray(value)) return []
  const blocks: BridgeBlock[] = []
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("OpenAI content block must be an object")
    const record = part as Record<string, Json>
    switch (stringAt(record, "type")) {
      case "text":
      case "input_text":
      case "output_text":
        blocks.push({ kind: "text", text: stringAt(record, "text") })
        break
      case "image_url":
        blocks.push({ kind: "image", url: firstString(stringAt(record, "image_url", "url"), stringAt(record, "image_url")) })
        break
      case "input_image":
        blocks.push({ kind: "image", url: stringAt(record, "image_url") })
        break
      case "file":
      case "input_file": {
        const file = mapAt(record, "file")
        blocks.push({
          kind: "file",
          fileId: firstString(stringAt(record, "file_id"), stringAt(file, "file_id")),
          filename: firstString(stringAt(record, "filename"), stringAt(file, "filename")),
          mediaType: firstString(stringAt(record, "media_type"), stringAt(file, "media_type")),
          data: firstString(stringAt(record, "file_data"), stringAt(file, "file_data")),
        })
        break
      }
      default:
        throw new Error(`unsupported OpenAI content block type "${stringAt(record, "type")}"`)
    }
  }
  return blocks
}

export function decodeAnthropicBlocksChecked(value: Json): BridgeBlock[] {
  if (typeof value === "string") return value === "" ? [] : [{ kind: "text", text: value }]
  const blocks: BridgeBlock[] = []
  for (const raw of asSlice(value) ?? []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Anthropic content block must be an object")
    const part = raw as Record<string, Json>
    switch (stringAt(part, "type")) {
      case "thinking":
        blocks.push({ kind: "reasoning", text: stringAt(part, "thinking"), signature: stringAt(part, "signature") })
        break
      case "redacted_thinking":
        blocks.push({ kind: "reasoning", encrypted: stringAt(part, "data") })
        break
      case "text":
        blocks.push({ kind: "text", text: stringAt(part, "text") })
        break
      case "image": {
        const source = mapAt(part, "source") ?? {}
        if (stringAt(source, "type") === "url") blocks.push({ kind: "image", url: stringAt(source, "url") })
        else blocks.push({ kind: "image", mediaType: stringAt(source, "media_type"), data: stringAt(source, "data") })
        break
      }
      case "document": {
        const source = mapAt(part, "source") ?? {}
        if (stringAt(source, "type") === "text") {
          blocks.push({ kind: "text", text: firstString(stringAt(source, "data"), stringAt(source, "text")) })
          break
        }
        blocks.push({
          kind: "file",
          url: stringAt(source, "url"),
          mediaType: stringAt(source, "media_type"),
          data: firstString(stringAt(source, "data"), stringAt(source, "text")),
          filename: stringAt(part, "title"),
        })
        break
      }
      case "tool_use":
        blocks.push({ kind: "tool_call", id: stringAt(part, "id"), name: stringAt(part, "name"), arguments: part.input })
        break
      case "tool_result":
        blocks.push({ kind: "tool_result", callId: stringAt(part, "tool_use_id"), result: part.content, isError: boolAt(part, "is_error") })
        break
      default:
        throw new Error(`unsupported Anthropic content block type "${stringAt(part, "type")}"`)
    }
  }
  return blocks
}

function decodeChatReasoning(message: Record<string, Json>): BridgeBlock[] {
  let value = message.reasoning_content
  if (value === undefined) value = message.reasoning
  if (typeof value !== "string") return []
  return [{ kind: "reasoning", text: value, signature: stringAt(message, "reasoning_signature") }]
}

function decodeResponsesReasoning(item: Record<string, Json>): BridgeBlock[] {
  let text = ""
  for (const raw of asSlice(item.summary) ?? []) text += stringAt(raw, "text")
  if (item.content !== undefined && item.content !== null) {
    for (const raw of asSlice(item.content) ?? []) text += stringAt(raw, "text")
  }
  const encrypted = stringAt(item, "encrypted_content")
  if (text === "" && encrypted === "") return []
  return [{ kind: "reasoning", id: stringAt(item, "id"), text, encrypted }]
}

function encodeResponsesReasoningInput(block: BridgeBlock): Record<string, Json> | undefined {
  if (!block.id && !block.encrypted) return undefined
  return encodeResponsesReasoning(block, false)
}

export function encodeResponsesReasoning(block: BridgeBlock, completed: boolean): Record<string, Json> {
  const id = block.id || `rs_${Math.random().toString(36).slice(2, 14)}`
  const summary: Json[] = block.text ? [{ type: "summary_text", text: block.text }] : []
  const item: Record<string, Json> = { id, type: "reasoning", summary }
  if (block.encrypted) item.encrypted_content = block.encrypted
  if (completed) item.status = "completed"
  return item
}

export function bridgeReasoningText(blocks: BridgeBlock[]): { text: string; ok: boolean } {
  if (blocks.length === 0) return { text: "", ok: false }
  let text = ""
  for (const block of blocks) {
    if (block.text) text += block.text
    else if (block.encrypted) text += ANTHROPIC_REDACTED_THINKING_PLACEHOLDER
  }
  return { text, ok: true }
}

export function bridgeReasoningSignature(blocks: BridgeBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].signature) return blocks[i].signature as string
  return ""
}

export function encodeChatBlocks(blocks: BridgeBlock[]): Json {
  if (blocks.length === 1 && blocks[0].kind === "text") return blocks[0].text
  const parts: Json[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        parts.push({ type: "text", text: block.text })
        break
      case "image": {
        const url = block.url || (block.data ? `data:${block.mediaType};base64,${block.data}` : "")
        parts.push({ type: "image_url", image_url: { url } })
        break
      }
      case "file": {
        const file: Record<string, Json> = {}
        put(file, "file_id", block.fileId)
        put(file, "file_data", block.data)
        put(file, "filename", block.filename)
        parts.push({ type: "file", file })
        break
      }
    }
  }
  return parts
}

export function encodeAnthropicBlocks(blocks: BridgeBlock[]): Json[] {
  const parts: Json[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        parts.push({ type: "text", text: block.text })
        break
      case "image":
        if (block.url) parts.push({ type: "image", source: { type: "url", url: block.url } })
        else parts.push({ type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } })
        break
      case "file": {
        let source: Record<string, Json> | undefined
        if (block.url) source = { type: "url", url: block.url }
        else if (block.data) source = { type: "base64", media_type: firstString(block.mediaType ?? "", "application/octet-stream"), data: block.data }
        if (source) {
          const part: Record<string, Json> = { type: "document", source }
          put(part, "title", block.filename)
          parts.push(part)
        }
        break
      }
      case "tool_call": {
        const input = block.arguments !== undefined && block.arguments !== null ? block.arguments : parseJsonOrString(block.argumentsJson ?? "")
        parts.push({ type: "tool_use", id: block.id, name: block.name, input })
        break
      }
      case "tool_result": {
        const content = Array.isArray(block.result) ? encodeAnthropicBlocks(block.result as BridgeBlock[]) : block.result
        parts.push({ type: "tool_result", tool_use_id: block.callId, content, is_error: block.isError })
        break
      }
      case "reasoning":
        if (block.encrypted) {
          parts.push({ type: "redacted_thinking", data: block.encrypted })
          break
        }
        parts.push({ type: "thinking", thinking: block.text, signature: block.signature })
        break
    }
  }
  return parts
}

export function bridgeArgumentsJson(block: BridgeBlock): string {
  if (block.argumentsJson) return block.argumentsJson
  if (block.arguments === undefined || block.arguments === null) return "{}"
  try {
    return JSON.stringify(block.arguments)
  } catch {
    return "{}"
  }
}

export function bridgeToolResultContent(value: Json): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    let text = ""
    for (const raw of value) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || stringAt(raw, "type") !== "text") return JSON.stringify(value)
      text += stringAt(raw, "text")
    }
    return text
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// tool choices

function decodeChatToolChoice(value: Json): BridgeToolChoice {
  if (typeof value === "string") return { mode: value, name: "" }
  const choice = mapAt(value) ?? {}
  if (stringAt(choice, "type") === "function") return { mode: "named", name: stringAt(choice, "function", "name") }
  return { mode: "", name: "" }
}

function decodeResponsesToolChoice(value: Json): BridgeToolChoice {
  if (typeof value === "string") return { mode: value, name: "" }
  const choice = mapAt(value) ?? {}
  if (stringAt(choice, "type") === "function") return { mode: "named", name: stringAt(choice, "name") }
  return { mode: "", name: "" }
}

function decodeAnthropicToolChoice(value: Json): BridgeToolChoice {
  if (typeof value === "string") return decodeAnthropicToolChoice({ type: value === "required" ? "any" : value })
  const choice = mapAt(value) ?? {}
  switch (stringAt(choice, "type")) {
    case "auto":
      return { mode: "auto", name: "" }
    case "none":
      return { mode: "none", name: "" }
    case "any":
      return { mode: "required", name: "" }
    case "tool":
      return { mode: "named", name: stringAt(choice, "name") }
    default:
      return { mode: "", name: "" }
  }
}

function encodeChatToolChoice(choice: BridgeToolChoice): Json {
  switch (choice.mode) {
    case "named":
      return { type: "function", function: { name: choice.name } }
    case "auto":
    case "none":
    case "required":
      return choice.mode
    default:
      return undefined
  }
}

function encodeResponsesToolChoice(choice: BridgeToolChoice): Json {
  switch (choice.mode) {
    case "named":
      return { type: "function", name: choice.name }
    case "auto":
    case "none":
    case "required":
      return choice.mode
    default:
      return undefined
  }
}

function encodeAnthropicToolChoice(choice: BridgeToolChoice): Json {
  switch (choice.mode) {
    case "named":
      return { type: "tool", name: choice.name }
    case "required":
      return { type: "any" }
    case "auto":
      return { type: "auto" }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// tool images

export function decodeToolImages(from: Protocol, value: Json): Json {
  if (!Array.isArray(value)) return value
  const imageType = from === ANTHROPIC ? "image" : "input_image"
  const textType = from === ANTHROPIC ? "text" : "input_text"
  const hasImage = value.some((part) => stringAt(part, "type") === imageType)
  if (!hasImage) return value
  for (let i = 0; i < value.length; i++) {
    const part = value[i]
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error(`content[${i}] must be an object`)
    const record = part as Record<string, Json>
    switch (stringAt(record, "type")) {
      case textType:
        if (typeof record.text !== "string") throw new Error(`content[${i}] requires text`)
        break
      case imageType:
        if (from === ANTHROPIC) {
          const source = mapAt(record, "source") ?? {}
          let valid = false
          switch (stringAt(source, "type")) {
            case "url":
              valid = stringAt(source, "url") !== "" && source.data === undefined && source.file_id === undefined
              break
            case "base64":
              valid = stringAt(source, "data") !== "" && stringAt(source, "media_type").startsWith("image/") && source.url === undefined && source.file_id === undefined
              break
          }
          if (!valid) throw new Error(`content[${i}] has an unsupported or conflicting image source`)
        } else if (stringAt(record, "image_url") === "" || record.file_id !== undefined) {
          throw new Error(`content[${i}] requires an image URL without a file reference`)
        }
        break
      default:
        throw new Error(`content[${i}] contains an unsupported block alongside tool images`)
    }
  }
  if (from === ANTHROPIC) return decodeAnthropicBlocksChecked(value)
  const blocks = decodeOpenAIBlocksChecked(value)
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.kind !== "image" || !block.url?.startsWith("data:")) continue
    const rest = block.url.slice("data:".length)
    const comma = rest.indexOf(",")
    if (comma < 0) throw new Error(`content[${i}] has an invalid image data URI`)
    const header = rest.slice(0, comma)
    const data = rest.slice(comma + 1)
    const media = header.replace(/;base64$/, "")
    if (!header.endsWith(";base64") || !media.startsWith("image/") || data === "") throw new Error(`content[${i}] has an invalid image data URI`)
    block.url = ""
    block.mediaType = media
    block.data = data
  }
  return blocks
}

export function chatToolImages(result: BridgeBlock): { text: string; images: BridgeBlock[] } {
  if (!Array.isArray(result.result)) return { text: bridgeToolResultContent(result.result), images: [] }
  const parts = result.result as BridgeBlock[]
  let text = ""
  const images: BridgeBlock[] = []
  let n = 0
  for (const part of parts) {
    if (part.kind === "text") {
      text += part.text
      continue
    }
    n++
    const marker = `[tool_image call_id=${JSON.stringify(result.callId ?? "")} index=${n}]`
    text += `\n${marker}\n`
    images.push({ kind: "text", text: marker }, part)
  }
  return { text, images }
}

export function responsesToolContent(value: Json): Json {
  if (!Array.isArray(value)) return bridgeToolResultContent(value)
  const content: Json[] = []
  for (const part of value as BridgeBlock[]) {
    if (part.kind === "text") content.push({ type: "input_text", text: part.text })
    else {
      const url = part.url || `data:${part.mediaType};base64,${part.data}`
      content.push({ type: "input_image", image_url: url })
    }
  }
  return content
}

// ---------------------------------------------------------------------------
// request decoding

function appendBridgeBlock(messages: BridgeMessage[], role: string, block: BridgeBlock): void {
  const last = messages[messages.length - 1]
  if (last && last.role === role && bridgeBlocksOnlyTools(last.blocks)) {
    last.blocks.push(block)
    return
  }
  messages.push({ role, blocks: [block] })
}

function bridgeBlocksOnlyTools(blocks: BridgeBlock[]): boolean {
  if (blocks.length === 0) return false
  return blocks.every((block) => block.kind === "tool_call" || block.kind === "tool_result")
}

function anthropicReasoning(input: Record<string, Json>): Json {
  const stated = firstAny(anyAt(input, "output_config", "effort"), input.effort)
  const normalized = normalizeEffortValue(stated)
  if (normalized.stated) {
    if (normalized.effort === undefined) return undefined
    const thinking = mapAt(input, "thinking")
    if (thinking) return { ...thinking, effort: normalized.effort }
    return normalized.effort
  }
  return input.thinking
}

export function decodeBridgeRequest(protocol: Protocol, input: Record<string, Json>): BridgeRequest {
  const request: BridgeRequest = {
    model: stringAt(input, "model"),
    system: [],
    developer: [],
    messages: [],
    tools: [],
    toolChoice: { mode: "", name: "" },
    stream: boolAt(input, "stream"),
    temperature: input.temperature,
    topP: input.top_p,
    maxTokens: undefined,
    stop: undefined,
    reasoning: undefined,
    metadata: input.metadata,
    responseFormat: undefined,
    parallelToolCalls: undefined,
    frequencyPenalty: undefined,
    presencePenalty: undefined,
    seed: undefined,
    promptCacheKey: undefined,
    safetyIdentifier: undefined,
    serviceTier: undefined,
    store: undefined,
  }

  switch (protocol) {
    case CHAT: {
      request.maxTokens = firstAny(input.max_completion_tokens, input.max_tokens)
      request.stop = input.stop
      request.reasoning = firstAny(input.reasoning_effort, input.reasoning)
      const messages = sliceAt(input, "messages") ?? []
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i]
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error(`messages[${i}] must be an object`)
        const record = message as Record<string, Json>
        const role = stringAt(record, "role")
        let blocks = decodeOpenAIBlocksChecked(record.content)
        if (role === "assistant") {
          blocks = [...decodeChatReasoning(record), ...blocks]
          const budget = intAt(record, "reasoning_budget_tokens")
          if (budget > 0) request.reasoning = withReasoningBudget(request.reasoning, budget)
        }
        const calls = sliceAt(record, "tool_calls") ?? []
        for (let j = 0; j < calls.length; j++) {
          const call = calls[j]
          if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error(`messages[${i}].tool_calls[${j}] must be an object`)
          const callRecord = call as Record<string, Json>
          const fn = mapAt(callRecord, "function") ?? {}
          blocks.push({ kind: "tool_call", id: stringAt(callRecord, "id"), name: stringAt(fn, "name"), argumentsJson: stringAt(fn, "arguments") })
        }
        switch (role) {
          case "system":
            request.system.push(...blocks)
            break
          case "developer":
            request.developer.push(...blocks)
            break
          case "tool":
            request.messages.push({ role: "user", blocks: [{ kind: "tool_result", callId: stringAt(record, "tool_call_id"), result: record.content }] })
            break
          case "user":
          case "assistant":
            request.messages.push({ role, blocks })
            break
          default:
            throw new Error(`messages[${i}] has unsupported role "${role}"`)
        }
      }
      const tools = sliceAt(input, "tools") ?? []
      for (let i = 0; i < tools.length; i++) {
        const tool = tools[i]
        if (!tool || typeof tool !== "object" || Array.isArray(tool) || stringAt(tool, "type") !== "function")
          throw new Error(`tools[${i}] must be a function tool`)
        const fn = mapAt(tool, "function") ?? {}
        request.tools.push({
          name: stringAt(fn, "name"),
          description: stringAt(fn, "description"),
          schema: fn.parameters,
          strict: boolAt(fn, "strict"),
        })
      }
      request.toolChoice = decodeChatToolChoice(input.tool_choice)
      request.responseFormat = input.response_format
      request.parallelToolCalls = input.parallel_tool_calls
      request.frequencyPenalty = input.frequency_penalty
      request.presencePenalty = input.presence_penalty
      request.seed = input.seed
      request.promptCacheKey = input.prompt_cache_key
      request.safetyIdentifier = input.safety_identifier
      request.serviceTier = input.service_tier
      request.store = input.store
      break
    }

    case RESPONSES: {
      request.maxTokens = input.max_output_tokens
      request.stop = input.stop
      request.reasoning = firstAny(input.reasoning, input.reasoning_effort)
      request.system.push(...decodeOpenAIBlocksChecked(input.instructions))
      const value = input.input
      if (typeof value === "string") {
        request.messages.push({ role: "user", blocks: [{ kind: "text", text: value }] })
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i]
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`input[${i}] must be an object`)
          const record = item as Record<string, Json>
          switch (stringAt(record, "type")) {
            case "reasoning":
              for (const block of decodeResponsesReasoning(record)) appendBridgeBlock(request.messages, "assistant", block)
              break
            case "function_call":
              appendBridgeBlock(request.messages, "assistant", {
                kind: "tool_call",
                id: firstString(stringAt(record, "call_id"), stringAt(record, "id")),
                name: stringAt(record, "name"),
                argumentsJson: stringAt(record, "arguments"),
              })
              break
            case "function_call_output":
              appendBridgeBlock(request.messages, "user", { kind: "tool_result", callId: stringAt(record, "call_id"), result: record.output })
              break
            case "message":
            case "": {
              const role = stringAt(record, "role")
              const blocks = decodeOpenAIBlocksChecked(record.content)
              if (role === "system") request.system.push(...blocks)
              else if (role === "developer") request.developer.push(...blocks)
              else if (role === "user" || role === "assistant") request.messages.push({ role, blocks })
              break
            }
            default:
              throw new Error(`input[${i}] has unsupported Responses item type "${stringAt(record, "type")}"`)
          }
        }
      } else {
        throw new Error("input must be a string or array")
      }
      const tools = sliceAt(input, "tools") ?? []
      for (let i = 0; i < tools.length; i++) {
        const tool = tools[i]
        if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error(`tools[${i}] must be an object`)
        const record = tool as Record<string, Json>
        // Built-in Responses tools have no Chat/Anthropic equivalent: skip them.
        if (stringAt(record, "type") !== "function") continue
        request.tools.push({
          name: stringAt(record, "name"),
          description: stringAt(record, "description"),
          schema: record.parameters,
          strict: boolAt(record, "strict"),
        })
      }
      request.toolChoice = decodeResponsesToolChoice(input.tool_choice)
      request.responseFormat = mapAt(input, "text", "format")
      request.parallelToolCalls = input.parallel_tool_calls
      request.promptCacheKey = input.prompt_cache_key
      request.safetyIdentifier = input.safety_identifier
      request.serviceTier = input.service_tier
      request.store = input.store
      break
    }

    case ANTHROPIC: {
      request.maxTokens = input.max_tokens
      request.stop = input.stop_sequences
      request.reasoning = anthropicReasoning(input)
      request.system = decodeAnthropicBlocksChecked(input.system)
      const messages = sliceAt(input, "messages") ?? []
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i]
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error(`messages[${i}] must be an object`)
        const record = message as Record<string, Json>
        const role = stringAt(record, "role")
        if (role === "system" || role === "developer") {
          const blocks = decodeAnthropicBlocksChecked(record.content)
          if (role === "system") request.system.push(...blocks)
          else request.developer.push(...blocks)
          continue
        }
        if (role !== "user" && role !== "assistant") throw new Error(`messages[${i}] has unsupported role "${role}"`)
        request.messages.push({ role, blocks: decodeAnthropicBlocksChecked(record.content) })
      }
      const tools = sliceAt(input, "tools") ?? []
      for (let i = 0; i < tools.length; i++) {
        const tool = tools[i]
        if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error(`tools[${i}] must be an object`)
        const record = tool as Record<string, Json>
        request.tools.push({
          name: stringAt(record, "name"),
          description: stringAt(record, "description"),
          schema: record.input_schema,
          strict: false,
        })
      }
      request.toolChoice = decodeAnthropicToolChoice(input.tool_choice)
      break
    }

    default:
      throw new Error(`unsupported input protocol "${protocol}"`)
  }

  for (let i = 0; i < request.messages.length; i++) {
    for (let j = 0; j < request.messages[i].blocks.length; j++) {
      const block = request.messages[i].blocks[j]
      if (block.kind !== "tool_result" || protocol === CHAT) continue
      const result = decodeToolImages(protocol, block.result)
      if (Array.isArray(result) && !block.callId) throw new Error(`messages[${i}]: tool image result requires a call ID`)
      block.result = result
    }
  }
  return request
}

// ---------------------------------------------------------------------------
// request encoding

function validateBridgeRequest(protocol: Protocol, request: BridgeRequest): void {
  if (protocol === RESPONSES) {
    for (const block of request.system) {
      if (block.kind === "file") throw new Error("file content is not valid inside Responses instructions; send it as a message input item")
    }
  }
  const blocks = [...request.system, ...request.developer]
  for (const message of request.messages) blocks.push(...message.blocks)
  for (const block of blocks) {
    if (block.kind === "file" && protocol === ANTHROPIC && block.fileId && !block.data && !block.url)
      throw new Error(`file "${block.fileId}" cannot be represented by Anthropic Messages without file data or a URL`)
  }
}

export function encodeChatRequest(request: BridgeRequest): Record<string, Json> {
  const output: Record<string, Json> = { model: request.model, stream: request.stream }
  put(output, "temperature", request.temperature)
  put(output, "top_p", request.topP)
  put(output, "max_tokens", request.maxTokens)
  put(output, "stop", request.stop)
  const effort = reasoningEffort(request.reasoning)
  if (effort !== undefined && effort !== null) output.reasoning_effort = effort
  const format = chatResponseFormat(request.responseFormat)
  if (format !== undefined) output.response_format = format
  put(output, "parallel_tool_calls", request.parallelToolCalls)
  put(output, "frequency_penalty", request.frequencyPenalty)
  put(output, "presence_penalty", request.presencePenalty)
  put(output, "seed", request.seed)
  put(output, "prompt_cache_key", request.promptCacheKey)
  put(output, "safety_identifier", request.safetyIdentifier)
  put(output, "service_tier", request.serviceTier)
  put(output, "store", request.store)
  if (request.stream) output.stream_options = { include_usage: true }

  const messages: Json[] = []
  if (request.system.length) messages.push({ role: "system", content: encodeChatBlocks(request.system) })
  if (request.developer.length) messages.push({ role: "developer", content: encodeChatBlocks(request.developer) })

  const pending = new Set<string>()
  const pendingResults = new Map<string, BridgeBlock>()
  let pendingOrder: string[] = []
  let deferred: BridgeBlock[][] = []
  let budgetCarried = false

  const carryBudget = (encoded: Record<string, Json>): void => {
    if (budgetCarried) return
    const budget = reasoningBudget(request.reasoning)
    if (budget > 0) {
      encoded.reasoning_budget_tokens = budget
      budgetCarried = true
    }
  }
  const flushDeferred = (): void => {
    for (const blocks of deferred) {
      if (blocks.length) messages.push({ role: "user", content: encodeChatBlocks(blocks) })
    }
    deferred = []
  }
  const carryBudgetOnly = (): void => {
    if (budgetCarried) return
    if (reasoningBudget(request.reasoning) <= 0) return
    const encoded: Record<string, Json> = { role: "assistant", content: null }
    carryBudget(encoded)
    if (encoded.reasoning_budget_tokens === undefined) return
    messages.push(encoded)
  }

  for (let i = 0; i < request.messages.length; i++) {
    const message = request.messages[i]
    const content: BridgeBlock[] = []
    const reasoning: BridgeBlock[] = []
    const calls: BridgeBlock[] = []
    const results: BridgeBlock[] = []
    for (const block of message.blocks) {
      if (block.kind === "reasoning") reasoning.push(block)
      else if (block.kind === "tool_call") calls.push(block)
      else if (block.kind === "tool_result") results.push(block)
      else content.push(block)
    }

    if (message.role === "assistant") {
      if (pending.size > 0) throw new Error(`messages[${i}]: assistant message appears before tool results for ${missingToolIds(pendingOrder, pending).join(", ")}`)
      if (results.length) throw new Error(`messages[${i}]: assistant message contains tool results`)
      const encoded: Record<string, Json> = { role: "assistant", content: null }
      carryBudget(encoded)
      const reasoningText = bridgeReasoningText(reasoning)
      if (reasoningText.ok) encoded.reasoning_content = reasoningText.text
      if (content.length) encoded.content = encodeChatBlocks(content)
      if (calls.length) {
        const toolCalls: Json[] = []
        for (const call of calls) {
          if (!call.id || !call.name) throw new Error(`messages[${i}]: tool call must contain id and name`)
          if (pending.has(call.id)) throw new Error(`messages[${i}]: duplicate tool call id "${call.id}"`)
          pending.add(call.id)
          pendingOrder.push(call.id)
          toolCalls.push({ id: call.id, type: "function", function: { name: call.name, arguments: bridgeArgumentsJson(call) } })
        }
        encoded.tool_calls = toolCalls
      }
      if (content.length || reasoning.length || calls.length) {
        messages.push(encoded)
        budgetCarried = true
      }
      continue
    }

    if (calls.length) throw new Error(`messages[${i}]: user message contains tool calls`)
    for (const result of results) {
      const callId = result.callId ?? ""
      if (pendingResults.has(callId)) throw new Error(`messages[${i}]: duplicate tool result "${callId}"`)
      if (!pending.has(callId)) throw new Error(`messages[${i}]: tool result "${callId}" has no pending tool call`)
      pendingResults.set(callId, result)
      pending.delete(callId)
    }
    if (content.length) {
      if (pendingOrder.length || deferred.length) deferred.push(content)
      else messages.push({ role: "user", content: encodeChatBlocks(content) })
    }
    if (pending.size === 0 && pendingOrder.length) {
      const attachments: Json[] = []
      for (const id of pendingOrder) {
        const result = pendingResults.get(id)!
        const { text, images } = chatToolImages(result)
        if (images.length) attachments.push({ role: "user", content: encodeChatBlocks(images) })
        messages.push({ role: "tool", tool_call_id: id, content: text })
      }
      messages.push(...attachments)
      flushDeferred()
      pendingOrder = []
      pendingResults.clear()
    }
  }
  if (pending.size) throw new Error(`tool calls are missing results for ${missingToolIds(pendingOrder, pending).join(", ")}`)
  flushDeferred()
  carryBudgetOnly()
  output.messages = messages

  if (request.tools.length) {
    const tools: Json[] = request.tools.map((tool) => {
      const fn: Record<string, Json> = { name: tool.name, description: tool.description, parameters: schemaOrDefault(tool.schema) }
      if (tool.strict) fn.strict = true
      return { type: "function", function: fn }
    })
    output.tools = tools
    const choice = encodeChatToolChoice(request.toolChoice)
    if (choice !== undefined) output.tool_choice = choice
  }
  return output
}

function missingToolIds(order: string[], pending: Set<string>): string[] {
  const missing = order.filter((id) => pending.has(id))
  if (missing.length === pending.size) return missing
  for (const id of pending) if (!missing.includes(id)) missing.push(id)
  return missing.sort()
}

const MIN_RESPONSES_MAX_OUTPUT_TOKENS = 16

export function floorResponsesMaxTokens(value: Json): Json {
  if (typeof value === "number" && value > 0 && value < MIN_RESPONSES_MAX_OUTPUT_TOKENS) return MIN_RESPONSES_MAX_OUTPUT_TOKENS
  return value
}

function responsesReasoning(value: Json): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, Json>
    if (stringAt(object, "type") === "disabled") return undefined
    const effort = reasoningEffort(object)
    if (effort !== undefined && effort !== null) {
      if (typeof effort === "string") return { effort }
      if (typeof effort === "object") return effort
      return { effort }
    }
    return object
  }
  if (typeof value === "string") {
    const normalized = normalizeEffortValue(value)
    if (normalized.stated) {
      if (normalized.effort === undefined) return undefined
      return { effort: normalized.effort }
    }
    return { effort: value }
  }
  return value
}

export function encodeResponsesRequest(request: BridgeRequest): Record<string, Json> {
  const output: Record<string, Json> = { model: request.model, stream: request.stream }
  put(output, "temperature", request.temperature)
  put(output, "top_p", request.topP)
  put(output, "max_output_tokens", floorResponsesMaxTokens(request.maxTokens))
  put(output, "stop", request.stop)
  put(output, "metadata", request.metadata)
  if (request.system.length) output.instructions = bridgeBlocksText(request.system)
  if (request.reasoning !== undefined && request.reasoning !== null) {
    const reasoning = responsesReasoning(request.reasoning)
    if (reasoning !== undefined && reasoning !== null) output.reasoning = reasoning
  }
  const format = responsesTextFormat(request.responseFormat)
  if (format !== undefined) output.text = { format }
  put(output, "parallel_tool_calls", request.parallelToolCalls)
  put(output, "prompt_cache_key", request.promptCacheKey)
  put(output, "safety_identifier", request.safetyIdentifier)
  put(output, "service_tier", request.serviceTier)
  put(output, "store", request.store)

  const items: Json[] = []
  if (request.developer.length) {
    items.push({ type: "message", role: "developer", content: [{ type: "input_text", text: bridgeBlocksText(request.developer) }] })
  }
  for (const message of request.messages) {
    let content: Json[] = []
    const flush = (): void => {
      if (!content.length) return
      items.push({ type: "message", role: message.role === "assistant" ? "assistant" : "user", content })
      content = []
    }
    for (const block of message.blocks) {
      switch (block.kind) {
        case "reasoning": {
          flush()
          const item = encodeResponsesReasoningInput(block)
          if (item) items.push(item)
          break
        }
        case "text":
          content.push({ type: message.role === "assistant" ? "output_text" : "input_text", text: block.text })
          break
        case "image": {
          const url = block.url || (block.data ? `data:${block.mediaType};base64,${block.data}` : "")
          content.push({ type: "input_image", image_url: url })
          break
        }
        case "file": {
          const item: Record<string, Json> = { type: "input_file" }
          put(item, "file_id", block.fileId)
          put(item, "file_data", block.data)
          put(item, "filename", block.filename)
          content.push(item)
          break
        }
        case "tool_call":
          flush()
          items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: bridgeArgumentsJson(block) })
          break
        case "tool_result":
          flush()
          items.push({ type: "function_call_output", call_id: block.callId, output: responsesToolContent(block.result) })
          break
      }
    }
    flush()
  }
  output.input = items
  if (request.tools.length) {
    output.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: schemaOrDefault(tool.schema),
      strict: tool.strict,
    }))
    const choice = encodeResponsesToolChoice(request.toolChoice)
    if (choice !== undefined) output.tool_choice = choice
  }
  return output
}

export function encodeAnthropicRequest(request: BridgeRequest): Record<string, Json> {
  const output: Record<string, Json> = { model: request.model, stream: request.stream }
  put(output, "temperature", request.temperature)
  put(output, "top_p", request.topP)
  put(output, "stop_sequences", request.stop)
  output.max_tokens = request.maxTokens === undefined || request.maxTokens === null ? 4096 : request.maxTokens
  const { thinking, outputConfig } = anthropicThinking(request.reasoning)
  if (thinking !== undefined && thinking !== null) {
    output.thinking = thinking
    if (outputConfig !== undefined) output.output_config = outputConfig
  }
  if (request.system.length || request.developer.length) {
    output.system = encodeAnthropicBlocks([...request.system, ...request.developer])
  }

  const messages: Json[] = []
  for (const message of request.messages) {
    const content = encodeAnthropicBlocks(message.blocks)
    if (!content.length) continue
    const role = message.role === "assistant" ? "assistant" : "user"
    const last = messages[messages.length - 1] as Record<string, Json> | undefined
    if (last && stringAt(last, "role") === role) {
      last.content = [...(last.content as Json[]), ...content]
      continue
    }
    messages.push({ role, content })
  }
  output.messages = messages

  // Anthropic has no tool_choice "none": omitting the tools is the way to say it.
  if (request.tools.length && request.toolChoice.mode !== "none") {
    output.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: schemaOrDefault(tool.schema),
    }))
    const choice = encodeAnthropicToolChoice(request.toolChoice)
    if (choice !== undefined) output.tool_choice = choice
  }
  return output
}

export function bridgeBlocksText(blocks: BridgeBlock[]): string {
  let text = ""
  for (const block of blocks) if (block.kind === "text") text += block.text ?? ""
  return text
}

// ---------------------------------------------------------------------------
// public request API

export function convertRequest(from: Protocol, to: Protocol, input: Record<string, Json>): Record<string, Json> {
  if (from === to) return cloneMap(input)
  const request = decodeBridgeRequest(from, input)
  validateBridgeRequest(to, request)
  switch (to) {
    case CHAT:
      return encodeChatRequest(request)
    case RESPONSES:
      return encodeResponsesRequest(request)
    case ANTHROPIC:
      return encodeAnthropicRequest(request)
    default:
      throw new Error(`unsupported output protocol "${to}"`)
  }
}

export function prepareRequest(from: Protocol, to: Protocol, input: Record<string, Json>, upstreamUrl: string): Record<string, Json> {
  const output = convertRequest(from, to, input)
  if (to === RESPONSES) output.max_output_tokens = floorResponsesMaxTokens(output.max_output_tokens)
  normalizeToolReasoningHistory(to, stringAt(output, "model"), upstreamUrl, output)
  return output
}

/** forcedEffort applies an operator-configured thinking level to a prepared body. */
export function forcedEffort(protocol: Protocol, body: Record<string, Json>, effort: string): void {
  const level = effort.trim().toLowerCase()
  if (!["minimal", "low", "medium", "high", "xhigh", "max", "none"].includes(level)) return
  const disable = level === "none"
  if (clientEffortExplicit(protocol, body)) return
  switch (protocol) {
    case CHAT:
      if (disable) delete body.reasoning_effort
      else body.reasoning_effort = level
      break
    case ANTHROPIC:
      if (disable) {
        delete body.thinking
        delete body.output_config
        break
      }
      const outputConfig = (mapAt(body, "output_config") ?? {}) as Record<string, Json>
      outputConfig.effort = level
      body.output_config = outputConfig
      const budget = budgetForEffort(level)
      const thinking = (mapAt(body, "thinking") ?? {}) as Record<string, Json>
      thinking.type = "enabled"
      thinking.budget_tokens = budget
      body.thinking = thinking
      const current = intAt(body, "max_tokens")
      if (current > 0 && current <= budget) body.max_tokens = budget + 4096
      break
    case RESPONSES:
      if (disable) {
        delete body.reasoning
        break
      }
      const reasoning = (mapAt(body, "reasoning") ?? {}) as Record<string, Json>
      reasoning.effort = level
      body.reasoning = reasoning
      break
  }
}

function clientEffortExplicit(protocol: Protocol, body: Record<string, Json>): boolean {
  switch (protocol) {
    case CHAT:
      return typeof body.reasoning_effort === "string" && body.reasoning_effort.trim() !== ""
    case ANTHROPIC: {
      const effort = anyAt(body, "output_config", "effort")
      if (typeof effort === "string" && effort.trim() !== "") return true
      return typeof body.effort === "string" && body.effort.trim() !== ""
    }
    case RESPONSES: {
      const effort = anyAt(body, "reasoning", "effort")
      return typeof effort === "string" && effort.trim() !== ""
    }
    default:
      return false
  }
}

function isReasoningVendorIdentifier(value: string): boolean {
  const lowered = value.toLowerCase()
  return REASONING_VENDOR_HINTS.some((hint) => lowered.includes(hint))
}

function requestEnablesReasoning(input: Record<string, Json>): boolean {
  for (const key of ["reasoning_effort", "reasoning", "thinking", "effort"]) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (typeof value === "string") {
      const mode = value.trim().toLowerCase()
      if (mode !== "" && mode !== "none" && mode !== "disabled") return true
    } else if (typeof value === "boolean") {
      if (value) return true
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const mode = firstString(stringAt(value, "type"), stringAt(value, "effort")).trim().toLowerCase()
      if (mode === "none" || mode === "disabled") continue
      return true
    } else return true
  }
  return false
}

export function normalizeToolReasoningHistory(protocol: Protocol, model: string, upstreamUrl: string, input: Record<string, Json>): boolean {
  const vendor = isReasoningVendorIdentifier(model) || isReasoningVendorIdentifier(upstreamUrl)
  switch (protocol) {
    case CHAT:
      if (!vendor && !requestEnablesReasoning(input)) return false
      return normalizeChatToolReasoningHistory(input)
    case ANTHROPIC:
      if (!vendor) return false
      return normalizeAnthropicToolThinkingHistory(input)
    default:
      return false
  }
}

function normalizeChatToolReasoningHistory(input: Record<string, Json>): boolean {
  const messages = sliceAt(input, "messages")
  if (!messages) return false
  let changed = false
  for (const raw of messages) {
    const message = raw as Record<string, Json>
    if (!message || typeof message !== "object" || Array.isArray(message)) continue
    if (stringAt(message, "role") !== "assistant") continue
    if (!(sliceAt(message, "tool_calls") ?? []).length) continue
    if (typeof message.reasoning_content === "string" && message.reasoning_content.trim() !== "") continue
    let reasoning = typeof message.reasoning === "string" ? message.reasoning : ""
    if (reasoning.trim() === "") reasoning = TOOL_REASONING_PLACEHOLDER
    message.reasoning_content = reasoning
    changed = true
  }
  return changed
}

function normalizeAnthropicToolThinkingHistory(input: Record<string, Json>): boolean {
  const messages = sliceAt(input, "messages")
  if (!messages) return false
  let changed = false
  for (const raw of messages) {
    const message = raw as Record<string, Json>
    if (!message || typeof message !== "object" || Array.isArray(message)) continue
    if (stringAt(message, "role") !== "assistant") continue
    const content = sliceAt(message, "content")
    if (!content || !content.some((block) => stringAt(block, "type") === "tool_use")) continue
    let hasThinking = false
    for (let i = 0; i < content.length; i++) {
      const block = content[i] as Record<string, Json>
      switch (stringAt(block, "type")) {
        case "thinking":
          hasThinking = true
          if ("signature" in block) {
            delete block.signature
            changed = true
          }
          if (typeof block.thinking !== "string" || block.thinking.trim() === "") {
            block.thinking = TOOL_REASONING_PLACEHOLDER
            changed = true
          }
          break
        case "redacted_thinking":
          hasThinking = true
          content[i] = { type: "thinking", thinking: ANTHROPIC_REDACTED_THINKING_PLACEHOLDER }
          changed = true
          break
      }
    }
    if (!hasThinking) {
      content.unshift({ type: "thinking", thinking: TOOL_REASONING_PLACEHOLDER })
      message.content = content
      changed = true
    }
  }
  return changed
}

export { asPrefix }
