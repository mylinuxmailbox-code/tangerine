import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import React from "react";
import { render } from "ink";
import type { CliArgs } from "./args.js";
import { HELP } from "./args.js";
import { createContext, type Context } from "./bootstrap.js";
import { Tangerine, withOverlay, type RunOutcome } from "../core/Tangerine.js";
import { TangerineError, errMsg } from "../core/Errors.js";
import { SessionStore } from "../core/SessionStore.js";
import { inspectSession, recoverStaleSession } from "../core/Recovery.js";
import { SignalManager } from "../process/SignalManager.js";
import { installExitHandler } from "../process/ExitHandler.js";
import { renderPlan, renderCapabilities } from "./render.js";
import { runDoctor, renderDoctor } from "./doctor.js";
import { App } from "../terminal/App.js";
import { BenchmarkRunner, type BenchmarkResult, type SessionHandle } from "../benchmark/BenchmarkRunner.js";
import { buildExperiment, type ExperimentKind } from "../benchmark/Experiments.js";
import { compareRuns } from "../benchmark/Comparison.js";
import { formatBlock, formatComparison, formatResultLine } from "../benchmark/Reporter.js";
import { defaultConfigPath } from "../config/loader.js";
import { formatRecord, type LogRecord } from "../utils/Logger.js";
import { sleep } from "../utils/Async.js";
import { selectGraphics } from "../performance/GraphicsManager.js";

const out = (s: string): void => void process.stdout.write(s + "\n");
const err = (s: string): void => void process.stderr.write(s + "\n");

function requireWorkload(ctx: Context): void {
  if (!ctx.loaded.config.runtime.executable) {
    throw new TangerineError({ code: "RUNTIME_NOT_FOUND", subsystem: "runtime", message: "No workload configured.", recoverable: false, hint: "Pass the command after `--` (tangerine start -- ./run.sh app.apk) or set runtime.executable in the config file." });
  }
}

function wantUi(ctx: Context, args: CliArgs): boolean {
  return ctx.loaded.config.ui.enabled && !args.noUi && !args.json && !!process.stdout.isTTY;
}

export async function cmdStart(args: CliArgs): Promise<number> {
  const ui0 = !args.noUi && !args.dryRun && !!process.stdout.isTTY;
  const ctx = await createContext(args, { stderrLogs: !ui0 && !args.quiet && (args.verbose || args.debug) });
  const t = new Tangerine(ctx.deps, ctx.loaded);
  requireWorkload(ctx);

  if (args.dryRun) {
    const plan = await t.plan({ virtual: true });
    out(renderPlan(plan));
    return 0;
  }

  const uiOn = wantUi(ctx, args);
  const signals = new SignalManager(ctx.logger, () => t.requestShutdown("signal"), () => t.processManager.killAllSync());
  signals.install();
  const removeExit = installExitHandler(t.processManager);
  let instance: ReturnType<typeof render> | undefined;
  const benchLines: string[] | undefined = args.benchmark ? ["recording a benchmark result for this session"] : undefined;
  let outcome: RunOutcome | undefined;
  let result: BenchmarkResult | undefined;
  let exitCode = 0;
  try {
    await t.start();
    const plan = t.currentPlan;
    if (uiOn) {
      instance = render(React.createElement(App, { tangerine: t, refreshMs: ctx.loaded.config.ui.refreshMs, benchmarkLines: benchLines, onQuit: () => t.requestShutdown("user") }), { exitOnCtrlC: false, patchConsole: false });
    } else {
      out(`tangerine: running ${plan?.runtimeId} pid ${t.workloadPid} | graphics ${plan?.performance.graphics.backend} | sandbox ${plan?.sandbox.backend} | network ${plan?.network.effective} | Ctrl-C to stop`);
      for (const w of plan?.warnings ?? []) err(`warning: ${w}`);
      startPlainTicker(t, args);
    }
    outcome = await t.run({});
    await t.stop();
    if (args.benchmark) result = await t.benchmarkResult({ label: args.positional[0] ?? "session", runIndex: 0, overlay: {}, measuredMs: outcome.measuredMs, endReason: outcome.reason });
    exitCode = outcome.reason === "exited" ? outcome.exitCode ?? 0 : 0;
  } catch (e) {
    exitCode = 1;
    instance?.unmount();
    printError(e);
  } finally {
    instance?.unmount();
    plainTickerStop();
    const report = await t.cleanup();
    signals.uninstall();
    removeExit();
    if (report.cleanupErrors.length) {
      exitCode = exitCode || 3;
      err("CLEANUP INCOMPLETE (host state may need attention):");
      for (const e of report.cleanupErrors) err(`  - ${e}`);
      err("The session record was kept; the next `tangerine start` or `tangerine stop` will retry recovery.");
    }
  }
  if (outcome) out(`tangerine: session ended (${outcome.reason}${outcome.exitCode !== undefined ? `, workload exit code ${outcome.exitCode}` : ""})`);
  if (result) {
    const path = await ctx.store.save(result);
    out(formatBlock("SESSION", [result]));
    out(`saved: ${path}`);
  }
  return exitCode;
}

