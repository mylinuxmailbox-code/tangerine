export type ErrorCode =
  | "CONFIG_INVALID"
  | "RUNTIME_NOT_FOUND"
  | "RUNTIME_REQUEST_INVALID"
  | "GRAPHICS_BACKEND_UNAVAILABLE"
  | "AFFINITY_FAILED"
  | "SCHEDULER_PERMISSION_DENIED"
  | "SANDBOX_UNAVAILABLE"
  | "MOUNT_FAILED"
  | "MOUNT_REJECTED"
  | "NETWORK_POLICY_FAILED"
  | "PROCESS_START_FAILED"
  | "PROCESS_TIMEOUT"
  | "MUTATION_FAILED"
  | "INVALID_STATE_TRANSITION"
  | "CLEANUP_FAILED"
  | "COMMAND_FAILED"
  | "STALE_SESSION"
  | "SESSION_ACTIVE"
  | "INTERNAL";

export interface TangerineErrorInit {
  code: ErrorCode;
  subsystem: string;
  message: string;
  /** Can Tangerine continue (possibly degraded) after this error? */
  recoverable: boolean;
  /** Was host state changed before the failure? (spec §39.4) */
  hostModified?: boolean;
  /** Human description of the fallback, if any. (spec §39.3) */
  fallback?: string;
  /** What the user can do next. (spec §39.5) */
  hint?: string;
  cause?: unknown;
}

/** Structured error: explains what failed, why, fallback, host impact, and next step. */
export class TangerineError extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly subsystem: string;
  readonly hostModified: boolean;
  readonly fallback?: string;
  readonly hint?: string;
  override readonly cause?: unknown;

  constructor(init: TangerineErrorInit) {
    super(init.message);
    this.name = "TangerineError";
    this.code = init.code;
    this.recoverable = init.recoverable;
    this.subsystem = init.subsystem;
    this.hostModified = init.hostModified ?? false;
    this.fallback = init.fallback;
    this.hint = init.hint;
    this.cause = init.cause;
  }

  describe(): string {
    const lines = [`[${this.code}] (${this.subsystem}) ${this.message}`];
    lines.push(`  host state modified: ${this.hostModified ? "yes" : "no"}`);
    if (this.fallback) lines.push(`  fallback: ${this.fallback}`);
    if (this.hint) lines.push(`  next step: ${this.hint}`);
    if (this.cause !== undefined) lines.push(`  cause: ${errMsg(this.cause)}`);
    return lines.join("\n");
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;
}
