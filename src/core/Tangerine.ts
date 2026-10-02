import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TangerineConfig, MountSpec } from "../config/schema.js";
import type { LoadedConfig } from "../config/loader.js";
import type { HardwareClass } from "../performance/HardwareProfile.js";
import { CapabilityManager, type HostCapabilities } from "./CapabilityManager.js";
import { StateMachine, type TangerineState } from "./Lifecycle.js";
import { MutationManager, type MutationReport } from "./MutationManager.js";
import { SessionStore, type Dirs } from "./SessionStore.js";
import { inspectSession, recoverStaleSession } from "./Recovery.js";
import { TangerineError, errMsg } from "./Errors.js";
import type { LinuxSystem } from "../system/Linux.js";
import type { ProcFs } from "../system/ProcFs.js";
import type { SysFs } from "../system/SysFs.js";
import { detectPlatform, type PlatformInfo, type RuntimePlatform } from "../system/Platform.js";
import { PerformanceManager, type PerformancePlan } from "../performance/PerformanceManager.js";
import { SandboxManager, type SandboxPlan } from "../sandbox/SandboxManager.js";
import type { ValidatedMount } from "../sandbox/FilesystemPolicy.js";
import { buildScopeArgs, scopeUnitName } from "../sandbox/CgroupManager.js";
import { NetworkManager } from "../network/NetworkManager.js";
import type { NetworkPlan } from "../network/NetworkPolicy.js";
import type { FirewallStatus } from "../network/FirewallManager.js";
import { MountManager, SANDBOX_HOME, SANDBOX_SHADER_CACHE } from "../runtime/MountManager.js";
import { buildEnvironment, type BuiltEnvironment } from "../runtime/EnvironmentBuilder.js";
import type { RuntimeManager } from "../runtime/RuntimeManager.js";
import type { RuntimeAdapter, RuntimeRequest } from "../runtime/RuntimeAdapter.js";
import { ProcessManager } from "../process/ProcessManager.js";
import type { ChildManagedProcess } from "../process/ManagedProcess.js";
import { MetricsStore } from "../monitoring/MetricsStore.js";
import { MonitorManager } from "../monitoring/MonitorManager.js";
import { CpuMonitor } from "../monitoring/CpuMonitor.js";
import { MemoryMonitor } from "../monitoring/MemoryMonitor.js";
import { SwapMonitor, SwapPressureDetector } from "../monitoring/SwapMonitor.js";
import { ProcessMonitor } from "../monitoring/ProcessMonitor.js";
import { GpuMonitor } from "../monitoring/GpuMonitor.js";
import { FpsMonitor } from "../monitoring/FpsMonitor.js";
import type { BenchmarkStore } from "../benchmark/BenchmarkStore.js";
import { captureSystemState } from "../benchmark/Baseline.js";
import { newResultId, type BenchmarkResult } from "../benchmark/BenchmarkRunner.js";
import { monotonicMs } from "../utils/Timing.js";
import { sleep, withTimeout } from "../utils/Async.js";
import type { Logger } from "../utils/Logger.js";
import { deepMerge, deepFreeze } from "../utils/Validation.js";
import { assertValid } from "../config/validator.js";
import type { PartialConfig } from "../config/schema.js";

export interface TangerineDeps {
  sys: LinuxSystem;
  proc: ProcFs;
  sysfs: SysFs;
  platform: RuntimePlatform;
  logger: Logger;
  dirs: Dirs;
  runtimeManager: RuntimeManager;
  benchmarkStore?: BenchmarkStore;
  /** Reuse across sessions (benchmark loops) to avoid re-probing the host. */
  capabilities?: HostCapabilities;
}

export interface SessionPlan {
  sessionId: string;
  config: Readonly<TangerineConfig>;
  platform: PlatformInfo;
  hardware: HardwareClass;
  caps: HostCapabilities;
  runtimeId: string;
  runtimeVersion?: string;
  executable: string;
  performance: PerformancePlan;
  sandbox: SandboxPlan;
  network: NetworkPlan;
  firewall: FirewallStatus;
  scopeWrapper: string[];
  mounts: ValidatedMount[];
  environment: BuiltEnvironment;
  wrapper: string[];
  argv: string[];
  plannedMutations: string[];
  privileges: string[];
  warnings: string[];
  notes: string[];
}