let tick: NodeJS.Timeout | undefined;
function startPlainTicker(t: Tangerine, args: CliArgs): void {
  if (args.quiet) return;
  tick = setInterval(() => {
    const s = t.store.snapshot;
    const parts: string[] = [];
    if (s.cpu.available) parts.push(`cpu ${s.cpu.value.totalPercent.toFixed(0)}%${s.cpu.value.tempC !== undefined ? ` ${s.cpu.value.tempC.toFixed(0)}C` : ""}`);
    if (s.memory.available) parts.push(`mem ${(s.memory.value.usedKb / 1048576).toFixed(1)}/${(s.memory.value.totalKb / 1048576).toFixed(1)}GB`);
    if (s.swap.available) parts.push(`swap ${s.swap.value.active ? "THRASH" : "ok"}`);
    parts.push(s.fps.available ? `fps ${s.fps.value.instantFps.toFixed(1)}` : "fps n/a");
    out(`[${new Date().toISOString().slice(11, 19)}] ${parts.join(" | ")}`);
  }, 5000);
  tick.unref();
}
function plainTickerStop(): void {
  if (tick) clearInterval(tick);
  tick = undefined;
}

function printError(e: unknown): void {
  if (e instanceof TangerineError) err(e.describe());
  else err(`unexpected error: ${errMsg(e)}`);
}

export async function cmdStatus(args: CliArgs): Promise<number> {
  const ctx = await createContext(args, { stderrLogs: false });
  const v = await inspectSession(ctx.sys, ctx.proc, ctx.dirs.runtime);
  if (args.json) {
    out(JSON.stringify(v ? { ...v.session, stale: v.stale, reason: v.reason } : { active: false }, null, 2));
    return 0;
  }
  if (!v) return out("No active Tangerine session."), 0;
  const s = v.session;
  out(`session ${s.sessionId}`);
  out(`  state: ${s.state}${v.stale ? "  (STALE: " + v.reason + ")" : ""}`);
  out(`  controller pid: ${s.controllerPid}   workload pid: ${s.runtimePid ?? "-"}   adapter: ${s.runtimeAdapter ?? "-"}`);
  out(`  started: ${s.startedAt}`);
  out(`  recorded host mutations: ${s.undo.length}   temp dirs: ${s.tempDirs.length}`);
  if (v.stale) out("  run `tangerine stop` to roll back what the crashed session left behind.");
  return 0;
}

