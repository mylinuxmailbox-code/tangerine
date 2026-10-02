import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { MutationManager } from "../src/core/MutationManager.js";
import { StateMachine } from "../src/core/Lifecycle.js";
import { TangerineError } from "../src/core/Errors.js";
import { buildEnvironment, describeEnvironment } from "../src/runtime/EnvironmentBuilder.js";
import { validateMount, validateMounts } from "../src/sandbox/FilesystemPolicy.js";
import { buildBwrapArgs } from "../src/sandbox/SandboxManager.js";
import { buildUnshareArgs } from "../src/sandbox/NamespaceManager.js";
import { buildScopeArgs } from "../src/sandbox/CgroupManager.js";
import { planNetwork } from "../src/network/NetworkPolicy.js";
import { Logger, redact } from "../src/utils/Logger.js";
import { buildBackgroundMutations, resolveRules, PROTECTED_NAMES } from "../src/performance/BackgroundProcessManager.js";
import { LinuxProcFs } from "../src/system/ProcFs.js";
import { inspectSession, recoverStaleSession } from "../src/core/Recovery.js";
import { FakeLinuxSystem } from "./helpers/fakes.js";
import type { SandboxCapabilities } from "../src/core/CapabilityManager.js";
import type { GraphicsSelection } from "../src/performance/GraphicsManager.js";

const quiet = Logger.create("error");

// ---------- mutation manager ----------
test("mutations roll back in reverse order and cleanup is idempotent", async () => {
  const log: string[] = [];
  const mm = new MutationManager(quiet);
  for (const n of ["a", "b", "c"]) await mm.apply(mm.create(n, async () => void log.push(`apply ${n}`), async () => void log.push(`rollback ${n}`)));
  await mm.rollbackAll();
  await mm.rollbackAll();
  assert.deepEqual(log, ["apply a", "apply b", "apply c", "rollback c", "rollback b", "rollback a"]);
  assert.equal(mm.appliedCount, 0);
});

test("a failing apply is itself rolled back and reported; earlier mutations stay rollback-able", async () => {
  const log: string[] = [];
  const mm = new MutationManager(quiet);
  await mm.apply(mm.create("ok", async () => void log.push("apply ok"), async () => void log.push("rollback ok")));
  await assert.rejects(mm.apply(mm.create("bad", async () => { throw new Error("boom"); }, async () => void log.push("rollback bad"))), (e: unknown) => e instanceof TangerineError && e.code === "MUTATION_FAILED");
  await mm.rollbackAll();
  assert.deepEqual(log, ["apply ok", "rollback bad", "rollback ok"]);
  assert.deepEqual(mm.report().map((r) => r.status), ["rolled-back", "failed-apply"]);
});

test("a failing rollback does not stop the remaining rollbacks", async () => {
  const log: string[] = [];
  const mm = new MutationManager(quiet);
  await mm.apply(mm.create("first", async () => undefined, async () => void log.push("rollback first")));
  await mm.apply(mm.create("second", async () => undefined, async () => { throw new Error("nope"); }));
  const reports = await mm.rollbackAll();
  assert.deepEqual(log, ["rollback first"]);
  assert.equal(reports.find((r) => r.description === "second")?.status, "failed-rollback");
});

test("irreversible mutations are recorded as such and never rolled back", async () => {
  let rolled = false;
  const mm = new MutationManager(quiet);
  await mm.apply(mm.create("term", async () => undefined, async () => { rolled = true; }, { irreversible: true }));
  await mm.rollbackAll();
  assert.equal(rolled, false);
  assert.equal(mm.report()[0]?.status, "irreversible");
});

test("undo records are journaled before apply and forgotten after rollback", async () => {
  const events: string[] = [];
  const journal = { record: async (u: { id: string }) => void events.push(`rec ${u.id}`), forget: async (id: string) => void events.push(`forget ${id}`) };
  const mm = new MutationManager(quiet, journal);
  await mm.apply(mm.create("x", async () => void events.push("apply"), async () => undefined, { undo: { id: "u1", kind: "resume", data: {}, description: "d" } }));
  await mm.rollbackAll();
  assert.deepEqual(events, ["rec u1", "apply", "forget u1"]);
});

