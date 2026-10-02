import { TangerineError } from "./Errors.js";

export type TangerineState =
  | "idle" | "initializing" | "preparing" | "starting" | "running"
  | "stopping" | "cleaning" | "failed" | "stopped";

/** Allowed transitions (spec §57). `idle -> running` is deliberately absent. */
const TRANSITIONS: Record<TangerineState, readonly TangerineState[]> = {
  idle: ["initializing", "cleaning", "stopped"],
  initializing: ["preparing", "failed", "cleaning"],
  preparing: ["starting", "failed", "cleaning"],
  starting: ["running", "failed", "stopping", "cleaning"],
  running: ["stopping", "failed", "cleaning"],
  stopping: ["cleaning", "failed"],
  cleaning: ["stopped", "failed"],
  failed: ["cleaning", "stopped"],
  stopped: ["initializing"],
};

export type LifecyclePhase =
  | "INITIALIZE" | "LOAD CONFIG" | "VALIDATE CONFIG" | "DETECT PLATFORM" | "DETECT CAPABILITIES"
  | "CREATE RUNTIME PLAN" | "CREATE SANDBOX" | "CREATE NETWORK POLICY" | "PREPARE MOUNTS"
  | "BUILD ENVIRONMENT" | "APPLY PERFORMANCE POLICY" | "START RUNTIME" | "START MONITORING"
  | "RUN TARGET" | "COLLECT TELEMETRY" | "STOP TARGET" | "STOP MONITORS" | "ROLL BACK MUTATIONS"
  | "UNMOUNT RESOURCES" | "DESTROY SANDBOX" | "FINAL REPORT";

export type StateListener = (state: TangerineState, from: TangerineState) => void;

export class StateMachine {
  private current: TangerineState = "idle";
  private readonly listeners = new Set<StateListener>();
  private phaseName: LifecyclePhase | undefined;

  get state(): TangerineState {
    return this.current;
  }
  get phase(): LifecyclePhase | undefined {
    return this.phaseName;
  }
  setPhase(p: LifecyclePhase): void {
    this.phaseName = p;
  }
  canTransition(to: TangerineState): boolean {
    return to === this.current || TRANSITIONS[this.current].includes(to);
  }
  transition(to: TangerineState): void {
    if (to === this.current) return;
    if (!this.canTransition(to)) {
      throw new TangerineError({
        code: "INVALID_STATE_TRANSITION",
        subsystem: "lifecycle",
        message: `Invalid transition ${this.current} -> ${to}`,
        recoverable: false,
      });
    }
    const from = this.current;
    this.current = to;
    for (const l of this.listeners) l(to, from);
  }
  onChange(l: StateListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
