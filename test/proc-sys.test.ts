import test from "node:test";
import assert from "node:assert/strict";
import { parseMemInfo, parseCpuStat, cpuUsagePercent, parseVmStat, parseProcessStatus, parseProcessStat, parsePsi, LinuxProcFs } from "../src/system/ProcFs.js";
import { parseCpuList, buildTopology, coreGroups, LinuxSysFs } from "../src/system/SysFs.js";
import { parseCapEff, parseLimit, detectPermissions } from "../src/system/Permissions.js";
import { parseOsRelease } from "../src/system/Platform.js";
import { FakeLinuxSystem, addI3Topology } from "./helpers/fakes.js";

const MEMINFO = `MemTotal:        7900000 kB
MemFree:          500000 kB
MemAvailable:    3000000 kB
Buffers:          100000 kB
Cached:          2000000 kB
SwapCached:         1000 kB
AnonPages:       3500000 kB
Shmem:            200000 kB
Dirty:               400 kB
SwapTotal:       2097148 kB
SwapFree:        2000000 kB
`;

test("parseMemInfo", () => {
  const m = parseMemInfo(MEMINFO);
  assert.equal(m.totalKb, 7900000);
  assert.equal(m.availableKb, 3000000);
  assert.equal(m.swapTotalKb - m.swapFreeKb, 97148);
  assert.equal(m.anonPagesKb, 3500000);
});

test("parseMemInfo falls back when MemAvailable is missing (old kernels)", () => {
  const m = parseMemInfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n");
  assert.equal(m.availableKb, 300);
});

test("cpu stat parsing and usage deltas", () => {
  const a = parseCpuStat("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\nctxt 5\n");
  const b = parseCpuStat("cpu  200 0 200 900 0 0 0 0 0 0\ncpu0 100 0 100 450 0 0 0 0 0 0\ncpu1 100 0 100 450 0 0 0 0 0 0\nctxt 9\n");
  assert.equal(a.perCpu.size, 2);
  assert.equal(cpuUsagePercent(a.total, b.total), 200 / 300 * 100);
  assert.equal(cpuUsagePercent(a.total, a.total), undefined, "no elapsed ticks => unknown, not 0%");
});

test("vmstat parsing", () => {
  const v = parseVmStat("pswpin 10\npswpout 20\npgfault 300\npgmajfault 4\nallocstall_normal 3\nallocstall_dma 1\n");
  assert.equal(v.pswpin, 10);
  assert.equal(v.pswpout, 20);
  assert.equal(v.allocstall, 4);
});

test("process status and stat (comm containing spaces and parentheses)", () => {
  const s = parseProcessStatus(42, "Name:\tandroid (x)\nState:\tS (sleeping)\nPPid:\t7\nVmSize:\t900 kB\nVmRSS:\t300 kB\nRssAnon:\t200 kB\nVmSwap:\t5 kB\nThreads:\t12\nCpus_allowed_list:\t0-3\n");
  assert.equal(s.vmRssKb, 300);
  assert.equal(s.state, "S");
  assert.equal(s.cpusAllowedList, "0-3");
  const st = parseProcessStat("42 (my (weird) name) S 7 42 42 0 -1 4194560 100 0 0 0 11 22 0 0 20 0 3 0 99999 1000 100 18446744073709551615");
  assert.ok(st);
  assert.equal(st.comm, "my (weird) name");
  assert.equal(st.ppid, 7);
  assert.equal(st.pgrp, 42);
  assert.equal(st.utime, 11);
  assert.equal(st.stime, 22);
  assert.equal(st.threads, 3);
  assert.equal(st.startTimeTicks, 99999);
});

test("PSI parsing", () => {
  const p = parsePsi("some avg10=1.50 avg60=0.40 avg300=0.10 total=12345\nfull avg10=0.25 avg60=0.05 avg300=0.00 total=99\n");
  assert.equal(p?.someAvg10, 1.5);
  assert.equal(p?.fullAvg10, 0.25);
  assert.equal(parsePsi("garbage"), undefined);
});

test("cpu list syntax", () => {
  assert.deepEqual(parseCpuList("0-1,3,5-6\n"), [0, 1, 3, 5, 6]);
  assert.deepEqual(parseCpuList("2"), [2]);
  assert.deepEqual(parseCpuList("a-b"), []);
  assert.deepEqual(parseCpuList("5-2"), []);
});

test("i3-6006U topology: logical ids do not map 1:1 to cores", async () => {
  const sys = new FakeLinuxSystem();
  addI3Topology(sys);
  const t = await new LinuxSysFs(sys).readCpuTopology();
  assert.equal(t.logicalCount, 4);
  assert.equal(t.physicalCoreCount, 2);
  assert.equal(t.smt, true);
  assert.deepEqual(coreGroups(t), [[0, 2], [1, 3]]);
  assert.equal(t.freqDriver, "intel_pstate");
  assert.equal(t.cpus[0]?.governor, "powersave");
});

test("topology respects offline CPUs", () => {
  const t = buildTopology({ possible: [0, 1, 2, 3], online: [0, 1], perCpu: new Map(), numaNodes: 1 });
  assert.equal(t.logicalCount, 2);
  assert.equal(t.cpus.filter((c) => !c.online).length, 2);
});

test("gpu info from i915 sysfs; debugfs reported honestly", async () => {
  const sys = new FakeLinuxSystem();
  const c = "/sys/class/drm/card0";
  sys.addFile(`${c}/device/vendor`, "0x8086\n").addFile(`${c}/device/device`, "0x1916\n").addFile(`${c}/gt_cur_freq_mhz`, "600\n").addFile(`${c}/gt_max_freq_mhz`, "900\n");
  sys.addLink(`${c}/device/driver`, "/sys/bus/pci/drivers/i915");
  const g = await new LinuxSysFs(sys).readGpuInfo();
  assert.equal(g.devices[0]?.isIntel, true);
  assert.equal(g.devices[0]?.curFreqMhz, 600);
  assert.equal(g.devices[0]?.driver, "i915");
  assert.equal(g.debugfsReadable, false);
});

test("permissions: capabilities, rlimits, minNice", async () => {
  assert.equal(parseCapEff("CapEff:\t0000000000800000\n"), 1n << 23n);
  assert.equal(parseLimit("Max nice priority         0                    0\n", "Max nice priority"), 0);
  assert.equal(parseLimit("Max realtime priority     unlimited unlimited\n", "Max realtime priority"), Infinity);
  const sys = new FakeLinuxSystem();
  sys.addFile("/proc/self/status", "CapEff:\t0000000000000000\n").addFile("/proc/self/limits", "Max nice priority         0                    0\nMax realtime priority     0                    0\n");
  const p = await detectPermissions(sys, new LinuxProcFs(sys));
  assert.equal(p.hasSysNice, false);
  assert.equal(p.minNice, 0, "unprivileged Mint default cannot lower nice below 0");
  sys.addFile("/proc/self/status", "CapEff:\t0000000000800000\n");
  assert.equal((await detectPermissions(sys, new LinuxProcFs(sys))).minNice, -20);
});

test("os-release", () => {
  const r = parseOsRelease('NAME="Linux Mint"\nVERSION_ID="21.3"\nVERSION_CODENAME=virginia\nUBUNTU_CODENAME=jammy\n');
  assert.equal(r["NAME"], "Linux Mint");
  assert.equal(r["VERSION_CODENAME"], "virginia");
});