export interface RunOutcome {
  reason: "exited" | "duration" | "shutdown";
  exitCode?: number;
  /** Measured time after warm-up. */
  measuredMs: number;
}

export interface FinalReport {
  state: TangerineState;
  mutations: MutationReport[];
  cleanupErrors: string[];
  exitCode?: number;
}

export class Tangerine {
  readonly store = new MetricsStore();
  readonly machine = new StateMachine();
  readonly processManager: ProcessManager;
  readonly sessionId = randomUUID();
  private plan_?: SessionPlan;
  private mm?: MutationManager;
  private session?: SessionStore;
  private adapter?: RuntimeAdapter;
  private proc?: ChildManagedProcess;
  private monitors?: MonitorManager;
  private fps?: FpsMonitor;
  private startupMs = 0;
  private cleanupDone = false;
  private cleanupPromise?: Promise<FinalReport>;
  private shutdownResolve?: (reason: string) => void;
  private readonly shutdownP: Promise<string>;
  private cacheOutcome?: { beforeAvailableKb: number; afterAvailableKb: number };
  private runStartedAt = 0;
  private lastExit?: number;
  private readonly mounts: MountManager;
  private readonly perf: PerformanceManager;
  private readonly logger: Logger;

  constructor(
    private readonly deps: TangerineDeps,
    readonly loaded: LoadedConfig,
  ) {
    this.logger = deps.logger.child("core");
    this.processManager = new ProcessManager(deps.platform, deps.logger.child("process"));
    this.mounts = new MountManager(deps.sys, deps.logger.child("mount"));
    this.perf = new PerformanceManager(deps.sys, deps.proc);
    this.shutdownP = new Promise((r) => (this.shutdownResolve = r));
  }

  get config(): Readonly<TangerineConfig> {
    return this.loaded.config;
  }
  get currentPlan(): SessionPlan | undefined {
    return this.plan_;
  }
  get workloadPid(): number | undefined {
    return this.proc?.pid;
  }
  get fpsMonitor(): FpsMonitor | undefined {
    return this.fps;
  }

  async detectCapabilities(deep = false): Promise<HostCapabilities> {
    if (this.deps.capabilities && !deep) return this.deps.capabilities;
    const caps = await new CapabilityManager(this.deps.sys, this.deps.proc, this.deps.sysfs).detect({ deepGraphics: deep });
    this.logger.info("capabilities", { cpuAffinity: caps.cpuAffinity, cgroups: caps.cgroups, namespaces: caps.namespaces, bwrap: caps.bwrap, opengl: caps.opengl, vulkan: caps.vulkan, realtime: caps.realtimeScheduling });
    return caps;
  }

