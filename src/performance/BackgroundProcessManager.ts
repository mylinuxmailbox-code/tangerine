import { randomUUID } from "node:crypto";
import type { BackgroundProcessRule } from "../config/schema.js";
import type { LinuxSystem } from "../system/Linux.js";
import type { ProcFs } from "../system/ProcFs.js";
import type { MutationManager, SystemMutation } from "../core/MutationManager.js";
import { TangerineError } from "../core/Errors.js";

/**
 * Processes Tangerine refuses to touch no matter what the config says (spec §12, §48).
 * Matching is on the kernel `comm` name (max 15 chars).
 */
export const PROTECTED_NAMES = new Set([
  "systemd", "init", "Xorg", "Xwayland", "marco", "mate-session", "mate-panel", "dbus-daemon", "dbus-broker",
  "lightdm", "gdm3", "sshd", "NetworkManager", "pulseaudio", "pipewire", "wireplumber", "systemd-logind",
  "udevd", "systemd-udevd", "login", "agetty", "bash", "sh", "zsh", "fish", "node", "tangerine",
]);

export interface ResolvedRule {
  rule: BackgroundProcessRule;
  pids: { pid: number; name: string }[];
  refused: { pid: number; name: string; why: string }[];
}

/** Resolves rules to concrete PIDs once at start (one /proc scan, not periodic). */
export async function resolveRules(rules: BackgroundProcessRule[], proc: ProcFs, selfPids: Set<number>): Promise<ResolvedRule[]> {
  if (!rules.length) return [];
  const allPids = await proc.listPids();
  const out: ResolvedRule[] = [];
  for (const rule of rules) {
    const resolved: ResolvedRule = { rule, pids: [], refused: [] };
    const candidates: number[] = "pid" in rule.match ? [rule.match.pid] : [];
    if ("name" in rule.match) {
      const want = rule.match.name;
      for (const pid of allPids) {
        const st = await proc.readProcessStat(pid);
        if (st && st.comm === want) candidates.push(pid);
      }
    }
    for (const pid of candidates) {
      const st = await proc.readProcessStat(pid);
      if (!st) continue;
      if (pid <= 1 || selfPids.has(pid)) resolved.refused.push({ pid, name: st.comm, why: "Tangerine / init / its own ancestors" });
      else if (PROTECTED_NAMES.has(st.comm)) resolved.refused.push({ pid, name: st.comm, why: "protected essential process" });
      else resolved.pids.push({ pid, name: st.comm });
    }
    out.push(resolved);
  }
  return out;
}

/** Builds reversible mutations for resolved rules. `terminate` is recorded as irreversible. */
export async function buildBackgroundMutations(resolved: ResolvedRule[], sys: LinuxSystem, proc: ProcFs, mm: MutationManager): Promise<SystemMutation[]> {
  const result: SystemMutation[] = [];
  for (const r of resolved) {
    for (const { pid, name } of r.pids) {
      const st = await proc.readProcessStat(pid);
      if (!st) continue;
      const ticks = st.startTimeTicks;
      const stillSame = async (): Promise<boolean> => (await proc.readProcessStat(pid))?.startTimeTicks === ticks;
      switch (r.rule.action) {
        case "lower-priority": {
          const target = r.rule.nice ?? 10;
          let original = 0;
          const m = mm.create(
            `renice ${name}(${pid}) to ${target}`,
            async () => {
              original = sys.getPriority(pid);
              sys.setPriority(pid, target);
            },
            async () => {
              if (await stillSame()) sys.setPriority(pid, original);
            },
            { undo: { id: randomUUID(), kind: "renice", data: { pid, startTicks: ticks, original: st.nice }, description: `restore nice of ${name}(${pid})` } },
          );
          result.push(m);
          break;
        }
        case "pause": {
          result.push(
            mm.create(
              `SIGSTOP ${name}(${pid})`,
              async () => sys.kill(pid, "SIGSTOP"),
              async () => {
                if (await stillSame()) sys.kill(pid, "SIGCONT");
              },
              { undo: { id: randomUUID(), kind: "resume", data: { pid, startTicks: ticks }, description: `SIGCONT ${name}(${pid})` } },
            ),
          );
          break;
        }
        case "terminate": {
          result.push(
            mm.create(
              `SIGTERM ${name}(${pid}) (irreversible, explicitly configured)`,
              async () => {
                if (!(await stillSame())) throw new TangerineError({ code: "MUTATION_FAILED", subsystem: "background", message: `pid ${pid} changed identity`, recoverable: true });
                sys.kill(pid, "SIGTERM");
              },
              async () => undefined,
              { irreversible: true },
            ),
          );
          break;
        }
      }
    }
  }
  return result;
}