export async function cmdStop(args: CliArgs): Promise<number> {
  const ctx = await createContext(args, { stderrLogs: false });
  const v = await inspectSession(ctx.sys, ctx.proc, ctx.dirs.runtime);
  if (!v) return out("No active Tangerine session."), 0;
  if (v.stale) {
    out(`Stale session found (${v.reason}); rolling back...`);
    const r = await recoverStaleSession(ctx.sys, ctx.proc, ctx.dirs.runtime, v, ctx.logger);
    for (const a of r.actions) out(`  done: ${a}`);
    for (const e of r.errors) err(`  FAILED: ${e}`);
    return r.recovered ? 0 : 3;
  }
  out(`Sending SIGTERM to Tangerine controller (pid ${v.session.controllerPid})...`);
  try {
    ctx.sys.kill(v.session.controllerPid, "SIGTERM");
  } catch (e) {
    err(`Cannot signal pid ${v.session.controllerPid}: ${errMsg(e)}`);
    return 1;
  }
  const deadline = Date.now() + ctx.loaded.config.runtime.stopTimeoutMs + 10_000;
  while (Date.now() < deadline) {
    if (!(await SessionStore.read(ctx.dirs.runtime))) return out("Session stopped and cleaned up."), 0;
    await sleep(250);
  }
  err("Session did not finish cleanup in time. Press Ctrl-C in its terminal, or run `tangerine stop` again.");
  return 1;
}

export async function cmdRestart(args: CliArgs): Promise<number> {
  const rc = await cmdStop(args);
  if (rc !== 0) return rc;
  return cmdStart(args);
}

