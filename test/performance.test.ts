import test from "node:test";
import assert from "node:assert/strict";
import { planAffinity } from "../src/performance/AffinityManager.js";
import { planScheduler } from "../src/performance/SchedulerManager.js";
import { planMemory } from "../src/performance/MemoryManager.js";
import { selectGraphics, parseGlxinfo, parseVulkanSummary, type GraphicsCapabilities } from "../src/performance/GraphicsManager.js";
import { TangerineError } from "../src/core/Errors.js";
import { SwapPressureDetector } from "../src/monitoring/SwapMonitor.js";
import { FrameStatsAccumulator, parseFrameLine, percentile, FpsMonitor } from "../src/monitoring/FpsMonitor.js";
import { MetricsStore, Series } from "../src/monitoring/MetricsStore.js";
import { compareRuns, stat } from "../src/benchmark/Comparison.js";
import type { BenchmarkResult } from "../src/benchmark/BenchmarkRunner.js";
import type { CpuSummary } from "../src/performance/CpuManager.js";
import type { PermissionInfo } from "../src/system/Permissions.js";
import type { GraphicsConfig } from "../src/config/schema.js";
import type { VmStat } from "../src/system/ProcFs.js";

const i3: CpuSummary = { logical: 4, physical: 2, smt: true, online: [0, 1, 2, 3], allowed: [0, 1, 2, 3], groups: [[0, 2], [1, 3]] };
const eight: CpuSummary = { logical: 8, physical: 4, smt: true, online: [0, 1, 2, 3, 4, 5, 6, 7], allowed: [0, 1, 2, 3, 4, 5, 6, 7], groups: [[0, 4], [1, 5], [2, 6], [3, 7]] };
const unpriv: PermissionInfo = { uid: 1000, isRoot: false, hasSysNice: false, hasSysAdmin: false, hasNetAdmin: false, rtprioLimit: 0, niceLimit: 0, minNice: 0 };
const priv: PermissionInfo = { ...unpriv, hasSysNice: true, minNice: -20 };

test("affinity: auto is a documented no-op on the 2C/4T i3-6006U", () => {
  const p = planAffinity({ enabled: true, strategy: "auto" }, i3);
  assert.equal(p.applied, false);
  assert.match(p.reason, /unproven/);
  assert.deepEqual(p.wrapper, []);
});

test("affinity: dedicated on the i3 uses one SMT thread per core, flagged experimental", () => {
  const p = planAffinity({ enabled: true, strategy: "dedicated" }, i3);
  assert.deepEqual(p.cpus, [0, 1]);
  assert.deepEqual(p.wrapper, ["taskset", "-c", "0,1"]);
  assert.ok(p.warnings.some((w) => /EXPERIMENTAL/.test(w)));
});

test("affinity: 8 threads reserve the last physical core for the desktop", () => {
  const p = planAffinity({ enabled: true, strategy: "auto" }, eight);
  assert.deepEqual(p.cpus, [0, 1, 2, 4, 5, 6]);
  assert.match(p.reason, /\{3,7\}/);
});

test("affinity: manual drops offline/disallowed CPUs, and never pins to 'everything'", () => {
  const p = planAffinity({ enabled: true, strategy: "manual", cpus: [1, 3, 9] }, i3);
  assert.deepEqual(p.cpus, [1, 3]);
  assert.ok(p.warnings.some((w) => /9/.test(w)));
  assert.equal(planAffinity({ enabled: true, strategy: "manual", cpus: [0, 1, 2, 3] }, i3).applied, false);
  assert.equal(planAffinity({ enabled: true, strategy: "manual", cpus: [7] }, i3).applied, false);
  assert.equal(planAffinity({ enabled: false, strategy: "auto" }, eight).applied, false);
});

test("affinity respects a restricted allowed set", () => {
  assert.equal(planAffinity({ enabled: true, strategy: "manual", cpus: [0, 1, 2] }, { ...i3, allowed: [0, 1, 2] }).applied, false, "all allowed CPUs == no pinning");
  const q = planAffinity({ enabled: true, strategy: "manual", cpus: [1, 2, 3] }, { ...i3, allowed: [0, 1, 2] });
  assert.deepEqual(q.cpus, [1, 2]);
  assert.ok(q.warnings.some((w) => /3/.test(w)));
});

