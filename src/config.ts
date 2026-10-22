// Configuration: strict decoding, validation, persistence and redaction.
//
// This port serves the keyless OpenCode free tier only: there are no upstream
// Zen/Go API keys, so the configuration keeps the local client keys, the
// proxies, the upstream origin and the operational knobs. Fields the Go
// implementation used for the keyed tiers (zen_keys, go_keys, prefer,
// rotation, anonymous) are accepted and ignored, so an existing config.json
// keeps loading.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "bun:fs";
import { dirname, isAbsolute, join } from "bun:path";

export interface UpstreamConfig {
  /** The keyless free tier origin (the v2 /inference console). */
  anonymous: string;
  /** The v1 (/zen) origin the anonymous lane falls back to. */
  fallback: string;
}

export interface RetryConfig {
  max_attempts: number;
  timeout_seconds: number;
  stream_timeout_seconds?: number;
}

export interface AnonymousBackoffConfig {
  threshold: number;
  base_hours: number;
  max_hours: number;
}

export interface ModelsConfig {
  refresh_seconds: number;
  protocols: Record<string, string>;
  anonymous_backoff?: AnonymousBackoffConfig;
}

export interface PerformanceConfig {
  max_idle_conns: number;
  max_idle_conns_per_host: number;
  max_conns_per_host: number;
  idle_conn_timeout_seconds: number;
  connect_timeout_seconds: number;
  failure_cooldown_seconds: number;
  attempt_timeout_seconds: number;
  first_event_timeout_seconds: number;
  max_anonymous_exits: number;
  free_tier_block_seconds: number;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  ring_size: number;
  dump_request_bodies: boolean;
}

export interface WebUIConfig {
  enabled: boolean;
  listen: string;
  username: string;
  password?: string;
  password_hash?: string;
  session_ttl_minutes: number;
}

export interface ServerKeyMetadata {
  name?: string;
  disabled?: boolean;
  created_at?: string;
}

export interface Config {
  listen: string;
  server_keys: string[];
  server_key_metadata?: Record<string, ServerKeyMetadata>;
  proxies: string[];
  proxyfile: string;
  upstream: UpstreamConfig;
  retry: RetryConfig;
  models: ModelsConfig;
  performance: PerformanceConfig;
  logging: LoggingConfig;
  webui: WebUIConfig;
  reasoning: { effort?: string; effort_by_model?: Record<string, string> };
  /** Resolved proxy list (config proxies plus proxyfile entries). Never saved. */
  effectiveProxies: string[];
}

export const DEFAULT_CONFIG: Config = {
  listen: "127.0.0.1:8080",
  server_keys: [],
  proxies: [],
  proxyfile: "",
  upstream: {
    anonymous: "https://opencode.ai/inference",
    fallback: "https://opencode.ai/zen",
  },
  retry: { max_attempts: 3, timeout_seconds: 300 },
  models: { refresh_seconds: 300, protocols: {} },
  performance: {
    max_idle_conns: 2048,
    max_idle_conns_per_host: 256,
    max_conns_per_host: 0,
    idle_conn_timeout_seconds: 120,
    connect_timeout_seconds: 5,
    failure_cooldown_seconds: 15,
    attempt_timeout_seconds: 0,
    first_event_timeout_seconds: 0,
    max_anonymous_exits: 8,
    free_tier_block_seconds: 900,
  },
  logging: { level: "info", ring_size: 2000, dump_request_bodies: false },
  webui: {
    enabled: false,
    listen: "0.0.0.0:8081",
    username: "",
    session_ttl_minutes: 720,
  },
  reasoning: {},
  effectiveProxies: [],
};

/** Fields the Go implementation used for the keyed tiers; accepted and ignored. */
const IGNORED_FIELDS = [
  "zen_keys",
  "go_keys",
  "prefer",
  "anonymous",
  "rotation",
  "free_only",
];

// ---------------------------------------------------------------------------
// decoding helpers

class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) && !IGNORED_FIELDS.includes(key))
      fail(`${path}.${key} is not a known field`);
  }
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  return value;
}

function readString(value: unknown, path: string, fallback?: string): string {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    fail(`${path} is required`);
  }
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}

function readNumber(value: unknown, path: string, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    fail(`${path} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${path} must be a number`);
  return value;
}

function readBoolean(
  value: unknown,
  path: string,
  fallback?: boolean,
): boolean {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    fail(`${path} is required`);
  }
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function readStringList(
  value: unknown,
  path: string,
  fallback: string[],
): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value.map((item, index) => readString(item, `${path}[${index}]`));
}

