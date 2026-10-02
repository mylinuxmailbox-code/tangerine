# Tangerine

A private, local **execution harness and performance control plane** for running Android x86_64
software on resource-constrained Linux desktops. TypeScript (strict), Ink terminal UI, Node ≥ 20 or Bun.
It does **not** ship an Android runtime: it launches whatever you configure through a pluggable
`RuntimeAdapter`, wraps it in a prepared and monitored environment, and undoes every change on exit.

Primary target: **Linux Mint 21.3 "Virginia" MATE · Intel i3-6006U (2C/4T, 2.0 GHz, HD Graphics 520) ·
8 GB DDR4 · 240 GB SATA SSD**. Defaults are chosen from detected hardware, so better machines get
more aggressive defaults and nothing is hard-wired to one CPU.

> **No unmeasured claims.** Nothing here is advertised as "faster". Every tuning knob is an
> *experiment*; `tangerine benchmark` is how you find out whether it helps on *your* machine.
> FPS and GPU numbers are never fabricated: when a source does not exist, the UI says
> `unavailable` and why.

## Quick start

```bash
npm install
npm run build
node bin/tangerine.js doctor                      # PASS / WARN / FAIL / UNAVAILABLE for this host
node bin/tangerine.js start --dry-run -- /opt/android/launch.sh game.apk   # full plan, zero host changes
node bin/tangerine.js start -- /opt/android/launch.sh game.apk             # Ink dashboard
```

(`npm link` installs a `tangerine` command.)

## Commands

| Command | Purpose |
|---|---|
| `start` | Plan → prepare → launch → monitor. `--dry-run` prints the plan only. `--benchmark` records a result on exit. |
| `stop` / `restart` | SIGTERM the session controller, which stops the workload and rolls everything back. |
| `status` | Active session, PIDs, state. |
| `inspect` | Detected capabilities and the resolved plan (read-only). |
| `doctor` | Capability checks, each PASS / WARN / FAIL / UNAVAILABLE with a remedy. |
| `benchmark` | Measured sessions; `--experiment cpu\|graphics\|memory\|compositor`; `benchmark compare A B`; `benchmark list`. |
| `config` | Effective config; `config path`; `config init`. |
| `logs` | Tail of the JSONL log (`-n N`). |

Options: `--profile safe|balanced|performance|custom`, `--graphics auto|opengl|vulkan`, `--no-network`,
`--debug`, `--verbose`, `--quiet`, `--dry-run`, `--benchmark`, `--no-ui`, `--json`, `--config PATH`,
`--runs/--duration/--warmup/--cooldown`.

Config precedence: **defaults (hardware-aware) → profile overlay → config file → `TANGERINE_*` env → CLI flags**.
Env allow-list: `TANGERINE_PROFILE`, `_GRAPHICS`, `_VSYNC`, `_NETWORK`, `_LOG_LEVEL`, `_UI`, `_RUNTIME`.
Example config for the i3-6006U: [`examples/tangerine.i3-6006u.json`](examples/tangerine.i3-6006u.json).

## Architecture

```
src/
  core/         Tangerine orchestrator, StateMachine, MutationManager (reversible host changes),
                SessionStore + Recovery (crash recovery), CapabilityManager, structured errors
  config/       schema, hardware-aware defaults, validator, env mapping, loader (precedence)
  runtime/      RuntimeAdapter, TranslationAdapter, ExecChainRuntime ("exec-chain"), RuntimeManager,
                MountManager, EnvironmentBuilder (layered env, redaction)
  process/      ProcessManager (spawn, never a shell, process groups), SignalManager, ExitHandler
  performance/  Hardware classes, profiles, graphics selection, CPU topology, affinity, scheduler,
                memory, compositor, opt-in background-process rules
  sandbox/      FilesystemPolicy, NamespaceManager (unshare), Bubblewrap argv, CgroupManager (systemd scope),
                SeccompManager (honest "not enforced"), SandboxManager
  network/      blocked / restricted / unrestricted policy, netns description, FirewallManager (read-only)
  monitoring/   Metric<T> with explicit availability, CPU/memory/swap/process/GPU/FPS monitors
  benchmark/    Runner, BenchmarkStore, Comparison (verdicts), Experiments (one variable at a time), Reporter
  system/       CommandRunner, LinuxSystem, ProcFs, SysFs, Permissions, Platform — mockable interfaces
  terminal/     Ink + React dashboard      cli/  arg parsing, doctor, commands
```