  /**
   * Read-only planning: DETECT PLATFORM .. BUILD ENVIRONMENT. Performs no host mutation, which
   * is why `tangerine start --dry-run` is built on it. In virtual mode the private session
   * directory does not exist yet, so its mount is listed in notes instead.
   */
  async plan(opts: { virtual: boolean }): Promise<SessionPlan> {
    const { sys, proc, dirs } = this.deps;
    const cfg = this.config;
    const warnings: string[] = [...this.loaded.warnings];
    const notes: string[] = [];

    this.machine.setPhase("DETECT PLATFORM");
    const platform = await detectPlatform(sys, proc);
    if (!platform.isLinux) throw new TangerineError({ code: "INTERNAL", subsystem: "platform", message: "Tangerine only supports Linux", recoverable: false });
    if (!platform.isX86_64) warnings.push(`architecture ${platform.arch}: Tangerine targets x86_64`);

    this.machine.setPhase("DETECT CAPABILITIES");
    const caps = await this.detectCapabilities();

    this.machine.setPhase("CREATE RUNTIME PLAN");
    const adapter = await this.deps.runtimeManager.resolve(cfg.runtime);
    if (!(await adapter.detect())) {
      throw new TangerineError({ code: "RUNTIME_NOT_FOUND", subsystem: "runtime", message: `Runtime adapter "${adapter.id}" did not detect a usable runtime`, recoverable: false, hint: "Check runtime.executable." });
    }
    this.adapter = adapter;
    const executable = adapter.getExecutable() ?? cfg.runtime.executable ?? "";
    const mem = await proc.readMemInfo();
    const selfPids = new Set<number>([process.pid, process.ppid]);
    const pref = await this.deps.benchmarkStore?.graphicsPreference();
    const shaderDir = join(dirs.cache, "shader-cache");
    const performance = await this.perf.plan(cfg, caps, mem, selfPids, { benchmarkPreference: pref, shaderCacheHostDir: shaderDir });

    this.machine.setPhase("CREATE NETWORK POLICY");
    const sandboxWanted = cfg.sandbox.enabled && cfg.sandbox.backend !== "none" && cfg.sandbox.networkNamespace;
    const { plan: network, firewall } = new NetworkManager().plan(cfg.network, caps, sandboxWanted);
    warnings.push(...network.warnings);

    this.machine.setPhase("PREPARE MOUNTS");
    const home = this.deps.sys.env()["HOME"] ?? "/";
    const sessionDir = this.mounts.sessionDir;
    const sys0 = await this.mounts.systemMounts(cfg.sandbox, sys.env(), performance.graphics.shaderCacheHostDir, !opts.virtual);
    const homeMount: MountSpec[] = sessionDir
      ? []
      : [{ source: join(dirs.runtime, "session-pending", "home"), target: SANDBOX_HOME, kind: "bind", readOnly: false, optional: true, purpose: "private empty HOME for the workload" }];
    if (!sessionDir) notes.push("private HOME directory is created at start (not part of a dry-run)");
    const allMounts: MountSpec[] = [...sys0.mounts, ...homeMount, ...adapter.getMounts(), ...cfg.runtime.mounts];

    // Sandbox plan needs the network decision; the wrapper is built after the working directory is known.
    const sandbox = await new SandboxManager(sys).plan(
      { config: cfg.sandbox, needNetNamespace: network.needNetNamespace, mounts: allMounts, home, allowedPrefixes: sys0.allowedPrefixes },
      caps,
    );
    warnings.push(...sandbox.warnings);
    // Only bubblewrap provides the private mount tree that maps the cache to /tangerine/shader-cache; otherwise use the host path directly.
    const gfx = performance.graphics;
    if (gfx.shaderCacheHostDir && !(sandbox.backend === "bwrap" && sandbox.mounts.some((m) => m.target === SANDBOX_SHADER_CACHE))) {
      gfx.environment["MESA_SHADER_CACHE_DIR"] = gfx.shaderCacheHostDir;
    }
    const caps_ = adapter.getCapabilities();
    if (!caps_.wrappable && network.needNetNamespace) {
      throw new TangerineError({ code: "NETWORK_POLICY_FAILED", subsystem: "network", message: `Runtime "${adapter.id}" cannot be wrapped, so the requested network isolation cannot be enforced.`, recoverable: false, fallback: "none (fail-closed)", hint: "Use network.mode=unrestricted explicitly if this runtime must be used." });
    }

    this.machine.setPhase("BUILD ENVIRONMENT");
    const sandboxedHome = sandbox.backend === "bwrap" && sandbox.mounts.some((m) => m.target === SANDBOX_HOME);
    const environment = buildEnvironment({
      host: sys.env(),
      runtime: adapter.getEnvironment(),
      graphics: performance.graphics,
      performance: {},
      sandbox: sandboxedHome ? { HOME: SANDBOX_HOME, TMPDIR: "/tmp" } : {},
      sandboxed: sandboxedHome,
      userOverrides: { ...cfg.runtime.env },
      passEnv: cfg.runtime.passEnv,
    });
    for (const r of environment.rejected) warnings.push(`environment: dropped ${r.key} (${r.why})`);

    const scopeWrapper =
      performance.memory.highBytes && caps.systemdScope && cfg.performance.useSystemdScope
        ? buildScopeArgs({ unitName: scopeUnitName(this.sessionId), memoryHighBytes: performance.memory.highBytes })
        : [];
    const cwd = cfg.runtime.workingDirectory ?? (sandboxedHome ? SANDBOX_HOME : undefined);
    const wrapper = caps_.wrappable ? [...scopeWrapper, ...performance.affinity.wrapper, ...performance.scheduler.wrapper, ...sandbox.buildWrapper({ cwd, home: sandboxedHome ? SANDBOX_HOME : undefined })] : [];
    if (!caps_.wrappable) warnings.push(`runtime "${adapter.id}" is not wrappable: affinity/priority/sandbox are not applied`);

    const plannedMutations: string[] = [];
    if (performance.memory.cacheDrop) plannedMutations.push("drop page cache once before launch (needs root; irreversible, cache refills)");
    if (performance.compositor.disable) plannedMutations.push("disable Marco compositing via gsettings (restored on exit)");
    for (const r of performance.background) for (const p of r.pids) plannedMutations.push(`${r.rule.action}: ${p.name}(${p.pid})`);

    const privileges: string[] = [];
    if (cfg.cpu.nice < 0 && performance.scheduler.nice < 0) privileges.push("CAP_SYS_NICE or RLIMIT_NICE (negative nice)");
    if (performance.scheduler.policy === "rr") privileges.push("CAP_SYS_NICE or RLIMIT_RTPRIO (SCHED_RR)");
    if (performance.memory.cacheDrop) privileges.push("root (write /proc/sys/vm/drop_caches)");
    if (sandbox.enabled) privileges.push(sandbox.backend === "bwrap" ? "unprivileged user namespaces (bubblewrap)" : "unprivileged user namespaces (unshare)");
    if (scopeWrapper.length) privileges.push("systemd user session (transient cgroup scope; no root)");
    if (performance.compositor.disable) privileges.push("session D-Bus + gsettings (no root)");
    if (!privileges.length) privileges.push("none (runs fully unprivileged)");

    const argv = [...wrapper, executable, ...cfg.runtime.args];
    this.plan_ = {
      sessionId: this.sessionId, config: cfg, platform, hardware: this.loaded.hardware, caps, runtimeId: adapter.id, runtimeVersion: adapter.version, executable,
      performance, sandbox, network, firewall, scopeWrapper, mounts: sandbox.mounts, environment, wrapper, argv, plannedMutations, privileges,
      warnings: [...new Set([...warnings, ...performance.warnings])], notes,
    };
    return this.plan_;
  }