function readStringMap(
  value: unknown,
  path: string,
  fallback: Record<string, string>,
): Record<string, string> {
  if (value === undefined) return fallback;
  const record = readObject(value, path);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record))
    out[key] = readString(item, `${path}.${key}`);
  return out;
}

/** decodeConfig turns parsed JSON into a Config, rejecting unknown fields. */
export function decodeConfig(raw: unknown): Config {
  if (!isRecord(raw)) fail("configuration must be a JSON object");
  rejectUnknown(
    raw,
    [
      "listen",
      "server_keys",
      "server_key_metadata",
      "proxies",
      "proxyfile",
      "upstream",
      "retry",
      "models",
      "performance",
      "logging",
      "webui",
      "reasoning",
    ],
    "config",
  );

  const upstream = readObject(raw.upstream ?? {}, "upstream");
  rejectUnknown(upstream, ["anonymous", "fallback"], "upstream");

  const retry = readObject(raw.retry ?? {}, "retry");
  rejectUnknown(
    retry,
    ["max_attempts", "timeout_seconds", "stream_timeout_seconds"],
    "retry",
  );

  const models = readObject(raw.models ?? {}, "models");
  rejectUnknown(
    models,
    ["refresh_seconds", "protocols", "anonymous_backoff"],
    "models",
  );
  let backoff: AnonymousBackoffConfig | undefined;
  if (models.anonymous_backoff !== undefined) {
    const block = readObject(
      models.anonymous_backoff,
      "models.anonymous_backoff",
    );
    rejectUnknown(
      block,
      ["threshold", "base_hours", "max_hours"],
      "models.anonymous_backoff",
    );
    backoff = {
      threshold: readNumber(
        block.threshold,
        "models.anonymous_backoff.threshold",
        0,
      ),
      base_hours: readNumber(
        block.base_hours,
        "models.anonymous_backoff.base_hours",
        0,
      ),
      max_hours: readNumber(
        block.max_hours,
        "models.anonymous_backoff.max_hours",
        0,
      ),
    };
  }

  const performance = readObject(raw.performance ?? {}, "performance");
  rejectUnknown(
    performance,
    [
      "max_idle_conns",
      "max_idle_conns_per_host",
      "max_conns_per_host",
      "idle_conn_timeout_seconds",
      "connect_timeout_seconds",
      "failure_cooldown_seconds",
      "attempt_timeout_seconds",
      "first_event_timeout_seconds",
      "max_anonymous_exits",
      "free_tier_block_seconds",
    ],
    "performance",
  );

  const logging = readObject(raw.logging ?? {}, "logging");
  rejectUnknown(
    logging,
    ["level", "ring_size", "dump_request_bodies"],
    "logging",
  );

  const webui = readObject(raw.webui ?? {}, "webui");
  rejectUnknown(
    webui,
    [
      "enabled",
      "listen",
      "username",
      "password",
      "password_hash",
      "session_ttl_minutes",
    ],
    "webui",
  );

  const reasoning = readObject(raw.reasoning ?? {}, "reasoning");
  rejectUnknown(reasoning, ["effort", "effort_by_model"], "reasoning");

  let metadata: Record<string, ServerKeyMetadata> | undefined;
  if (raw.server_key_metadata !== undefined) {
    const entries = readObject(raw.server_key_metadata, "server_key_metadata");
    metadata = {};
    for (const [id, item] of Object.entries(entries)) {
      const entry = readObject(item, `server_key_metadata.${id}`);
      rejectUnknown(
        entry,
        ["name", "disabled", "created_at"],
        `server_key_metadata.${id}`,
      );
      metadata[id] = {
        name:
          entry.name === undefined
            ? undefined
            : readString(entry.name, `server_key_metadata.${id}.name`),
        disabled:
          entry.disabled === undefined
            ? undefined
            : readBoolean(entry.disabled, `server_key_metadata.${id}.disabled`),
        created_at:
          entry.created_at === undefined
            ? undefined
            : readString(
                entry.created_at,
                `server_key_metadata.${id}.created_at`,
              ),
      };
    }
  }

  const config: Config = {
    listen: readString(raw.listen, "listen", DEFAULT_CONFIG.listen),
    server_keys: readStringList(raw.server_keys, "server_keys", []),
    server_key_metadata: metadata,
    proxies: readStringList(raw.proxies, "proxies", []),
    proxyfile: readString(raw.proxyfile, "proxyfile", ""),
    upstream: {
      anonymous: readString(
        upstream.anonymous,
        "upstream.anonymous",
        DEFAULT_CONFIG.upstream.anonymous,
      ),
      fallback: readString(
        upstream.fallback,
        "upstream.fallback",
        DEFAULT_CONFIG.upstream.fallback,
      ),
    },
    retry: {
      max_attempts: readNumber(
        retry.max_attempts,
        "retry.max_attempts",
        DEFAULT_CONFIG.retry.max_attempts,
      ),
      timeout_seconds: readNumber(
        retry.timeout_seconds,
        "retry.timeout_seconds",
        DEFAULT_CONFIG.retry.timeout_seconds,
      ),
      stream_timeout_seconds:
        retry.stream_timeout_seconds === undefined
          ? undefined
          : readNumber(
              retry.stream_timeout_seconds,
              "retry.stream_timeout_seconds",
            ),
    },
    models: {
      refresh_seconds: readNumber(
        models.refresh_seconds,
        "models.refresh_seconds",
        DEFAULT_CONFIG.models.refresh_seconds,
      ),
      protocols: readStringMap(models.protocols, "models.protocols", {}),
      anonymous_backoff: backoff,
    },
    performance: {
      max_idle_conns: readNumber(
        performance.max_idle_conns,
        "performance.max_idle_conns",
        DEFAULT_CONFIG.performance.max_idle_conns,
      ),
      max_idle_conns_per_host: readNumber(
        performance.max_idle_conns_per_host,
        "performance.max_idle_conns_per_host",
        DEFAULT_CONFIG.performance.max_idle_conns_per_host,
      ),
      max_conns_per_host: readNumber(
        performance.max_conns_per_host,
        "performance.max_conns_per_host",
        DEFAULT_CONFIG.performance.max_conns_per_host,
      ),
      idle_conn_timeout_seconds: readNumber(
        performance.idle_conn_timeout_seconds,
        "performance.idle_conn_timeout_seconds",
        DEFAULT_CONFIG.performance.idle_conn_timeout_seconds,
      ),
      connect_timeout_seconds: readNumber(
        performance.connect_timeout_seconds,
        "performance.connect_timeout_seconds",
        DEFAULT_CONFIG.performance.connect_timeout_seconds,
      ),
      failure_cooldown_seconds: readNumber(
        performance.failure_cooldown_seconds,
        "performance.failure_cooldown_seconds",
        DEFAULT_CONFIG.performance.failure_cooldown_seconds,
      ),
      attempt_timeout_seconds: readNumber(
        performance.attempt_timeout_seconds,
        "performance.attempt_timeout_seconds",
        DEFAULT_CONFIG.performance.attempt_timeout_seconds,
      ),
      first_event_timeout_seconds: readNumber(
        performance.first_event_timeout_seconds,
        "performance.first_event_timeout_seconds",
        DEFAULT_CONFIG.performance.first_event_timeout_seconds,
      ),
      max_anonymous_exits: readNumber(
        performance.max_anonymous_exits,
        "performance.max_anonymous_exits",
        DEFAULT_CONFIG.performance.max_anonymous_exits,
      ),
      free_tier_block_seconds: readNumber(
        performance.free_tier_block_seconds,
        "performance.free_tier_block_seconds",
        DEFAULT_CONFIG.performance.free_tier_block_seconds,
      ),
    },
    logging: {
      level: readString(
        logging.level,
        "logging.level",
        "info",
      ) as LoggingConfig["level"],
      ring_size: readNumber(
        logging.ring_size,
        "logging.ring_size",
        DEFAULT_CONFIG.logging.ring_size,
      ),
      dump_request_bodies: readBoolean(
        logging.dump_request_bodies,
        "logging.dump_request_bodies",
        false,
      ),
    },
    webui: {
      enabled: readBoolean(webui.enabled, "webui.enabled", false),
      listen: readString(
        webui.listen,
        "webui.listen",
        DEFAULT_CONFIG.webui.listen,
      ),
      username: readString(webui.username, "webui.username", ""),
      password:
        webui.password === undefined
          ? undefined
          : readString(webui.password, "webui.password"),
      password_hash:
        webui.password_hash === undefined
          ? undefined
          : readString(webui.password_hash, "webui.password_hash"),
      session_ttl_minutes: readNumber(
        webui.session_ttl_minutes,
        "webui.session_ttl_minutes",
        DEFAULT_CONFIG.webui.session_ttl_minutes,
      ),
    },
    reasoning: {
      effort:
        reasoning.effort === undefined
          ? undefined
          : readString(reasoning.effort, "reasoning.effort"),
      effort_by_model:
        reasoning.effort_by_model === undefined
          ? undefined
          : readStringMap(
              reasoning.effort_by_model,
              "reasoning.effort_by_model",
              {},
            ),
    },
    effectiveProxies: [],
  };
  return config;
}

