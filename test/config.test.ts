import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.js";
import { validateConfig } from "../src/config/validator.js";
import { buildDefaults } from "../src/config/defaults.js";
import { classifyHardware } from "../src/performance/HardwareProfile.js";
import { configFromEnvironment } from "../src/config/environment.js";
import { parseArgs, cliOverrides } from "../src/cli/args.js";
import type { TangerineConfig } from "../src/config/schema.js";

const i3 = classifyHardware({ cpuModel: "Intel(R) Core(TM) i3-6006U CPU @ 2.00GHz", totalMemKb: 7_900_000 }, { logicalCount: 4, physicalCoreCount: 2, smt: true });
const big = classifyHardware({ cpuModel: "AMD Ryzen 9", totalMemKb: 32_000_000 }, { logicalCount: 16, physicalCoreCount: 8, smt: true });

test("hardware classification recognises the i3-6006U target", () => {
  assert.equal(i3.id, "i3-6006u");
  assert.equal(big.id, "standard");
  assert.equal(classifyHardware({ cpuModel: "N100", totalMemKb: 16_000_000 }, { logicalCount: 4, physicalCoreCount: 4, smt: false }).id, "low-end");
});

test("low-end defaults sample less often than standard hardware", () => {
  assert.ok(buildDefaults(i3).monitoring.processIntervalMs > buildDefaults(big).monitoring.processIntervalMs);
  assert.ok(buildDefaults(i3).ui.refreshMs >= buildDefaults(big).ui.refreshMs);
});

test("precedence: defaults < profile < file < env < cli", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-cfg-"));
  try {
    const file = join(dir, "c.json");
    await writeFile(file, JSON.stringify({ performance: { profile: "performance" }, cpu: { nice: 3 }, graphics: { vsync: false, backend: "opengl" } }));
    const env = { TANGERINE_GRAPHICS: "vulkan", TANGERINE_NETWORK: "unrestricted" };
    const r = await loadConfig({ hardware: i3, filePath: file, env, cli: { network: { mode: "blocked" } } });
    assert.equal(r.config.performance.profile, "performance");
    assert.equal(r.profileSource, "file");
    assert.equal(r.config.cpu.affinity.strategy, "dedicated", "profile overlay applied");
    assert.equal(r.config.cpu.nice, 3, "file overrides profile");
    assert.equal(r.config.graphics.backend, "vulkan", "env overrides file");
    assert.equal(r.config.graphics.vsync, false);
    assert.equal(r.config.network.mode, "blocked", "cli overrides env");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("cli profile beats file profile", async () => {
  const r = await loadConfig({ hardware: i3, filePath: "/nonexistent/x.json", env: {}, cli: { performance: { profile: "safe" } } });
  assert.equal(r.profileSource, "cli");
  assert.equal(r.config.cpu.affinity.enabled, false);
});

test("loaded config is deeply frozen (session immutability)", async () => {
  const r = await loadConfig({ hardware: i3, filePath: "/nonexistent/x.json", env: {} });
  assert.throws(() => { (r.config.cpu as { nice: number }).nice = 9; });
  assert.throws(() => { (r.config.runtime.args as string[]).push("x"); });
});

test("validation rejects unsafe or malformed values", () => {
  const base = buildDefaults(i3) as TangerineConfig;
  const bad = (mut: (c: TangerineConfig) => void): string[] => { const c = structuredClone(base); mut(c); return validateConfig(c).errors; };
  assert.ok(bad((c) => { c.cpu.scheduler = "rr"; }).some((e) => /allowRealtime/.test(e)), "rr never implicit");
  assert.ok(bad((c) => { c.monitoring.cpuIntervalMs = 5; }).length);
  assert.ok(bad((c) => { c.runtime.env = { "BAD KEY": "x" }; }).length);
  assert.ok(bad((c) => { c.runtime.env = { OK: "a\0b" }; }).length);
  assert.ok(bad((c) => { c.cpu.nice = 40; }).length);
  assert.ok(bad((c) => { c.network.mode = "everything" as never; }).length);
  assert.ok(bad((c) => { c.cpu.affinity = { enabled: true, strategy: "manual" }; }).length, "manual needs cpus");
  assert.ok(bad((c) => { c.memory.swapInInactivePagesPerSec = 999999; }).length, "hysteresis band must be ordered");
  assert.ok(bad((c) => { c.network.allow = [{}]; }).length);
  assert.equal(validateConfig(base).ok, true);
});

test("warnings (not errors) for risky-but-allowed settings", () => {
  const c = structuredClone(buildDefaults(i3)) as TangerineConfig;
  c.sandbox.exposeHome = true;
  c.network.mode = "unrestricted";
  const r = validateConfig(c);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 2);
});

test("environment variables map through an allow-list only", () => {
  const c = configFromEnvironment({ TANGERINE_PROFILE: "safe", TANGERINE_UI: "0", TANGERINE_SANDBOX_ENABLED: "false", PATH: "/x" });
  assert.equal(c.performance?.profile, "safe");
  assert.equal(c.ui?.enabled, false);
  assert.equal((c as Record<string, unknown>)["sandbox"], undefined, "sandbox cannot be switched off from the environment");
});

test("CLI parsing: workload after --, flags, and bad input", () => {
  const a = parseArgs(["start", "--profile", "performance", "--graphics", "vulkan", "--no-network", "--dry-run", "--", "./run.sh", "--flag", "x"]);
  assert.deepEqual(a.workload, ["./run.sh", "--flag", "x"]);
  assert.equal(a.dryRun, true);
  const o = cliOverrides(a);
  assert.equal(o.runtime?.executable, "./run.sh");
  assert.deepEqual(o.runtime?.args, ["--flag", "x"]);
  assert.equal(o.network?.mode, "blocked");
  assert.throws(() => parseArgs(["start", "--profile", "turbo"]));
  assert.throws(() => parseArgs(["frobnicate"]));
  assert.throws(() => parseArgs(["start", "--duration"]));
});