export async function cmdInspect(args: CliArgs): Promise<number> {
  const ctx = await createContext(args, { stderrLogs: false });
  const t = new Tangerine(ctx.deps, ctx.loaded);
  const caps = await t.detectCapabilities(true);
  if (args.json) {
    const plan = ctx.loaded.config.runtime.executable ? await t.plan({ virtual: true }).catch(() => undefined) : undefined;
    out(JSON.stringify({ hardware: ctx.loaded.hardware, config: ctx.loaded.config, capabilities: { ...caps, topology: undefined, gpu: caps.gpu }, argv: plan?.argv }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
    return 0;
  }
  out(`HARDWARE: ${ctx.loaded.hardware.id}  (${ctx.loaded.hardware.cpuModel ?? "?"}, ${ctx.loaded.hardware.physicalCores}C/${ctx.loaded.hardware.logicalCpus}T, ${ctx.loaded.hardware.totalMemMb} MB)`);
  for (const n of ctx.loaded.hardware.notes) out(`  - ${n}`);
  out("\n" + renderCapabilities(caps));
  out("\nGRAPHICS");
  for (const d of caps.graphics.details) out(`  ${d}`);
  out(`  renderer: ${caps.graphics.renderer ?? "?"}  mesa: ${caps.graphics.mesaVersion ?? "?"}`);
  try {
    const sel = selectGraphics(ctx.loaded.config.graphics, caps.graphics, { benchmarkPreference: await ctx.store.graphicsPreference() });
    out(`  selected: ${sel.backend} - ${sel.reason}`);
  } catch (e) {
    printError(e);
  }
  if (ctx.loaded.config.runtime.executable) {
    try {
      out("\n" + renderPlan(await t.plan({ virtual: true }), { showEnv: false }));
    } catch (e) {
      printError(e);
    }
  } else out("\n(no runtime.executable configured: full launch plan skipped)");
  return 0;
}

export async function cmdDoctor(args: CliArgs): Promise<number> {
  const ctx = await createContext(args, { stderrLogs: false });
  const r = await runDoctor(ctx);
  if (args.json) out(JSON.stringify({ checks: r.checks, tips: r.tips }, null, 2));
  else out(renderDoctor(r));
  return r.checks.some((c) => c.status === "FAIL") ? 1 : 0;
}

const EXAMPLE_CONFIG = (hwId: string): string =>
  JSON.stringify(
    {
      "$comment": `Generated for hardware class "${hwId}". Every key is optional. Run \`tangerine config\` to see the effective values.`,
      runtime: { adapter: "auto", executable: "/home/YOU/android/run.sh", args: ["app.apk"], fpsFromStderr: false },
      graphics: { backend: "auto", vsync: true },
      performance: { profile: "balanced" },
      network: { mode: "blocked" },
      sandbox: { enabled: true, backend: "auto" },
    },
    null,
    2,
  ) + "\n";

export async function cmdConfig(args: CliArgs): Promise<number> {
  const sub = args.positional[0];
  if (sub === "path") return out(args.configPath ?? defaultConfigPath()), 0;
  const ctx = await createContext(args, { stderrLogs: false });
  if (sub === "init") {
    const path = args.configPath ?? defaultConfigPath();
    try {
      await readFile(path, "utf8");
      err(`${path} already exists; not overwriting.`);
      return 1;
    } catch {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, EXAMPLE_CONFIG(ctx.loaded.hardware.id), { flag: "wx", mode: 0o600 });
      out(`wrote ${path}`);
      return 0;
    }
  }
  out(JSON.stringify(ctx.loaded.config, null, 2));
  out(`\n# hardware class: ${ctx.loaded.hardware.id}; profile "${ctx.loaded.config.performance.profile}" set by: ${ctx.loaded.profileSource}; file: ${ctx.loaded.filePath}`);
  for (const w of ctx.loaded.warnings) out(`# warning: ${w}`);
  return 0;
}

export async function cmdLogs(args: CliArgs): Promise<number> {
  const ctx = await createContext(args, { stderrLogs: false });
  let text: string;
  try {
    text = await readFile(ctx.logFile, "utf8");
  } catch {
    return out(`No log file yet (${ctx.logFile}).`), 0;
  }
  const lines = text.trim().split("\n").slice(-(args.lines ?? 50));
  for (const l of lines) {
    try {
      out(formatRecord(JSON.parse(l) as LogRecord));
    } catch {
      out(l);
    }
  }
  return 0;
}

export async function cmdBenchmark(args: CliArgs): Promise<number> {
  const sub = args.positional[0];
  const ctx = await createContext(args, { stderrLogs: args.verbose || args.debug });
  if (sub === "list") {
    const all = await ctx.store.list();
    if (!all.length) return out("No benchmark results yet."), 0;
    for (const r of all) out(`${r.timestamp}  ${formatResultLine(r)}`);
    return 0;
  }
  if (sub === "compare") {
    const [la, lb] = [args.positional[1], args.positional[2]];
    if (!la || !lb) return err("usage: tangerine benchmark compare <labelA> <labelB>"), 2;
    const [a, b] = [await ctx.store.byLabel(la), await ctx.store.byLabel(lb)];
    if (!a.length || !b.length) return err(`No stored results for label ${!a.length ? la : lb}.`), 1;
    out(formatBlock(`BASELINE (${la})`, a) + "\n\n" + formatBlock(`CONFIGURATION B (${lb})`, b) + "\n\n" + formatComparison(compareRuns(a, b)));
    return 0;
  }
  requireWorkload(ctx);

  const caps = await new Tangerine(ctx.deps, ctx.loaded).detectCapabilities(false);
  if (args.experiment && !["cpu", "graphics", "memory", "compositor"].includes(args.experiment)) return err("--experiment must be cpu|graphics|memory|compositor"), 2;
  const experiment = args.experiment ? buildExperiment(args.experiment as ExperimentKind, caps) : undefined;
  const steps = experiment?.steps ?? [{ label: args.positional[0] ?? "default", overlay: {} }];
  if (experiment) {
    out(`EXPERIMENT ${experiment.kind}: ${experiment.description}`);
    for (const s of experiment.skipped) out(`  skipped: ${s}`);
  }
  if (!steps.length) return err("nothing to run"), 1;
  const runs = args.runs ?? (experiment ? 3 : 1);
  const durationMs = (args.durationSec ?? 60) * 1000;
  const opts = { runs, durationMs, warmupMs: (args.warmupSec ?? 5) * 1000, cooldownMs: (args.cooldownSec ?? 10) * 1000 };
  out(`${steps.length} configuration(s) x ${runs} run(s) x ${args.durationSec ?? 60}s (+${args.warmupSec ?? 5}s warm-up, ${args.cooldownSec ?? 10}s cool-down). Close other applications for cleaner data.`);

  let aborted = false;
  let current: Tangerine | undefined;
  const signals = new SignalManager(ctx.logger, () => { aborted = true; current?.requestShutdown("signal"); }, () => current?.processManager.killAllSync());
  signals.install();

  const handle: SessionHandle = {
    async runOnce(o) {
      if (aborted) throw new Error("aborted");
      const t = new Tangerine({ ...ctx.deps, capabilities: caps }, withOverlay(ctx.loaded, o.overlay));
      current = t;
      const removeExit = installExitHandler(t.processManager);
      try {
        await t.start();
        const outcome = await t.run({ durationMs: o.durationMs, warmupMs: o.warmupMs });
        await t.stop();
        const r = await t.benchmarkResult({ label: o.label, runIndex: o.runIndex, overlay: o.overlay, measuredMs: outcome.measuredMs, endReason: outcome.reason });
        if (outcome.reason === "exited") out(`  note: workload exited early (code ${outcome.exitCode}) after ${(outcome.measuredMs / 1000).toFixed(1)}s: result may be unrepresentative`);
        await ctx.store.save(r);
        out("  " + formatResultLine(r));
        return r;
      } finally {
        const rep = await t.cleanup();
        removeExit();
        if (rep.cleanupErrors.length) for (const e of rep.cleanupErrors) err(`  cleanup problem: ${e}`);
      }
    },
  };
  const runner = new BenchmarkRunner(handle, ctx.logger, (m) => out(m));
  const results = await runner.runSteps(steps, opts);
  signals.uninstall();

  const labels = steps.map((s) => s.label);
  let i = 0;
  for (const l of labels) out("\n" + formatBlock(i++ === 0 ? `BASELINE (${l})` : `CONFIGURATION ${String.fromCharCode(65 + i - 1)} (${l})`, results.get(l) ?? []));
  for (let k = 1; k < labels.length; k++) {
    const a = results.get(labels[k - 1] as string) ?? [];
    const b = results.get(labels[k] as string) ?? [];
    if (a.length && b.length) out("\n" + formatComparison(compareRuns(a, b)));
  }
  if (args.savePreference && experiment?.kind === "graphics") await maybeSavePreference(ctx, results, out);
  return aborted ? 130 : 0;
}

async function maybeSavePreference(ctx: Context, results: Map<string, BenchmarkResult[]>, log: (s: string) => void): Promise<void> {
  const gl = results.get("opengl");
  const vk = results.get("vulkan");
  if (!gl?.length || !vk?.length) return log("preference not saved: need both opengl and vulkan results");
  const rep = compareRuns(gl, vk);
  const fps = rep.metrics.find((m) => m.metric === "FPS (avg)");
  const p95 = rep.metrics.find((m) => m.metric === "Frame time (p95)");
  if (!fps || fps.verdict === "n/a" || fps.verdict === "unverified-single-run" || fps.verdict === "within-noise") return log(`preference not saved: FPS difference is ${fps?.verdict ?? "n/a"}`);
  const vulkanBetter = fps.verdict === "higher";
  if (p95 && ((vulkanBetter && p95.verdict === "higher") || (!vulkanBetter && p95.verdict === "lower"))) return log("preference not saved: average FPS and p95 frame time disagree");
  const backend = vulkanBetter ? "vulkan" : "opengl";
  await ctx.store.saveGraphicsPreference(backend, `avgFps ${fps.a?.mean.toFixed(1)} (opengl) vs ${fps.b?.mean.toFixed(1)} (vulkan), n=${gl.length}/${vk.length}`);
  log(`saved graphics preference for 'auto': ${backend} (measured on this workload/driver; re-run after driver updates)`);
}

export function cmdHelp(): number {
  out(HELP);
  return 0;
}