// ---------------------------------------------------------------------------
// proxies

export interface ProxyEntry {
  clean: string;
  pool: boolean;
}

/** parseProxyEntry splits the rotating-pool marker from a proxy entry. */
export function parseProxyEntry(raw: string): ProxyEntry {
  let trimmed = raw.trim();
  if (trimmed === "" || trimmed === "direct")
    return { clean: trimmed, pool: false };
  let pool = false;
  if (trimmed.toLowerCase().startsWith("pool+")) {
    trimmed = trimmed.slice(5).trim();
    pool = true;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hash.replace(/^#/, "").trim().toLowerCase() === "pool") {
        pool = true;
        // Strip the fragment by hand: URL.toString() would add a trailing "/".
        trimmed = trimmed.slice(0, trimmed.lastIndexOf("#"));
      }
    } catch {
      const index = trimmed.lastIndexOf("#");
      if (
        index >= 0 &&
        trimmed
          .slice(index + 1)
          .trim()
          .toLowerCase() === "pool"
      ) {
        pool = true;
        trimmed = trimmed.slice(0, index).trim();
      }
    }
  } else {
    const index = trimmed.lastIndexOf("#");
    if (
      index >= 0 &&
      trimmed
        .slice(index + 1)
        .trim()
        .toLowerCase() === "pool"
    ) {
      pool = true;
      trimmed = trimmed.slice(0, index).trim();
    }
  }
  return { clean: trimmed, pool };
}

function stripProxyLineComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (i > 0 && line[i - 1] !== " " && line[i - 1] !== "\t") continue;
    if (
      line[i] === "#" ||
      line[i] === ";" ||
      (line[i] === "/" && line[i + 1] === "/")
    )
      return line.slice(0, i);
  }
  return line;
}

function readProxyFile(path: string): string[] {
  const content = readFileSync(path, "utf8");
  const proxies: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const value = stripProxyLineComment(raw.replace(/^﻿/, "").trim()).trim();
    if (value !== "") proxies.push(value);
  }
  return proxies;
}

function uniqueProxyEntries(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pools = new Set<string>();
  for (const item of items) {
    const { clean, pool } = parseProxyEntry(item);
    if (clean === "") continue;
    if (pool) {
      if (pools.has(clean)) continue;
      pools.add(clean);
      out.push(item);
      continue;
    }
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(item);
  }
  return out;
}

function trimList(items: string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

// ---------------------------------------------------------------------------
// validation

const EFFORT_LEVELS = new Set([
  "",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
]);

function validateEffort(name: string, value: string): void {
  if (!EFFORT_LEVELS.has(value))
    fail(
      `${name} must be one of auto, minimal, low, medium, high, xhigh, max, none, or empty to disable the override`,
    );
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && url.host !== ""
    );
  } catch {
    return false;
  }
}

