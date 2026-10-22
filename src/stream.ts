// SSE streaming: parsing upstream events, encoding them for another
// protocol, forwarding them unchanged, and collapsing them into one document.

import {
  ANTHROPIC,
  CHAT,
  RESPONSES,
  type BridgeBlock,
  type Json,
  type Protocol,
  type Usage,
  asPrefix,
  firstString,
  intAt,
  mapAt,
  sliceAt,
  stringAt,
} from "./protocol.ts"
import {
  anthropicStop,
  anthropicUsage,
  canonicalResponsesIncomplete,
  chatStop,
  decodeAnthropicUsage,
  decodeOpenAIUsage,
  encodeBridgeResponse,
  openAIUsage,
} from "./response.ts"

export class StreamUpstreamFailure extends Error {}
export class StreamNormalTermination extends Error {}
export class UnexpectedEOF extends Error {}

export interface BridgeStreamEvent {
  kind:
    | "start"
    | "text"
    | "reasoning"
    | "reasoning_signature"
    | "tool_start"
    | "tool_delta"
    | "usage"
    | "finish"
    | "error"
    | "done"
  responseId?: string
  model?: string
  text?: string
  signature?: string
  toolKey?: string
  toolId?: string
  toolName?: string
  stop?: string
  error?: string
  errorType?: string
  encrypted?: string
  usage?: Usage
}

