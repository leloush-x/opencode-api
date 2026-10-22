import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeConfig, normalize } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";

let upstream: ReturnType<typeof Bun.serve>;
let upstreamUrl = "";
let lastBody = "";
let lastPath = "";
let lastHeaders: Record<string, string> = {};
/** upstreamMode picks what the stub answers with. */
let upstreamMode: "text" | "tool" = "text";

const upstreamEvents = [
  'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
  "data: [DONE]\n\n",
];

/** toolCallEvents is the upstream answer that asks for a tool. */
const toolCallEvents = [
  'data: {"id":"chatcmpl-2","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Berlin\\"}"}}]}}]}\n\n',
  'data: {"id":"chatcmpl-2","model":"m","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      lastPath = new URL(request.url).pathname;
      lastHeaders = Object.fromEntries(request.headers.entries());
      lastBody = await request.text();
      // Once the tool result is in the history the upstream answers with text.
      const events =
        upstreamMode === "tool" && !lastBody.includes('"tool_call_id"')
          ? toolCallEvents
          : upstreamEvents;
      return new Response(events.join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  upstreamUrl = `http://localhost:${upstream.port}`;
});

afterAll(() => {
  upstream.stop(true);
});

function makeGateway(): Gateway {
  const config = normalize(
    "config.json",
    decodeConfig({
      listen: "127.0.0.1:0",
      server_keys: ["local-key"],
      upstream: { anonymous: upstreamUrl, fallback: upstreamUrl },
      retry: { max_attempts: 1, timeout_seconds: 30 },
    }),
  );
  const gateway = new Gateway(config);
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
  ]);
  return gateway;
}

describe("gateway", () => {
  test("rejects a request without a local key", async () => {
    const gateway = makeGateway();
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "model-free", messages: [] }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("answers an unknown model with 404", async () => {
    const gateway = makeGateway();
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({ model: "nope", messages: [] }),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("rejects a paid model on the keyless lane", async () => {
    const gateway = makeGateway();
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({ model: "model-paid", messages: [] }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("collapses the free-tier stream into one document", async () => {
    const gateway = makeGateway();
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({
          model: "model-free",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    expect(document.choices[0].message.content).toBe("hi");
    expect(document.usage.total_tokens).toBe(3);
  });

  test("sends the free-tier request shape upstream", async () => {
    const gateway = makeGateway();
    await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({
          model: "model-free",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const payload = JSON.parse(lastBody);
    expect(payload.stream).toBe(true);
    expect(payload.stream_options.include_usage).toBe(true);
    expect(
      payload.tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toContain("shell");
    expect(lastHeaders.authorization).toBe("Bearer public");
    expect(lastHeaders["x-opencode-client"]).toBe("cli");
    expect(lastPath).toBe("/v1/chat/completions");
  });

  test("lists the free models", async () => {
    const gateway = makeGateway();
    const response = await gateway.handle(
      new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer local-key" },
      }),
    );
    const payload = (await response.json()) as { data: { id: string }[] };
    expect(payload.data.map((model) => model.id)).toEqual(["model-free"]);
  });
});

describe("gateway tool calls", () => {
  test("a tool call round trip reaches the model and comes back", async () => {
    upstreamMode = "tool";
    const gateway = makeGateway();
    const first = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({
          model: "model-free",
          messages: [{ role: "user", content: "weather in Berlin?" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                },
              },
            },
          ],
        }),
      }),
    );
    expect(first.status).toBe(200);
    const document = (await first.json()) as {
      choices: {
        message: {
          tool_calls: {
            id: string;
            function: { name: string; arguments: string };
          }[];
        };
        finish_reason: string;
      }[];
    };
    expect(document.choices[0].finish_reason).toBe("tool_calls");
    expect(document.choices[0].message.tool_calls[0].function.name).toBe(
      "get_weather",
    );

    // The client answers the tool; the upstream now replies with text.
    const second = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({
          model: "model-free",
          messages: [
            { role: "user", content: "weather in Berlin?" },
            {
              role: "assistant",
              content: null,
              tool_calls: document.choices[0].message.tool_calls,
            },
            { role: "tool", tool_call_id: "call_1", content: "18C" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                },
              },
            },
          ],
        }),
      }),
    );
    const answer = (await second.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(answer.choices[0].message.content).toBe("hi");
    // The tool result must reach the upstream as a tool message.
    expect(lastBody).toContain('"tool_call_id":"call_1"');
    upstreamMode = "text";
  });

  test("the client tool definition survives the free-tier shaping", async () => {
    upstreamMode = "tool";
    const gateway = makeGateway();
    await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({
          model: "model-free",
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "the weather",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        }),
      }),
    );
    const payload = JSON.parse(lastBody);
    const names = payload.tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    expect(names).toContain("get_weather");
    // The core tool set is injected next to it.
    expect(names).toContain("shell");
    upstreamMode = "text";
  });
});

describe("gateway error paths", () => {
  test("a malformed body is a 400", async () => {
    const gateway = makeGateway();
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer local-key",
          "Content-Type": "application/json",
        },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("a missing model is a 400", async () => {
    const gateway = makeGateway();
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("the anthropic endpoint answers in the anthropic envelope", async () => {
    const gateway = makeGateway();
    const response = await gateway.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "local-key" },
        body: JSON.stringify({
          model: "model-free",
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      type: string;
      content: { type: string; text: string }[];
      stop_reason: string;
    };
    expect(document.type).toBe("message");
    expect(document.stop_reason).toBe("end_turn");
    expect(document.content[0].text).toBe("hi");
  });

  test("an upstream failure is a 502", async () => {
    const gateway = makeGateway();
    const broken = new Gateway(gateway.config);
    broken.catalog.replace(gateway.catalog.infos());
    // Point the gateway at a closed port.
    broken.config.upstream.anonymous = "http://127.0.0.1:1";
    broken.config.upstream.fallback = "http://127.0.0.1:1";
    const response = await broken.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer local-key" },
        body: JSON.stringify({
          model: "model-free",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(response.status).toBe(502);
  });
});
