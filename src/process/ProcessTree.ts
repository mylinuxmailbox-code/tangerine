import type { ProcFs } from "../system/ProcFs.js";

/**
 * Returns root + all descendants. Fast path: /proc/<pid>/task/<tid>/children (one tiny file
 * read per node). Fallback when the kernel lacks CONFIG_PROC_CHILDREN: one /proc scan matching
 * ppid/pgrp. Not a hot path: called at the process-monitor interval only.
 */
export async function snapshotTree(proc: ProcFs, root: number, maxNodes = 512): Promise<number[]> {
  const seen = new Set<number>([root]);
  const queue = [root];
  let fastPathWorks = true;
  while (queue.length && seen.size < maxNodes) {
    const pid = queue.shift() as number;
    const kids = await proc.readChildren(pid);
    if (kids === undefined) {
      if (pid === root) fastPathWorks = false;
      continue;
    }
    for (const k of kids) {
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
  }
  if (!fastPathWorks) return scanTree(proc, root, maxNodes);
  return [...seen];
}

async function scanTree(proc: ProcFs, root: number, maxNodes: number): Promise<number[]> {
  const parents = new Map<number, number>();
  const groups = new Map<number, number>();
  for (const pid of await proc.listPids()) {
    const st = await proc.readProcessStat(pid);
    if (st) {
      parents.set(pid, st.ppid);
      groups.set(pid, st.pgrp);
    }
  }
  const members = new Set<number>([root]);
  let grew = true;
  while (grew && members.size < maxNodes) {
    grew = false;
    for (const [pid, ppid] of parents) {
      if (!members.has(pid) && (members.has(ppid) || groups.get(pid) === root)) {
        members.add(pid);
        grew = true;
      }
    }
  }
  return [...members];
}
