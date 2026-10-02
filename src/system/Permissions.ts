import type { LinuxSystem } from "./Linux.js";
import type { ProcFs } from "./ProcFs.js";

export const CAP_NET_ADMIN = 12;
export const CAP_SYS_ADMIN = 21;
export const CAP_SYS_NICE = 23;

export interface PermissionInfo {
  uid: number;
  isRoot: boolean;
  /** Effective capability bitmask (CapEff) as BigInt, if readable. */
  capEff?: bigint;
  hasSysNice: boolean;
  hasSysAdmin: boolean;
  hasNetAdmin: boolean;
  /** RLIMIT_RTPRIO soft limit (0 = no unprivileged realtime). */
  rtprioLimit?: number;
  /** RLIMIT_NICE soft limit; lowest permitted nice = 20 - limit. */
  niceLimit?: number;
  minNice: number;
}

export function parseCapEff(statusText: string): bigint | undefined {
  const m = /^CapEff:\s*([0-9a-fA-F]+)/m.exec(statusText);
  return m?.[1] ? BigInt("0x" + m[1]) : undefined;
}

export function parseLimit(limitsText: string, label: string): number | undefined {
  for (const line of limitsText.split("\n")) {
    if (line.startsWith(label)) {
      const soft = line.slice(label.length).trim().split(/\s+/)[0];
      if (soft === "unlimited") return Number.POSITIVE_INFINITY;
      if (soft && /^\d+$/.test(soft)) return Number(soft);
    }
  }
  return undefined;
}

export async function detectPermissions(sys: LinuxSystem, proc: ProcFs): Promise<PermissionInfo> {
  const uid = sys.uid();
  let capEff: bigint | undefined;
  try {
    capEff = parseCapEff(await sys.readFile("/proc/self/status"));
  } catch {
    capEff = undefined;
  }
  const has = (bit: number): boolean => (capEff !== undefined ? (capEff & (1n << BigInt(bit))) !== 0n : uid === 0);
  let rtprio: number | undefined;
  let nice: number | undefined;
  try {
    const limits = await proc.readLimits();
    rtprio = parseLimit(limits, "Max realtime priority");
    nice = parseLimit(limits, "Max nice priority");
  } catch {
    /* limits unreadable: leave undefined */
  }
  const hasSysNice = has(CAP_SYS_NICE);
  return {
    uid,
    isRoot: uid === 0,
    capEff,
    hasSysNice,
    hasSysAdmin: has(CAP_SYS_ADMIN),
    hasNetAdmin: has(CAP_NET_ADMIN),
    rtprioLimit: rtprio,
    niceLimit: nice,
    // With CAP_SYS_NICE any value is allowed; otherwise RLIMIT_NICE bounds how negative we can go.
    minNice: hasSysNice ? -20 : nice !== undefined && Number.isFinite(nice) ? Math.min(0, Math.max(-20, 20 - nice)) : 0,
  };
}
