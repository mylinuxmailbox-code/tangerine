import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, chmod, readdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tangerine, type TangerineDeps } from "../src/core/Tangerine.js";
import { RealCommandRunner } from "../src/system/Commands.js";
import { RealLinuxSystem } from "../src/system/Linux.js";
import { LinuxProcFs } from "../src/system/ProcFs.js";
import { LinuxSysFs } from "../src/system/SysFs.js";
import { detectPlatform, detectRuntimePlatform } from "../src/system/Platform.js";
import { classifyHardware } from "../src/performance/HardwareProfile.js";
import { loadConfig, type LoadedConfig } from "../src/config/loader.js";
import { createDefaultRuntimeManager } from "../src/runtime/RuntimeManager.js";
import { Logger } from "../src/utils/Logger.js";
import { SessionStore } from "../src/core/SessionStore.js";
import type { PartialConfig } from "../src/config/schema.js";

interface Env { root: string; dirs: { runtime: string; state: string; cache: string }; script: string; deps: TangerineDeps; loaded: (extra?: PartialConfig) => Promise<LoadedConfig>; cleanup: () => Promise<void> }

/** Real Linux, but every directory lives in a private tmp tree; sandbox + network isolation disabled so no privileges are needed. */
async function setup(scriptBody: string): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "tangerine-it-"));
  const dirs = { runtime: join(root, "run", "tangerine"), state: join(root, "state"), cache: join(root, "cache") };
  const script = join(root, "workload.sh");
  await writeFile(script, `#!/bin/sh\n${scriptBody}\n`);
  await chmod(script, 0o755);
  const logger = Logger.create("error");
  const sys = new RealLinuxSystem(new RealCommandRunner());
  const proc = new LinuxProcFs(sys);
  const sysfs = new LinuxSysFs(sys);
  const platform = await detectPlatform(sys, proc);
  const hardware = classifyHardware(platform, await sysfs.readCpuTopology());
  const deps: TangerineDeps = { sys, proc, sysfs, platform: detectRuntimePlatform(), logger, dirs, runtimeManager: createDefaultRuntimeManager(sys) };
  const loaded = (extra: PartialConfig = {}): Promise<LoadedConfig> =>
    loadConfig({
      hardware,
      filePath: join(root, "none.json"),
      env: { HOME: root },
      cli: {
        runtime: { executable: script, args: [], stopTimeoutMs: 1500, fpsFromStderr: true },
        sandbox: { enabled: false },
        network: { mode: "unrestricted" },
        performance: { useSystemdScope: false },
        graphics: { shaderCache: false },
        monitoring: { cpuIntervalMs: 200, memoryIntervalMs: 200, processIntervalMs: 200, gpuIntervalMs: 500, fpsIntervalMs: 200 },
        ...extra,
      } as PartialConfig,
    });
  return { root, dirs, script, deps, loaded, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("integration: start -> run -> stop -> cleanup leaves nothing behind", async () => {
  const env = await setup(`trap 'exit 0' TERM INT\nwhile :; do echo "frame time: 16.0 ms" >&2; sleep 0.1; done`);
  try {
    const t = new Tangerine(env.deps, await env.loaded());
    await t.start();
    assert.equal(t.machine.state, "running");
    const pid = t.workloadPid;
    assert.ok(pid && alive(pid));
    const session = await SessionStore.read(env.dirs.runtime);
    assert.equal(session?.runtimePid, pid, "session record names the workload so crash recovery can find it");
    const outcome = await t.run({ durationMs: 1200 });
    assert.equal(outcome.reason, "duration");
    const fpsStats = t.fpsMonitor?.acc.snapshot(true);
    assert.ok(fpsStats && fpsStats.avgFps > 55 && fpsStats.avgFps < 65, `fps derived from real frame times, got ${fpsStats?.avgFps}`);
    await t.stop();
    const report = await t.cleanup();
    assert.equal(report.state, "stopped");
    assert.deepEqual(report.cleanupErrors, []);
    assert.equal(alive(pid), false, "workload is gone");
    assert.equal(await SessionStore.read(env.dirs.runtime), undefined, "session record removed");
    const left = await readdir(env.dirs.runtime).catch(() => []);
    assert.deepEqual(left.filter((n) => n.startsWith("session-")), [], "private session dir removed");
    assert.equal((await t.cleanup()).state, "stopped", "cleanup is idempotent");
  } finally {
    await env.cleanup();
  }
});

test("integration: requestShutdown ends run() early and the stopped workload group is fully gone", async () => {
  const env = await setup(`sleep 300 &\necho $! > "$0.child"\nwait`);
  try {
    const t = new Tangerine(env.deps, await env.loaded());
    await t.start();
    const pid = t.workloadPid as number;
    setTimeout(() => t.requestShutdown("test"), 400);
    const outcome = await t.run({});
    assert.equal(outcome.reason, "shutdown");
    await t.stop();
    const r = await t.cleanup();
    assert.deepEqual(r.cleanupErrors, []);
    assert.equal(alive(pid), false);
    const child = Number((await readFile(`${env.script}.child`, "utf8")).trim());
    await new Promise((r2) => setTimeout(r2, 200));
    assert.equal(alive(child), false, "background grandchild killed with the process group");
  } finally {
    await env.cleanup();
  }
});

test("integration: a workload that exits by itself is reported, not treated as an error", async () => {
  const env = await setup(`exit 7`);
  try {
    const t = new Tangerine(env.deps, await env.loaded());
    await t.start();
    const outcome = await t.run({ durationMs: 5000 });
    assert.equal(outcome.reason, "exited");
    assert.equal(outcome.exitCode, 7);
    await t.stop();
    const r = await t.cleanup();
    assert.deepEqual(r.cleanupErrors, []);
  } finally {
    await env.cleanup();
  }
});

test("integration: missing executable fails with a structured error and leaves no session behind", async () => {
  const env = await setup(`true`);
  try {
    const t = new Tangerine(env.deps, await env.loaded({ runtime: { executable: join(env.root, "missing") } } as PartialConfig));
    await assert.rejects(t.start(), (e: unknown) => (e as { code?: string }).code === "RUNTIME_NOT_FOUND");
    await t.cleanup();
    assert.equal(await SessionStore.read(env.dirs.runtime), undefined);
  } finally {
    await env.cleanup();
  }
});

test("integration: dry-run plan performs no host mutation", async () => {
  const env = await setup(`true`);
  try {
    const t = new Tangerine(env.deps, await env.loaded());
    const plan = await t.plan({ virtual: true });
    assert.equal(plan.sandbox.backend, "none");
    assert.equal(plan.network.effective, "unrestricted");
    assert.equal(await stat(env.dirs.runtime).then(() => true, () => false), false, "no runtime dir created");
    assert.equal(t.machine.state, "idle");
  } finally {
    await env.cleanup();
  }
});

test("integration: stale session from a crashed controller is recovered on the next start", async () => {
  const env = await setup(`trap 'exit 0' TERM\nwhile :; do sleep 0.2; done`);
  try {
    // Simulate a crash: an orphaned workload + session file whose controller pid is dead.
    const orphan = (await import("node:child_process")).spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
    orphan.unref();
    const orphanPid = orphan.pid as number;
    const startTicks = (await new LinuxProcFs(env.deps.sys).readProcessStat(orphanPid))?.startTimeTicks;
    const staleDir = join(env.dirs.runtime, "session-stale");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, ".tangerine-owned"), "x");
    await writeFile(join(env.dirs.runtime, "session.json"), JSON.stringify({ sessionId: "old", controllerPid: 2 ** 22 - 3, startedAt: "t", state: "running", tempDirs: [staleDir], undo: [], runtimePid: orphanPid, runtimeStartTicks: startTicks }));
    const t = new Tangerine(env.deps, await env.loaded());
    await t.start();
    assert.equal(await stat(staleDir).then(() => true, () => false), false, "stale private dir removed");
    for (let i = 0; i < 40 && alive(orphanPid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(orphanPid), false, "orphaned workload terminated");
    assert.notEqual((await SessionStore.read(env.dirs.runtime))?.sessionId, "old");
    await t.stop();
    await t.cleanup();
  } finally {
    await env.cleanup();
  }
});

test("integration: a live session blocks a second start (SESSION_ACTIVE)", async () => {
  const env = await setup(`trap 'exit 0' TERM\nwhile :; do sleep 0.2; done`);
  try {
    const a = new Tangerine(env.deps, await env.loaded());
    await a.start();
    const b = new Tangerine(env.deps, await env.loaded());
    await assert.rejects(b.start(), (e: unknown) => (e as { code?: string }).code === "SESSION_ACTIVE");
    assert.ok(a.workloadPid && alive(a.workloadPid), "first session untouched");
    await a.stop();
    await a.cleanup();
  } finally {
    await env.cleanup();
  }
});
