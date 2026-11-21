//go:build unix

package monitor

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
)

func TestParseNvidiaSMICSV(t *testing.T) {
	raw := `0, NVIDIA GeForce RTX 4090, 74, 16384, 24564, 68, 312.5, 450.0
1, NVIDIA GeForce RTX 4090, 12, 1024, 24564, 41, [N/A], 450.0
`
	gpus := parseNvidiaSMICSV(raw)
	if len(gpus) != 2 {
		t.Fatalf("got %d gpus, want 2", len(gpus))
	}
	if gpus[0].Index != 0 || gpus[0].Name != "NVIDIA GeForce RTX 4090" || gpus[0].Vendor != "nvidia" {
		t.Fatalf("gpu[0] = %+v", gpus[0])
	}
	if gpus[0].UtilPct == nil || *gpus[0].UtilPct != 74 {
		t.Errorf("gpu[0].UtilPct = %v, want 74", gpus[0].UtilPct)
	}
	if gpus[0].TempC == nil || *gpus[0].TempC != 68 {
		t.Errorf("gpu[0].TempC = %v, want 68", gpus[0].TempC)
	}
	if gpus[0].PowerW == nil || *gpus[0].PowerW != 312.5 {
		t.Errorf("gpu[0].PowerW = %v, want 312.5", gpus[0].PowerW)
	}
	if gpus[0].MemUsedBytes != 16384*1024*1024 {
		t.Errorf("gpu[0].MemUsedBytes = %d", gpus[0].MemUsedBytes)
	}
	if gpus[1].PowerW != nil {
		t.Errorf("gpu[1].PowerW = %v, want nil for [N/A]", gpus[1].PowerW)
	}
}

func TestParseNvidiaComputeApps(t *testing.T) {
	raw := "1234, 4096\n1234, 1024\n5678, [N/A]\n"
	m := parseNvidiaComputeApps(raw)
	if m[1234] != 5120*1024*1024 {
		t.Fatalf("pid 1234 = %d, want %d", m[1234], 5120*1024*1024)
	}
	if _, ok := m[5678]; ok {
		t.Fatalf("unexpected entry for [N/A]")
	}
}

func TestParseProcStatAndDelta(t *testing.T) {
	s1 := "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\n"
	s2 := "cpu  200 0 150 950 0 0 0 0 0 0\ncpu0 100 0 100 450 0 0 0 0 0 0\n"
	t1, c1, ok1 := parseProcStat(s1)
	t2, c2, ok2 := parseProcStat(s2)
	if !ok1 || !ok2 || len(c1) != 1 || len(c2) != 1 {
		t.Fatalf("parseProcStat failed")
	}
	// total delta = 300, idle delta = 150 -> 50.0%
	if pct := cpuDeltaPct(t1, t2); pct != 50 {
		t.Errorf("total pct = %v, want 50", pct)
	}
	// cpu0 total delta = 150, idle delta = 50 -> 66.7%
	if pct := cpuDeltaPct(c1[0], c2[0]); pct != 66.7 {
		t.Errorf("core0 pct = %v, want 66.7", pct)
	}
}

func TestParseProcMeminfo(t *testing.T) {
	raw := `MemTotal:       16000000 kB
MemFree:         2000000 kB
MemAvailable:    6000000 kB
SwapTotal:       4000000 kB
SwapFree:        3000000 kB
`
	m := parseProcMeminfo(raw)
	if m.TotalBytes != 16000000*1024 || m.UsedBytes != 10000000*1024 || m.UsedPct != 62.5 {
		t.Fatalf("mem = %+v", m)
	}
	if m.SwapTotalBytes != 4000000*1024 || m.SwapUsedBytes != 1000000*1024 {
		t.Fatalf("swap = %+v", m)
	}
}