const cpuCfg = { affinity: { enabled: false, strategy: "none" as const }, scheduler: "normal" as const, rtPriority: 1, allowRealtime: false, nice: 0, background: [] };

test("scheduler: unprivileged negative nice is clamped and reported", () => {
  const p = planScheduler({ ...cpuCfg, nice: -5 }, unpriv, 0, true);
  assert.equal(p.nice, 0);
  assert.deepEqual(p.wrapper, []);
  assert.match(p.warnings[0] ?? "", /SCHEDULER_PERMISSION_DENIED/);
});

test("scheduler: nice is honoured with CAP_SYS_NICE; positive nice always allowed", () => {
  assert.deepEqual(planScheduler({ ...cpuCfg, nice: -5 }, priv, 0, true).wrapper, ["nice", "-n", "-5"]);
  assert.deepEqual(planScheduler({ ...cpuCfg, nice: 10 }, unpriv, 0, true).wrapper, ["nice", "-n", "10"]);
});

test("scheduler: SCHED_RR is never implicit and needs consent + permission", () => {
  assert.equal(planScheduler({ ...cpuCfg, scheduler: "rr" }, priv, 0, true).policy, "normal", "no allowRealtime");
  assert.equal(planScheduler({ ...cpuCfg, scheduler: "rr", allowRealtime: true }, unpriv, 0, true).policy, "normal", "no permission");
  assert.equal(planScheduler({ ...cpuCfg, scheduler: "rr", allowRealtime: true }, priv, 0, false).policy, "normal", "no chrt");
  const ok = planScheduler({ ...cpuCfg, scheduler: "rr", allowRealtime: true, rtPriority: 3 }, priv, 0, true);
  assert.equal(ok.policy, "rr");
  assert.deepEqual(ok.wrapper, ["chrt", "-r", "3"]);
  assert.ok(ok.warnings.some((w) => /starve/.test(w)), "host-starvation warning");
});

test("memory.high plan: 80% of 8 GB, only when a scope is available", () => {
  const mem = { totalKb: 7_900_000 } as never;
  const cfg = { monitor: true, swapMonitoring: true, cacheManagement: false, highPercent: 80, swapInActivePagesPerSec: 1, swapInInactivePagesPerSec: 1 };
  const p = planMemory(cfg, mem, true);
  assert.equal(p.highBytes, Math.floor((7_900_000 * 1024 * 0.8) / 1048576) * 1048576);
  assert.equal(planMemory(cfg, mem, false).highBytes, undefined);
  assert.equal(planMemory({ ...cfg, highPercent: 0 }, mem, true).highBytes, undefined);
});

// ---------- graphics ----------
const caps = (o: Partial<GraphicsCapabilities> = {}): GraphicsCapabilities => ({ opengl: true, vulkan: true, vulkanSoftwareOnly: false, driDrivers: ["iris"], vulkanIcds: ["intel_icd.x86_64.json"], vulkanDevices: [], isIntel: true, deep: false, details: ["x"], ...o });
const gcfg = (o: Partial<GraphicsConfig> = {}): GraphicsConfig => ({ backend: "auto", vsync: true, debug: false, shaderCache: false, glthread: false, ...o });

test("graphics: auto does not assume Vulkan; records the reason", () => {
  const s = selectGraphics(gcfg(), caps());
  assert.equal(s.backend, "opengl");
  assert.match(s.reason, /Not assumed faster/);
});

test("graphics: a recorded benchmark preference is honoured for auto only", () => {
  assert.equal(selectGraphics(gcfg(), caps(), { benchmarkPreference: "vulkan" }).backend, "vulkan");
  assert.equal(selectGraphics(gcfg({ backend: "opengl" }), caps(), { benchmarkPreference: "vulkan" }).backend, "opengl");
  assert.equal(selectGraphics(gcfg(), caps({ vulkan: false }), { benchmarkPreference: "vulkan" }).backend, "opengl", "preference ignored when unavailable");
});

test("graphics: explicit unavailable backend fails with a structured error; auto degrades", () => {
  assert.throws(() => selectGraphics(gcfg({ backend: "vulkan" }), caps({ vulkan: false })), (e: unknown) => e instanceof TangerineError && e.code === "GRAPHICS_BACKEND_UNAVAILABLE" && e.recoverable && !e.hostModified);
  const none = selectGraphics(gcfg(), caps({ opengl: false, vulkan: false }));
  assert.equal(none.backend, "none");
  assert.deepEqual(none.environment, {});
});

