// Entry point: configuration, servers and graceful shutdown.

import { Admin, webuiDir } from "./admin.ts";
import {
  type Config,
  Redactor,
  hashPassword,
  loadConfig,
  saveConfigAtomic,
} from "./config.ts";
import { Gateway } from "./gateway.ts";
import { logger } from "./telemetry.ts";
import { existsSync } from "bun:fs";
import { join } from "bun:path";

interface Flags {
  config: string;
  listen?: string;
  webListen?: string;
}

/**
 * parseListen splits a listen address into its host and port. A bare port
 * ("8080") and a missing host (":8080") fall back to the default host, and
 * an IPv6 address keeps its brackets.
 */
function parseListen(
  address: string,
  defaultHost: string,
): { host: string; port: number } {
  const trimmed = address.trim();
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) };
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) {
    const port = Number(trimmed);
    if (Number.isFinite(port) && port > 0) return { host: defaultHost, port };
    return { host: defaultHost, port: 8080 };
  }
  const host = trimmed.slice(0, colon).trim();
  const port = Number(trimmed.slice(colon + 1));
  return {
    host: host === "" ? defaultHost : host,
    port: Number.isFinite(port) ? port : 8080,
  };
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { config: "config.json" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-config" || arg === "--config") flags.config = argv[++i];
    else if (arg === "-listen" || arg === "--listen") flags.listen = argv[++i];
    else if (arg === "-web-listen" || arg === "--web-listen")
      flags.webListen = argv[++i];
  }
  return flags;
}

async function bootstrapPassword(
  config: Config,
  configPath: string,
): Promise<Config> {
  if (!config.webui.enabled || !config.webui.password) return config;
  const hash = await hashPassword(config.webui.password);
  config.webui.password_hash = hash;
  delete config.webui.password;
  saveConfigAtomic(configPath, config);
  logger.info(
    "config",
    "password_hashed",
    "webui bootstrap password hashed into the configuration",
  );
  return config;
}

async function main(): Promise<void> {
  const flags = parseFlags(Bun.argv.slice(2));
  let config = loadConfig(flags.config);
  if (flags.listen) config.listen = flags.listen;
  if (flags.webListen) config.webui.listen = flags.webListen;
  config = await bootstrapPassword(config, flags.config);

  const redactor = new Redactor();
  redactor.replace(config);
  logger.configure(config.logging.level, config.logging.ring_size, (value) =>
    redactor.string(value),
  );

  const gateway = new Gateway(config, flags.config);
  gateway.start();

  const apiListen = parseListen(config.listen, "127.0.0.1");
  const api = Bun.serve({
    port: apiListen.port,
    hostname: apiListen.host,
    idleTimeout: 120,
    fetch: (request) => gateway.handle(request),
  });
  logger.info("server", "server_started", "api server listening", {
    address: config.listen,
  });

  let admin: ReturnType<typeof Bun.serve> | undefined;
  if (config.webui.enabled) {
    const manager = new Admin(config, (candidate) => {
      // A configuration change applies to new requests immediately.
      Object.assign(gateway.config, candidate);
      gateway.exits = new (
        gateway.exits.constructor as new (
          proxies: string[],
        ) => typeof gateway.exits
      )(candidate.proxies.length ? candidate.proxies : ["direct"]);
    });
    const assets = webuiDir();
    // Bun's directory routes serve the WebUI with sendfile, ETag and
    // Last-Modified caching, Range requests and openat2 path clamping.
    const routes = existsSync(join(assets, "index.html"))
      ? {
          "/": new Response(Bun.file(join(assets, "index.html"))),
          "/css/*": { dir: join(assets, "css") },
          "/js/*": { dir: join(assets, "js") },
        }
      : undefined;
    if (!routes)
      logger.warn(
        "server",
        "webui_assets_missing",
        "webui assets not found; serving the api only",
        { assets },
      );
    const webListen = parseListen(config.webui.listen, "0.0.0.0");
    admin = Bun.serve({
      routes,
      port: webListen.port,
      hostname: webListen.host,
      idleTimeout: 120,
      fetch: (request) => manager.handle(request),
    });
    logger.info("server", "server_started", "webui server listening", {
      address: config.webui.listen,
    });
  }

  const shutdown = async (): Promise<void> => {
    logger.info("server", "shutdown", "shutting down");
    gateway.stop();
    await api.stop(true);
    if (admin) await admin.stop(true);
    // Nothing keeps the loop alive once the servers are closed, so the
    // process ends on its own.
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