/** normalize validates a configuration and resolves its proxy list. */
export function normalize(configPath: string, config: Config): Config {
  config.server_keys = trimList(config.server_keys);
  config.proxies = trimList(config.proxies);
  config.proxyfile = config.proxyfile.trim();

  const effective = [...config.proxies];
  if (config.proxyfile !== "") {
    const resolved = isAbsolute(config.proxyfile)
      ? config.proxyfile
      : join(dirname(configPath), config.proxyfile);
    if (!existsSync(resolved))
      fail(`load proxy file ${resolved}: no such file`);
    effective.push(...readProxyFile(resolved));
  }
  config.effectiveProxies = uniqueProxyEntries(effective);
  if (config.effectiveProxies.length === 0)
    config.effectiveProxies = ["direct"];

  if (config.listen === "") fail("listen must not be empty");
  config.upstream.anonymous = config.upstream.anonymous.trim();
  if (config.upstream.anonymous === "")
    config.upstream.anonymous = DEFAULT_CONFIG.upstream.anonymous;
  if (!isHttpUrl(config.upstream.anonymous))
    fail("upstream.anonymous must be an http or https URL");

  if (config.server_keys.length === 0)
    fail("server_keys must contain at least one local key");
  if (firstEnabledServerKey(config) === "")
    fail("at least one server key must remain enabled");
  if (config.retry.max_attempts < 1)
    fail("retry.max_attempts must be at least 1");
  if (config.retry.timeout_seconds < 1)
    fail("retry.timeout_seconds must be at least 1");
  if (config.models.refresh_seconds < 1)
    fail("models.refresh_seconds must be at least 1");
  const perf = config.performance;
  if (
    perf.max_idle_conns < 1 ||
    perf.max_idle_conns_per_host < 1 ||
    perf.max_conns_per_host < 0
  )
    fail("performance pool limits are invalid");
  if (
    perf.idle_conn_timeout_seconds < 1 ||
    perf.connect_timeout_seconds < 1 ||
    perf.failure_cooldown_seconds < 1
  )
    fail("performance values must be positive");
  if (perf.attempt_timeout_seconds < 0)
    fail("performance.attempt_timeout_seconds must not be negative");
  if (
    perf.first_event_timeout_seconds < 0 ||
    perf.first_event_timeout_seconds > 86400
  )
    fail("performance.first_event_timeout_seconds must be between 0 and 86400");
  if (perf.max_anonymous_exits < 0)
    fail("performance.max_anonymous_exits must not be negative");
  if (perf.free_tier_block_seconds < 0)
    fail("performance.free_tier_block_seconds must not be negative");
  if (!["debug", "info", "warn", "error"].includes(config.logging.level))
    fail("logging.level must be debug, info, warn, or error");
  if (config.logging.ring_size < 100 || config.logging.ring_size > 50000)
    fail("logging.ring_size must be between 100 and 50000");
  if (config.webui.password && config.webui.password.length < 10)
    fail("webui.password must contain at least 10 characters");
  if (config.webui.enabled) {
    config.webui.listen = config.webui.listen.trim();
    config.webui.username = config.webui.username.trim();
    if (config.webui.listen === "")
      fail("webui.listen must not be empty when webui is enabled");
    if (config.webui.username === "")
      fail("webui.username must not be empty when webui is enabled");
    if (!config.webui.password && !config.webui.password_hash)
      fail("webui.password is required for first-time setup");
    if (
      config.webui.session_ttl_minutes < 5 ||
      config.webui.session_ttl_minutes > 10080
    )
      fail("webui.session_ttl_minutes must be between 5 and 10080");
  }
  for (const raw of config.effectiveProxies) {
    if (raw === "direct") continue;
    const { clean } = parseProxyEntry(raw);
    let url: URL;
    try {
      url = new URL(clean);
    } catch {
      fail(`invalid proxy URL ${redactUrl(raw)}`);
    }
    const scheme = url.protocol.replace(":", "").toLowerCase();
    if (!["http", "https", "socks5", "socks5h"].includes(scheme))
      fail(`unsupported proxy scheme ${scheme}`);
  }
  if (config.models.anonymous_backoff) {
    const block = config.models.anonymous_backoff;
    block.threshold = block.threshold || 6;
    block.base_hours = block.base_hours || 1;
    block.max_hours = block.max_hours || 24;
    if (block.threshold < 1)
      fail("models.anonymous_backoff.threshold must be at least 1");
    if (block.base_hours < 1)
      fail("models.anonymous_backoff.base_hours must be at least 1");
    if (block.max_hours < block.base_hours)
      fail(
        "models.anonymous_backoff.max_hours must not be smaller than base_hours",
      );
  }
  for (const [model, protocol] of Object.entries(config.models.protocols)) {
    if (model === "" || !["chat", "responses", "anthropic"].includes(protocol))
      fail(
        `models.protocols contains invalid mapping "${model}": "${protocol}"`,
      );
  }
  config.reasoning.effort = (config.reasoning.effort ?? "")
    .trim()
    .toLowerCase();
  validateEffort("reasoning.effort", config.reasoning.effort);
  if (config.reasoning.effort_by_model) {
    const normalized: Record<string, string> = {};
    for (const [model, effort] of Object.entries(
      config.reasoning.effort_by_model,
    )) {
      const key = model.trim();
      if (key === "")
        fail("reasoning.effort_by_model must not contain an empty model ID");
      const level = effort.trim().toLowerCase();
      validateEffort(`reasoning.effort_by_model["${key}"]`, level);
      normalized[key] = level;
    }
    config.reasoning.effort_by_model = Object.keys(normalized).length
      ? normalized
      : undefined;
  }
  return config;
}