test("graphics: only documented variables are emitted", () => {
  const gl = selectGraphics(gcfg({ vsync: false, glthread: true, debug: true, shaderCache: true }), caps(), { shaderCacheHostDir: "/c" });
  assert.deepEqual(gl.environment, { vblank_mode: "0", mesa_glthread: "true", LIBGL_DEBUG: "verbose", MESA_SHADER_CACHE_DIR: "/tangerine/shader-cache", MESA_SHADER_CACHE_MAX_SIZE: "512M" });
  const vk = selectGraphics(gcfg({ backend: "vulkan", vsync: false }), caps());
  assert.deepEqual(vk.environment, { MESA_VK_WSI_PRESENT_MODE: "immediate" });
  assert.deepEqual(selectGraphics(gcfg({ vsync: true }), caps()).environment, {}, "GL vsync=true leaves Mesa defaults alone");
});

test("graphics: frameLimit is passed through, not faked as an env var", () => {
  const s = selectGraphics(gcfg({ frameLimit: 30 }), caps());
  assert.equal(s.frameLimit, 30);
  assert.ok(!Object.keys(s.environment).some((k) => /FPS|LIMIT/i.test(k)));
  assert.ok(s.notes.some((n) => /runtime adapter/.test(n)));
});

test("glxinfo / vulkaninfo parsing", () => {
  const g = parseGlxinfo("OpenGL renderer string: Mesa Intel(R) HD Graphics 520 (SKL GT2)\nOpenGL version string: 4.6 (Compatibility Profile) Mesa 23.2.1-1ubuntu3.1~22.04.3\n");
  assert.equal(g.renderer, "Mesa Intel(R) HD Graphics 520 (SKL GT2)");
  assert.equal(g.mesaVersion, "23.2.1-1ubuntu3.1~22.04.3");
  assert.deepEqual(parseVulkanSummary("GPU0:\n\tdeviceName         = Intel(R) HD Graphics 520 (SKL GT2)\nGPU1:\n\tdeviceName = llvmpipe (LLVM 15)\n"), ["Intel(R) HD Graphics 520 (SKL GT2)", "llvmpipe (LLVM 15)"]);
});

// ---------- swap ----------
const vm = (inn: number, out: number, major = 0): VmStat => ({ pswpin: inn, pswpout: out, pgfault: 0, pgmajfault: major });

test("swap pressure uses RATES with hysteresis (not swap fill)", () => {
  const d = new SwapPressureDetector({ activePagesPerSec: 200, inactivePagesPerSec: 50, enterSamples: 2, exitSamples: 3 });
  assert.equal(d.update(vm(0, 0), 0), undefined, "first sample has no rate");
  let t = 0;
  let pin = 0;
  const step = (rate: number): boolean => { t += 1000; pin += rate; return (d.update(vm(pin, 0), t) as { active: boolean }).active; };
  assert.equal(step(1000), false, "one spike is not enough");
  assert.equal(step(1000), true, "two consecutive samples => active");
  assert.equal(step(100), true, "inside the band the state is held");
  assert.equal(step(10), true);
  assert.equal(step(10), true);
  assert.equal(step(10), false, "three quiet samples => inactive");
  assert.equal(step(100), false, "band does not re-trigger");
});

test("swap detector survives counter resets", () => {
  const d = new SwapPressureDetector({ activePagesPerSec: 10, inactivePagesPerSec: 5 });
  d.update(vm(1000, 1000), 0);
  assert.equal(d.update(vm(0, 0), 1000), undefined);
  const p = d.update(vm(100, 0, 7), 2000);
  assert.equal(p?.pagesInPerSecond, 100);
});

// ---------- fps ----------
test("fps line parsing recognises real formats and rejects noise", () => {
  assert.deepEqual(parseFrameLine("fps: 59.7"), { fps: 59.7 });
  assert.deepEqual(parseFrameLine("render 60.2 fps"), { fps: 60.2 });
  assert.deepEqual(parseFrameLine("frame time: 16.7 ms"), { frameTimeMs: 16.7 });
  assert.equal(parseFrameLine("loading assets 50%"), undefined);
  assert.equal(parseFrameLine("fps: 0"), undefined);
});