func TestParseProcNetAndDiskstats(t *testing.T) {
	netRaw := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999   100 0 0 0 0 0 0 999999 100 0 0 0 0 0 0
  eth0: 100000    10 0 0 0 0 0 0 200000  20 0 0 0 0 0 0
`
	netMap := parseProcNetDev(netRaw)
	if _, ok := netMap["lo"]; ok {
		t.Errorf("loopback should be skipped")
	}
	if netMap["eth0"].rx != 100000 || netMap["eth0"].tx != 200000 {
		t.Fatalf("eth0 = %+v", netMap["eth0"])
	}

	diskRaw := `   8       0 sda 100 0 2000 0 50 0 1000 0 0 0 0
   8       1 sda1 100 0 2000 0 50 0 1000 0 0 0 0
 259       0 nvme0n1 10 0 400 0 20 0 600 0 0 0 0
 259       1 nvme0n1p1 10 0 400 0 20 0 600 0 0 0 0
   7       0 loop0 1 0 100 0 0 0 0 0 0 0 0
`
	rd, wr := parseProcDiskstats(diskRaw)
	if rd != (2000+400)*512 || wr != (1000+600)*512 {
		t.Fatalf("diskstats rd=%d wr=%d", rd, wr)
	}
}

func TestParseDarwinParsers(t *testing.T) {
	vmRaw := `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down:                             100000.
Pages purgeable:                                5000.
Anonymous pages:                              305000.
Pages occupied by compressor:                 100000.
`
	mem := parseVMStat(vmRaw, 16*1024*1024*1024)
	// (300000 + 100000 + 100000) * 16384 = 8192000000 bytes
	if mem.UsedBytes != 500000*16384 {
		t.Fatalf("darwin mem used = %d, want %d", mem.UsedBytes, 500000*16384)
	}

	totSwap, usedSwap := parseSwapUsage("total = 4096.00M  used = 1024.00M  free = 3072.00M  (encrypted)")
	if totSwap != 4096*1024*1024 || usedSwap != 1024*1024*1024 {
		t.Fatalf("swap = %d / %d", usedSwap, totSwap)
	}

	if pct, ok := parseDarwinTopCPU("CPU usage: 10.5% user, 14.5% sys, 75.0% idle"); !ok || pct != 25 {
		t.Fatalf("top cpu = %v (%v)", pct, ok)
	}

	l1, l5, l15 := parseDarwinLoadAvg("{ 1.25 2.50 3.75 }")
	if l1 != 1.3 || l5 != 2.5 || l15 != 3.8 {
		t.Fatalf("load = %v %v %v", l1, l5, l15)
	}

	gpuRaw := `+-o AGXAcceleratorG16G  <class AGXAcceleratorG16G>
  {
    "model" = "Apple M4"
    "PerformanceStatistics" = {"Device Utilization %"=22,"In use system memory"=1073741824,"Alloc system memory"=2147483648}
  }
`
	gpus := parseDarwinIOAccelerator(gpuRaw, 16*1024*1024*1024)
	if len(gpus) != 1 || gpus[0].Name != "Apple M4" || gpus[0].UtilPct == nil || *gpus[0].UtilPct != 22 {
		t.Fatalf("darwin gpus = %+v", gpus)
	}

	dfRaw := `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1s1 1000000 100000 400000 10% /
/dev/disk3s5 1000000 500000 400000 56% /System/Volumes/Data
/dev/disk3s6 1000000 50000 400000 5% /System/Volumes/VM
/dev/disk4s1 200000 100000 100000 50% /Volumes/External
`
	disks := parseDarwinDF(dfRaw)
	if len(disks) != 2 || disks[0].Mount != "/" || disks[0].UsedPct != 60 || disks[1].Mount != "/Volumes/External" {
		t.Fatalf("darwin disks = %+v", disks)
	}

	metaRaw := "  100     1 alice  12.5  3.2  65536 R   01:23 /usr/bin/python3\n"
	argsRaw := "  100 /usr/bin/python3 train.py --epochs 10\n"
	procs := parsePSOutput(metaRaw, argsRaw)
	if len(procs) != 1 || procs[0].PID != 100 || procs[0].Name != "python3" || procs[0].Command != "/usr/bin/python3 train.py --epochs 10" {
		t.Fatalf("procs = %+v", procs)
	}
}

func TestCollectLiveMetricsAndProcesses(t *testing.T) {
	c := newCollector()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	m, err := c.CollectMetrics(ctx)
	if err != nil {
		t.Fatalf("CollectMetrics: %v", err)
	}
	if m.CPU.Cores <= 0 {
		t.Errorf("cores = %d", m.CPU.Cores)
	}
	if m.Memory.TotalBytes == 0 {
		t.Errorf("memory total = 0")
	}
	if len(m.Disks) == 0 {
		t.Errorf("expected at least one disk")
	}

	p, err := c.CollectProcesses(ctx)
	if err != nil {
		t.Fatalf("CollectProcesses: %v", err)
	}
	if len(p.Processes) == 0 {
		t.Errorf("expected running processes")
	}
}

func TestSendSignalGuardsAndSuccess(t *testing.T) {
	checkCode := func(p SignalParams, want string) {
		t.Helper()
		_, err := sendSignal(p)
		if err == nil {
			t.Fatalf("sendSignal(%+v) succeeded, want code %s", p, want)
		}
		var pe *plugin.Error
		if !errors.As(err, &pe) || pe.Code != want {
			t.Fatalf("sendSignal(%+v) err = %v, want code %s", p, err, want)
		}
	}

	checkCode(SignalParams{PID: 0, Signal: "TERM"}, "invalid_pid")
	checkCode(SignalParams{PID: 1, Signal: "TERM"}, "invalid_pid")
	checkCode(SignalParams{PID: -5, Signal: "TERM"}, "invalid_pid")
	checkCode(SignalParams{PID: os.Getpid(), Signal: "TERM"}, "invalid_pid")
	checkCode(SignalParams{PID: 999999, Signal: "SEGV"}, "invalid_signal")

	// Start a short-lived child process and terminate it cleanly.
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start sleep: %v", err)
	}
	defer cmd.Wait()

	rep, err := sendSignal(SignalParams{PID: cmd.Process.Pid, Signal: "TERM"})
	if err != nil || !rep.OK || rep.Signal != "TERM" {
		t.Fatalf("sendSignal child: rep=%+v err=%v", rep, err)
	}
}