// ---------- state machine ----------
test("state machine forbids idle -> running and allows the documented path", () => {
  const m = new StateMachine();
  assert.throws(() => m.transition("running"), (e: unknown) => e instanceof TangerineError && e.code === "INVALID_STATE_TRANSITION");
  for (const s of ["initializing", "preparing", "starting", "running", "stopping", "cleaning", "stopped"] as const) m.transition(s);
  assert.equal(m.state, "stopped");
  assert.throws(() => m.transition("running"));
});

// ---------- environment ----------
const gfx = (env: Record<string, string>): GraphicsSelection => ({ requested: "auto", backend: "opengl", reason: "t", environment: env, vsync: true, notes: [] });

test("environment layers: later layers win, host env is NOT inherited wholesale", () => {
  const b = buildEnvironment({
    host: { PATH: "/usr/bin", HOME: "/home/u", DISPLAY: ":0", AWS_SECRET_ACCESS_KEY: "s3cr3t", SSH_AUTH_SOCK: "/tmp/ssh", FOO: "host" },
    runtime: { FOO: "runtime", R: "1" },
    graphics: gfx({ FOO: "graphics", vblank_mode: "0" }),
    performance: {},
    sandbox: { HOME: "/home/tangerine" },
    sandboxed: true,
    userOverrides: { R: "user" },
    passEnv: [],
  });
  assert.equal(b.env["FOO"], "graphics");
  assert.equal(b.env["R"], "user");
  assert.equal(b.env["HOME"], "/home/tangerine", "sandbox HOME beats host HOME");
  assert.equal(b.env["DISPLAY"], ":0");
  assert.equal(b.env["AWS_SECRET_ACCESS_KEY"], undefined);
  assert.equal(b.env["SSH_AUTH_SOCK"], undefined);
  assert.equal(b.provenance["R"], "user");
  assert.equal(b.provenance["FOO"], "graphics");
});

test("environment: sandboxed runs do not receive host HOME/USER; unsandboxed do", () => {
  const input = { host: { PATH: "/bin", HOME: "/home/u", USER: "u" }, runtime: {}, graphics: gfx({}), performance: {}, sandbox: {}, userOverrides: {}, passEnv: [] };
  assert.equal(buildEnvironment({ ...input, sandboxed: true }).env["USER"], undefined);
  assert.equal(buildEnvironment({ ...input, sandboxed: false }).env["HOME"], "/home/u");
});

test("environment: passEnv is explicit; invalid names/values are rejected, not passed", () => {
  const b = buildEnvironment({ host: { PATH: "/bin", MY_TOKEN: "abc" }, runtime: {}, graphics: gfx({}), performance: {}, sandbox: {}, sandboxed: true, userOverrides: { "BAD-NAME": "x", OK: "a\0b" }, passEnv: ["MY_TOKEN"] });
  assert.equal(b.env["MY_TOKEN"], "abc");
  assert.equal(b.env["BAD-NAME"], undefined);
  assert.equal(b.env["OK"], undefined);
  assert.equal(b.rejected.length, 2);
  assert.equal(describeEnvironment(b).find((e) => e.key === "MY_TOKEN")?.value, "[REDACTED]", "secret-looking values never displayed");
});

test("PATH falls back to a safe default", () => {
  assert.match(buildEnvironment({ host: {}, runtime: {}, graphics: gfx({}), performance: {}, sandbox: {}, sandboxed: true, userOverrides: {}, passEnv: [] }).env["PATH"] ?? "", /\/usr\/bin/);
});

// ---------- logging ----------
test("logger redacts secrets by key and by token shape", () => {
  const r = redact({ password: "hunter2", nested: { api_key: "k", note: "token ghp_abcdefghijklmnop1234" }, ok: "fine" }) as Record<string, unknown>;
  assert.equal(r["password"], "[REDACTED]");
  assert.equal((r["nested"] as Record<string, unknown>)["api_key"], "[REDACTED]");
  assert.match(String((r["nested"] as Record<string, unknown>)["note"]), /\[REDACTED\]/);
  assert.equal(r["ok"], "fine");
  const lines: string[] = [];
  const l = Logger.create("debug");
  l.addSink((rec) => lines.push(JSON.stringify(rec)));
  l.info("x", { authorization: "Bearer abc" });
  assert.ok(!lines[0]?.includes("Bearer abc"));
});

