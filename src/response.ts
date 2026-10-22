// Response conversion between the three message protocols.

import {
  ANTHROPIC,
  CHAT,
  RESPONSES,
  type BridgeBlock,
  type BridgeResponse,
  type Json,
  type Protocol,
  type Usage,
  asPrefix,
  boolAt,
  bridgeArgumentsJson,
  bridgeBlocksText,
  bridgeReasoningSignature,
  bridgeReasoningText,
  cloneMap,
  decodeAnthropicBlocksChecked,
  decodeOpenAIBlocksChecked,
  encodeAnthropicBlocks,
  encodeResponsesReasoning,
  firstString,
  intAt,
  mapAt,
  parseJsonOrString,
  sliceAt,
  stringAt,
} from "./protocol.ts"

export function decodeOpenAIUsage(usage: Record<string, Json> | undefined): Usage {
  const map = usage ?? {}
  const first = (...values: number[]): number => {
    for (const value of values) if (value !== 0) return value
    return 0
  }
  const input = first(intAt(map, "prompt_tokens"), intAt(map, "input_tokens"))
  const output = first(intAt(map, "completion_tokens"), intAt(map, "output_tokens"))
  let total = intAt(map, "total_tokens")
  if (total === 0) total = input + output
  const cached = first(intAt(map, "prompt_tokens_details", "cached_tokens"), intAt(map, "input_tokens_details", "cached_tokens"))
  const cacheCreation = first(
    intAt(map, "cache_creation_input_tokens"),
    intAt(map, "prompt_tokens_details", "cache_creation_input_tokens"),
    intAt(map, "prompt_tokens_details", "cache_write_tokens"),
    intAt(map, "input_tokens_details", "cache_creation_input_tokens"),
  )
  const reasoning = first(intAt(map, "completion_tokens_details", "reasoning_tokens"), intAt(map, "output_tokens_details", "reasoning_tokens"))
  return { input, output, total, cached, cacheCreation, reasoning }
}

export function decodeAnthropicUsage(usage: Record<string, Json> | undefined): Usage {
  const map = usage ?? {}
  const cached = intAt(map, "cache_read_input_tokens")
  const cacheCreation = intAt(map, "cache_creation_input_tokens")
  const output = intAt(map, "output_tokens")
  const input = intAt(map, "input_tokens") + cached + cacheCreation
  return { input, output, total: input + output, cached, cacheCreation, reasoning: 0 }
}

export function openAIUsage(usage: Usage): Record<string, Json> {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.total,
    prompt_tokens_details: { cached_tokens: usage.cached },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
  }
}

export function anthropicUsage(usage: Usage): Record<string, Json> {
  return {
    input_tokens: Math.max(usage.input - usage.cached - usage.cacheCreation, 0),
    output_tokens: usage.output,
    cache_creation_input_tokens: usage.cacheCreation,
    cache_read_input_tokens: usage.cached,
  }
}

export function chatStop(stop: string): string {
  switch (stop) {
    case "tool_use":
    case "tool_calls":
      return "tool_calls"
    case "max_tokens":
    case "length":
      return "length"
    case "content_filter":
    case "error":
      return stop
    default:
      return "stop"
  }
}

export function anthropicStop(stop: string): string {
  switch (stop) {
    case "tool_use":
    case "tool_calls":
      return "tool_use"
    case "max_tokens":
    case "length":
      return "max_tokens"
    case "stop_sequence":
    case "pause_turn":
    case "refusal":
      return stop
    default:
      return "end_turn"
  }
}

export function canonicalChatStop(stop: string): string {
  switch (stop) {
    case "tool_calls":
    case "function_call":
      return "tool_calls"
    case "length":
      return "length"
    case "content_filter":
      return "content_filter"
    case "error":
    case "network_error":
    case "server_error":
      return "error"
    default:
      return "stop"
  }
}

export function canonicalAnthropicStop(stop: string): string {
  switch (stop) {
    case "tool_use":
      return "tool_calls"
    case "max_tokens":
      return "length"
    case "stop_sequence":
    case "pause_turn":
    case "refusal":
      return stop
    case "error":
    case "network_error":
    case "server_error":
      return "error"
    default:
      return "stop"
  }
}