  async start(): Promise<void> {
    const t0 = monotonicMs();
    try {
      this.machine.transition("initializing");
      this.machine.setPhase("INITIALIZE");
      await this.recoverStale();
      const ticks = (await this.deps.proc.readProcessStat(process.pid))?.startTimeTicks;
      this.session = new SessionStore(this.deps.dirs.runtime, { controllerPid: process.pid, controllerStartTicks: ticks, command: this.config.runtime.executable });
      // Use our own session id everywhere (scope unit, logs, session file).
      await this.session.update({ sessionId: this.sessionId, state: "initializing" });
      this.mm = new MutationManager(this.deps.logger.child("mutation"), this.session);

      this.machine.transition("preparing");
      const dir = await this.mounts.createSessionDir(this.deps.dirs.runtime, this.sessionId);
      await this.session.addTempDir(dir.path);
      const plan = await this.plan({ virtual: false });
      for (const w of plan.warnings) this.logger.warn("plan.warning", { warning: w });
      await this.session.update({ state: "preparing", runtimeAdapter: plan.runtimeId });

      this.machine.transition("starting");
      this.machine.setPhase("APPLY PERFORMANCE POLICY");
      const muts = await this.perf.mutations(plan.performance, this.mm, (o) => (this.cacheOutcome = o));
      for (const m of muts) {
        try {
          await this.mm.apply(m);
        } catch (e) {
          if (e instanceof TangerineError && e.recoverable) this.logger.warn("mutation.skipped", { description: m.description, error: e.message });
          else throw e;
        }
      }

      this.machine.setPhase("START RUNTIME");
      const adapter = this.adapter as RuntimeAdapter;
      await adapter.prepare({ config: this.config.runtime, graphics: plan.performance.graphics, sessionDir: dir.path, sys: this.deps.sys, logger: this.deps.logger.child("runtime") });
      const request: RuntimeRequest = {
        executable: plan.executable,
        args: [...this.config.runtime.args],
        workingDirectory: this.config.runtime.workingDirectory,
        environment: plan.environment.env,
        mounts: plan.mounts,
        graphics: this.config.graphics,
        cpu: this.config.cpu,
        network: this.config.network,
        sandbox: this.config.sandbox,
      };
      this.proc = await adapter.start({ request, env: plan.environment.env, wrapper: plan.wrapper, processManager: this.processManager });
      const st = await this.deps.proc.readProcessStat(this.proc.pid);
      await this.session.update({ runtimePid: this.proc.pid, runtimeStartTicks: st?.startTimeTicks, state: "running" });
      this.startupMs = monotonicMs() - t0;

      this.machine.setPhase("START MONITORING");
      this.startMonitors();
      this.machine.transition("running");
      this.machine.setPhase("RUN TARGET");
      this.logger.info("session.running", { runtime: plan.runtimeId, pid: this.proc.pid, startupMs: this.startupMs, graphics: plan.performance.graphics.backend });
    } catch (e) {
      this.logger.error("session.start_failed", { error: errMsg(e) });
      if (this.machine.canTransition("failed")) this.machine.transition("failed");
      await this.cleanup(); // roll back everything applied so far
      throw e;
    }
  }