// ---------- filesystem policy ----------
const ctx = (sys: FakeLinuxSystem, exposeHome = false) => ({ sys, home: "/home/u", exposeHome });

test("mount policy: rejects HOME, secrets, parents of secrets and symlink smuggling", async () => {
  const sys = new FakeLinuxSystem();
  sys.addDir("/home/u").addDir("/home/u/.ssh").addDir("/home/u/games").addDir("/etc").addDir("/home").addDir("/safe");
  sys.addLink("/safe/link", "/home/u/.ssh");
  const bind = (source: string, target = "/m", ro = true) => ({ source, target, kind: "bind" as const, readOnly: ro, purpose: "test" });
  await assert.rejects(validateMount(bind("/home/u"), ctx(sys)), /whole home/);
  await assert.rejects(validateMount(bind("/home/u/.ssh"), ctx(sys)), /sensitive/);
  await assert.rejects(validateMount(bind("/safe/link"), ctx(sys)), /sensitive/, "symlinks are resolved before policy");
  await assert.rejects(validateMount(bind("/etc"), ctx(sys)), /contains sensitive/);
  await assert.rejects(validateMount(bind("/"), ctx(sys)), /root/);
  await assert.rejects(validateMount(bind("/home"), ctx(sys)), /\/home/);
  assert.ok(await validateMount(bind("/home/u/games"), ctx(sys)));
  assert.ok(await validateMount(bind("/home/u"), ctx(sys, true)), "explicit opt-in allows HOME");
  await assert.rejects(validateMount(bind("/home/u/.ssh"), ctx(sys, true)), /sensitive/, "even with exposeHome, secrets stay blocked");
});

test("mount policy: path shape, purpose, device and duplicate rules", async () => {
  const sys = new FakeLinuxSystem();
  sys.addDir("/a").addDir("/dev/dri").addDir("/dev/sda").addDir("/usr");
  const m = (o: object) => ({ source: "/a", target: "/t", kind: "bind" as const, readOnly: true, purpose: "p", ...o });
  await assert.rejects(validateMount(m({ target: "relative" }), ctx(sys)), /absolute/);
  await assert.rejects(validateMount(m({ target: "/a/../b" }), ctx(sys)), /normalised|\.\./);
  await assert.rejects(validateMount(m({ purpose: "" }), ctx(sys)), /purpose/);
  await assert.rejects(validateMount(m({ source: "/nope" }), ctx(sys)), /does not exist/);
  assert.equal(await validateMount(m({ source: "/nope", optional: true }), ctx(sys)), undefined);
  await assert.rejects(validateMount(m({ source: "/dev/sda", device: true }), ctx(sys)), /device passthrough/);
  assert.ok(await validateMount(m({ source: "/dev/dri", device: true, readOnly: false }), ctx(sys)));
  await assert.rejects(validateMount(m({ source: "/usr", readOnly: false }), ctx(sys)), /read-only/);
  await assert.rejects(validateMounts([m({}), m({ source: "/dev/dri" })], ctx(sys)), /Duplicate/);
});

