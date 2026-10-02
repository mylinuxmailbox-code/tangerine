# Optimization guide (i3-6006U / 8 GB / SATA SSD first)

Rule zero: **a knob is a hypothesis until `tangerine benchmark` says otherwise.** Tangerine ships only
conservative defaults and prints the exact effect of every profile with `tangerine start --dry-run`.

## Profiles

| Profile | Changes (low-core host, ≤4 logical CPUs) |
|---|---|
| `safe` | Nothing but the sandbox/network defaults. No pinning, no nice, no cgroup. |
| `balanced` (default) | cgroup `MemoryHigh` = 80 % of RAM, persistent shader cache. **No CPU pinning** on ≤4 logical CPUs: the desktop needs those cores and the benefit is unproven. |
| `performance` | EXPERIMENTAL on 2C/4T: one thread per physical core (SMT siblings left to the desktop), `nice -5` if permitted, `MemoryHigh` 85 %. |
| `custom` | No overlay: only your file / env / CLI. |

On ≥8 logical CPUs `balanced` reserves one physical core (both SMT siblings) for the desktop.

## Knobs

| Knob | Mechanism | Risk | Measure with |
|---|---|---|---|
| Graphics backend `auto/opengl/vulkan` | Mesa env vars only: `vblank_mode`, `mesa_glthread`, `MESA_SHADER_CACHE_DIR`, `MESA_SHADER_CACHE_MAX_SIZE`, `LIBGL_DEBUG`, `MESA_VK_WSI_PRESENT_MODE`. Vulkan is **not** assumed faster on HD 520. | Explicit unavailable backend → hard error. `auto` with nothing detected → backend `none` + warning. | `--experiment graphics` (`--save-preference` stores a measured winner for `auto`) |
| `graphics.vsync=false` | `vblank_mode=0` / `immediate` present mode | Tearing | graphics experiment |
| Shader cache | persistent dir, 512 M cap | Disk use | cold vs warm runs |
| CPU affinity | `taskset -c` plan from sysfs topology; never pins to "all CPUs" | Starves the desktop on 2C/4T | `--experiment cpu` |
| Nice | `nice -n` (negative needs `CAP_SYS_NICE`; clamped + reported otherwise) | Desktop latency | cpu experiment |
| Realtime | `chrt -r` only with `allowRealtime: true` **and** permission | Can lock up the host | not recommended |
| Memory cap | `systemd-run --user --scope -p MemoryHigh=` (soft limit, reclaim not OOM-kill) | Throttling | `--experiment memory` |
| Swap watch | pswpin/pswpout **rates** with hysteresis (enter/exit sample counts); swap *fill* alone is not "thrashing" | none (read-only) | dashboard |
| Compositor | MATE Marco `compositing-manager` via gsettings, restored on exit (also by crash recovery) | Visual glitches | `--experiment compositor` |
| Background rules | opt-in `cpu.background[]`: `lower-priority`, `pause` (SIGSTOP/SIGCONT), `terminate` (irreversible, flagged) | Never applies to protected names (Xorg, marco, mate-*, systemd, sshd, shells, node, …) or Tangerine itself; PID reuse checked on rollback | cpu experiment |
| Cache drop | `memory.cacheManagement`, opt-in, root, once, before launch | Cold cache hurts first launch | memory experiment |

## Measuring

1. Quiesce the machine (same power source, same governor, no updates running).
2. `tangerine benchmark --experiment <kind> --runs 3 --duration 60 --warmup 10 --cooldown 15 -- <launch cmd>`
3. Runs alternate through a ladder where each step differs from the baseline by one variable.
4. Results are stored under `~/.local/state/tangerine/benchmarks/`; each stores the system fingerprint
   (kernel, CPU, runtime adapter, config/env hash). `compare` lists any mismatch as **NOT like-for-like**.
5. Read the verdicts: `higher/lower` only when ranges are separated; otherwise `within-noise`;
   a single run is `unverified-single-run`.
6. FPS appears only if the runtime exposes frame data (`runtime.fpsFromStderr` parses `fps: N`, `N fps`,
   `frame time: N ms` from the workload's stderr). Otherwise FPS = unavailable and comparisons use CPU/memory/swap/startup.

## Reading the swap signal

Swap traffic (pages in + out per second) above `memory.swapInActivePagesPerSec` (200 by default on this class) for `enterSamples`
consecutive samples enters *thrashing*; it exits only after `exitSamples` samples below the inactive threshold (50).
Between the two thresholds the state is held, which prevents flapping. Tangerine only reports this. It never
disables swap or kills anything in response.

## Process-lifecycle note

Inside a PID namespace the workload is PID 1, and the kernel ignores signals PID 1 has not handled.
A launch script must `trap` SIGTERM (or `exec` the real app) or `stop` waits `runtime.stopTimeoutMs`
(8 s default) and then escalates to SIGKILL.
