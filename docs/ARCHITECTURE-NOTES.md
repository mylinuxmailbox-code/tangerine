# Architecture notes: adapters, FFI / ABI boundaries, extension

## Runtime adapters
`RuntimeAdapter` (src/runtime/RuntimeAdapter.ts): `detect`, `prepare(ctx)`, `start(opts)`, `stop`, `cleanup`,
`getEnvironment`, plus capability and mount declarations the sandbox planner reads. The core only talks to this interface.
The bundled `ExecChainRuntime` (`id: "exec-chain"`) launches any executable you configure
(`runtime.executable` or the `-- cmd args` on the CLI) — a launcher script, a front-end for a translation
layer, a container wrapper. A new runtime = implement the interface and register it in `RuntimeManager`
(`adapter: "auto"` picks the first whose `detect()` succeeds; `TANGERINE_RUNTIME` forces one).

## Translation adapters
`TranslationAdapter` rewrites the final `{command, args, env}` (e.g. to put a translation front-end in front of an
ARM/x86 binary) and reports `detect()`. The default is `PassthroughTranslation`. Android x86_64 workloads usually
need no translation; the seam exists so that one can be added without touching the core.

## Boundaries where Tangerine crosses an ABI
Tangerine contains **no native code and no FFI**. Every crossing is a process or file interface:

| Boundary | Interface | Stability contract |
|---|---|---|
| External tools (`bwrap`, `unshare`, `taskset`, `nice`, `chrt`, `systemd-run`, `gsettings`, `glxinfo`, `vulkaninfo`) | argv via `RealCommandRunner` (spawn, `shell:false`, NUL-checked, timeouts, bounded output, audit history) | CLI of each tool; absent tool ⇒ capability reported UNAVAILABLE |
| Kernel | `/proc`, `/sys`, `/proc/pressure/*` text formats; `kill(2)`, `setpriority(2)` through Node | Parsers are tested against captured samples, tolerate missing files (PSI disabled, no cpufreq) |
| Workload | spawn with explicit env, process group leader; stdout/stderr text (frame lines) | The workload ABI is whatever it is: Tangerine never loads it into its own address space |
| Graphics | Mesa/driver environment variables only (documented ones) | An unknown variable is never invented; `frameLimit` is passed to the runtime adapter, not faked via env |
| Runtime adapter | TypeScript interface | Versioned with the package |

If a native binding is ever added (e.g. `setpriority`/`sched_setaffinity` without `taskset`), put it behind the
existing `LinuxSystem` interface so tests keep using the fake, and document struct layouts and the supported
glibc/kernel range here.

## Mockable system interfaces
`LinuxSystem` (files, exec, signals, priorities), `ProcFs`, `SysFs`, `CommandRunner`. `test/helpers/fakes.ts`
provides `FakeLinuxSystem` and an i3-6006U topology fixture (siblings 0/2 and 1/3).

## Known limitations
- Seccomp is not implemented (reported as not enforced).
- `network.mode: restricted` (allow-lists) is not implemented; it falls back to `blocked` with a warning.
- Without `bwrap`, there is **no filesystem isolation** (`unshare` only gives PID/net/mount namespaces).
- GPU telemetry is limited to i915 clock frequencies from `/sys/class/drm` (not utilisation); otherwise `unavailable`.
- The i3-6006U numbers in docs are intentionally absent: none were measured on that hardware in this repo's CI.
