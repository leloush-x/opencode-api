import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decodeConfig, loadConfig, normalize, parseProxyEntry, stripJSONComments } from "../src/config.ts"

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oc2api-"))
  const path = join(dir, "config.json")
  writeFileSync(path, body)
  return path
}

describe("stripJSONComments", () => {
  test("keeps strings and line numbers", () => {
    const text = `{
  // a line comment
  "url": "https://example.com/x", /* block */
  "n": 1
}`
    const stripped = stripJSONComments(text)
    expect(stripped.split("\n").length).toBe(text.split("\n").length)
    expect(JSON.parse(stripped)).toEqual({ url: "https://example.com/x", n: 1 })
  })
})

describe("loadConfig", () => {
  test("applies defaults and ignores the removed keyed-tier fields", () => {
    const path = writeConfig(`{"server_keys":["local-key"],"anonymous":true,"zen_keys":["a"],"go_keys":["b"],"prefer":"zen"}`)
    const config = loadConfig(path)
    expect(config.listen).toBe("127.0.0.1:8080")
    expect(config.upstream.anonymous).toBe("https://opencode.ai/inference")
    expect(config.retry.max_attempts).toBe(3)
    expect(config.effectiveProxies).toEqual(["direct"])
  })

  test("rejects unknown fields", () => {
    const path = writeConfig(`{"server_keys":["local-key"],"nope":1}`)
    expect(() => loadConfig(path)).toThrow(/nope is not a known field/)
  })

  test("requires a local key", () => {
    const path = writeConfig(`{"server_keys":[]}`)
    expect(() => loadConfig(path)).toThrow(/server_keys/)
  })

  test("takes the server keys from the environment", () => {
    const path = writeConfig(`{"server_keys":["from-file"]}`)
    process.env.SERVER_KEYS = " key-a , key-b ,, "
    try {
      expect(loadConfig(path).server_keys).toEqual(["key-a", "key-b"])
    } finally {
      delete process.env.SERVER_KEYS
    }
  })

  test("rejects an invalid upstream url", () => {
    const path = writeConfig(`{"server_keys":["local-key"],"upstream":{"anonymous":"ftp://example.com"}}`)
    expect(() => loadConfig(path)).toThrow(/upstream.anonymous/)
  })
})

describe("normalize", () => {
  test("rejects an invalid protocol override", () => {
    const config = decodeConfig({ server_keys: ["k"], models: { protocols: { m: "bogus" } } })
    expect(() => normalize("config.json", config)).toThrow(/models.protocols/)
  })

  test("rejects an out-of-range effort", () => {
    const config = decodeConfig({ server_keys: ["k"], reasoning: { effort: "turbo" } })
    expect(() => normalize("config.json", config)).toThrow(/reasoning.effort/)
  })
})

describe("parseProxyEntry", () => {
  test("detects the pool marker in both spellings", () => {
    expect(parseProxyEntry("pool+http://127.0.0.1:7890")).toEqual({ clean: "http://127.0.0.1:7890", pool: true })
    expect(parseProxyEntry("http://127.0.0.1:7890#pool")).toEqual({ clean: "http://127.0.0.1:7890", pool: true })
    expect(parseProxyEntry("http://127.0.0.1:7890")).toEqual({ clean: "http://127.0.0.1:7890", pool: false })
    expect(parseProxyEntry("direct")).toEqual({ clean: "direct", pool: false })
  })
})
