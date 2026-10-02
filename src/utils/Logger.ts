import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  subsystem: string;
  event: string;
  pid?: number;
  data?: Record<string, unknown>;
}

export type LogSink = (rec: LogRecord) => void;

const SECRET_KEY_RE = /pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|cookie|authorization|credential|auth/i;
const SECRET_VALUE_RE = /(ghp_|gho_|github_pat_|sk-|xox[bap]-|AKIA)[A-Za-z0-9_\-]{8,}/g;

/** Redacts values whose key looks secret and strings that look like well-known tokens (spec §24, §45). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return value.replace(SECRET_VALUE_RE, "[REDACTED]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Shared sink set + level so child loggers (per subsystem) stay cheap. */
class LogCore {
  level: LogLevel = "info";
  sinks: LogSink[] = [];
}

export class Logger {
  private constructor(
    private readonly core: LogCore,
    readonly subsystem: string,
  ) {}

  static create(level: LogLevel = "info"): Logger {
    const core = new LogCore();
    core.level = level;
    return new Logger(core, "tangerine");
  }

  child(subsystem: string): Logger {
    return new Logger(this.core, subsystem);
  }

  setLevel(level: LogLevel): void {
    this.core.level = level;
  }

  get level(): LogLevel {
    return this.core.level;
  }

  addSink(sink: LogSink): void {
    this.core.sinks.push(sink);
  }

  log(level: LogLevel, event: string, data?: Record<string, unknown>, pid?: number): void {
    if (ORDER[level] < ORDER[this.core.level]) return;
    const rec: LogRecord = {
      ts: new Date().toISOString(),
      level,
      subsystem: this.subsystem,
      event,
      pid,
      data: data ? (redact(data) as Record<string, unknown>) : undefined,
    };
    for (const s of this.core.sinks) {
      try {
        s(rec);
      } catch {
        /* a broken sink must never break the control plane */
      }
    }
  }

  debug(event: string, data?: Record<string, unknown>, pid?: number): void {
    this.log("debug", event, data, pid);
  }
  info(event: string, data?: Record<string, unknown>, pid?: number): void {
    this.log("info", event, data, pid);
  }
  warn(event: string, data?: Record<string, unknown>, pid?: number): void {
    this.log("warn", event, data, pid);
  }
  error(event: string, data?: Record<string, unknown>, pid?: number): void {
    this.log("error", event, data, pid);
  }
}

/** JSON-lines file sink. Synchronous append: log volume is tiny and it is crash-safe. */
export function fileSink(path: string): LogSink {
  let ready = false;
  return (rec) => {
    if (!ready) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      ready = true;
    }
    appendFileSync(path, JSON.stringify(rec) + "\n", { mode: 0o600 });
  };
}

export function formatRecord(rec: LogRecord): string {
  const data = rec.data && Object.keys(rec.data).length ? " " + JSON.stringify(rec.data) : "";
  const pid = rec.pid !== undefined ? ` pid=${rec.pid}` : "";
  return `${rec.ts} ${rec.level.toUpperCase().padEnd(5)} [${rec.subsystem}] ${rec.event}${pid}${data}`;
}

export function stderrSink(): LogSink {
  return (rec) => process.stderr.write(formatRecord(rec) + "\n");
}

export const NULL_LOGGER = Logger.create("error");
