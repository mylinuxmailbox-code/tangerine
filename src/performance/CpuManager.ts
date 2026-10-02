import type { CpuTopology } from "../system/SysFs.js";
import { coreGroups } from "../system/SysFs.js";
import { parseCpuList } from "../system/SysFs.js";
import type { ProcFs } from "../system/ProcFs.js";

export interface CpuSummary {
  logical: number;
  physical: number;
  smt: boolean;
  online: number[];
  /** CPUs this process (and so its children) may use, from Cpus_allowed_list (cpuset/cgroup/taskset aware). */
  allowed: number[];
  groups: number[][];
  governor?: string;
  freqDriver?: string;
  maxFreqKhz?: number;
}

export async function summarizeCpu(topo: CpuTopology, proc: ProcFs): Promise<CpuSummary> {
  let allowed = topo.online;
  try {
    const list = (await proc.readSelfStatus()).cpusAllowedList;
    if (list) {
      const parsed = parseCpuList(list);
      if (parsed.length) allowed = parsed.filter((c) => topo.online.includes(c));
    }
  } catch {
    /* keep online */
  }
  const first = topo.cpus.find((c) => c.online);
  return {
    logical: topo.logicalCount,
    physical: topo.physicalCoreCount,
    smt: topo.smt,
    online: topo.online,
    allowed,
    groups: coreGroups(topo),
    governor: first?.governor,
    freqDriver: topo.freqDriver,
    maxFreqKhz: first?.maxFreqKhz,
  };
}