// ---------- sandbox / network ----------
test("bwrap argv: namespaces, private mounts, no host root, ordering", () => {
  const a = buildBwrapArgs({ unsharePid: true, unshareNet: true, usrSymlinks: ["bin", "lib"], usrPlain: [], mounts: [{ source: "/h", resolvedSource: "/h", target: "/home/tangerine", kind: "bind", readOnly: false, purpose: "p" }, { source: "/dev/dri", target: "/dev/dri", kind: "bind", readOnly: false, device: true, purpose: "p" }], etcPresent: ["/etc/fonts"], cwd: "/home/tangerine", home: "/home/tangerine" });
  const s = a.join(" ");
  for (const f of ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net", "--tmpfs /tmp", "--ro-bind /usr /usr", "--symlink usr/bin /bin", "--ro-bind /etc/fonts /etc/fonts", "--bind /h /home/tangerine", "--dev-bind /dev/dri /dev/dri", "--setenv HOME /home/tangerine", "--chdir /home/tangerine"]) assert.ok(s.includes(f), `missing ${f}\n${s}`);
  assert.ok(!s.includes("--ro-bind / /"), "never binds the host root");
  assert.equal(a[a.length - 1], "--");
  const open = buildBwrapArgs({ unsharePid: false, unshareNet: false, usrSymlinks: [], usrPlain: [], mounts: [], etcPresent: [] }).join(" ");
  assert.ok(!open.includes("--unshare-net") && !open.includes("--unshare-pid"));
});

test("unshare argv and systemd scope argv", () => {
  assert.deepEqual(buildUnshareArgs({ mount: true, pid: true, net: true }), ["unshare", "--user", "--map-root-user", "--kill-child", "--mount", "--pid", "--fork", "--mount-proc", "--net", "--"]);
  assert.ok(!buildUnshareArgs({ mount: false, pid: false, net: false }).includes("--net"));
  assert.deepEqual(buildScopeArgs({ unitName: "t.scope" }), []);
  assert.deepEqual(buildScopeArgs({ unitName: "t.scope", memoryHighBytes: 1048576 }), ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit", "t.scope", "-p", "MemoryHigh=1048576", "--"]);
});

const sbCaps = (net: boolean): SandboxCapabilities => ({ mountNamespace: net, pidNamespace: net, networkNamespace: net, cgroups: false, seccomp: false, filesystemIsolation: false });

test("network: blocked is fail-closed when a netns cannot be created", () => {
  assert.throws(() => planNetwork({ mode: "blocked", allow: [] }, sbCaps(false), true), (e: unknown) => e instanceof TangerineError && e.code === "NETWORK_POLICY_FAILED" && !e.recoverable);
  assert.throws(() => planNetwork({ mode: "blocked", allow: [] }, sbCaps(true), false), /network namespace/);
  assert.equal(planNetwork({ mode: "blocked", allow: [] }, sbCaps(true), true).needNetNamespace, true);
});

test("network: unrestricted needs nothing; restricted falls back to blocked with a warning", () => {
  const u = planNetwork({ mode: "unrestricted", allow: [] }, sbCaps(false), false);
  assert.equal(u.needNetNamespace, false);
  const r = planNetwork({ mode: "restricted", allow: [{ port: 443 }] }, sbCaps(true), true);
  assert.equal(r.effective, "blocked");
  assert.match(r.warnings[0] ?? "", /not implemented/);
});

// ---------- background rules ----------
test("background rules refuse protected processes and Tangerine's own ancestry; actions are reversible", async () => {
  const sys = new FakeLinuxSystem();
  const stat = (pid: number, comm: string, nice: number) => sys.addFile(`/proc/${pid}/stat`, `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 1 1 0 0 20 ${nice} 1 0 555 0 0`);
  stat(100, "tracker-miner", 0); stat(101, "Xorg", 0); stat(102, "node", 0); stat(103, "chrome", 0);
  sys.addDir("/proc");
  const proc = new LinuxProcFs(sys);
  const resolved = await resolveRules([{ match: { name: "tracker-miner" }, action: "lower-priority", nice: 15 }, { match: { name: "Xorg" }, action: "terminate" }, { match: { pid: 102 }, action: "pause" }, { match: { pid: 103 }, action: "pause" }], proc, new Set([102]));
  assert.equal(resolved[0]?.pids.length, 1);
  assert.equal(resolved[1]?.pids.length, 0, "Xorg is protected");
  assert.match(resolved[1]?.refused[0]?.why ?? "", /protected/);
  assert.equal(resolved[2]?.pids.length, 0, "own pid refused");
  assert.ok(PROTECTED_NAMES.has("marco"));
  const mm = new MutationManager(quiet);
  const muts = await buildBackgroundMutations(resolved, sys, proc, mm);
  for (const m of muts) await mm.apply(m);
  assert.equal(sys.priorities.get(100), 15);
  assert.deepEqual(sys.signals, [{ pid: 103, signal: "SIGSTOP" }]);
  await mm.rollbackAll();
  assert.equal(sys.priorities.get(100), 0, "nice restored");
  assert.deepEqual(sys.signals.at(-1), { pid: 103, signal: "SIGCONT" });
});

test("rollback skips a PID that was reused by a different process", async () => {
  const sys = new FakeLinuxSystem();
  sys.addDir("/proc").addFile("/proc/200/stat", "200 (job) S 1 200 200 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 111 0 0");
  const proc = new LinuxProcFs(sys);
  const mm = new MutationManager(quiet);
  const resolved = await resolveRules([{ match: { pid: 200 }, action: "pause" }], proc, new Set());
  for (const m of await buildBackgroundMutations(resolved, sys, proc, mm)) await mm.apply(m);
  sys.addFile("/proc/200/stat", "200 (other) S 1 200 200 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 999 0 0"); // pid reused
  await mm.rollbackAll();
  assert.ok(!sys.signals.some((s) => s.signal === "SIGCONT"), "must not SIGCONT an unrelated process");
});

// ---------- crash recovery ----------
// SessionStore uses the real filesystem (atomic rename), so these tests use a private temp dir
// for the session file and a FakeLinuxSystem for every process/host action.
async function runtimeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tangerine-test-"));
}

test("stale-session recovery undoes recorded mutations and only removes marker-owned dirs", async () => {
  const dir = await runtimeDir();
  try {
    const sys = new FakeLinuxSystem();
    sys.addDir("/proc");
    sys.addFile("/proc/300/stat", "300 (paused) T 1 300 300 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 4242 0 0");
    sys.addFile("/proc/400/stat", "400 (other) S 1 400 400 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 9999 0 0");
    const owned = join(dir, "session-aaa");
    const foreign = join(dir, "session-notours");
    await mkdir(owned, { recursive: true });
    await writeFile(join(owned, ".tangerine-owned"), "id");
    await mkdir(foreign);
    sys.addFile(join(owned, ".tangerine-owned"), "id");
    sys.addFile("/home/u/precious/file", "do not delete");
    await writeFile(join(dir, "session.json"), JSON.stringify({
      sessionId: "s1", controllerPid: 99999, startedAt: "t", state: "running", tempDirs: [owned, "/home/u/precious"], runtimePid: 400, runtimeStartTicks: 1,
      undo: [
        { id: "1", kind: "resume", data: { pid: 300, startTicks: 4242 }, description: "SIGCONT paused" },
        { id: "2", kind: "gsettings", data: { schema: "org.mate.Marco.general", key: "compositing-manager", original: "true" }, description: "restore compositing" },
        { id: "3", kind: "renice", data: { pid: 300, startTicks: 1, original: 0 }, description: "stale renice (pid reused)" },
      ],
    }));
    const proc = new LinuxProcFs(sys);
    const v = await inspectSession(sys, proc, dir);
    assert.equal(v?.stale, true);
    const r = await recoverStaleSession(sys, proc, dir, v!, quiet);
    assert.equal(r.recovered, true, r.errors.join(";"));
    assert.ok(sys.signals.some((s) => s.pid === 300 && s.signal === "SIGCONT"));
    assert.ok(sys.execCalls.some((c) => c.command === "gsettings" && c.args.join(" ") === "set org.mate.Marco.general compositing-manager true"));
    assert.ok(sys.removed.includes(owned));
    assert.ok(!sys.removed.includes(foreign), "unmarked dir is not ours");
    assert.ok(!sys.removed.includes("/home/u/precious"), "recorded dir outside the runtime root is never removed");
    assert.equal(sys.priorities.has(300), false, "renice skipped: start time did not match");
    assert.ok(!sys.signals.some((s) => s.pid === -400), "runtime pid whose start time doesn't match is not signalled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live controller is not stale; pid reuse is detected", async () => {
  const dir = await runtimeDir();
  try {
    const sys = new FakeLinuxSystem();
    sys.addDir("/proc");
    sys.alive.add(555);
    sys.addFile("/proc/555/stat", "555 (node) S 1 555 555 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 777 0 0");
    await writeFile(join(dir, "session.json"), JSON.stringify({ sessionId: "s", controllerPid: 555, controllerStartTicks: 777, startedAt: "t", state: "running", tempDirs: [], undo: [] }));
    assert.equal((await inspectSession(sys, new LinuxProcFs(sys), dir))?.stale, false);
    sys.addFile("/proc/555/stat", "555 (node) S 1 555 555 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 888 0 0");
    assert.equal((await inspectSession(sys, new LinuxProcFs(sys), dir))?.stale, true, "pid reuse detected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
