// Benchmarks the port: startup, the model list, a non-streaming reply and the
// time to the first byte of a streaming reply.
//
//   bun run bench            # against a local stub upstream (the port's own cost)
//   UPSTREAM=https://opencode.ai/inference bun run bench --live

import { mkdtempSync, writeFileSync } from "bun:fs";
import { join } from "bun:path";

const LIVE = process.argv.includes("--live");
const REQUESTS = 40;

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return `p50 ${p(0.5).toFixed(2)}ms  p95 ${p(0.95).toFixed(2)}ms  max ${sorted[sorted.length - 1]?.toFixed(2)}ms`;
}

async function time<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

// A stub upstream with the free tier's shape: an SSE stream of small chunks.
const stub = Bun.serve({
  port: 0,
  fetch: async (request) => {
    // The catalog refresh asks the origin for its model list.
    if (new URL(request.url).pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          { id: "bench-model-free", object: "model", owned_by: "opencode" },
        ],
      });
    }
    const chunks: string[] = [];
    for (let i = 0; i < 12; i++) {
      chunks.push(
        `data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"content":"tok${i} "}}]}\n\n`,
      );
    }
    chunks.push(
      `data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":12}}\n\n`,
    );
    chunks.push("data: [DONE]\n\n");
    return new Response(chunks.join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
});

const dir = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "oc2api-bench-"));
const apiPort = 8300 + Math.floor(Math.random() * 500);
const upstream = LIVE
  ? (process.env.UPSTREAM ?? "https://opencode.ai/inference")
  : `http://localhost:${stub.port}`;
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    listen: `127.0.0.1:${apiPort}`,
    server_keys: ["bench-key"],
    upstream: { anonymous: upstream, fallback: upstream },
    retry: { max_attempts: 1, timeout_seconds: 120 },
    models: { refresh_seconds: 300, protocols: {} },
    logging: { level: "error", ring_size: 1000, dump_request_bodies: false },
    webui: { enabled: false },
  }),
);

const started = performance.now();
const server = Bun.spawn(
  [
    "bun",
    "run",
    join(import.meta.dir, "..", "src", "index.ts"),
    "-config",
    configPath,
  ],
  { stdout: "ignore", stderr: "ignore" },
);
const base = `http://127.0.0.1:${apiPort}`;

// Wait for the server to answer.
for (let i = 0; i < 100; i++) {
  try {
    await fetch(`${base}/healthz`);
    break;
  } catch {
    await Bun.sleep(50);
  }
}
const startup = performance.now() - started;
console.log(
  `target            ${LIVE ? "live free tier" : "local stub upstream"}`,
);
console.log(
  `startup           ${startup.toFixed(0)}ms (process spawn to first /healthz answer)`,
);

// Wait for the first catalog refresh (or the cached catalog).
for (let i = 0; i < 60; i++) {
  const probe = await fetch(`${base}/v1/models`, {
    headers: { Authorization: "Bearer bench-key" },
  });
  const payload = (await probe.json()) as { data: unknown[] };
  if (payload.data.length) break;
  await Bun.sleep(100);
}

// The model list is served from the catalog cache: no upstream call.
const models = await time(async () => {
  const response = await fetch(`${base}/v1/models`, {
    headers: { Authorization: "Bearer bench-key" },
  });
  return response.json() as Promise<{ data: unknown[] }>;
});
console.log(
  `GET /v1/models    ${stats([models.ms])}  (${models.value.data.length} models, local)`,
);

const modelIds = models.value.data.map((model) => (model as { id: string }).id);
const model = modelIds.find((id) => id.includes("free")) ?? modelIds[0];

const listSamples: number[] = [];
for (let i = 0; i < REQUESTS; i++) {
  const result = await time(async () => {
    const response = await fetch(`${base}/v1/models`, {
      headers: { Authorization: "Bearer bench-key" },
    });
    await response.arrayBuffer();
  });
  listSamples.push(result.ms);
}
console.log(`GET /v1/models x${REQUESTS}  ${stats(listSamples)}`);

if (model) {
  const replySamples: number[] = [];
  for (let i = 0; i < REQUESTS; i++) {
    const result = await time(async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer bench-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "say ok" }],
        }),
      });
      await response.arrayBuffer();
    });
    replySamples.push(result.ms);
  }
  console.log(
    `chat reply x${REQUESTS}     ${stats(replySamples)}  (model ${model})`,
  );

  const ttfbSamples: number[] = [];
  for (let i = 0; i < REQUESTS; i++) {
    const result = await time(async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer bench-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: "user", content: "say ok" }],
        }),
      });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
    });
    ttfbSamples.push(result.ms);
  }
  console.log(
    `stream ttfb x${REQUESTS}     ${stats(ttfbSamples)}  (time to the first byte)`,
  );
}

server.kill();
stub.stop(true);
