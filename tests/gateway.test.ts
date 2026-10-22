import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { decodeConfig, normalize } from "../src/config.ts"
import { Gateway } from "../src/gateway.ts"

let upstream: ReturnType<typeof Bun.serve>
let upstreamUrl = ""
let lastBody = ""
let lastPath = ""
let lastHeaders: Record<string, string> = {}

const upstreamEvents = [
  'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
  "data: [DONE]\n\n",
]

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      lastPath = new URL(request.url).pathname
      lastHeaders = Object.fromEntries(request.headers.entries())
      lastBody = await request.text()
      return new Response(upstreamEvents.join(""), {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  upstreamUrl = `http://localhost:${upstream.port}`
})

afterAll(() => {
  upstream.stop(true)
})

function makeGateway(): Gateway {
  const config = normalize(
    "config.json",
    decodeConfig({
      listen: "127.0.0.1:0",
      server_keys: ["local-key"],
      upstream: { anonymous: upstreamUrl },
      retry: { max_attempts: 1, timeout_seconds: 30 },
    }),
  )
  const gateway = new Gateway(config)
  gateway.catalog.replace([
    {
      id: "model-free",
      protocol: "chat",
      contextWindow: 1000,
      maxOutput: 100,
      reasoning: false,
      toolCall: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      deprecated: false,
      free: true,
    },
    {
      id: "model-paid",
      protocol: "chat",
      contextWindow: 1000,
      maxOutput: 100,
      reasoning: false,
      toolCall: true,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      deprecated: false,
      free: false,
    },
  ])
  return gateway
}

describe("gateway", () => {
  test("rejects a request without a local key", async () => {
    const gateway = makeGateway()
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "model-free", messages: [] }),
      }),
    )
    expect(response.status).toBe(401)
  })

  test("answers an unknown model with 404", async () => {
    const gateway = makeGateway()
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({ model: "nope", messages: [] }),
      }),
    )
    expect(response.status).toBe(404)
  })

  test("rejects a paid model on the keyless lane", async () => {
    const gateway = makeGateway()
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({ model: "model-paid", messages: [] }),
      }),
    )
    expect(response.status).toBe(400)
  })

  test("collapses the free-tier stream into one document", async () => {
    const gateway = makeGateway()
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({ model: "model-free", messages: [{ role: "user", content: "hi" }] }),
      }),
    )
    expect(response.status).toBe(200)
    const document = (await response.json()) as { choices: { message: { content: string } }[]; usage: { total_tokens: number } }
    expect(document.choices[0].message.content).toBe("hi")
    expect(document.usage.total_tokens).toBe(3)
  })

  test("sends the free-tier request shape upstream", async () => {
    const gateway = makeGateway()
    await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({ model: "model-free", messages: [{ role: "user", content: "hi" }] }),
      }),
    )
    const payload = JSON.parse(lastBody)
    expect(payload.stream).toBe(true)
    expect(payload.stream_options.include_usage).toBe(true)
    expect(payload.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("shell")
    expect(lastHeaders.authorization).toBe("Bearer public")
    expect(lastHeaders["x-opencode-client"]).toBe("cli")
    expect(lastPath).toBe("/v1/chat/completions")
  })

  test("lists the free models", async () => {
    const gateway = makeGateway()
    const response = await gateway.handle(new Request("http://localhost/v1/models", { headers: { Authorization: "Bearer local-key" } }))
    const payload = (await response.json()) as { data: { id: string }[] }
    expect(payload.data.map((model) => model.id)).toEqual(["model-free"])
  })
})
