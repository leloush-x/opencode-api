import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC,
  CHAT,
  RESPONSES,
  budgetForEffort,
  convertRequest,
  effortForThinkingBudget,
  forcedEffort,
  prepareRequest,
} from "../src/protocol.ts";
import { convertResponse } from "../src/response.ts";

describe("convertRequest", () => {
  test("chat to anthropic keeps the turn shape and merges the system prompt", () => {
    const body = {
      model: "m",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
      max_tokens: 128,
    };
    const out = convertRequest(CHAT, ANTHROPIC, body);
    expect(out.model).toBe("m");
    expect(out.max_tokens).toBe(128);
    expect(out.system).toEqual([{ type: "text", text: "be brief" }]);
    const messages = out.messages as {
      role: string;
      content: { type: string; text: string }[];
    }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0].text).toBe("hello");
  });

  test("chat tool calls become anthropic tool_use blocks", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    };
    const out = convertRequest(CHAT, ANTHROPIC, body);
    const messages = out.messages as {
      role: string;
      content: Record<string, unknown>[];
    }[];
    const assistant = messages.find((message) => message.role === "assistant")!;
    expect(assistant.content[0]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "read",
    });
    expect(assistant.content[0].input).toEqual({ path: "a.txt" });
    const user = messages.find(
      (message) =>
        message.role === "user" &&
        message.content.some((block) => block.type === "tool_result"),
    )!;
    expect(user).toBeDefined();
    expect(
      user.content.find((block) => block.type === "tool_result"),
    ).toMatchObject({ type: "tool_result", tool_use_id: "call_1" });
  });

  test("responses to chat emits tool messages after the assistant turn", () => {
    const body = {
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
        {
          type: "function_call",
          call_id: "call_9",
          name: "bash",
          arguments: '{"cmd":"ls"}',
        },
        { type: "function_call_output", call_id: "call_9", output: "ok" },
      ],
      tools: [
        {
          type: "function",
          name: "bash",
          parameters: { type: "object", properties: {} },
        },
      ],
    };
    const out = convertRequest(RESPONSES, CHAT, body);
    const messages = out.messages as {
      role: string;
      tool_call_id?: string;
      content?: unknown;
    }[];
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(messages[2].tool_call_id).toBe("call_9");
  });

  test("a same-protocol body is passed through unchanged", () => {
    const body = { model: "m", seed: 7, messages: [] };
    expect(convertRequest(CHAT, CHAT, body)).toEqual(body);
  });

  test("an unpaired tool call is rejected by the chat encoder", () => {
    const body = {
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
      ],
    };
    expect(() => convertRequest(RESPONSES, CHAT, body)).toThrow(
      /missing results/,
    );
  });
});

describe("reasoning levels", () => {
  test("budget and effort are inverse", () => {
    expect(budgetForEffort("max")).toBe(32768);
    expect(effortForThinkingBudget(32768)).toBe("max");
    expect(effortForThinkingBudget(16384)).toBe("xhigh");
    expect(effortForThinkingBudget(8192)).toBe("high");
    expect(effortForThinkingBudget(4096)).toBe("medium");
    expect(effortForThinkingBudget(1024)).toBe("low");
  });

  test("an explicit effort wins over the thinking budget", () => {
    const out = convertRequest(ANTHROPIC, CHAT, {
      model: "m",
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 2048 },
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.reasoning_effort).toBe("max");
  });

  test("the forced effort fills an empty slot", () => {
    const body: Record<string, unknown> = { model: "m", messages: [] };
    forcedEffort(CHAT, body, "xhigh");
    expect(body.reasoning_effort).toBe("xhigh");
    const plain: Record<string, unknown> = { model: "m", messages: [] };
    forcedEffort(CHAT, plain, "none");
    expect(plain.reasoning_effort).toBeUndefined();
  });
});

describe("prepareRequest", () => {
  test("floors a tiny responses budget", () => {
    const out = prepareRequest(
      RESPONSES,
      RESPONSES,
      { model: "m", max_output_tokens: 4, input: "hi" },
      "https://opencode.ai/inference",
    );
    expect(out.max_output_tokens).toBe(16);
  });
});

describe("convertResponse", () => {
  test("chat to anthropic", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        id: "chatcmpl-1",
        model: "m",
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );
    const out = JSON.parse(
      new TextDecoder().decode(convertResponse(CHAT, ANTHROPIC, body)),
    );
    expect(out.type).toBe("message");
    expect(out.stop_reason).toBe("end_turn");
    expect(out.content[0]).toEqual({ type: "text", text: "hello" });
    expect(out.usage.input_tokens).toBe(3);
    expect(out.usage.output_tokens).toBe(4);
  });

  test("a same-protocol body is unchanged", () => {
    const body = new TextEncoder().encode('{"id":"x"}');
    expect(new TextDecoder().decode(convertResponse(CHAT, CHAT, body))).toBe(
      '{"id":"x"}',
    );
  });

  test("an upstream error envelope becomes an error", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ error: { message: "boom" } }),
    );
    expect(() => convertResponse(CHAT, ANTHROPIC, body)).toThrow(/boom/);
  });
});
