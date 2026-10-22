// Build the standalone binary and stage the WebUI next to it.

import { cpSync, mkdirSync } from "bun:fs";
import { dirname, join, resolve } from "bun:path";

const root = resolve(import.meta.dir, "..");
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir: outDir,
  target: "bun",
  compile: { outfile: join(outDir, "opencode2api") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const webui = join(root, "..", "webui");
try {
  cpSync(webui, join(outDir, "webui"), { recursive: true });
  console.log("webui staged next to the binary");
} catch {
  console.warn("webui not found; set WEBUI_DIR at runtime");
}

console.log(`binary: ${join(outDir, "opencode2api")}`);
