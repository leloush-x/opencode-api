import { describe, expect, test } from "bun:test";
import { ANTHROPIC, CHAT, RESPONSES } from "../src/protocol.ts";
import {
  BridgeStreamEncoder,
  BridgeStreamParser,
  collapseStream,
  transcodeStream,
} from "../src/stream.ts";

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
}

describe("BridgeStreamParser", () => {
  test("parses a chat chunk into text and finish events", () => {
    const parser = new BridgeStreamParser(CHAT);
    const events = parser.parse(
      "",
      JSON.stringify({
        id: "chatcmpl-1",
        model: "m",
        choices: [{ delta: { content: "hi" } }],
      }),
    );
    expect(events[0]).toMatchObject({
      kind: "start",
      responseId: "chatcmpl-1",
    });
    expect(events[1]).toEqual({ kind: "text", text: "hi" });
  });

  test("rejects the [DONE] terminator outside chat", () => {
    const parser = new BridgeStreamParser(RESPONSES);
    expect(() => parser.parse("", "[DONE]")).toThrow(/DONE/);
  });

  test("reports an upstream error event", () => {
    const parser = new BridgeStreamParser(ANTHROPIC);
    const events = parser.parse(
      "error",
      JSON.stringify({
        type: "error",
        error: { type: "overloaded", message: "busy" },
      }),
    );
    expect(events[0]).toMatchObject({
      kind: "error",
      error: "busy",
      errorType: "overloaded",
    });
  });
});

describe("BridgeStreamEncoder", () => {
  test("emits a chat stream that ends with [DONE]", async () => {
    const chunks: string[] = [];
    const encoder = new BridgeStreamEncoder(
      (chunk) => void chunks.push(chunk),
      CHAT,
      "m",
    );
    await encoder.emit({ kind: "start", responseId: "chatcmpl-1", model: "m" });
    await encoder.emit({ kind: "text", text: "hello" });
    await encoder.emit({ kind: "finish", stop: "stop" });
    await encoder.emit({ kind: "done" });
    const output = chunks.join("");
    expect(output).toContain('"object":"chat.completion.chunk"');
    expect(output).toContain('"content":"hello"');
    expect(output.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("transcodeStream", () => {
  test("transcodes a chat stream into anthropic events", async () => {
    const source = sseStream([
      'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const chunks: string[] = [];
    const result = await transcodeStream(
      source,
      (chunk) => void chunks.push(chunk),
      CHAT,
      ANTHROPIC,
      "m",
    );
    const output = chunks.join("");
    expect(result.error).toBeUndefined();
    expect(output).toContain("event: message_start");
    expect(output).toContain('"type":"text_delta"');
    expect(output).toContain("event: message_stop");
  });
});

describe("collapseStream", () => {
  test("collapses a chat stream into one document", async () => {
    const source = sseStream([
      'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const document = JSON.parse(
      new TextDecoder().decode(await collapseStream(source, CHAT, "m")),
    );
    expect(document.choices[0].message.content).toBe("hi");
    expect(document.usage.total_tokens).toBe(3);
  });

  test("a stream without a terminal event is an error", async () => {
    const source = sseStream([
      'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]);
    expect(collapseStream(source, CHAT, "m")).rejects.toThrow();
  });
});
