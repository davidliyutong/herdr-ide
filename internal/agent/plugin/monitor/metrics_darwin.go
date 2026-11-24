//go:build darwin

package monitor

import (
	"context"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// CollectMetrics gathers a macOS host's CPU, memory, per-GPU, network, disk I/O
// and filesystem usage, and the battery temperature, concurrently.
func (c *Collector) CollectMetrics(ctx context.Context) (*Metrics, error) {
	now := time.Now()
	m := baseMetrics(now)

	var (
		wg         sync.WaitGroup
		sysctlRaw  string
		vmStatRaw  string
		topRaw     string
		netstatRaw string
		gpuRaw     string
		blockRaw   string
		dfRaw      string
		batteryRaw string
	)

	run := func(dst *string, name string, args ...string) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s, err := runCmd(ctx, name, args...); err == nil {
				*dst = s
			}
		}()
	}

	run(&sysctlRaw, "sysctl", "-n", "vm.loadavg", "hw.memsize", "vm.swapusage", "kern.boottime")
	run(&vmStatRaw, "vm_stat")
	run(&topRaw, "top", "-l", "1", "-n", "0", "-s", "0")
	run(&netstatRaw, "netstat", "-ibn")
	run(&gpuRaw, "ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator")
	run(&blockRaw, "ioreg", "-r", "-c", "IOBlockStorageDriver", "-w", "0")
	run(&dfRaw, "df", "-kP")
	// The battery is the only temperature sensor readable without root or
	// cgo (SMC, IOHID); a desktop Mac has none and shows no sensors.
	run(&batteryRaw, "ioreg", "-rn", "AppleSmartBattery", "-w0")

	wg.Wait()

	var memTotal uint64
	if sysctlRaw != "" {
		lines := strings.Split(strings.TrimSpace(sysctlRaw), "\n")
		if len(lines) >= 1 {
			m.CPU.Load1, m.CPU.Load5, m.CPU.Load15 = parseDarwinLoadAvg(lines[0])
		}
		if len(lines) >= 2 {
			memTotal, _ = strconv.ParseUint(strings.TrimSpace(lines[1]), 10, 64)
		}
		if len(lines) >= 3 {
			m.Memory.SwapTotalBytes, m.Memory.SwapUsedBytes = parseSwapUsage(lines[2])
		}
		if len(lines) >= 4 {
			m.UptimeSec = parseDarwinBoottime(lines[3], now)
		}
	}

	if vmStatRaw != "" {
		mem := parseVMStat(vmStatRaw, memTotal)
		mem.SwapTotalBytes = m.Memory.SwapTotalBytes
		mem.SwapUsedBytes = m.Memory.SwapUsedBytes
		m.Memory = mem
	} else {
		m.Memory.TotalBytes = memTotal
	}

	if pct, ok := parseDarwinTopCPU(topRaw); ok {
		m.CPU.UsagePct = pct
	}

	if gpuRaw != "" {
		if gpus := parseDarwinIOAccelerator(gpuRaw, memTotal); len(gpus) > 0 {
			m.GPUs = gpus
		}
	}

	if netstatRaw != "" {
		m.Network = c.computeNetRates(now, parseDarwinNetstat(netstatRaw))
	}

	if blockRaw != "" {
		rd, wr := parseDarwinBlockStorageIO(blockRaw)
		m.DiskIO = c.computeDiskIORates(now, rd, wr)
	}

	if dfRaw != "" {
		m.Disks = parseDarwinDF(dfRaw)
	}

	if batteryRaw != "" {
		m.Sensors = parseDarwinBatteryTemp(batteryRaw)
	}

	return &m, nil
}

// CollectProcesses lists processes on macOS via ps.
func (c *Collector) CollectProcesses(ctx context.Context) (*ProcessesReply, error) {
	now := time.Now()
	var (
		wg      sync.WaitGroup
		metaRaw string
		argsRaw string
		memRaw  string
		metaErr error
	)

	wg.Add(3)
	go func() {
		defer wg.Done()
		metaRaw, metaErr = runCmd(ctx, "ps", "-axww", "-o", "pid=,ppid=,user=,%cpu=,%mem=,rss=,state=,etime=,comm=")
	}()
	go func() {
		defer wg.Done()
		argsRaw, _ = runCmd(ctx, "ps", "-axww", "-o", "pid=,args=")
	}()
	go func() {
		defer wg.Done()
		memRaw, _ = runCmd(ctx, "sysctl", "-n", "hw.memsize")
	}()
	wg.Wait()

	if metaErr != nil {
		return nil, metaErr
	}
	memTotal, _ := strconv.ParseUint(strings.TrimSpace(memRaw), 10, 64)
	procs := parsePSOutput(metaRaw, argsRaw)
	return &ProcessesReply{
		Processes:     procs,
		Total:         len(procs),
		Cores:         runtime.NumCPU(),
		MemTotalBytes: memTotal,
		TimestampMs:   now.UnixMilli(),
	}, nil
}
