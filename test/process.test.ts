import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealCommandRunner } from "../src/system/Commands.js";
import { ProcessManager } from "../src/process/ProcessManager.js";
import { detectRuntimePlatform } from "../src/system/Platform.js";
import { Logger } from "../src/utils/Logger.js";
import { TangerineError } from "../src/core/Errors.js";

const quiet = Logger.create("error");

test("CommandRunner: runs argv without a shell (metacharacters stay literal)", async () => {
  const r = new RealCommandRunner();
  const res = await r.run("echo", ["a; touch /tmp/tangerine-pwned $(id) `id` | cat"]);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout.trim(), "a; touch /tmp/tangerine-pwned $(id) `id` | cat");
  await assert.rejects(stat("/tmp/tangerine-pwned"));
});

test("CommandRunner: never rejects - ENOENT, non-zero exit, timeout, NUL bytes are results", async () => {
  const r = new RealCommandRunner();
  const missing = await r.run("definitely-not-a-binary-xyz", []);
  assert.equal(missing.exitCode, -1);
  assert.ok(missing.spawnError);
  const fail = await r.run("sh", ["-c", "echo err >&2; exit 3"]);
  assert.equal(fail.exitCode, 3);
  assert.equal(fail.stderr.trim(), "err");
  const slow = await r.run("sleep", ["5"], { timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
  assert.ok(slow.durationMs < 3000);
  assert.ok((await r.run("echo", ["a\0b"])).spawnError);
  assert.ok(r.history.length >= 4, "audit trail kept");
});

test("CommandRunner: stdin input and output cap", async () => {
  const r = new RealCommandRunner();
  assert.equal((await r.run("cat", [], { input: "hello" })).stdout, "hello");
  const big = await r.run("sh", ["-c", "head -c 3000000 /dev/zero | tr '\\0' x"], { maxBuffer: 1000 });
  assert.equal(big.stdout.length, 1000);
});

test("ProcessManager: env is not inherited; group termination reaches grandchildren", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tangerine-pm-"));
  try {
    process.env["TANGERINE_TEST_LEAK"] = "leak";
    const pm = new ProcessManager(detectRuntimePlatform(), quiet);
    const out = await pm.spawn({ command: "/usr/bin/env", args: [], env: { ONLY: "this" }, label: "env" });
    let text = "";
    out.onStdout((c) => (text += c));
    await out.wait();
    assert.equal(text.trim(), "ONLY=this");

    const pidfile = join(dir, "grandchild.pid");
    const script = join(dir, "tree.sh");
    await writeFile(script, `#!/bin/sh\nsleep 60 &\necho $! > "${pidfile}"\nwait\n`);
    await chmod(script, 0o755);
    const p = await pm.spawn({ command: script, args: [], env: { PATH: "/usr/bin:/bin" }, label: "tree" });
    for (let i = 0; i < 50; i++) {
      try { if ((await readFile(pidfile, "utf8")).trim()) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const gc = Number((await readFile(pidfile, "utf8")).trim());
    assert.ok(gc > 1);
    process.kill(gc, 0); // alive
    await pm.terminateAll(2000);
    assert.equal(p.isRunning, false);
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(gc, 0), /ESRCH/, "grandchild must die with the group");
  } finally {
    delete process.env["TANGERINE_TEST_LEAK"];
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProcessManager: SIGTERM-ignoring process is SIGKILLed after the grace period", async () => {
  const pm = new ProcessManager(detectRuntimePlatform(), quiet);
  const p = await pm.spawn({ command: "/bin/sh", args: ["-c", "trap '' TERM; while :; do sleep 1; done"], env: { PATH: "/usr/bin:/bin" }, label: "stubborn" });
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  await p.terminate("SIGTERM", 400);
  assert.equal(p.isRunning, false);
  assert.equal(p.signal, "SIGKILL");
  assert.ok(Date.now() - t0 >= 350);
});

test("ProcessManager: errors are structured; timeouts terminate; shutdown refuses new work", async () => {
  const pm = new ProcessManager(detectRuntimePlatform(), quiet);
  await assert.rejects(pm.spawn({ command: "/nonexistent/bin", args: [], env: {}, label: "x" }), (e: unknown) => e instanceof TangerineError && e.code === "PROCESS_START_FAILED");
  await assert.rejects(pm.spawn({ command: "", args: [], env: {}, label: "x" }), /invalid command/);
  const t = await pm.spawn({ command: "/bin/sleep", args: ["30"], env: {}, label: "t", timeoutMs: 100, graceMs: 500 });
  await t.wait();
  assert.equal(t.isRunning, false);
  pm.stopAccepting();
  await assert.rejects(pm.spawn({ command: "/bin/true", args: [], env: {}, label: "late" }), /not accepting/);
});

test("SignalManager: first SIGTERM => graceful handler once; second => emergency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tangerine-sig-"));
  try {
    const script = join(dir, "child.mjs");
    const mod = new URL("../src/process/SignalManager.js", import.meta.url).href;
    const log = new URL("../src/utils/Logger.js", import.meta.url).href;
    await writeFile(script, `
import { SignalManager } from ${JSON.stringify(mod)};
import { Logger } from ${JSON.stringify(log)};
const events = [];
const sm = new SignalManager(Logger.create("error"),
  async (s) => { events.push("shutdown:" + s); console.log("shutdown " + s); await new Promise(() => {}); },
  (s) => { console.log("emergency " + s); process.exit(42); });
sm.install();
console.log("ready");
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    const waitFor = async (s: string): Promise<void> => { for (let i = 0; i < 100 && !out.includes(s); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(out.includes(s), `waiting for "${s}", got: ${out}`); };
    await waitFor("ready");
    child.kill("SIGTERM");
    await waitFor("shutdown SIGTERM");
    child.kill("SIGINT");
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    assert.equal(code, 42);
    assert.ok(out.includes("emergency SIGINT"));
    assert.equal(out.split("shutdown ").length - 1, 1, "graceful handler ran exactly once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
