import type { TangerineConfig } from "./schema.js";
import { TangerineError } from "../core/Errors.js";
import { ENV_KEY_RE, hasNul, isInt, isRecord } from "../utils/Validation.js";

const BACKENDS = ["auto", "opengl", "vulkan"];
const SCHEDULERS = ["normal", "rr"];
const NET_MODES = ["blocked", "restricted", "unrestricted"];
const PROFILES = ["safe", "balanced", "performance", "custom"];
const STRATEGIES = ["manual", "auto", "dedicated", "none"];
const SANDBOX_BACKENDS = ["auto", "bwrap", "unshare", "none"];
const LOG_LEVELS = ["debug", "info", "warn", "error"];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateEnvMap(map: unknown, where: string, errors: string[]): void {
  if (!isRecord(map)) return void errors.push(`${where} must be an object of strings`);
  for (const [k, v] of Object.entries(map)) {
    if (!ENV_KEY_RE.test(k)) errors.push(`${where}: invalid variable name ${JSON.stringify(k)}`);
    if (typeof v !== "string") errors.push(`${where}.${k} must be a string`);
    else if (hasNul(v)) errors.push(`${where}.${k} contains a NUL byte`);
  }
}

/** Validates the fully merged configuration. Runs before any host change (spec §34). */
export function validateConfig(c: TangerineConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const e = (m: string): void => void errors.push(m);
  const w = (m: string): void => void warnings.push(m);
  const oneOf = (v: unknown, list: string[], name: string): void => {
    if (typeof v !== "string" || !list.includes(v)) e(`${name} must be one of ${list.join("|")} (got ${JSON.stringify(v)})`);
  };
  const interval = (v: unknown, name: string): void => {
    if (!isInt(v) || v < 100 || v > 60_000) e(`${name} must be an integer between 100 and 60000 ms`);
  };

  // runtime
  if (typeof c.runtime.adapter !== "string" || !c.runtime.adapter) e("runtime.adapter must be a non-empty string");
  if (c.runtime.executable !== undefined && (typeof c.runtime.executable !== "string" || !c.runtime.executable || hasNul(c.runtime.executable))) e("runtime.executable must be a non-empty string without NUL");
  if (!Array.isArray(c.runtime.args) || c.runtime.args.some((a) => typeof a !== "string" || hasNul(a))) e("runtime.args must be an array of NUL-free strings");
  validateEnvMap(c.runtime.env, "runtime.env", errors);
  if (!Array.isArray(c.runtime.passEnv) || c.runtime.passEnv.some((n) => typeof n !== "string" || !ENV_KEY_RE.test(n))) e("runtime.passEnv must be an array of variable names");
  if (!isInt(c.runtime.stopTimeoutMs) || c.runtime.stopTimeoutMs < 0 || c.runtime.stopTimeoutMs > 120_000) e("runtime.stopTimeoutMs must be 0..120000");
  if (c.runtime.workingDirectory !== undefined && !String(c.runtime.workingDirectory).startsWith("/")) e("runtime.workingDirectory must be absolute");

  // graphics
  oneOf(c.graphics.backend, BACKENDS, "graphics.backend");
  if (c.graphics.frameLimit !== undefined && (typeof c.graphics.frameLimit !== "number" || !(c.graphics.frameLimit > 0 && c.graphics.frameLimit <= 1000))) e("graphics.frameLimit must be in (0,1000]");
  if (c.graphics.extraEnvironment !== undefined) validateEnvMap(c.graphics.extraEnvironment, "graphics.extraEnvironment", errors);

  // cpu
  oneOf(c.cpu.affinity.strategy, STRATEGIES, "cpu.affinity.strategy");
  if (c.cpu.affinity.cpus !== undefined && (!Array.isArray(c.cpu.affinity.cpus) || c.cpu.affinity.cpus.some((x) => !isInt(x) || x < 0 || x >= 8192))) e("cpu.affinity.cpus must be an array of non-negative integers");
  if (c.cpu.affinity.enabled && c.cpu.affinity.strategy === "manual" && !(c.cpu.affinity.cpus && c.cpu.affinity.cpus.length)) e("cpu.affinity.strategy=manual requires cpu.affinity.cpus");
  oneOf(c.cpu.scheduler, SCHEDULERS, "cpu.scheduler");
  if (!isInt(c.cpu.nice) || c.cpu.nice < -20 || c.cpu.nice > 19) e("cpu.nice must be an integer in [-20,19]");
  if (!isInt(c.cpu.rtPriority) || c.cpu.rtPriority < 1 || c.cpu.rtPriority > 99) e("cpu.rtPriority must be 1..99");
  if (c.cpu.scheduler === "rr" && !c.cpu.allowRealtime) e("cpu.scheduler=rr requires cpu.allowRealtime=true (real-time scheduling is never enabled implicitly and can starve the desktop)");
  if (c.cpu.scheduler === "rr" && c.cpu.allowRealtime) w("Real-time scheduling requested: a busy SCHED_RR workload can starve Xorg/MATE on a 2-core CPU. Keep rtPriority low and have a way to kill it.");
  for (const [i, r] of (c.cpu.background ?? []).entries()) {
    if (!isRecord(r) || !isRecord(r.match)) { e(`cpu.background[${i}].match is required`); continue; }
    const m = r.match as Record<string, unknown>;
    if (!(isInt(m["pid"]) && (m["pid"] as number) > 1) && !(typeof m["name"] === "string" && m["name"])) e(`cpu.background[${i}].match needs pid>1 or name`);
    oneOf(r.action, ["lower-priority", "pause", "terminate"], `cpu.background[${i}].action`);
    if (r.nice !== undefined && (!isInt(r.nice) || r.nice < -20 || r.nice > 19)) e(`cpu.background[${i}].nice out of range`);
  }

  // memory
  if (typeof c.memory.highPercent !== "number" || c.memory.highPercent < 0 || c.memory.highPercent > 100) e("memory.highPercent must be 0..100");
  if (c.memory.highPercent > 0 && c.memory.highPercent < 30) w("memory.highPercent < 30 will aggressively throttle the workload");
  if (c.memory.swapInInactivePagesPerSec > c.memory.swapInActivePagesPerSec) e("memory swap hysteresis: inactive threshold must be <= active threshold");
  if (c.memory.cacheManagement) w("memory.cacheManagement: drops the page cache once before launch (needs root). This can slow disk-backed startup; effect is measured and logged.");

  // sandbox / network
  oneOf(c.sandbox.backend, SANDBOX_BACKENDS, "sandbox.backend");
  oneOf(c.network.mode, NET_MODES, "network.mode");
  if (c.sandbox.exposeHome) w("sandbox.exposeHome=true exposes your whole home directory (including keys and browser profiles) to an untrusted workload.");
  if (c.network.mode === "unrestricted") w("network.mode=unrestricted: the workload shares the host network.");
  if (c.network.mode === "blocked" && c.network.allow.length) w("network.allow rules are ignored in blocked mode");
  for (const [i, r] of c.network.allow.entries()) {
    if (r.port !== undefined && (!isInt(r.port) || r.port < 1 || r.port > 65535)) e(`network.allow[${i}].port invalid`);
    if (r.protocol !== undefined && r.protocol !== "tcp" && r.protocol !== "udp") e(`network.allow[${i}].protocol invalid`);
    if (r.host !== undefined && !/^[A-Za-z0-9.\-]+$/.test(r.host)) e(`network.allow[${i}].host invalid`);
    if (r.cidr !== undefined && !/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(r.cidr)) e(`network.allow[${i}].cidr invalid`);
    if (!r.host && !r.cidr && r.port === undefined) e(`network.allow[${i}] must specify host, cidr or port`);
  }

  // monitoring/ui
  for (const k of ["cpuIntervalMs", "memoryIntervalMs", "processIntervalMs", "gpuIntervalMs", "fpsIntervalMs"] as const) interval(c.monitoring[k], `monitoring.${k}`);
  if (!isInt(c.ui.refreshMs) || c.ui.refreshMs < 100 || c.ui.refreshMs > 5000) e("ui.refreshMs must be 100..5000");
  oneOf(c.performance.profile, PROFILES, "performance.profile");
  oneOf(c.logging.level, LOG_LEVELS, "logging.level");

  return { ok: errors.length === 0, errors, warnings };
}

export function assertValid(c: TangerineConfig): string[] {
  const r = validateConfig(c);
  if (!r.ok) {
    throw new TangerineError({
      code: "CONFIG_INVALID",
      subsystem: "config",
      message: `Invalid configuration:\n  - ${r.errors.join("\n  - ")}`,
      recoverable: false,
      hint: "Fix the listed keys (see `tangerine config`). No host changes were made.",
    });
  }
  return r.warnings;
}