export function isToolStop(stop: string): boolean {
  return stop === "tool_calls" || stop === "tool_use" || stop === "function_call"
}

export function usableToolBlocks(tools: BridgeBlock[]): BridgeBlock[] {
  return tools.filter((tool) => (tool.name ?? "").trim() !== "")
}

export function canonicalResponsesIncomplete(reason: string): string {
  return reason === "content_filter" ? "content_filter" : "length"
}

function responsesIncompleteReason(stop: string): string {
  return stop === "content_filter" ? "content_filter" : "max_output_tokens"
}

function responseTextBlocks(blocks: BridgeBlock[], protocol: string): string {
  for (const block of blocks) {
    if (block.kind !== "text") throw new Error(`${protocol} response contains unsupported ${block.kind} content block`)
  }
  return bridgeBlocksText(blocks)
}

/** decodeBridgeResponse decodes a complete response body into the bridge model. */
export function decodeBridgeResponse(protocol: Protocol, input: Record<string, Json>): BridgeResponse {
  const response: BridgeResponse = {
    id: stringAt(input, "id"),
    model: stringAt(input, "model"),
    text: "",
    reasoning: [],
    tools: [],
    stop: "",
    error: "",
    usage: { input: 0, output: 0, total: 0, cached: 0, cacheCreation: 0, reasoning: 0 },
    created: intAt(input, "created") || intAt(input, "created_at") || Math.floor(Date.now() / 1000),
  }

  switch (protocol) {
    case CHAT: {
      const message = stringAt(input, "error", "message")
      if (message !== "") response.error = message
      if (response.error !== "") return response
      const choices = sliceAt(input, "choices") ?? []
      if (!choices.length) throw new Error("chat response contains no choices")
      const choice = choices[0] as Record<string, Json>
      const chatMessage = mapAt(choice, "message") ?? {}
      const reasoningContent = chatMessage.reasoning_content ?? chatMessage.reasoning
      if (typeof reasoningContent === "string") {
        response.reasoning.push({ kind: "reasoning", text: reasoningContent, signature: stringAt(chatMessage, "reasoning_signature") })
      }
      const blocks = decodeOpenAIBlocksChecked(chatMessage.content)
      response.text = responseTextBlocks(blocks, "Chat")
      for (const raw of sliceAt(chatMessage, "tool_calls") ?? []) {
        const call = raw as Record<string, Json>
        const fn = mapAt(call, "function") ?? {}
        response.tools.push({ kind: "tool_call", id: stringAt(call, "id"), name: stringAt(fn, "name"), argumentsJson: stringAt(fn, "arguments") })
      }
      response.stop = canonicalChatStop(stringAt(choice, "finish_reason"))
      response.usage = decodeOpenAIUsage(mapAt(input, "usage"))
      break
    }

    case RESPONSES: {
      for (const raw of sliceAt(input, "output") ?? []) {
        const item = raw as Record<string, Json>
        switch (stringAt(item, "type")) {
          case "reasoning": {
            let text = ""
            for (const part of (item.summary as Json[] | undefined) ?? []) text += stringAt(part, "text")
            if (item.content !== undefined && item.content !== null) {
              for (const part of (item.content as Json[] | undefined) ?? []) text += stringAt(part, "text")
            }
            const encrypted = stringAt(item, "encrypted_content")
            if (text !== "" || encrypted !== "") {
              response.reasoning.push({ kind: "reasoning", id: stringAt(item, "id"), text, encrypted })
            }
            break
          }
          case "message": {
            const blocks = decodeOpenAIBlocksChecked(item.content)
            response.text += responseTextBlocks(blocks, "Responses")
            break
          }
          case "function_call":
            response.tools.push({
              kind: "tool_call",
              id: firstString(stringAt(item, "call_id"), stringAt(item, "id")),
              name: stringAt(item, "name"),
              argumentsJson: stringAt(item, "arguments"),
            })
            break
          default:
            throw new Error(`Responses response has unsupported output item type "${stringAt(item, "type")}"`)
        }
      }
      response.stop = response.tools.length ? "tool_calls" : "stop"
      if (stringAt(input, "status") === "incomplete") {
        response.stop = canonicalResponsesIncomplete(stringAt(input, "incomplete_details", "reason"))
      } else if (stringAt(input, "status") === "failed") {
        response.stop = "error"
        response.error = firstString(stringAt(input, "error", "message"), "upstream Responses request failed")
      }
      response.usage = decodeOpenAIUsage(mapAt(input, "usage"))
      break
    }

    case ANTHROPIC: {
      if (stringAt(input, "type") === "error") {
        response.error = firstString(stringAt(input, "error", "message"), "upstream Anthropic request failed")
      }
      for (const block of decodeAnthropicBlocksChecked(input.content)) {
        if (block.kind === "reasoning") response.reasoning.push(block)
        else if (block.kind === "text") response.text += block.text ?? ""
        else if (block.kind === "tool_call") response.tools.push(block)
        else throw new Error(`Anthropic response contains unsupported ${block.kind} content block`)
      }
      response.stop = canonicalAnthropicStop(stringAt(input, "stop_reason"))
      response.usage = decodeAnthropicUsage(mapAt(input, "usage"))
      break
    }

    default:
      throw new Error(`unsupported response protocol "${protocol}"`)
  }
  return response
}