test("frame statistics from frame times: harmonic avg, p95, stddev, dropped", () => {
  const a = new FrameStatsAccumulator();
  for (let i = 0; i < 95; i++) a.addFrameTime(16);
  for (let i = 0; i < 5; i++) a.addFrameTime(50);
  const s = a.snapshot(true);
  assert.ok(s);
  assert.equal(s.source, "frame-times");
  assert.equal(s.droppedFrames, 5);
  assert.equal(s.frameTimeP95Ms, 16);
  assert.equal(s.minFps, 20);
  assert.ok(Math.abs(s.avgFrameTimeMs - 17.7) < 0.01);
  assert.ok(Math.abs(s.avgFps - 1000 / 17.7) < 0.01);
  assert.ok(s.frameTimeStdDevMs > 5);
});

test("fps reports are labelled as derived; no data means unavailable, never zero", () => {
  const a = new FrameStatsAccumulator();
  assert.equal(a.snapshot(), undefined);
  a.addFpsReport(30);
  a.addFpsReport(60);
  const s = a.snapshot(true);
  assert.equal(s?.source, "fps-reports");
  assert.equal(s?.minFps, 30);
  const store = new MetricsStore();
  const m = new FpsMonitor(store, undefined).metric();
  assert.equal(m.available, false);
  assert.equal(m.available === false && m.reason, "No supported frame timing source");
  assert.equal(percentile([], 95), NaN);
});

test("Series is bounded", () => {
  const s = new Series(3);
  for (let i = 0; i < 10; i++) s.push(i);
  assert.equal(s.length, 3);
  assert.equal(s.mean(), 8);
  s.push(NaN);
  assert.equal(s.length, 3);
});

// ---------- comparison ----------
const result = (label: string, fps: number, extra: Partial<BenchmarkResult> = {}): BenchmarkResult => ({
  id: "x", timestamp: "t", durationMs: 60000, graphicsBackend: "opengl", schedulerPolicy: "normal", avgFps: fps, cpuUsagePercent: 80, memoryUsageMb: 3000, swapInPerSecond: 0, swapOutPerSecond: 0, startupTimeMs: 50,
  label, runIndex: 0, profile: "balanced", niceLevel: 0, sandboxBackend: "bwrap", networkMode: "blocked", endReason: "duration", overlay: {},
  system: { kernel: "6", logicalCpus: 4, physicalCores: 2, runtimeAdapter: "exec-chain", nodeVersion: "22", configHash: "a", environmentHash: "e" }, ...extra,
});

test("comparison: single runs are 'unverified', never a winner", () => {
  const r = compareRuns([result("A", 42)], [result("B", 48)]);
  const fps = r.metrics.find((m) => m.metric === "FPS (avg)");
  assert.equal(fps?.verdict, "unverified-single-run");
  assert.equal(fps?.delta, 6);
  assert.ok(Math.abs((fps?.deltaPercent ?? 0) - 14.2857) < 0.01);
});

test("comparison: distributions decide between higher / within-noise", () => {
  const a = [41, 42, 43].map((f) => result("A", f));
  const clear = compareRuns(a, [51, 52, 53].map((f) => result("B", f)));
  assert.equal(clear.metrics.find((m) => m.metric === "FPS (avg)")?.verdict, "higher");
  const noisy = compareRuns(a, [40, 44, 43].map((f) => result("B", f)));
  assert.equal(noisy.metrics.find((m) => m.metric === "FPS (avg)")?.verdict, "within-noise");
});

test("comparison: missing FPS is n/a; mismatched systems are flagged", () => {
  const a = result("A", 0, { avgFps: undefined });
  const b = result("B", 50, { system: { ...result("B", 1).system, kernel: "7", environmentHash: "other" } });
  const r = compareRuns([a], [b]);
  assert.equal(r.metrics.find((m) => m.metric === "FPS (avg)")?.verdict, "n/a");
  assert.ok(r.mismatches.some((m) => /kernel/.test(m)));
  assert.ok(r.notes.some((n) => /FPS not measured/.test(n)));
});

test("stat computes sample stddev", () => {
  const s = stat([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s?.mean, 5);
  assert.ok(Math.abs((s?.stddev ?? 0) - 2.138) < 0.001);
  assert.equal(stat([]), undefined);
});