Lifecycle: `IDLE → INITIALIZING → PREPARING → STARTING → RUNNING → STOPPING → CLEANING → STOPPED`
(`FAILED` is reachable from every active state, then `CLEANING → STOPPED`; illegal transitions throw `INVALID_STATE_TRANSITION`).
Start order: detect platform → detect capabilities → load config → validate → plan sandbox/network/graphics/CPU →
register mutations → apply → build environment → launch → monitor.
Stop order: stop accepting work → ask the app to quit → wait → kill the process group → roll back mutations
in reverse → remove the private session dir → remove the session record.

Design rules enforced in code **and tests**: every host change goes through `MutationManager`, which journals
the undo record *before* applying it; cleanup is idempotent; crash recovery only touches resources whose PID +
start time (or ownership marker file) it can prove are its own.

## What actually runs on a given host (honest capability reporting)

Tangerine detects what exists and degrades visibly; `inspect`/`--dry-run` show the decision and the reason.

| Layer | Preferred | Fallback | Not available → |
|---|---|---|---|
| Filesystem isolation | `bwrap` (private `/tmp`, read-only `/usr`, explicit binds, no HOME) | `unshare` (**no fs isolation**, reported as such) | none; `failIfDegraded` makes it fatal |
| PID / net namespace | bwrap or `unshare --user --map-root-user` | — | `network.mode: blocked` **fails closed** (never silently open) |
| Memory cap | `systemd-run --user --scope -p MemoryHigh=` | none | skipped with a note |
| Seccomp | not implemented | — | reported "not enforced"; never claimed |
| Network `restricted` | not implemented | falls back to `blocked` with a warning | the global firewall is never modified |

## Permissions

Everything runs as your user, no root. Privileged features are probed and skipped, with the reason, if
unavailable: negative `nice` and `SCHED_RR` need `CAP_SYS_NICE`; page-cache drop (opt-in, one shot) needs root.
Real-time scheduling needs **both** `cpu.allowRealtime: true` and permission, and is never inferred from a profile.
Never done automatically: dropping caches, disabling swap, killing processes, changing the firewall.

## Tests & validation

```bash
npm test                           # builds, then runs node:test over dist/test — 81 tests, no root needed
npx tsc --noEmit -p .              # strict type check
node bin/tangerine.js doctor
node bin/tangerine.js start --dry-run --profile performance -- /path/to/launch.sh
```

Unit tests use `FakeLinuxSystem` (in-memory files, scripted commands, recorded signals/affinity/priority).
Integration tests run the real orchestrator against a shell-script workload in a temp tree (sandbox and network
isolation disabled, so unprivileged): start → run → stop → cleanup, process-group kill, stale-session recovery.

## Benchmarking method

See [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md). In short:

```bash
tangerine benchmark --experiment cpu      --runs 3 --duration 60 --warmup 10 -- ./launch.sh
tangerine benchmark --experiment graphics --runs 3 --duration 60 --save-preference -- ./launch.sh
tangerine benchmark compare baseline pinned
```

Each experiment changes **one variable**, records the whole system state (kernel, CPU, config + env hash), and
refuses to call a winner from a single run or a difference inside run-to-run noise (verdict `within-noise` /
`unverified-single-run`). Differences in the *cause* of a change are always reported as "unverified".

## Further docs

- [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md) — what each knob does, risks, how to measure it
- [docs/ARCHITECTURE-NOTES.md](docs/ARCHITECTURE-NOTES.md) — FFI / ABI boundaries, runtime & translation adapters, extending