// ---------------------------------------------------------------------------
// loading and saving

function envKeyList(name: string): string[] | undefined {
  const raw = Bun.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function applyEnvKeys(config: Config): void {
  const server = envKeyList("SERVER_KEYS");
  if (server) config.server_keys = server;
}

/** loadConfig reads, decodes and validates the configuration file. */
export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    // Bun parses JSON with comments natively.
    parsed = Bun.JSONC.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    fail(`parse ${path}: ${(error as Error).message}`);
  }
  const config = decodeConfig(parsed);
  applyEnvKeys(config);
  return normalize(path, config);
}

/** saveConfigAtomic writes the configuration, keeping the previous file as .bak. */
export function saveConfigAtomic(path: string, config: Config): void {
  const payload: Record<string, unknown> = { ...config };
  delete payload.effectiveProxies;
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.config-${Date.now()}.tmp`);
  writeFileSync(temp, data, { mode: 0o600 });
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {
      /* a missing backup must not block the save */
    }
    try {
      chmodSync(temp, 0o600);
    } catch {
      /* keep going: the content is what matters */
    }
  }
  renameSync(temp, path);
}

/** runtimeProxies returns the resolved proxy list. */
export function runtimeProxies(config: Config): string[] {
  if (config.effectiveProxies.length > 0) return config.effectiveProxies;
  if (config.proxies.length > 0) return config.proxies;
  return ["direct"];
}

// ---------------------------------------------------------------------------
// secrets

export function fingerprint(value: string): string {
  return sha256(value).slice(0, 16);
}

/** sha256 hashes a string with Bun's built-in hasher. */
export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function keyDisplayId(value: string): string {
  return value.length <= 5 ? value : value.slice(-5);
}

export function maskValue(value: string): string {
  return value.length <= 5 ? "••••" : `••••${value.slice(-5)}`;
}

export function redactUrl(raw: string): string {
  let value = raw;
  const { clean } = parseProxyEntry(raw);
  if (clean !== "") value = clean;
  if (value === "direct") return value;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return "<invalid>";
  }
}

/** Redactor scrubs configured secrets from log lines and error messages. */
export class Redactor {
  private secrets: string[] = [];

  replace(config: Config): void {
    const values: string[] = [...config.server_keys];
    if (config.webui.password) values.push(config.webui.password);
    const upstream = parseUserinfo(config.upstream.anonymous);
    if (upstream) values.push(...upstream);
    for (const value of runtimeProxies(config)) {
      if (value === "direct") continue;
      const { clean } = parseProxyEntry(value);
      values.push(value, clean);
      const parsed = parseUserinfo(clean);
      if (parsed) values.push(...parsed);
    }
    this.secrets = values
      .filter((value) => value.length >= 4)
      .sort((a, b) => b.length - a.length);
  }

  string(value: string): string {
    let out = value;
    for (const secret of this.secrets) out = out.split(secret).join("***");
    return out;
  }
}

function parseUserinfo(value: string): string[] | undefined {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return undefined;
    const out = [value, decodeURIComponent(url.username)];
    if (url.password) out.push(decodeURIComponent(url.password));
    return out;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// webui password

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10)
    fail("webui password must contain at least 10 characters");
  return await Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(
  encoded: string,
  password: string,
): Promise<boolean> {
  if (!encoded.startsWith("$argon2id$")) return false;
  // The Go implementation wrote unpadded base64; Bun writes padded base64.
  const candidates = new Set([encoded, encoded.replace(/=+$/, "")]);
  for (const candidate of candidates) {
    try {
      if (await Bun.password.verify(password, candidate)) return true;
    } catch {
      /* a malformed hash never matches */
    }
  }
  return false;
}

export function serverKeyEnabled(config: Config, key: string): boolean {
  return !config.server_key_metadata?.[fingerprint(key)]?.disabled;
}

export function firstEnabledServerKey(config: Config): string {
  for (const key of config.server_keys)
    if (serverKeyEnabled(config, key)) return key;
  return "";
}

export function forcedEffort(config: Config, model: string): string {
  const perModel = config.reasoning.effort_by_model;
  if (perModel && model in perModel) return perModel[model] ?? "";
  return config.reasoning.effort ?? "";
}

export { ConfigError };
