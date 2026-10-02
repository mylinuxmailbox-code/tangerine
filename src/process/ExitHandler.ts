import type { ProcessManager } from "./ProcessManager.js";

/**
 * Last-resort cleanup on the synchronous 'exit' event (crash, uncaught exception, process.exit).
 * Only synchronous work is possible here: kill the workload's process groups. Host mutations
 * that need async undo (renice, gsettings, SIGCONT) are NOT lost - they are in the on-disk
 * journal and are rolled back by stale-session recovery on the next start (spec §59).
 */
export function installExitHandler(pm: ProcessManager): () => void {
  const h = (): void => pm.killAllSync();
  process.on("exit", h);
  return () => process.off("exit", h);
}