function randomId(prefix: string, length = 12): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 2 + length)}`
}

export function mergeUsage(destination: Usage, source: Usage): void {
  if (source.input) destination.input = source.input
  if (source.output) destination.output = source.output
  if (source.total) destination.total = Math.max(destination.total, source.total)
  if (source.cached) destination.cached = source.cached
  if (source.cacheCreation) destination.cacheCreation = source.cacheCreation
  if (source.reasoning) destination.reasoning = source.reasoning
  destination.total = Math.max(destination.total, destination.input + destination.output)
}

// ---------------------------------------------------------------------------
// SSE reading

export interface SSERecord {
  event: string
  data: string
}

/** readSSE yields one record per complete SSE event. */
export async function* readSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSERecord> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  let event = ""
  let dataLines: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith("\r")) line = line.slice(0, -1)
        if (line === "") {
          if (dataLines.length) {
            yield { event, data: dataLines.join("\n") }
          }
          event = ""
          dataLines = []
          continue
        }
        if (line.startsWith(":")) continue
        if (line.startsWith("event:")) {
          event = line.slice(6).trim()
          continue
        }
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
      }
    }
    buffer += decoder.decode()
    if (buffer.length) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length) throw new UnexpectedEOF("unexpected end of SSE stream")
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// parser

function mergeToolName(current: string, fragment: string): string {
  if (current === "" || fragment === current) return fragment
  if (fragment.startsWith(current)) return fragment
  return current + fragment
}

function isStreamErrorFinish(stop: string): boolean {
  const value = stop.trim().toLowerCase()
  return value === "error" || value === "network_error" || value === "server_error"
}

function streamErrorMessage(value: Record<string, Json>, fallback: string): string {
  const nested = stringAt(value, "error", "message")
  if (nested) return nested
  const top = stringAt(value, "message")
  if (top) return top
  if (typeof value.error === "string" && value.error) return value.error
  return fallback
}

function streamErrorType(value: Record<string, Json>): string {
  return firstString(stringAt(value, "error", "type"), stringAt(value, "error", "code"), "upstream_error")
}

function responseToolKey(event: Record<string, Json>, item?: Record<string, Json>): string {
  if (item) {
    const id = stringAt(item, "id")
    if (id) return id
  }
  const itemId = stringAt(event, "item_id")
  if (itemId) return itemId
  return String(event.output_index)
}

export class BridgeStreamParser {
  private protocol: Protocol
  private started = false
  private tools = new Map<string, boolean>()
  private toolIds = new Map<string, string>()
  private toolNames = new Map<string, string>()
  private toolOrder: string[] = []
  private responseArgs = new Set<string>()
  private responseReasoning = new Set<string>()

  constructor(protocol: Protocol) {
    this.protocol = protocol
  }

  parse(eventName: string, data: string): BridgeStreamEvent[] {
    if (data === "[DONE]") {
      if (this.protocol !== CHAT) throw new Error(`unexpected [DONE] terminator for ${this.protocol} stream`)
      return [{ kind: "done" }]
    }
    let value: Record<string, Json>
    try {
      value = JSON.parse(data)
    } catch (error) {
      throw new Error(`invalid upstream SSE JSON: ${(error as Error).message}`)
    }
    switch (this.protocol) {
      case CHAT:
        return this.parseChatEvent(eventName, value)
      case ANTHROPIC:
        return this.parseAnthropicEvent(eventName, value)
      case RESPONSES:
        return this.parseResponses(eventName, value)
      default:
        throw new Error(`unsupported stream protocol "${this.protocol}"`)
    }
  }

  private parseChatEvent(eventName: string, value: Record<string, Json>): BridgeStreamEvent[] {
    const events: BridgeStreamEvent[] = []
    if (eventName === "error" || (value.error !== undefined && value.error !== null)) {
      return [{ kind: "error", error: streamErrorMessage(value, "upstream Chat stream error"), errorType: streamErrorType(value) }]
    }
    if (!this.started) {
      const id = stringAt(value, "id")
      if (id) {
        this.started = true
        events.push({ kind: "start", responseId: id, model: stringAt(value, "model") })
      }
    }
    const usageMap = mapAt(value, "usage")
    if (usageMap && Object.keys(usageMap).length) {
      events.push({ kind: "usage", usage: decodeOpenAIUsage(usageMap) })
    }
    for (const raw of sliceAt(value, "choices") ?? []) {
      const choice = raw as Record<string, Json>
      const delta = mapAt(choice, "delta") ?? {}
      const reasoning = firstString(stringAt(delta, "reasoning_content"), stringAt(delta, "reasoning"))
      if (reasoning) events.push({ kind: "reasoning", text: reasoning })
      const text = stringAt(delta, "content")
      if (text) events.push({ kind: "text", text })
      for (const rawCall of sliceAt(delta, "tool_calls") ?? []) {
        const call = rawCall as Record<string, Json>
        const key = String(call.index !== undefined && call.index !== null ? call.index : stringAt(call, "id"))
        const fn = mapAt(call, "function") ?? {}
        const id = stringAt(call, "id")
        if (!this.tools.has(key)) {
          this.tools.set(key, false)
          this.toolOrder.push(key)
        }
        if (id) this.toolIds.set(key, id)
        const name = stringAt(fn, "name")
        if (name) this.toolNames.set(key, mergeToolName(this.toolNames.get(key) ?? "", name))
        const args = stringAt(fn, "arguments")
        if (args) {
          if (!this.tools.get(key) && this.toolNames.get(key)) {
            this.tools.set(key, true)
            events.push({ kind: "tool_start", toolKey: key, toolId: this.toolIds.get(key), toolName: this.toolNames.get(key) })
          }
          events.push({ kind: "tool_delta", toolKey: key, toolId: this.toolIds.get(key), toolName: this.toolNames.get(key), text: args })
        }
      }
      const stop = stringAt(choice, "finish_reason")
      if (stop) {
        if (isStreamErrorFinish(stop)) {
          events.push({ kind: "error", error: firstString(stringAt(choice, "error", "message"), "upstream Chat stream failed"), errorType: "upstream_error" })
          continue
        }
        for (const key of this.toolOrder) {
          if (!this.tools.get(key) && this.toolNames.get(key)) {
            this.tools.set(key, true)
            events.push({ kind: "tool_start", toolKey: key, toolId: this.toolIds.get(key), toolName: this.toolNames.get(key) })
          }
        }
        events.push({ kind: "finish", stop })
      }
    }
    return events
  }

  private parseAnthropicEvent(eventName: string, value: Record<string, Json>): BridgeStreamEvent[] {
    let typeName = stringAt(value, "type")
    if (typeName === "") typeName = eventName
    switch (typeName) {
      case "message_start": {
        const message = mapAt(value, "message") ?? {}
        const events: BridgeStreamEvent[] = [{ kind: "start", responseId: stringAt(message, "id"), model: stringAt(message, "model") }]
        const usageMap = mapAt(message, "usage")
        if (usageMap && Object.keys(usageMap).length) events.push({ kind: "usage", usage: decodeAnthropicUsage(usageMap) })
        return events
      }
      case "content_block_start": {
        const block = mapAt(value, "content_block") ?? {}
        const key = String(value.index)
        switch (stringAt(block, "type")) {
          case "thinking": {
            const events: BridgeStreamEvent[] = []
            const thinking = stringAt(block, "thinking")
            if (thinking) events.push({ kind: "reasoning", text: thinking })
            const signature = stringAt(block, "signature")
            if (signature) events.push({ kind: "reasoning_signature", signature })
            return events
          }
          case "redacted_thinking":
            return [{ kind: "reasoning", encrypted: stringAt(block, "data") }]
          case "tool_use":
            this.tools.set(key, true)
            return [{ kind: "tool_start", toolKey: key, toolId: stringAt(block, "id"), toolName: stringAt(block, "name") }]
          case "text": {
            const text = stringAt(block, "text")
            if (text) return [{ kind: "text", text }]
            return []
          }
        }
        return []
      }
      case "content_block_delta": {
        const delta = mapAt(value, "delta") ?? {}
        const key = String(value.index)
        switch (stringAt(delta, "type")) {
          case "thinking_delta":
            return [{ kind: "reasoning", text: stringAt(delta, "thinking") }]
          case "signature_delta":
            return [{ kind: "reasoning_signature", signature: stringAt(delta, "signature") }]
          case "text_delta":
            return [{ kind: "text", text: stringAt(delta, "text") }]
          case "input_json_delta":
            return [{ kind: "tool_delta", toolKey: key, text: stringAt(delta, "partial_json") }]
        }
        return []
      }
      case "message_delta": {
        const events: BridgeStreamEvent[] = []
        const usageMap = mapAt(value, "usage")
        if (usageMap && Object.keys(usageMap).length) events.push({ kind: "usage", usage: decodeAnthropicUsage(usageMap) })
        const stop = stringAt(value, "delta", "stop_reason")
        if (stop) {
          if (isStreamErrorFinish(stop)) {
            events.push({ kind: "error", error: "upstream Anthropic stream failed", errorType: "upstream_error" })
            return events
          }
          events.push({ kind: "finish", stop })
        }
        return events
      }
      case "message_stop":
        return [{ kind: "done" }]
      case "error":
        return [
          {
            kind: "error",
            error: firstString(stringAt(value, "error", "message"), "upstream Anthropic stream error"),
            errorType: firstString(stringAt(value, "error", "type"), "upstream_error"),
          },
        ]
    }
    return []
  }

  private parseResponses(eventName: string, value: Record<string, Json>): BridgeStreamEvent[] {
    let typeName = stringAt(value, "type")
    if (typeName === "") typeName = eventName
    switch (typeName) {
      case "error":
        return [{ kind: "error", error: streamErrorMessage(value, "upstream Responses stream error"), errorType: streamErrorType(value) }]
      case "response.created": {
        const response = mapAt(value, "response") ?? {}
        return [{ kind: "start", responseId: stringAt(response, "id"), model: stringAt(response, "model") }]
      }
      case "response.output_text.delta":
        return [{ kind: "text", text: stringAt(value, "delta") }]
      case "response.reasoning_summary_text.delta": {
        const key = responseToolKey(value)
        this.responseReasoning.add(key)
        return [{ kind: "reasoning", text: stringAt(value, "delta") }]
      }
      case "response.output_item.added": {
        const item = mapAt(value, "item") ?? {}
        if (stringAt(item, "type") === "function_call") {
          const key = responseToolKey(value, item)
          this.rememberTool(key, stringAt(item, "call_id"), stringAt(item, "name"))
          if (this.toolNames.get(key)) {
            this.tools.set(key, true)
            return [{ kind: "tool_start", toolKey: key, toolId: this.toolIds.get(key), toolName: this.toolNames.get(key) }]
          }
        }
        return []
      }
      case "response.function_call_arguments.delta": {
        const key = responseToolKey(value)
        this.responseArgs.add(key)
        return [{ kind: "tool_delta", toolKey: key, toolId: this.toolIds.get(key), toolName: this.toolNames.get(key), text: stringAt(value, "delta") }]
      }
      case "response.function_call_arguments.done": {
        const key = responseToolKey(value)
        if (!this.responseArgs.has(key)) {
          this.responseArgs.add(key)
          return [{ kind: "tool_delta", toolKey: key, toolId: this.toolIds.get(key), toolName: this.toolNames.get(key), text: stringAt(value, "arguments") }]
        }
        return []
      }
      case "response.output_item.done": {
        const item = mapAt(value, "item") ?? {}
        if (stringAt(item, "type") === "reasoning") {
          const key = responseToolKey(value, item)
          if (this.responseReasoning.has(key)) return []
          let text = ""
          for (const part of (item.summary as Json[] | undefined) ?? []) text += stringAt(part, "text")
          if (item.content !== undefined && item.content !== null) {
            for (const part of (item.content as Json[] | undefined) ?? []) text += stringAt(part, "text")
          }
          const encrypted = stringAt(item, "encrypted_content")
          if (text !== "" || encrypted !== "") return [{ kind: "reasoning", text, encrypted }]
          return []
        }
        if (stringAt(item, "type") === "function_call") {
          const key = responseToolKey(value, item)
          this.rememberTool(key, stringAt(item, "call_id"), stringAt(item, "name"))
          const events: BridgeStreamEvent[] = []
          if (!this.tools.get(key)) {
            this.tools.set(key, true)
            events.push({ kind: "tool_start", toolKey: key, toolId: this.toolIds.get(key), toolName: this.toolNames.get(key) })
          }
          if (!this.responseArgs.has(key)) {
            const args = stringAt(item, "arguments")
            if (args) events.push({ kind: "tool_delta", toolKey: key, text: args })
          }
          return events
        }
        return []
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
      case "response.done": {
        const response = mapAt(value, "response") ?? {}
        const usageMap = mapAt(response, "usage")
        if (typeName === "response.failed" || stringAt(response, "status") === "failed") {
          const message = firstString(stringAt(response, "error", "message"), stringAt(value, "error", "message"), "upstream Responses request failed")
          const events: BridgeStreamEvent[] = [
            { kind: "error", error: message, errorType: firstString(stringAt(response, "error", "code"), "upstream_error") },
          ]
          if (usageMap && Object.keys(usageMap).length) events.unshift({ kind: "usage", usage: decodeOpenAIUsage(usageMap) })
          return events
        }
        let stop = "stop"
        if (typeName === "response.incomplete") stop = canonicalResponsesIncomplete(stringAt(response, "incomplete_details", "reason"))
        else stop = this.responsesCompletedStop(response)
        const events: BridgeStreamEvent[] = []
        if (usageMap && Object.keys(usageMap).length) events.push({ kind: "usage", usage: decodeOpenAIUsage(usageMap) })
        events.push({ kind: "finish", stop }, { kind: "done" })
        return events
      }
    }
    return []
  }

  private responsesCompletedStop(response: Record<string, Json>): string {
    for (const raw of sliceAt(response, "output") ?? []) {
      if (stringAt(raw, "type") === "function_call") return "tool_calls"
    }
    if (this.toolOrder.length) return "tool_calls"
    return "stop"
  }

  private rememberTool(key: string, id: string, name: string): void {
    if (!this.tools.has(key)) {
      this.tools.set(key, false)
      this.toolOrder.push(key)
    }
    if (id) this.toolIds.set(key, id)
    if (name) this.toolNames.set(key, name)
  }
}

// ---------------------------------------------------------------------------
// emitter

interface StreamTool {
  key: string
  id: string
  itemId: string
  name: string
  arguments: string
  index: number
  anthropicIndex: number
  started: boolean
  emittedArguments: number
}

export type StreamWriter = (chunk: string) => void | Promise<void>

export class BridgeStreamEncoder {
  private write: StreamWriter
  private target: Protocol
  private model: string
  private id = ""
  private created = Math.floor(Date.now() / 1000)
  private started = false
  private done = false
  private stop = ""
  usage: Usage = { input: 0, output: 0, total: 0, cached: 0, cacheCreation: 0, reasoning: 0 }
  usageReported = false
  private reasoningEncrypted = ""
  private text = ""
  private reasoning = ""
  private reasoningSignature = ""
  private tools = new Map<string, StreamTool>()
  private order: string[] = []
  private sequence = 0
  private nextOutput = 0
  private textOpen = false
  private reasoningOpen = false
  private reasoningClosed = false
  private reasoningItemId = ""
  private reasoningOutput = 0
  private reasoningIndex = 0
  private textIndex = 0
  private nextAnthropic = 0
  private textItemId = ""
  private textOutput = 0

  constructor(write: StreamWriter, target: Protocol, model: string) {
    this.write = write
    this.target = target
    this.model = model
  }

  async emit(event: BridgeStreamEvent): Promise<void> {
    if (event.responseId && !this.id) this.id = event.responseId
    if (event.model) this.model = event.model
    if (!this.started && ["start", "reasoning", "reasoning_signature", "text", "tool_start", "tool_delta"].includes(event.kind)) {
      await this.start()
    }
    switch (event.kind) {
      case "reasoning": {
        let text = event.text ?? ""
        if (event.encrypted) {
          this.reasoningEncrypted = event.encrypted
          if (this.target !== RESPONSES && !text) text = "[redacted thinking]"
          if (this.target === RESPONSES && !text) {
            await this.startReasoning()
            return
          }
        }
        if (!text) return
        this.reasoning += text
        await this.emitReasoning(text)
        return
      }
      case "reasoning_signature":
        if (!event.signature) return
        this.reasoningSignature += event.signature
        await this.emitReasoningSignature(event.signature)
        return
      case "text":
        if (!event.text) return
        this.text += event.text
        await this.emitText(event.text)
        return
      case "tool_start":
      case "tool_delta": {
        const tool = this.tool(event.toolKey ?? "")
        if (event.toolId) tool.id = event.toolId
        if (event.toolName) tool.name = event.toolName
        if (event.kind === "tool_delta") tool.arguments += event.text ?? ""
        await this.startTool(tool)
        await this.emitPendingToolArguments(tool)
        return
      }
      case "usage":
        if (event.usage) {
          this.usageReported = true
          mergeUsage(this.usage, event.usage)
        }
        return
      case "finish":
        this.stop = event.stop ?? ""
        return
      case "error":
        this.done = true
        await this.emitError(firstString(event.error ?? "", "upstream stream failed"), firstString(event.errorType ?? "", "upstream_error"))
        throw new StreamUpstreamFailure("upstream stream failure delivered")
      case "done":
        await this.finish()
        return
    }
  }

  private async emitError(message: string, errorType: string): Promise<void> {
    switch (this.target) {
      case ANTHROPIC:
        await this.sse("error", { type: "error", error: { type: errorType, message } })
        return
      case RESPONSES: {
        const response = this.responsesBase("failed", [])
        ;(response as Record<string, Json>).error = { code: errorType, message }
        await this.sse("response.failed", { type: "response.failed", response, sequence_number: this.nextSequence() })
        return
      }
      default:
        await this.sse("", { error: { message, type: errorType, param: null, code: null } })
        await this.rawSSE("", "[DONE]")
    }
  }

  private tool(key: string): StreamTool {
    if (!key) key = `tool-${this.order.length}`
    const current = this.tools.get(key)
    if (current) return current
    const tool: StreamTool = {
      key,
      id: randomId("call"),
      itemId: randomId("fc"),
      name: "",
      arguments: "",
      index: this.order.length,
      anthropicIndex: 0,
      started: false,
      emittedArguments: 0,
    }
    this.tools.set(key, tool)
    this.order.push(key)
    return tool
  }

  private anyToolStarted(): boolean {
    return this.order.some((key) => this.tools.get(key)?.started)
  }

  private async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (!this.id) this.id = randomId("resp")
    switch (this.target) {
      case CHAT:
        await this.sse("", {
          id: asPrefix(this.id, "chatcmpl"),
          object: "chat.completion.chunk",
          created: this.created,
          model: this.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        })
        return
      case ANTHROPIC:
        await this.sse("message_start", {
          type: "message_start",
          message: {
            id: asPrefix(this.id, "msg"),
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: anthropicUsage({ input: 0, output: 0, total: 0, cached: 0, cacheCreation: 0, reasoning: 0 }),
          },
        })
        return
      case RESPONSES: {
        const response = this.responsesBase("in_progress", [])
        await this.sse("response.created", { type: "response.created", response, sequence_number: this.nextSequence() })
        await this.sse("response.in_progress", { type: "response.in_progress", response, sequence_number: this.nextSequence() })
        return
      }
      default:
        throw new Error(`unsupported stream target "${this.target}"`)
    }
  }

  private async emitText(delta: string): Promise<void> {
    if (this.target === ANTHROPIC || this.target === RESPONSES) await this.finishReasoning()
    switch (this.target) {
      case CHAT:
        await this.chatChunk({ content: delta }, null)
        return
      case ANTHROPIC:
        if (!this.textOpen) {
          this.textOpen = true
          this.textIndex = this.nextAnthropic
          this.nextAnthropic++
          await this.sse("content_block_start", {
            type: "content_block_start",
            index: this.textIndex,
            content_block: { type: "text", text: "" },
          })
        }
        await this.sse("content_block_delta", {
          type: "content_block_delta",
          index: this.textIndex,
          delta: { type: "text_delta", text: delta },
        })
        return
      case RESPONSES:
        if (!this.textOpen) {
          this.textOpen = true
          this.textItemId = randomId("msg")
          this.textOutput = this.nextOutput
          this.nextOutput++
          const item = { id: this.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] }
          await this.sse("response.output_item.added", { type: "response.output_item.added", output_index: this.textOutput, item, sequence_number: this.nextSequence() })
          const part = { type: "output_text", text: "", annotations: [] }
          await this.sse("response.content_part.added", {
            type: "response.content_part.added",
            item_id: this.textItemId,
            output_index: this.textOutput,
            content_index: 0,
            part,
            sequence_number: this.nextSequence(),
          })
        }
        await this.sse("response.output_text.delta", {
          type: "response.output_text.delta",
          delta,
          item_id: this.textItemId,
          output_index: this.textOutput,
          content_index: 0,
          sequence_number: this.nextSequence(),
        })
        return
    }
  }

  private async emitReasoning(delta: string): Promise<void> {
    await this.startReasoning()
    switch (this.target) {
      case CHAT:
        await this.chatChunk({ reasoning_content: delta }, null)
        return
      case ANTHROPIC:
        await this.sse("content_block_delta", {
          type: "content_block_delta",
          index: this.reasoningIndex,
          delta: { type: "thinking_delta", thinking: delta },
        })
        return
      case RESPONSES:
        await this.sse("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          delta,
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutput,
          summary_index: 0,
          sequence_number: this.nextSequence(),
        })
        return
    }
  }

  private async emitReasoningSignature(signature: string): Promise<void> {
    await this.startReasoning()
    switch (this.target) {
      case CHAT:
        await this.chatChunk({ reasoning_signature: signature }, null)
        return
      case ANTHROPIC:
        await this.sse("content_block_delta", {
          type: "content_block_delta",
          index: this.reasoningIndex,
          delta: { type: "signature_delta", signature },
        })
        return
    }
  }

  private async startReasoning(): Promise<void> {
    if (this.reasoningOpen || this.reasoningClosed) return
    this.reasoningOpen = true
    switch (this.target) {
      case ANTHROPIC:
        this.reasoningIndex = this.nextAnthropic
        this.nextAnthropic++
        await this.sse("content_block_start", {
          type: "content_block_start",
          index: this.reasoningIndex,
          content_block: { type: "thinking", thinking: "", signature: "" },
        })
        return
      case RESPONSES:
        this.reasoningItemId = randomId("rs")
        this.reasoningOutput = this.nextOutput
        this.nextOutput++
        const item = { id: this.reasoningItemId, type: "reasoning", status: "in_progress", summary: [] }
        await this.sse("response.output_item.added", { type: "response.output_item.added", output_index: this.reasoningOutput, item, sequence_number: this.nextSequence() })
        const part = { type: "summary_text", text: "" }
        await this.sse("response.reasoning_summary_part.added", {
          type: "response.reasoning_summary_part.added",
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutput,
          summary_index: 0,
          part,
          sequence_number: this.nextSequence(),
        })
        return
    }
  }

  private async finishReasoning(): Promise<void> {
    if (!this.reasoningOpen || this.reasoningClosed) return
    this.reasoningClosed = true
    const text = this.reasoning
    switch (this.target) {
      case ANTHROPIC:
        await this.sse("content_block_stop", { type: "content_block_stop", index: this.reasoningIndex })
        return
      case RESPONSES: {
        await this.sse("response.reasoning_summary_text.done", {
          type: "response.reasoning_summary_text.done",
          text,
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutput,
          summary_index: 0,
          sequence_number: this.nextSequence(),
        })
        const part = { type: "summary_text", text }
        await this.sse("response.reasoning_summary_part.done", {
          type: "response.reasoning_summary_part.done",
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutput,
          summary_index: 0,
          part,
          sequence_number: this.nextSequence(),
        })
        const item: Record<string, Json> = { id: this.reasoningItemId, type: "reasoning", status: "completed", summary: [part] }
        if (this.reasoningEncrypted) item.encrypted_content = this.reasoningEncrypted
        await this.sse("response.output_item.done", { type: "response.output_item.done", output_index: this.reasoningOutput, item, sequence_number: this.nextSequence() })
        return
      }
    }
  }

  private async startTool(tool: StreamTool): Promise<void> {
    if (tool.started || !tool.name) return
    if (this.target === RESPONSES || this.target === ANTHROPIC) await this.finishReasoning()
    if (this.target === ANTHROPIC && this.textOpen) {
      await this.sse("content_block_stop", { type: "content_block_stop", index: this.textIndex })
      this.textOpen = false
    }
    tool.started = true
    switch (this.target) {
      case CHAT:
        await this.chatChunk(
          { tool_calls: [{ index: tool.index, id: tool.id, type: "function", function: { name: tool.name, arguments: "" } }] },
          null,
        )
        return
      case RESPONSES:
        tool.index = this.nextOutput
        this.nextOutput++
        await this.sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: tool.index,
          item: { id: tool.itemId, type: "function_call", status: "in_progress", arguments: "", call_id: tool.id, name: tool.name },
          sequence_number: this.nextSequence(),
        })
        return
      case ANTHROPIC:
        tool.anthropicIndex = this.nextAnthropic
        this.nextAnthropic++
        await this.sse("content_block_start", {
          type: "content_block_start",
          index: tool.anthropicIndex,
          content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
        })
        return
    }
  }

  private async emitToolDelta(tool: StreamTool, delta: string): Promise<void> {
    if (!delta) return
    switch (this.target) {
      case CHAT:
        await this.chatChunk({ tool_calls: [{ index: tool.index, function: { arguments: delta } }] }, null)
        return
      case RESPONSES:
        await this.sse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          delta,
          item_id: tool.itemId,
          output_index: tool.index,
          sequence_number: this.nextSequence(),
        })
        return
      case ANTHROPIC:
        await this.sse("content_block_delta", {
          type: "content_block_delta",
          index: tool.anthropicIndex,
          delta: { type: "input_json_delta", partial_json: delta },
        })
        return
    }
  }

  private async emitPendingToolArguments(tool: StreamTool): Promise<void> {
    if (!tool.started) return
    if (tool.emittedArguments >= tool.arguments.length) return
    const delta = tool.arguments.slice(tool.emittedArguments)
    tool.emittedArguments = tool.arguments.length
    await this.emitToolDelta(tool, delta)
  }

  async finish(): Promise<void> {
    if (this.done) return
    this.done = true
    if (!this.started) await this.start()
    if (!this.stop) this.stop = this.order.length ? "tool_calls" : "stop"
    if ((this.stop === "tool_calls" || this.stop === "tool_use") && !this.anyToolStarted()) this.stop = "stop"
    await this.finishReasoning()

    switch (this.target) {
      case CHAT:
        await this.chatChunk({}, chatStop(this.stop))
        await this.sse("", {
          id: asPrefix(this.id, "chatcmpl"),
          object: "chat.completion.chunk",
          created: this.created,
          model: this.model,
          choices: [],
          usage: openAIUsage(this.usage),
        })
        await this.rawSSE("", "[DONE]")
        return
      case ANTHROPIC: {
        if (this.textOpen) await this.sse("content_block_stop", { type: "content_block_stop", index: this.textIndex })
        for (const key of this.order) {
          const tool = this.tools.get(key)!
          await this.startTool(tool)
          await this.emitPendingToolArguments(tool)
          if (tool.started) await this.sse("content_block_stop", { type: "content_block_stop", index: tool.anthropicIndex })
        }
        await this.sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: anthropicStop(this.stop), stop_sequence: null },
          usage: anthropicUsage(this.usage),
        })
        await this.sse("message_stop", { type: "message_stop" })
        return
      }
      case RESPONSES: {
        await this.finishResponsesItems()
        const reasoning: BridgeBlock[] =
          this.reasoning.length || this.reasoningSignature.length
            ? [{ kind: "reasoning", id: this.reasoningItemId, text: this.reasoning, signature: this.reasoningSignature }]
            : []
        const tools: BridgeBlock[] = this.order.map((key) => {
          const tool = this.tools.get(key)!
          return { kind: "tool_call", id: tool.id, name: tool.name, argumentsJson: tool.arguments }
        })
        const completed = encodeBridgeResponse(RESPONSES, {
          id: this.id,
          model: this.model,
          text: this.text,
          reasoning,
          tools,
          stop: this.stop,
          error: "",
          usage: this.usage,
          created: this.created,
        })
        await this.sse("response.completed", { type: "response.completed", response: completed, sequence_number: this.nextSequence() })
        return
      }
    }
  }

  private async finishResponsesItems(): Promise<void> {
    if (this.textOpen) {
      const text = this.text
      await this.sse("response.output_text.done", {
        type: "response.output_text.done",
        text,
        item_id: this.textItemId,
        output_index: this.textOutput,
        content_index: 0,
        sequence_number: this.nextSequence(),
      })
      const part = { type: "output_text", text, annotations: [] }
      await this.sse("response.content_part.done", {
        type: "response.content_part.done",
        item_id: this.textItemId,
        output_index: this.textOutput,
        content_index: 0,
        part,
        sequence_number: this.nextSequence(),
      })
      await this.sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: this.textOutput,
        item: { id: this.textItemId, type: "message", status: "completed", role: "assistant", content: [part] },
        sequence_number: this.nextSequence(),
      })
    }
    for (const key of this.order) {
      const tool = this.tools.get(key)!
      const arguments_ = tool.arguments === "" ? "{}" : tool.arguments
      await this.startTool(tool)
      await this.emitPendingToolArguments(tool)
      await this.sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        arguments: arguments_,
        item_id: tool.itemId,
        output_index: tool.index,
        sequence_number: this.nextSequence(),
      })
      await this.sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: tool.index,
        item: { id: tool.itemId, type: "function_call", status: "completed", arguments: arguments_, call_id: tool.id, name: tool.name },
        sequence_number: this.nextSequence(),
      })
    }
  }

  private async chatChunk(delta: Record<string, Json>, finish: Json): Promise<void> {
    await this.sse("", {
      id: asPrefix(this.id, "chatcmpl"),
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
  }

  private responsesBase(status: string, output: Json[]): Record<string, Json> {
    return {
      id: asPrefix(this.id, "resp"),
      object: "response",
      created_at: this.created,
      status,
      model: this.model,
      output,
      error: null,
    }
  }

  private nextSequence(): number {
    return this.sequence++
  }

  private async sse(eventName: string, value: Json): Promise<void> {
    await this.rawSSE(eventName, JSON.stringify(value))
  }

  private async rawSSE(eventName: string, data: string): Promise<void> {
    if (eventName) await this.write(`event: ${eventName}\n`)
    await this.write(`data: ${data}\n\n`)
  }
}

// ---------------------------------------------------------------------------
// transcode / forward / collapse

export interface StreamResult {
  usage: Usage
  reported: boolean
  error?: Error
}

/** transcodeStream parses an upstream stream and re-encodes it for another protocol. */
export async function transcodeStream(
  source: ReadableStream<Uint8Array>,
  write: StreamWriter,
  from: Protocol,
  to: Protocol,
  model: string,
): Promise<StreamResult> {
  const parser = new BridgeStreamParser(from)
  const emitter = new BridgeStreamEncoder(write, to, model)
  let termination: "open" | "normal" | "error" = "open"
  try {
    for await (const record of readSSE(source)) {
      let events: BridgeStreamEvent[]
      try {
        events = parser.parse(record.event, record.data)
      } catch (error) {
        termination = "error"
        try {
          await emitter.emit({ kind: "error", error: (error as Error).message, errorType: "upstream_error" })
        } catch {
          /* the failure was already reported */
        }
        return { usage: emitter.usage, reported: emitter.usageReported, error: new StreamUpstreamFailure("upstream stream failure delivered") }
      }
      for (const event of events) {
        if (event.kind === "done") termination = "normal"
        if (event.kind === "error") termination = "error"
        try {
          await emitter.emit(event)
        } catch (error) {
          return { usage: emitter.usage, reported: emitter.usageReported, error: error as Error }
        }
        if (event.kind === "done") {
          return { usage: emitter.usage, reported: emitter.usageReported }
        }
      }
    }
  } catch (error) {
    if (termination === "open") {
      const cause = error as Error
      const message = cause instanceof UnexpectedEOF ? "upstream SSE stream ended before a terminal event" : `upstream SSE stream failed: ${cause.message}`
      try {
        await emitter.emit({ kind: "error", error: message, errorType: "upstream_error" })
      } catch {
        /* already reported */
      }
    }
    return { usage: emitter.usage, reported: emitter.usageReported, error: error as Error }
  }
  if (termination === "normal") return { usage: emitter.usage, reported: emitter.usageReported }
  if (termination === "error") return { usage: emitter.usage, reported: emitter.usageReported, error: new StreamUpstreamFailure("upstream stream failure delivered") }
  try {
    await emitter.emit({ kind: "error", error: "upstream SSE stream ended before a terminal event", errorType: "upstream_error" })
  } catch {
    /* already reported */
  }
  return { usage: emitter.usage, reported: emitter.usageReported, error: new UnexpectedEOF("unexpected end of SSE stream") }
}

/** forwardStream relays a same-protocol stream byte for byte while tracking usage. */
export async function forwardStream(
  source: ReadableStream<Uint8Array>,
  write: StreamWriter,
  protocol: Protocol,
  model: string,
): Promise<StreamResult> {
  const parser = new BridgeStreamParser(protocol)
  const usage: Usage = { input: 0, output: 0, total: 0, cached: 0, cacheCreation: 0, reasoning: 0 }
  let reported = false
  let normal = false
  let errorTermination = false
  let parseError: Error | undefined
  const reader = source.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await write(new TextDecoder().decode(value, { stream: true }))
      const text = new TextDecoder().decode(value)
      for (const record of parseFrames(text)) {
        try {
          for (const event of parser.parse(record.event, record.data)) {
            if (event.kind === "done") normal = true
            if (event.kind === "error") errorTermination = true
            if (event.usage) {
              reported = true
              mergeUsage(usage, event.usage)
            }
          }
        } catch (error) {
          if (!parseError) parseError = error as Error
        }
      }
    }
  } catch (error) {
    return { usage, reported, error: error as Error }
  }
  if (errorTermination) return { usage, reported, error: new StreamUpstreamFailure("upstream stream failure delivered") }
  if (normal && !parseError) return { usage, reported }
  const cause = parseError ?? new UnexpectedEOF("unexpected end of SSE stream")
  const emitter = new BridgeStreamEncoder(write, protocol, model)
  try {
    await emitter.emit({
      kind: "error",
      error: cause instanceof UnexpectedEOF ? "upstream SSE stream ended before a terminal event" : `upstream SSE stream failed: ${cause.message}`,
      errorType: "upstream_error",
    })
  } catch {
    /* already reported */
  }
  return { usage, reported, error: cause }
}

/** parseFrames extracts the complete SSE records of a chunk of stream bytes. */
export function parseFrames(text: string): SSERecord[] {
  const records: SSERecord[] = []
  let event = ""
  let dataLines: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw === "") {
      if (dataLines.length) records.push({ event, data: dataLines.join("\n") })
      event = ""
      dataLines = []
      continue
    }
    if (raw.startsWith(":")) continue
    if (raw.startsWith("event:")) {
      event = raw.slice(6).trim()
      continue
    }
    if (raw.startsWith("data:")) dataLines.push(raw.slice(5).trim())
  }
  return records
}

/** collapseStream turns a streaming upstream response into one document. */
export async function collapseStream(source: ReadableStream<Uint8Array>, protocol: Protocol, model: string): Promise<Uint8Array> {
  const parser = new BridgeStreamParser(protocol)
  const response = {
    id: "",
    model,
    text: "",
    reasoning: [] as BridgeBlock[],
    tools: [] as BridgeBlock[],
    stop: "",
    error: "",
    usage: { input: 0, output: 0, total: 0, cached: 0, cacheCreation: 0, reasoning: 0 } as Usage,
    created: Math.floor(Date.now() / 1000),
  }
  const toolIndex = new Map<string, number>()
  let reason: BridgeBlock | undefined
  let terminated = false
  let streamError: Error | undefined

  const reasoningBlock = (): BridgeBlock => {
    if (!reason) {
      response.reasoning.push({ kind: "reasoning" })
      reason = response.reasoning[response.reasoning.length - 1]
    }
    return reason
  }
  const toolBlock = (key: string, id: string, name: string): BridgeBlock => {
    const index = toolIndex.get(key)
    if (index !== undefined) {
      const block = response.tools[index]
      if (!block.id) block.id = id
      if (!block.name) block.name = name
      return block
    }
    response.tools.push({ kind: "tool_call", id, name })
    toolIndex.set(key, response.tools.length - 1)
    return response.tools[response.tools.length - 1]
  }

  try {
    for await (const record of readSSE(source)) {
      const events = parser.parse(record.event, record.data)
      for (const event of events) {
        switch (event.kind) {
          case "done":
            terminated = true
            throw new StreamNormalTermination("terminated")
          case "error":
            streamError = new Error(event.error || "upstream stream failed")
            throw new StreamUpstreamFailure("failed")
          case "start":
            if (event.responseId) response.id = event.responseId
            if (event.model) response.model = event.model
            break
          case "text":
            response.text += event.text ?? ""
            break
          case "reasoning": {
            const block = reasoningBlock()
            block.text = (block.text ?? "") + (event.text ?? "")
            if (event.encrypted) {
              reason = undefined
              reasoningBlock().encrypted = (reasoningBlock().encrypted ?? "") + event.encrypted
              reason = undefined
            }
            break
          }
          case "reasoning_signature": {
            const block = reasoningBlock()
            block.signature = (block.signature ?? "") + (event.signature ?? "")
            break
          }
          case "tool_start":
            toolBlock(event.toolKey ?? "", event.toolId ?? "", event.toolName ?? "")
            break
          case "tool_delta": {
            const block = toolBlock(event.toolKey ?? "", event.toolId ?? "", event.toolName ?? "")
            block.argumentsJson = (block.argumentsJson ?? "") + (event.text ?? "")
            break
          }
          case "usage":
            if (event.usage) mergeUsage(response.usage, event.usage)
            break
          case "finish":
            response.stop = event.stop ?? ""
            break
        }
      }
    }
  } catch (error) {
    if (error instanceof StreamNormalTermination) {
      return new TextEncoder().encode(JSON.stringify(encodeBridgeResponse(protocol, response)))
    }
    if (streamError) throw streamError
    throw error
  }
  if (streamError) throw streamError
  throw new UnexpectedEOF("unexpected end of SSE stream")
}

export { intAt }
