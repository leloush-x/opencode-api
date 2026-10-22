// Telemetry: structured logs with a bounded ring buffer, and counters.

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEvent {
  time: string
  level: LogLevel
  component: string
  event: string
  message: string
  fields: Record<string, unknown>
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export class Logger {
  private level: LogLevel = "info"
  private ring: LogEvent[] = []
  private ringSize = 2000
  private redact: (value: string) => string = (value) => value

  configure(level: LogLevel, ringSize: number, redact: (value: string) => string): void {
    this.level = level
    this.ringSize = ringSize
    this.redact = redact
  }

  log(level: LogLevel, component: string, event: string, message: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const entry: LogEvent = {
      time: new Date().toISOString(),
      level,
      component,
      event,
      message: this.redact(message),
      fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? this.redact(value) : value])),
    }
    this.ring.push(entry)
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize)
    const line = JSON.stringify({ ...entry, time: entry.time })
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else console.log(line)
  }

  debug(component: string, event: string, message: string, fields?: Record<string, unknown>): void {
    this.log("debug", component, event, message, fields)
  }
  info(component: string, event: string, message: string, fields?: Record<string, unknown>): void {
    this.log("info", component, event, message, fields)
  }
  warn(component: string, event: string, message: string, fields?: Record<string, unknown>): void {
    this.log("warn", component, event, message, fields)
  }
  error(component: string, event: string, message: string, fields?: Record<string, unknown>): void {
    this.log("error", component, event, message, fields)
  }

  recent(limit = 200): LogEvent[] {
    return this.ring.slice(-limit)
  }
}

export interface Metrics {
  requests: number
  failures: number
  clientCanceled: number
  streamErrors: number
  upstreamAttempts: number
  upstreamFailures: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  requestsWithUsage: number
}

export class Monitor {
  private metrics: Metrics = {
    requests: 0,
    failures: 0,
    clientCanceled: 0,
    streamErrors: 0,
    upstreamAttempts: 0,
    upstreamFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    requestsWithUsage: 0,
  }

  snapshot(): Metrics {
    return { ...this.metrics }
  }

  recordRequest(outcome: string, usage?: { input: number; output: number; cached: number }): void {
    this.metrics.requests++
    if (outcome === "failed") this.metrics.failures++
    if (outcome === "client_canceled") this.metrics.clientCanceled++
    if (outcome === "stream_error") this.metrics.streamErrors++
    if (usage) {
      this.metrics.inputTokens += usage.input
      this.metrics.outputTokens += usage.output
      this.metrics.cachedTokens += usage.cached
      this.metrics.requestsWithUsage++
    }
  }

  recordAttempt(success: boolean): void {
    this.metrics.upstreamAttempts++
    if (!success) this.metrics.upstreamFailures++
  }
}

export const logger = new Logger()
export const monitor = new Monitor()
