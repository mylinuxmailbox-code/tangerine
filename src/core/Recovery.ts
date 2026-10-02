import { join } from "node:path";
import type { LinuxSystem } from "../system/Linux.js";
import type { ProcFs } from "../system/ProcFs.js";
import { SessionStore, listOwnedTempDirs, type SessionRecord } from "./SessionStore.js";
import type { UndoRecord } from "./MutationManager.js";
import { errMsg } from "./Errors.js";
import type { Logger } from "../utils/Logger.js";

export interface StaleSessionVerdict {
  session: SessionRecord;
  stale: boolean;
  reason: string;
}

/** A session is stale only if its controller is provably gone (dead PID, or PID reused by another process). */
export async function inspectSession(sys: LinuxSystem, proc: ProcFs, dir: string): Promise<StaleSessionVerdict | undefined> {
  const session = await SessionStore.read(dir);
  if (!session) return undefined;
  if (!sys.isAlive(session.controllerPid)) return { session, stale: true, reason: `controller pid ${session.controllerPid} is not running` };
  if (session.controllerStartTicks !== undefined) {
    const st = await proc.readProcessStat(session.controllerPid);
    if (st && st.startTimeTicks !== session.controllerStartTicks) {
      return { session, stale: true, reason: `pid ${session.controllerPid} was reused by a different process` };
    }
  }
  return { session, stale: false, reason: "controller is alive" };
}

async function pidMatches(proc: ProcFs, pid: number, startTicks: number): Promise<boolean> {
  const st = await proc.readProcessStat(pid);
  return !!st && st.startTimeTicks === startTicks;
}

async function applyUndo(sys: LinuxSystem, proc: ProcFs, u: UndoRecord, runtimeDir: string): Promise<void> {
  const d = u.data;
  switch (u.kind) {
    case "renice":
      // Only touch the PID if it is still the *same* process (start time matches).
      if (await pidMatches(proc, Number(d["pid"]), Number(d["startTicks"]))) sys.setPriority(Number(d["pid"]), Number(d["original"]));
      return;
    case "resume":
      if (await pidMatches(proc, Number(d["pid"]), Number(d["startTicks"]))) sys.kill(Number(d["pid"]), "SIGCONT");
      return;
    case "gsettings": {
      const r = await sys.execute("gsettings", ["set", String(d["schema"]), String(d["key"]), String(d["original"])], { timeoutMs: 5000 });
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "gsettings failed");
      return;
    }
    case "tempdir": {
      const p = String(d["path"]);
      // Ownership: must live under our runtime dir AND carry the marker file.
      if (p.startsWith(runtimeDir + "/") && (await sys.exists(join(p, ".tangerine-owned")))) await sys.remove(p);
      return;
    }
  }
}

export interface RecoveryResult {
  recovered: boolean;
  actions: string[];
  errors: string[];
}

/** Rolls back resources of a stale session, then deletes its record. Never touches unidentified resources. */
export async function recoverStaleSession(sys: LinuxSystem, proc: ProcFs, dir: string, verdict: StaleSessionVerdict, logger: Logger): Promise<RecoveryResult> {
  const actions: string[] = [];
  const errors: string[] = [];
  const s = verdict.session;
  // 1. orphaned workload: only signal if pid+starttime still match what we recorded.
  if (s.runtimePid && s.runtimeStartTicks !== undefined && (await pidMatches(proc, s.runtimePid, s.runtimeStartTicks))) {
    try {
      sys.kill(-s.runtimePid, "SIGTERM"); // runtime was spawned as its own process-group leader
      actions.push(`sent SIGTERM to orphaned workload group ${s.runtimePid}`);
    } catch (e) {
      errors.push(`kill group ${s.runtimePid}: ${errMsg(e)}`);
    }
  }
  // 2. undo mutations in reverse order.
  for (const u of [...s.undo].reverse()) {
    try {
      await applyUndo(sys, proc, u, dir);
      actions.push(`undo: ${u.description}`);
    } catch (e) {
      errors.push(`undo ${u.description}: ${errMsg(e)}`);
    }
  }
  // 3. temp dirs recorded by the session (marker-checked).
  for (const t of s.tempDirs) {
    try {
      await applyUndo(sys, proc, { id: t, kind: "tempdir", data: { path: t }, description: `remove ${t}` }, dir);
      actions.push(`removed temp dir ${t}`);
    } catch (e) {
      errors.push(`tempdir ${t}: ${errMsg(e)}`);
    }
  }
  // 4. Any marker-bearing session dir whose owner is gone.
  for (const t of await listOwnedTempDirs(dir)) {
    if (s.tempDirs.includes(t)) continue;
    try {
      await sys.remove(t);
      actions.push(`removed orphaned dir ${t}`);
    } catch (e) {
      errors.push(`orphan ${t}: ${errMsg(e)}`);
    }
  }
  if (!errors.length) await sys.remove(SessionStore.path(dir));
  logger.info("recovery.done", { sessionId: s.sessionId, actions: actions.length, errors: errors.length });
  return { recovered: !errors.length, actions, errors };
}