  private startMonitors(): void {
    const { proc, sysfs, logger } = this.deps;
    const cfg = this.config;
    const m = new MonitorManager(logger.child("monitor"));
    m.add(new CpuMonitor(proc, sysfs, this.store), cfg.monitoring.cpuIntervalMs);
    if (cfg.memory.monitor) m.add(new MemoryMonitor(proc, this.store), cfg.monitoring.memoryIntervalMs);
    if (cfg.memory.swapMonitoring) {
      const th = { activePagesPerSec: cfg.memory.swapInActivePagesPerSec, inactivePagesPerSec: cfg.memory.swapInInactivePagesPerSec };
      m.add(new SwapMonitor(proc, this.store, new SwapPressureDetector(th)), cfg.monitoring.memoryIntervalMs);
    }
    m.add(new ProcessMonitor(proc, this.store, () => (this.proc?.isRunning ? this.proc.pid : undefined)), cfg.monitoring.processIntervalMs);
    m.add(new GpuMonitor(sysfs, this.store), cfg.monitoring.gpuIntervalMs);
    this.fps = new FpsMonitor(this.store, cfg.runtime.fpsFromStderr ? "workload output" : undefined);
    m.add(this.fps, cfg.monitoring.fpsIntervalMs);
    if (cfg.runtime.fpsFromStderr && this.proc) {
      const feed = lineFeeder((l) => this.fps?.ingestLine(l));
      this.proc.onStderr(feed);
      this.proc.onStdout(feed);
    }
    this.monitors = m;
    m.start();
  }

  private async recoverStale(): Promise<void> {
    const { sys, proc, dirs } = this.deps;
    const verdict = await inspectSession(sys, proc, dirs.runtime);
    if (!verdict) return;
    if (!verdict.stale) {
      throw new TangerineError({ code: "SESSION_ACTIVE", subsystem: "session", message: `Another Tangerine session (pid ${verdict.session.controllerPid}) is already running.`, recoverable: false, hint: "Run `tangerine stop` first." });
    }
    this.logger.warn("session.stale_found", { reason: verdict.reason, sessionId: verdict.session.sessionId });
    const r = await recoverStaleSession(sys, proc, dirs.runtime, verdict, this.logger.child("recovery"));
    if (!r.recovered) {
      throw new TangerineError({ code: "STALE_SESSION", subsystem: "recovery", message: `Could not fully clean a stale session: ${r.errors.join("; ")}`, recoverable: false, hostModified: true, hint: "Inspect the session file and undo manually, then remove it." });
    }
  }

