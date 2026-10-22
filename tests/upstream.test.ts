import { describe, expect, test } from "bun:test"
import { ANTHROPIC, CHAT, RESPONSES } from "../src/protocol.ts"
import {
  V1_BASE,
  ensureV1ReadTool,
  ensureV2Tools,
  isInferenceOrigin,
  isV1Upstream,
  marshalV2ChatBody,
  prepareAnonymousBody,
  upstreamHeaders,
  upstreamURL,
} from "../src/upstream.ts"
import { deriveRequestIds } from "../src/identity.ts"

const ids = deriveRequestIds({ "x-opencode-session": "ses_abc" }, { model: "m" }, "scope")

describe("upstream routes", () => {
  test("the v2 origin groups routes by provider family", () => {
    expect(upstreamURL("https://opencode.ai/inference", CHAT)).toBe("https://opencode.ai/inference/openai/v1/chat/completions")
    expect(upstreamURL("https://opencode.ai/inference", ANTHROPIC)).toBe("https://opencode.ai/inference/anthropic/v1/messages?beta=true")
    expect(upstreamURL("https://opencode.ai/inference/go", CHAT)).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions")
  })

  test("the v1 origin keeps the flat route", () => {
    expect(upstreamURL(V1_BASE, CHAT)).toBe("https://opencode.ai/zen/v1/chat/completions")
    expect(isV1Upstream(V1_BASE)).toBe(true)
    expect(isV1Upstream("https://opencode.ai/inference")).toBe(false)
    expect(isInferenceOrigin("https://opencode.ai/inference")).toBe(true)
    expect(isInferenceOrigin("https://example.com")).toBe(false)
  })
})

describe("upstream headers", () => {
  test("the v2 lane sends the 2.x client shape", () => {
    const headers = upstreamHeaders("https://opencode.ai/inference", CHAT, ids, "public")
    expect(headers["User-Agent"]).toMatch(/^opencode\/latest\/.+\/cli$/)
    expect(headers["x-opencode-client"]).toBe("cli")
    expect(headers["x-opencode-session"]).toBe(ids.session)
    expect(headers["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/)
    expect(headers.Authorization).toBe("Bearer public")
    expect(headers["x-opencode-request"]).toBeUndefined()
  })

  test("the v1 lane sends the 1.x client shape", () => {
    const headers = upstreamHeaders(V1_BASE, CHAT, ids, "public")
    expect(headers["User-Agent"]).toMatch(/^opencode\/1\.19\.3 ai-sdk\/provider-utils\//)
    expect(headers["x-opencode-request"]).toBe(ids.message)
  })

  test("anthropic requests carry the api key and the beta flag", () => {
    const headers = upstreamHeaders("https://opencode.ai/inference", ANTHROPIC, ids, "public")
    expect(headers["x-api-key"]).toBe("public")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
  })
})

describe("anonymous body shaping", () => {
  test("forces streaming and the usage option", () => {
    const shaped = prepareAnonymousBody(new TextEncoder().encode(JSON.stringify({ model: "m", messages: [] })), CHAT, false)
    const payload = JSON.parse(shaped.text)
    expect(payload.stream).toBe(true)
    expect(payload.stream_options.include_usage).toBe(true)
    expect(payload.max_completion_tokens).toBe(32000)
  })

  test("the v2 lane injects the genuine core tools", () => {
    const shaped = prepareAnonymousBody(new TextEncoder().encode(JSON.stringify({ model: "m", messages: [] })), CHAT, false)
    const payload = JSON.parse(shaped.text)
    const names = payload.tools.map((tool: { function: { name: string } }) => tool.function.name)
    expect(names).toEqual(["shell", "edit", "glob", "grep", "read"])
    expect(payload.tools[0].function.description.length).toBeGreaterThan(20)
  })

  test("the v1 lane aliases a read-like tool and reports the original name", () => {
    const payload: Record<string, unknown> = {
      model: "m",
      messages: [],
      tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }],
    }
    const shaped = prepareAnonymousBody(new TextEncoder().encode(JSON.stringify(payload)), CHAT, true)
    const out = JSON.parse(shaped.text)
    expect(shaped.alias).toBe("read_file")
    expect(out.tools[0].function.name).toBe("read")
  })

  test("the v1 lane injects a deprecated read stub when no read tool exists", () => {
    const payload: Record<string, unknown> = { model: "m", messages: [], tools: [] }
    const result = ensureV1ReadTool(payload, CHAT)
    expect(result.alias).toBe("")
    expect((payload.tools as { function: { name: string; description: string } }[])[0].function.name).toBe("read")
  })

  test("the v2 lane keeps client tools and adds the missing ones", () => {
    const payload: Record<string, unknown> = {
      model: "m",
      tools: [{ type: "function", function: { name: "shell", description: "mine", parameters: { type: "object", properties: {} } } }],
    }
    expect(ensureV2Tools(payload, CHAT)).toBe(true)
    const names = (payload.tools as { function: { name: string } }[]).map((tool) => tool.function.name)
    expect(names).toEqual(["shell", "edit", "glob", "grep", "read"])
  })
})

describe("marshalV2ChatBody", () => {
  test("keeps the 2.x client key order", () => {
    const encoded = marshalV2ChatBody({ model: "m", messages: [], tools: [], stream: true, max_completion_tokens: 10, extra: 1 })
    expect(encoded.indexOf('"model"')).toBeLessThan(encoded.indexOf('"messages"'))
    expect(encoded.indexOf('"stream"')).toBeLessThan(encoded.indexOf('"max_completion_tokens"'))
  })
})
