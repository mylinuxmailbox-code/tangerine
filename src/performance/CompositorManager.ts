import type { LinuxSystem } from "../system/Linux.js";
import type { ProcFs } from "../system/ProcFs.js";
import type { MutationManager, SystemMutation } from "../core/MutationManager.js";
import { commandOk } from "../system/Commands.js";
import { TangerineError } from "../core/Errors.js";
import { randomUUID } from "node:crypto";

const SCHEMA = "org.mate.Marco.general";
const KEY = "compositing-manager";

/**
 * MATE/Marco compositing toggle via gsettings (org.mate.Marco.general compositing-manager).
 * Facility: Marco's built-in compositor. Change: compositing off while the workload runs;
 * the previous value is read first and written back on rollback (and persisted in the
 * crash-recovery journal). Why it may help: removes one full-screen redirect/composite pass,
 * which matters on an iGPU sharing bandwidth with the CPU. Why it may hurt: tearing, and some
 * apps need compositing. Requires: session D-Bus + gsettings, no root. Unverified: benchmark it.
 */
export function createCompositorMutation(sys: LinuxSystem, proc: ProcFs, mm: MutationManager): SystemMutation {
  let original: string | undefined;
  const undoId = randomUUID();
  const self = mm.create(
    "disable Marco compositing for the session (restored afterwards)",
    async () => {
      const cur = await sys.execute("gsettings", ["get", SCHEMA, KEY], { timeoutMs: 3000 });
      if (!commandOk(cur)) throw new TangerineError({ code: "MUTATION_FAILED", subsystem: "performance", message: `gsettings unavailable: ${cur.stderr.trim() || cur.spawnError}`, recoverable: true, fallback: "compositor left unchanged" });
      original = cur.stdout.trim();
      if (original === "false") {
        original = undefined; // already off: nothing to restore, nothing to change
        return;
      }
      const r = await sys.execute("gsettings", ["set", SCHEMA, KEY, "false"], { timeoutMs: 3000 });
      if (!commandOk(r)) throw new Error(r.stderr.trim() || "gsettings set failed");
    },
    async () => {
      if (original === undefined) return;
      const r = await sys.execute("gsettings", ["set", SCHEMA, KEY, original], { timeoutMs: 3000 });
      if (!commandOk(r)) throw new Error(r.stderr.trim() || "gsettings restore failed");
      original = undefined;
    },
  );
  void proc;
  // Journal record written *before* apply; recovery re-sets to "true", the stock MATE default.
  self.undo = { id: undoId, kind: "gsettings", data: { schema: SCHEMA, key: KEY, original: "true" }, description: "restore Marco compositing" };
  return self;
}