  /** Waits for the workload to exit, the duration to elapse, or a shutdown request - whichever comes first. */
  async run(opts: { durationMs?: number; warmupMs?: number } = {}): Promise<RunOutcome> {
    const proc = this.proc;
    if (!proc || this.machine.state !== "running") {
      throw new TangerineError({ code: "INVALID_STATE_TRANSITION", subsystem: "lifecycle", message: `run() requires state "running" (is "${this.machine.state}")`, recoverable: false });
    }
    const warmup = opts.warmupMs ?? 0;
    this.runStartedAt = monotonicMs();
    const ac = new AbortController();
    const exited = proc.wait().then((code): RunOutcome["reason"] => ((this.lastExit = code), "exited"));
    const shutdown = this.shutdownP.then((): RunOutcome["reason"] => "shutdown");
    const contenders: Promise<RunOutcome["reason"]>[] = [exited, shutdown];
    if (opts.durationMs !== undefined) contenders.push(sleep(warmup + opts.durationMs, ac.signal).then((): RunOutcome["reason"] => "duration"));
    if (warmup > 0) void sleep(warmup, ac.signal).then(() => { if (!ac.signal.aborted) this.resetAggregates(); this.runStartedAt = monotonicMs(); });
    const reason = await Promise.race(contenders);
    ac.abort();
    this.machine.setPhase("COLLECT TELEMETRY");
    return { reason, exitCode: proc.exitCode, measuredMs: monotonicMs() - this.runStartedAt };
  }

  private resetAggregates(): void {
    for (const s of Object.values(this.store.series)) s.clear();
    this.fps?.acc.reset();
  }

  requestShutdown(reason: string): void {
    this.logger.info("shutdown.requested", { reason });
    this.shutdownResolve?.(reason);
  }

  /** Graceful stop of the workload and monitors. Host rollback happens in cleanup(). */
  async stop(): Promise<void> {
    if (this.machine.state === "running" || this.machine.state === "starting") this.machine.transition("stopping");
    this.machine.setPhase("STOP TARGET");
    this.processManager.stopAccepting();
    const stopTimeout = this.config.runtime.stopTimeoutMs;
    if (this.adapter) await withTimeout(this.adapter.stop().catch((e) => this.logger.error("runtime.stop_failed", { error: errMsg(e) })), stopTimeout + 5000);
    this.proc?.signalGroup("SIGKILL"); // stragglers that stayed in the workload's process group
    await this.processManager.terminateAll(Math.min(stopTimeout, 3000));
    this.machine.setPhase("STOP MONITORS");
    this.monitors?.stop();
  }

  /** Idempotent: concurrent/repeated calls share one cleanup run (spec §40). */
  cleanup(): Promise<FinalReport> {
    this.cleanupPromise ??= this.doCleanup();
    return this.cleanupPromise;
  }

