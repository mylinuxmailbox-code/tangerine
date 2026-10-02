import { randomUUID } from "node:crypto";
import { errMsg, TangerineError } from "./Errors.js";
import type { Logger } from "../utils/Logger.js";

/**
 * Serializable description of how to undo a mutation if Tangerine itself crashes.
 * Kinds are interpreted by core/Recovery.ts. Only Tangerine-owned, positively identified
 * resources may appear here (spec §59).
 */
export interface UndoRecord {
  id: string;
  kind: "renice" | "resume" | "gsettings" | "tempdir";
  data: Record<string, string | number | boolean>;
  description: string;
}

export interface SystemMutation {
  id: string;
  description: string;
  apply(): Promise<void>;
  rollback(): Promise<void>;
  applied: boolean;
  /** Irreversible actions (e.g. terminate) are recorded but cannot be rolled back. */
  irreversible?: boolean;
  /** Persisted before apply() so a crash mid-apply is still recoverable. */
  undo?: UndoRecord;
}

export interface MutationJournal {
  record(undo: UndoRecord): Promise<void>;
  forget(id: string): Promise<void>;
}

export interface MutationReport {
  id: string;
  description: string;
  status: "applied" | "rolled-back" | "failed-apply" | "failed-rollback" | "irreversible" | "pending";
  error?: string;
}

/** Registry of host modifications: apply in order, roll back in reverse, idempotently. */
export class MutationManager {
  private readonly mutations: SystemMutation[] = [];
  private readonly reports = new Map<string, MutationReport>();

  constructor(
    private readonly logger: Logger,
    private readonly journal?: MutationJournal,
  ) {}

  create(description: string, apply: () => Promise<void>, rollback: () => Promise<void>, extra: Partial<Pick<SystemMutation, "irreversible" | "undo">> = {}): SystemMutation {
    return { id: randomUUID(), description, apply, rollback, applied: false, ...extra };
  }

  /** Applies one mutation. On failure the mutation is rolled back (partial apply) and the error is rethrown. */
  async apply(m: SystemMutation): Promise<void> {
    this.mutations.push(m);
    this.reports.set(m.id, { id: m.id, description: m.description, status: "pending" });
    if (m.undo) await this.journal?.record(m.undo);
    try {
      await m.apply();
      m.applied = true;
      this.reports.set(m.id, { id: m.id, description: m.description, status: m.irreversible ? "irreversible" : "applied" });
      this.logger.info("mutation.applied", { id: m.id, description: m.description });
    } catch (error) {
      // apply() may have changed state before failing: attempt a rollback regardless.
      try {
        await m.rollback();
      } catch {
        /* best effort */
      }
      await this.journal?.forget(m.undo?.id ?? m.id);
      this.reports.set(m.id, { id: m.id, description: m.description, status: "failed-apply", error: errMsg(error) });
      this.logger.warn("mutation.failed", { id: m.id, description: m.description, error: errMsg(error) });
      throw new TangerineError({
        code: "MUTATION_FAILED",
        subsystem: "mutation",
        message: `Could not apply: ${m.description}`,
        recoverable: true,
        hostModified: false,
        cause: error,
      });
    }
  }

  /** Rolls everything back in reverse order. Safe to call repeatedly (idempotent). */
  async rollbackAll(): Promise<MutationReport[]> {
    for (const m of [...this.mutations].reverse()) {
      if (!m.applied) continue;
      if (m.irreversible) {
        m.applied = false;
        continue;
      }
      try {
        await m.rollback();
        m.applied = false;
        await this.journal?.forget(m.undo?.id ?? m.id);
        this.reports.set(m.id, { id: m.id, description: m.description, status: "rolled-back" });
        this.logger.info("mutation.rolled_back", { id: m.id, description: m.description });
      } catch (error) {
        this.reports.set(m.id, { id: m.id, description: m.description, status: "failed-rollback", error: errMsg(error) });
        this.logger.error("mutation.rollback_failed", { id: m.id, description: m.description, error: errMsg(error) });
      }
    }
    return this.report();
  }

  report(): MutationReport[] {
    return [...this.reports.values()];
  }

  get appliedCount(): number {
    return this.mutations.filter((m) => m.applied).length;
  }
}