/** encodeBridgeResponse encodes a bridge response in the target protocol. */
export function encodeBridgeResponse(protocol: Protocol, response: BridgeResponse): Record<string, Json> {
  if (!response.id) response.id = `resp_${Math.random().toString(36).slice(2, 14)}`
  if (isToolStop(response.stop)) {
    response.tools = usableToolBlocks(response.tools)
    if (!response.tools.length) response.stop = "stop"
  }

  switch (protocol) {
    case CHAT: {
      const message: Record<string, Json> = { role: "assistant", content: response.text }
      const reasoning = bridgeReasoningText(response.reasoning)
      if (reasoning.ok) message.reasoning_content = reasoning.text
      const signature = bridgeReasoningSignature(response.reasoning)
      if (signature !== "") message.reasoning_signature = signature
      if (response.tools.length) {
        message.tool_calls = response.tools.map((tool) => ({
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: bridgeArgumentsJson(tool) },
        }))
      }
      return {
        id: asPrefix(response.id, "chatcmpl"),
        object: "chat.completion",
        created: response.created,
        model: response.model,
        choices: [{ index: 0, message, finish_reason: chatStop(response.stop) }],
        usage: openAIUsage(response.usage),
      }
    }

    case RESPONSES: {
      const output: Json[] = []
      for (const reasoning of response.reasoning) output.push(encodeResponsesReasoning(reasoning, true))
      if (response.text !== "") {
        output.push({
          id: `msg_${Math.random().toString(36).slice(2, 14)}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: response.text, annotations: [] }],
        })
      }
      for (const tool of response.tools) {
        output.push({
          id: `fc_${Math.random().toString(36).slice(2, 14)}`,
          type: "function_call",
          status: "completed",
          call_id: tool.id,
          name: tool.name,
          arguments: bridgeArgumentsJson(tool),
        })
      }
      let status = "completed"
      let incomplete: Json = null
      if (response.stop === "length" || response.stop === "content_filter") {
        status = "incomplete"
        incomplete = { reason: responsesIncompleteReason(response.stop) }
      } else if (response.stop === "error") status = "failed"
      return {
        id: asPrefix(response.id, "resp"),
        object: "response",
        created_at: response.created,
        status,
        model: response.model,
        output,
        error: null,
        incomplete_details: incomplete,
        usage: {
          input_tokens: response.usage.input,
          output_tokens: response.usage.output,
          total_tokens: response.usage.total,
          input_tokens_details: { cached_tokens: response.usage.cached },
          output_tokens_details: { reasoning_tokens: response.usage.reasoning },
        },
      }
    }

    case ANTHROPIC: {
      const content: Json[] = [...encodeAnthropicBlocks(response.reasoning)]
      if (response.text !== "") content.push({ type: "text", text: response.text })
      for (const tool of response.tools) {
        const input = tool.arguments !== undefined && tool.arguments !== null ? tool.arguments : parseJsonOrString(tool.argumentsJson ?? "")
        content.push({ type: "tool_use", id: tool.id, name: tool.name, input })
      }
      return {
        id: asPrefix(response.id, "msg"),
        type: "message",
        role: "assistant",
        model: response.model,
        content,
        stop_reason: anthropicStop(response.stop),
        stop_sequence: null,
        usage: anthropicUsage(response.usage),
      }
    }

    default:
      return {}
  }
}

/** convertResponse converts a serialized response body between protocols. */
export function convertResponse(from: Protocol, to: Protocol, body: Uint8Array): Uint8Array {
  if (from === to) return body
  let input: Record<string, Json>
  try {
    input = JSON.parse(new TextDecoder().decode(body))
  } catch (error) {
    throw new Error((error as Error).message)
  }
  const response = decodeBridgeResponse(from, input)
  if (response.error !== "" || response.stop === "error") {
    throw new Error(`upstream response failed: ${firstString(response.error, "upstream response failed")}`)
  }
  return new TextEncoder().encode(JSON.stringify(encodeBridgeResponse(to, response)))
}

/** responseUsage extracts the usage of a serialized response body. */
export function responseUsage(protocol: Protocol, body: Uint8Array): { usage: Usage; reported: boolean } {
  let payload: Record<string, Json>
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return { usage: { input: 0, output: 0, total: 0, cached: 0, cacheCreation: 0, reasoning: 0 }, reported: false }
  }
  const usage = mapAt(payload, "usage")
  if (!usage || !Object.keys(usage).length) {
    return { usage: { input: 0, output: 0, total: 0, cached: 0, cacheCreation: 0, reasoning: 0 }, reported: false }
  }
  return protocol === ANTHROPIC ? { usage: decodeAnthropicUsage(usage), reported: true } : { usage: decodeOpenAIUsage(usage), reported: true }
}

/** renameResponseTool rewrites matching tool names in a serialized body. */
export function renameResponseTool(body: Uint8Array, protocol: Protocol, fromName: string, toName: string): Uint8Array {
  if (!fromName || !toName || fromName === toName || body.length === 0) return body
  const text = new TextDecoder().decode(body)
  if (!text.includes(fromName)) return body
  let payload: Record<string, Json>
  try {
    payload = JSON.parse(text)
  } catch {
    return body
  }
  if (!renameToolInMap(payload, protocol, fromName, toName)) return body
  return new TextEncoder().encode(JSON.stringify(payload))
}

export function renameToolInMap(payload: Record<string, Json>, protocol: Protocol, fromName: string, toName: string): boolean {
  let changed = false
  switch (protocol) {
    case CHAT:
      for (const rawChoice of sliceAt(payload, "choices") ?? []) {
        const choice = rawChoice as Record<string, Json>
        for (const key of ["message", "delta"]) {
          const container = mapAt(choice, key)
          for (const rawCall of sliceAt(container, "tool_calls") ?? []) {
            const call = rawCall as Record<string, Json>
            const fn = mapAt(call, "function")
            if (fn && stringAt(fn, "name") === fromName) {
              ;(fn as Record<string, Json>).name = toName
              changed = true
            }
          }
        }
      }
      break
    case RESPONSES: {
      const item = mapAt(payload, "item")
      if (item && stringAt(item, "type") === "function_call" && stringAt(item, "name") === fromName) {
        ;(item as Record<string, Json>).name = toName
        changed = true
      }
      for (const rawItem of sliceAt(payload, "output") ?? []) {
        const entry = rawItem as Record<string, Json>
        if (stringAt(entry, "type") === "function_call" && stringAt(entry, "name") === fromName) {
          entry.name = toName
          changed = true
        }
      }
      const response = mapAt(payload, "response")
      for (const rawItem of sliceAt(response, "output") ?? []) {
        const entry = rawItem as Record<string, Json>
        if (stringAt(entry, "type") === "function_call" && stringAt(entry, "name") === fromName) {
          entry.name = toName
          changed = true
        }
      }
      break
    }
    case ANTHROPIC: {
      const block = mapAt(payload, "content_block")
      if (block && stringAt(block, "type") === "tool_use" && stringAt(block, "name") === fromName) {
        ;(block as Record<string, Json>).name = toName
        changed = true
      }
      for (const rawBlock of sliceAt(payload, "content") ?? []) {
        const entry = rawBlock as Record<string, Json>
        if (stringAt(entry, "type") === "tool_use" && stringAt(entry, "name") === fromName) {
          entry.name = toName
          changed = true
        }
      }
      break
    }
  }
  return changed
}

export { boolAt, cloneMap }