  private async doCleanup(): Promise<FinalReport> {
    const errors: string[] = [];
    const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(`${name}: ${errMsg(e)}`);
        this.logger.error("cleanup.step_failed", { step: name, error: errMsg(e) });
      }
    };
    if (this.machine.state !== "cleaning" && this.machine.state !== "stopped" && this.machine.canTransition("cleaning")) this.machine.transition("cleaning");
    this.monitors?.stop();
    await step("terminate processes", async () => {
      this.proc?.signalGroup("SIGKILL");
      await this.processManager.terminateAll(Math.min(this.config.runtime.stopTimeoutMs, 3000));
    });
    this.machine.setPhase("ROLL BACK MUTATIONS");
    await step("rollback mutations", async () => {
      const reports = (await this.mm?.rollbackAll()) ?? [];
      for (const r of reports) if (r.status === "failed-rollback") errors.push(`rollback ${r.description}: ${r.error}`);
    });
    await step("runtime cleanup", async () => this.adapter?.cleanup());
    this.machine.setPhase("UNMOUNT RESOURCES");
    await step("remove private session dir", () => this.mounts.destroy());
    this.machine.setPhase("DESTROY SANDBOX");
    await step("remove session record", async () => (errors.length ? undefined : this.session?.remove()));
    this.cleanupDone = true;
    if (this.machine.canTransition("stopped")) this.machine.transition("stopped");
    this.machine.setPhase("FINAL REPORT");
    if (errors.length) this.logger.error("cleanup.incomplete", { errors });
    else this.logger.info("cleanup.complete");
    return { state: this.machine.state, mutations: this.mm?.report() ?? [], cleanupErrors: errors, exitCode: this.lastExit };
  }

  get isCleaned(): boolean {
    return this.cleanupDone;
  }

  /** Builds the benchmark record from live telemetry. Unmeasured values stay undefined (never 0). */
  async benchmarkResult(meta: { label: string; runIndex: number; overlay: PartialConfig; measuredMs: number; endReason: string }): Promise<BenchmarkResult> {
    const plan = this.plan_ as SessionPlan;
    const s = this.store.series;
    const fpsStats = this.fps?.acc.snapshot(true);
    const fpsMetric = this.fps?.metric();
    const system = await captureSystemState({ platform: plan.platform, caps: plan.caps, config: this.config, runtimeId: plan.runtimeId, runtimeVersion: plan.runtimeVersion, sys: this.deps.sys, proc: this.deps.proc });
    return {
      id: newResultId(),
      timestamp: new Date().toISOString(),
      durationMs: Math.round(meta.measuredMs),
      graphicsBackend: plan.performance.graphics.backend,
      cpuAffinity: plan.performance.affinity.applied ? plan.performance.affinity.cpus : undefined,
      schedulerPolicy: plan.performance.scheduler.policy,
      avgFps: fpsStats?.avgFps,
      minFps: fpsStats?.minFps,
      avgFrameTimeMs: fpsStats?.avgFrameTimeMs,
      frameTimeP95Ms: fpsStats?.frameTimeP95Ms,
      frameTimeStdDevMs: fpsStats?.frameTimeStdDevMs,
      droppedFrames: fpsStats?.droppedFrames,
      fpsSource: fpsStats?.source,
      fpsUnavailableReason: fpsStats ? undefined : fpsMetric && !fpsMetric.available ? fpsMetric.reason : "No supported frame timing source",
      cpuUsagePercent: s.cpuPercent.mean() ?? NaN,
      memoryUsageMb: s.memoryUsedMb.mean() ?? NaN,
      swapInPerSecond: s.swapInPerSec.mean() ?? 0,
      swapOutPerSecond: s.swapOutPerSec.mean() ?? 0,
      startupTimeMs: Math.round(this.startupMs),
      processRssMb: s.processRssMb.mean(),
      cpuFreqMhzAvg: s.cpuMhz.mean(),
      cpuTempMaxC: undefined,
      exitCode: this.proc?.exitCode,
      endReason: meta.endReason,
      label: meta.label,
      runIndex: meta.runIndex,
      profile: plan.performance.profile,
      niceLevel: plan.performance.scheduler.nice,
      sandboxBackend: plan.sandbox.backend,
      networkMode: plan.network.effective,
      system,
      overlay: meta.overlay,
    };
  }
}

/** Turns arbitrary stream chunks into complete lines. */
export function lineFeeder(onLine: (line: string) => void): (chunk: string) => void {
  let carry = "";
  return (chunk) => {
    carry += chunk;
    let i: number;
    while ((i = carry.indexOf("\n")) >= 0) {
      onLine(carry.slice(0, i));
      carry = carry.slice(i + 1);
    }
    if (carry.length > 8192) carry = ""; // never buffer an unbounded line
  };
}

/** Derives a validated, frozen session config from `loaded` + overlay (used by experiments). The original is untouched. */
export function withOverlay(loaded: LoadedConfig, overlay: PartialConfig): LoadedConfig {
  const merged = deepMerge(loaded.config as TangerineConfig, overlay);
  const warnings = assertValid(merged);
  return { ...loaded, config: deepFreeze(merged), warnings };
}
