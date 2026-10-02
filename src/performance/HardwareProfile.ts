import type { CpuTopology } from "../system/SysFs.js";
import type { PlatformInfo } from "../system/Platform.js";

/**
 * Hardware classes drive *defaults only* (sampling cost, memory headroom). They never
 * apply a host change by themselves, and every default can be overridden.
 *
 *  - i3-6006u : Intel Core i3-6006U (Skylake-U, 2C/4T, 2.0 GHz, no Turbo, HD 520, 15 W TDP).
 *               Target machine for this project: 8 GB DDR4 SODIMM, 240 GB SATA SSD.
 *  - low-end  : <= 4 logical CPUs or <= 8.5 GB RAM
 *  - standard : everything else
 */
export type HardwareClassId = "i3-6006u" | "low-end" | "standard";

export interface HardwareClass {
  id: HardwareClassId;
  logicalCpus: number;
  physicalCores: number;
  totalMemMb: number;
  smt: boolean;
  cpuModel?: string;
  notes: string[];
}

export function classifyHardware(platform: Pick<PlatformInfo, "cpuModel" | "totalMemKb">, topo: Pick<CpuTopology, "logicalCount" | "physicalCoreCount" | "smt">): HardwareClass {
  const totalMemMb = Math.round((platform.totalMemKb ?? 0) / 1024);
  const isI3 = /i3-6006U/i.test(platform.cpuModel ?? "");
  const lowEnd = topo.logicalCount <= 4 || (totalMemMb > 0 && totalMemMb <= 8704);
  const id: HardwareClassId = isI3 ? "i3-6006u" : lowEnd ? "low-end" : "standard";
  const notes: string[] = [];
  if (id === "i3-6006u") {
    notes.push("2 physical cores / 4 threads: the host desktop (MATE, Marco, Xorg) competes with the workload for every core, so core pinning is NOT assumed to help.");
    notes.push("15 W TDP, no Turbo Boost: sustained clocks are bounded by thermals; frequency + temperature are sampled to expose throttling.");
    notes.push("8 GB RAM: workload memory is soft-capped via cgroup memory.high (when available) so reclaim happens before the desktop starts swapping.");
    notes.push("SATA SSD: swap and shader-cache I/O are cheap compared with HDD but still ~100x slower than RAM; swap-in/out rates are tracked rather than swap utilisation.");
  } else if (id === "low-end") {
    notes.push("Low-core-count or low-RAM host: conservative sampling intervals and memory headroom are used.");
  }
  return { id, logicalCpus: topo.logicalCount, physicalCores: topo.physicalCoreCount, totalMemMb, smt: topo.smt, cpuModel: platform.cpuModel, notes };
}
