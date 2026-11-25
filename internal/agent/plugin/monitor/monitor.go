//go:build unix

package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net"
	"os"
	"os/exec"
	"path"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"veldr/internal/agent/plugin"
)

const (
	// ID is the plugin's identifier on every side.
	ID = "monitor"
	// maxCmdLen bounds a process's command line string in JSON replies.
	maxCmdLen = 512
	// cmdTimeout bounds external helper probes (nvidia-smi, ioreg, ps, etc.).
	cmdTimeout = 3 * time.Second
)

func init() {
	plugin.Register(ID, handle)
}

var defaultCollector = newCollector()

// Collector samples host metrics and processes, keeping the previous
// cumulative counters so throughput and CPU percentages reflect the recent
// interval.
type Collector struct {
	mu sync.Mutex

	// Previous Linux CPU ticks.
	prevCPU     cpuTicks
	prevPerCore []cpuTicks
	hasPrevCPU  bool

	// Previous network counters per interface.
	prevNet     map[string]netCounter
	prevNetTime time.Time

	// Previous block I/O counters.
	prevDiskRead  uint64
	prevDiskWrite uint64
	prevDiskTime  time.Time

	// Previous per-PID CPU ticks (Linux /proc).
	prevProcTicks map[int]uint64
	prevProcTime  time.Time

	// sensorsBusy is set while a sensor scan runs (sensorsWithin).
	sensorsBusy atomic.Bool
}

type cpuTicks struct {
	total uint64
	idle  uint64
}

type netCounter struct {
	rx uint64
	tx uint64
}

func newCollector() *Collector {
	return &Collector{
		prevNet:       map[string]netCounter{},
		prevProcTicks: map[int]uint64{},
	}
}

func handle(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
	ctx, cancel := plugin.UntilClosed(ctx, st)
	defer cancel()

	switch action {
	case "metrics":
		m, err := defaultCollector.CollectMetrics(ctx)
		return plugin.Reply(st, m, err)
	case "processes":
		p, err := defaultCollector.CollectProcesses(ctx)
		return plugin.Reply(st, p, err)
	case "signal":
		var p SignalParams
		if err := plugin.Decode(params, &p); err != nil {
			return plugin.Reply(st, nil, err)
		}
		rep, err := sendSignal(p)
		return plugin.Reply(st, rep, err)
	default:
		return plugin.Reply(st, nil, plugin.Errorf("unknown_action", "unknown monitor action %q", action))
	}
}

// allowedSignals maps the signal names the agent accepts to POSIX signals.
var allowedSignals = map[string]syscall.Signal{
	"TERM": syscall.SIGTERM,
	"KILL": syscall.SIGKILL,
	"INT":  syscall.SIGINT,
	"HUP":  syscall.SIGHUP,
	"STOP": syscall.SIGSTOP,
	"CONT": syscall.SIGCONT,
}

// maxPID is the largest pid the kernel's pid_t holds: kill(2) takes 32
// bits, so a larger int would wrap (4294967295 is -1, every process of
// the user; 2^32 plus the agent's pid is the agent).
const maxPID = math.MaxInt32

// sendSignal sends an allowlisted signal to pid, refusing PID <= 1, a pid
// beyond pid_t and the agent's own process.
func sendSignal(p SignalParams) (*SignalReply, error) {
	if p.PID <= 1 || p.PID > maxPID {
		return nil, plugin.Errorf("invalid_pid", "refusing to signal pid %d", p.PID)
	}
	if p.PID == os.Getpid() {
		return nil, plugin.Errorf("invalid_pid", "refusing to signal the agent process")
	}
	name := strings.ToUpper(strings.TrimSpace(p.Signal))
	if name == "" {
		name = "TERM"
	}
	sig, ok := allowedSignals[name]
	if !ok {
		return nil, plugin.Errorf("invalid_signal", "signal %q is not allowed", p.Signal)
	}
	if err := syscall.Kill(p.PID, sig); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil, plugin.Errorf("not_found", "process %d not found", p.PID)
		}
		if errors.Is(err, syscall.EPERM) {
			return nil, plugin.Errorf("permission_denied", "permission denied signaling pid %d", p.PID)
		}
		return nil, plugin.Errorf("signal_failed", "signal %s to %d: %v", name, p.PID, err)
	}
	return &SignalReply{OK: true, PID: p.PID, Signal: name}, nil
}

// computeNetRates updates the collector's previous interface counters and
// returns aggregate and per-interface rates.
func (c *Collector) computeNetRates(now time.Time, cur map[string]netCounter) NetMetric {
	c.mu.Lock()
	defer c.mu.Unlock()

	dt := now.Sub(c.prevNetTime).Seconds()
	hasPrev := !c.prevNetTime.IsZero() && dt > 0.01 && dt < 60

	var out NetMetric
	names := make([]string, 0, len(cur))
	for name := range cur {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		nc := cur[name]
		out.RxBytes += nc.rx
		out.TxBytes += nc.tx
		iface := NetInterface{Name: name, RxBytes: nc.rx, TxBytes: nc.tx}
		if hasPrev {
			if prev, ok := c.prevNet[name]; ok {
				if nc.rx >= prev.rx {
					iface.RxBytesPerSec = float64(nc.rx-prev.rx) / dt
				}
				if nc.tx >= prev.tx {
					iface.TxBytesPerSec = float64(nc.tx-prev.tx) / dt
				}
			}
		}
		out.RxBytesPerSec += iface.RxBytesPerSec
		out.TxBytesPerSec += iface.TxBytesPerSec
		if nc.rx > 0 || nc.tx > 0 || iface.RxBytesPerSec > 0 || iface.TxBytesPerSec > 0 {
			out.Interfaces = append(out.Interfaces, iface)
		}
	}

	c.prevNet = cur
	c.prevNetTime = now
	return out
}

// computeDiskIORates updates the collector's previous cumulative block byte
// counters and returns read/write rates.
func (c *Collector) computeDiskIORates(now time.Time, readBytes, writeBytes uint64) DiskIOMetric {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := DiskIOMetric{ReadBytes: readBytes, WriteBytes: writeBytes}
	dt := now.Sub(c.prevDiskTime).Seconds()
	if !c.prevDiskTime.IsZero() && dt > 0.01 && dt < 60 {
		if readBytes >= c.prevDiskRead {
			out.ReadBytesPerSec = float64(readBytes-c.prevDiskRead) / dt
		}
		if writeBytes >= c.prevDiskWrite {
			out.WriteBytesPerSec = float64(writeBytes-c.prevDiskWrite) / dt
		}
	}
	c.prevDiskRead = readBytes
	c.prevDiskWrite = writeBytes
	c.prevDiskTime = now
	return out
}

func runCmd(ctx context.Context, name string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, name, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return out.String(), nil
}

func hostnameOrEmpty() string {
	h, _ := os.Hostname()
	return h
}

func baseMetrics(now time.Time) Metrics {
	return Metrics{
		Hostname:    hostnameOrEmpty(),
		OS:          runtime.GOOS,
		Arch:        runtime.GOARCH,
		TimestampMs: now.UnixMilli(),
		CPU:         CPUMetric{Cores: runtime.NumCPU()},
		GPUs:        []GPUMetric{},
		Disks:       []DiskMetric{},
	}
}

func round1(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*10) / 10
}

func clampPct(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return round1(v)
}

func floatPtr(v float64) *float64 {
	r := round1(v)
	return &r
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// --- Shared pure parsers (also used by cross-platform unit tests) ---

// parseNvidiaSMICSV parses the output of:
// nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits
func parseNvidiaSMICSV(raw string) []GPUMetric {
	var out []GPUMetric
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 5 {
			continue
		}
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		idx, err := strconv.Atoi(parts[0])
		if err != nil {
			idx = len(out)
		}
		g := GPUMetric{
			Index:  idx,
			Name:   parts[1],
			Vendor: "nvidia",
		}
		if v, ok := parseOptionalFloat(parts[2]); ok {
			g.UtilPct = floatPtr(clampPct(v))
		}
		if usedMiB, ok := parseOptionalFloat(parts[3]); ok && usedMiB >= 0 {
			g.MemUsedBytes = uint64(usedMiB * 1024 * 1024)
		}
		if totalMiB, ok := parseOptionalFloat(parts[4]); ok && totalMiB > 0 {
			g.MemTotalBytes = uint64(totalMiB * 1024 * 1024)
			pct := clampPct(float64(g.MemUsedBytes) / float64(g.MemTotalBytes) * 100)
			g.MemPct = &pct
		}
		if len(parts) > 5 {
			if v, ok := parseOptionalFloat(parts[5]); ok {
				g.TempC = floatPtr(v)
			}
		}
		if len(parts) > 6 {
			if v, ok := parseOptionalFloat(parts[6]); ok {
				g.PowerW = floatPtr(v)
			}
		}
		if len(parts) > 7 {
			if v, ok := parseOptionalFloat(parts[7]); ok {
				g.PowerLimitW = floatPtr(v)
			}
		}
		out = append(out, g)
	}
	return out
}

// parseNvidiaComputeApps parses:
// nvidia-smi --query-compute-apps=pid,used_gpu_memory --format=csv,noheader,nounits
func parseNvidiaComputeApps(raw string) map[int]uint64 {
	res := map[int]uint64{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil || pid <= 0 {
			continue
		}
		if mib, ok := parseOptionalFloat(strings.TrimSpace(parts[1])); ok && mib > 0 {
			res[pid] += uint64(mib * 1024 * 1024)
		}
	}
	return res
}

func parseOptionalFloat(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "[") || strings.EqualFold(s, "N/A") {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// parseProcStat parses Linux /proc/stat total and per-core CPU ticks.
func parseProcStat(raw string) (cpuTicks, []cpuTicks, bool) {
	var total cpuTicks
	var cores []cpuTicks
	found := false
	for _, line := range strings.Split(raw, "\n") {
		if !strings.HasPrefix(line, "cpu") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		var vals []uint64
		for _, f := range fields[1:] {
			n, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				break
			}
			vals = append(vals, n)
		}
		if len(vals) < 4 {
			continue
		}
		var sum uint64
		for _, v := range vals {
			sum += v
		}
		idle := vals[3]
		if len(vals) > 4 {
			idle += vals[4] // iowait
		}
		tk := cpuTicks{total: sum, idle: idle}
		if fields[0] == "cpu" {
			total = tk
			found = true
		} else {
			cores = append(cores, tk)
		}
	}
	return total, cores, found
}

func cpuDeltaPct(prev, cur cpuTicks) float64 {
	if cur.total <= prev.total {
		return 0
	}
	dTotal := float64(cur.total - prev.total)
	var dIdle float64
	if cur.idle >= prev.idle {
		dIdle = float64(cur.idle - prev.idle)
	}
	return clampPct((1.0 - dIdle/dTotal) * 100.0)
}

// parseProcMeminfo parses Linux /proc/meminfo into MemoryMetric.
func parseProcMeminfo(raw string) MemoryMetric {
	kv := map[string]uint64{}
	for _, line := range strings.Split(raw, "\n") {
		k, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		// /proc/meminfo reports values in kB (KiB).
		kv[strings.TrimSpace(k)] = v * 1024
	}
	total := kv["MemTotal"]
	avail := kv["MemAvailable"]
	if avail == 0 {
		avail = kv["MemFree"] + kv["Buffers"] + kv["Cached"]
	}
	if avail > total {
		avail = total
	}
	used := total - avail
	var usedPct float64
	if total > 0 {
		usedPct = clampPct(float64(used) / float64(total) * 100)
	}
	swapTotal := kv["SwapTotal"]
	swapFree := kv["SwapFree"]
	var swapUsed uint64
	if swapTotal > swapFree {
		swapUsed = swapTotal - swapFree
	}
	return MemoryMetric{
		TotalBytes:     total,
		UsedBytes:      used,
		AvailableBytes: avail,
		UsedPct:        usedPct,
		SwapTotalBytes: swapTotal,
		SwapUsedBytes:  swapUsed,
	}
}

// parseProcNetDev parses Linux /proc/net/dev, skipping loopback.
func parseProcNetDev(raw string) map[string]netCounter {
	res := map[string]netCounter{}
	for _, line := range strings.Split(raw, "\n") {
		iface, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		iface = strings.TrimSpace(iface)
		if iface == "" || iface == "lo" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		res[iface] = netCounter{rx: rx, tx: tx}
	}
	return res
}

// parseProcDiskstats parses Linux /proc/diskstats for whole block devices,
// returning cumulative bytes read and written (sectors * 512).
func parseProcDiskstats(raw string) (uint64, uint64) {
	var readSectors, writeSectors uint64
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		name := fields[2]
		if !isWholeBlockDevice(name) {
			continue
		}
		rd, err1 := strconv.ParseUint(fields[5], 10, 64)
		wr, err2 := strconv.ParseUint(fields[9], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		readSectors += rd
		writeSectors += wr
	}
	return readSectors * 512, writeSectors * 512
}

// isWholeBlockDevice filters /proc/diskstats names to whole physical/virtual
// disks (sda, nvme0n1, vda, xvda, mmcblk0) so partitions are not double-counted.
func isWholeBlockDevice(name string) bool {
	if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "zram") || strings.HasPrefix(name, "sr") {
		return false
	}
	if strings.HasPrefix(name, "nvme") {
		// nvme0n1 is whole; nvme0n1p1 is a partition.
		idx := strings.IndexByte(name, 'n')
		if idx < 0 {
			return false
		}
		return !strings.Contains(name[idx+1:], "p")
	}
	if strings.HasPrefix(name, "mmcblk") {
		return !strings.Contains(name[6:], "p")
	}
	for _, prefix := range []string{"sd", "vd", "xvd", "hd"} {
		if strings.HasPrefix(name, prefix) {
			rest := name[len(prefix):]
			if rest == "" {
				return false
			}
			for i := 0; i < len(rest); i++ {
				if rest[i] < 'a' || rest[i] > 'z' {
					return false
				}
			}
			return true
		}
	}
	return false
}

// parseVMStat parses macOS vm_stat output plus total RAM bytes into MemoryMetric.
func parseVMStat(raw string, totalBytes uint64) MemoryMetric {
	var pageSize uint64 = 4096
	pages := map[string]uint64{}
	for _, line := range strings.Split(raw, "\n") {
		if strings.Contains(line, "page size of") {
			if idx := strings.Index(line, "page size of "); idx >= 0 {
				rest := line[idx+len("page size of "):]
				if sp := strings.IndexByte(rest, ' '); sp > 0 {
					if ps, err := strconv.ParseUint(rest[:sp], 10, 64); err == nil && ps > 0 {
						pageSize = ps
					}
				}
			}
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = strings.TrimRight(strings.TrimSpace(v), ".")
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			continue
		}
		pages[strings.TrimSpace(k)] = n
	}

	// Activity Monitor's Memory Used = App Memory (Anonymous - Purgeable) + Wired + Compressed.
	anon := pages["Anonymous pages"]
	purgeable := pages["Pages purgeable"]
	var app uint64
	if anon > purgeable {
		app = anon - purgeable
	}
	wired := pages["Pages wired down"]
	compressed := pages["Pages occupied by compressor"]
	used := (app + wired + compressed) * pageSize
	if used == 0 {
		// Fallback when anonymous pages line is absent on older macOS.
		used = (pages["Pages active"] + wired + compressed) * pageSize
	}
	if totalBytes > 0 && used > totalBytes {
		used = totalBytes
	}
	var avail uint64
	if totalBytes > used {
		avail = totalBytes - used
	}
	var pct float64
	if totalBytes > 0 {
		pct = clampPct(float64(used) / float64(totalBytes) * 100)
	}
	return MemoryMetric{
		TotalBytes:     totalBytes,
		UsedBytes:      used,
		AvailableBytes: avail,
		UsedPct:        pct,
	}
}

// parseSwapUsage parses macOS `sysctl -n vm.swapusage` e.g.:
// "total = 5120.00M  used = 3476.88M  free = 1643.12M  (encrypted)"
func parseSwapUsage(raw string) (totalBytes, usedBytes uint64) {
	fields := strings.Fields(raw)
	for i := 0; i+2 < len(fields); i++ {
		if fields[i+1] != "=" {
			continue
		}
		switch fields[i] {
		case "total":
			totalBytes = parseSizedNumber(fields[i+2])
		case "used":
			usedBytes = parseSizedNumber(fields[i+2])
		}
	}
	return totalBytes, usedBytes
}

func parseSizedNumber(s string) uint64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	mult := 1.0
	last := s[len(s)-1]
	switch last {
	case 'K', 'k':
		mult = 1024
		s = s[:len(s)-1]
	case 'M', 'm':
		mult = 1024 * 1024
		s = s[:len(s)-1]
	case 'G', 'g':
		mult = 1024 * 1024 * 1024
		s = s[:len(s)-1]
	case 'T', 't':
		mult = 1024 * 1024 * 1024 * 1024
		s = s[:len(s)-1]
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v < 0 {
		return 0
	}
	return uint64(v * mult)
}

// parseDarwinTopCPU parses `CPU usage: 4.61% user, 11.36% sys, 84.1% idle`.
func parseDarwinTopCPU(raw string) (float64, bool) {
	for _, line := range strings.Split(raw, "\n") {
		if !strings.Contains(line, "CPU usage:") {
			continue
		}
		parts := strings.Split(line, ",")
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if strings.HasSuffix(p, "idle") {
				num := strings.TrimSuffix(strings.Fields(p)[0], "%")
				if idle, err := strconv.ParseFloat(num, 64); err == nil {
					return clampPct(100.0 - idle), true
				}
			}
		}
	}
	return 0, false
}

// parseDarwinLoadAvg parses `{ 1.78 2.19 2.35 }`.
func parseDarwinLoadAvg(raw string) (l1, l5, l15 float64) {
	cleaned := strings.Trim(strings.TrimSpace(raw), "{}")
	fields := strings.Fields(cleaned)
	if len(fields) >= 3 {
		l1, _ = strconv.ParseFloat(fields[0], 64)
		l5, _ = strconv.ParseFloat(fields[1], 64)
		l15, _ = strconv.ParseFloat(fields[2], 64)
	}
	return round1(l1), round1(l5), round1(l15)
}

// parseDarwinBoottime parses `{ sec = 1795076341, usec = 156604 } ...`.
func parseDarwinBoottime(raw string, now time.Time) uint64 {
	idx := strings.Index(raw, "sec = ")
	if idx < 0 {
		return 0
	}
	rest := raw[idx+len("sec = "):]
	end := strings.IndexAny(rest, ", }")
	if end > 0 {
		rest = rest[:end]
	}
	sec, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
	if err != nil || sec <= 0 || now.Unix() < sec {
		return 0
	}
	return uint64(now.Unix() - sec)
}

// parseDarwinNetstat parses `netstat -ibn` Link# rows, skipping loopback.
func parseDarwinNetstat(raw string) map[string]netCounter {
	res := map[string]netCounter{}
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		if !strings.HasPrefix(fields[2], "<Link#") {
			continue
		}
		name := strings.TrimSuffix(fields[0], "*")
		if name == "" || name == "lo0" || strings.HasPrefix(name, "lo") {
			continue
		}
		// Columns with Address present (11 fields): Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
		// Columns without Address (10 fields): Name Mtu Network Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
		ibIdx, obIdx := 6, 9
		if len(fields) == 10 {
			ibIdx, obIdx = 5, 8
		}
		rx, err1 := strconv.ParseUint(fields[ibIdx], 10, 64)
		tx, err2 := strconv.ParseUint(fields[obIdx], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		if _, exists := res[name]; !exists {
			res[name] = netCounter{rx: rx, tx: tx}
		}
	}
	return res
}

// parseDarwinIOAccelerator parses `ioreg -r -d 1 -w 0 -c IOAccelerator` output
// into per-GPU metrics.
func parseDarwinIOAccelerator(raw string, hostMemTotal uint64) []GPUMetric {
	var out []GPUMetric
	// Each accelerator object starts with `+-o `
	blocks := strings.Split(raw, "+-o ")
	for _, block := range blocks[1:] {
		var name string
		var util *float64
		var memUsed uint64
		var memTotal uint64
		for _, line := range strings.Split(block, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, `"model" = "`) {
				v := strings.TrimPrefix(trimmed, `"model" = "`)
				if end := strings.IndexByte(v, '"'); end >= 0 {
					name = v[:end]
				}
			} else if strings.HasPrefix(trimmed, `"PerformanceStatistics" = {`) {
				if v, ok := extractIORegNum(trimmed, `"Device Utilization %"`); ok {
					util = floatPtr(clampPct(v))
				} else if v, ok := extractIORegNum(trimmed, `"Renderer Utilization %"`); ok {
					util = floatPtr(clampPct(v))
				}
				if v, ok := extractIORegNum(trimmed, `"In use system memory"`); ok && v > 0 {
					memUsed = uint64(v)
				} else if v, ok := extractIORegNum(trimmed, `"Alloc system memory"`); ok && v > 0 {
					memUsed = uint64(v)
				}
				if v, ok := extractIORegNum(trimmed, `"vramUsedBytes"`); ok && v > 0 {
					memUsed = uint64(v)
				}
				if v, ok := extractIORegNum(trimmed, `"vramFreeBytes"`); ok && v > 0 && memUsed > 0 {
					memTotal = memUsed + uint64(v)
				}
			}
		}
		if name == "" && util == nil && memUsed == 0 {
			continue
		}
		if name == "" {
			name = "GPU"
		}
		vendor := "apple"
		lower := strings.ToLower(name)
		switch {
		case strings.Contains(lower, "amd") || strings.Contains(lower, "radeon"):
			vendor = "amd"
		case strings.Contains(lower, "intel"):
			vendor = "intel"
		case strings.Contains(lower, "nvidia"):
			vendor = "nvidia"
		}
		// Apple Silicon shares unified memory with the host.
		if memTotal == 0 && vendor == "apple" && hostMemTotal > 0 {
			memTotal = hostMemTotal
		}
		var memPct *float64
		if memTotal > 0 && memUsed > 0 {
			p := clampPct(float64(memUsed) / float64(memTotal) * 100)
			memPct = &p
		}
		out = append(out, GPUMetric{
			Index:         len(out),
			Name:          name,
			Vendor:        vendor,
			UtilPct:       util,
			MemUsedBytes:  memUsed,
			MemTotalBytes: memTotal,
			MemPct:        memPct,
		})
	}
	return out
}

// parseDarwinBlockStorageIO parses `ioreg -r -c IOBlockStorageDriver -w 0`
// Statistics lines for cumulative bytes read and written.
func parseDarwinBlockStorageIO(raw string) (readBytes, writeBytes uint64) {
	for _, line := range strings.Split(raw, "\n") {
		if !strings.Contains(line, `"Statistics" = {`) {
			continue
		}
		if v, ok := extractIORegNum(line, `"Bytes (Read)"`); ok && v >= 0 {
			readBytes += uint64(v)
		}
		if v, ok := extractIORegNum(line, `"Bytes (Write)"`); ok && v >= 0 {
			writeBytes += uint64(v)
		}
	}
	return readBytes, writeBytes
}

func extractIORegNum(line, key string) (float64, bool) {
	prefix := key + "="
	idx := strings.Index(line, prefix)
	if idx < 0 {
		return 0, false
	}
	rest := line[idx+len(prefix):]
	end := strings.IndexAny(rest, ",}")
	if end >= 0 {
		rest = rest[:end]
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(rest), 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// parseDarwinDF parses `df -kP` output on macOS, consolidating APFS
// `/System/Volumes/Data` into `/` and skipping internal system volumes.
func parseDarwinDF(raw string) []DiskMetric {
	var root, dataVol *DiskMetric
	var others []DiskMetric
	seenDev := map[string]bool{}

	lines := strings.Split(raw, "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		dev := fields[0]
		if !strings.HasPrefix(dev, "/dev/") {
			continue
		}
		totalK, err1 := strconv.ParseUint(fields[1], 10, 64)
		usedK, err2 := strconv.ParseUint(fields[2], 10, 64)
		availK, err3 := strconv.ParseUint(fields[3], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil || totalK == 0 {
			continue
		}
		mount := strings.Join(fields[5:], " ")
		total := totalK * 1024
		avail := availK * 1024
		used := usedK * 1024
		if mount == "/System/Volumes/Data" {
			// On APFS, container used space is total - avail.
			if total > avail {
				used = total - avail
			}
			dm := DiskMetric{
				Mount:      "/",
				Device:     dev,
				TotalBytes: total,
				UsedBytes:  used,
				AvailBytes: avail,
				UsedPct:    clampPct(float64(used) / float64(total) * 100),
			}
			dataVol = &dm
			continue
		}
		if mount == "/" {
			dm := DiskMetric{
				Mount:      "/",
				Device:     dev,
				TotalBytes: total,
				UsedBytes:  used,
				AvailBytes: avail,
				UsedPct:    clampPct(float64(used) / float64(total) * 100),
			}
			root = &dm
			continue
		}
		if strings.HasPrefix(mount, "/System/Volumes/") || strings.HasPrefix(mount, "/private/var/vm") {
			continue
		}
		if seenDev[dev] {
			continue
		}
		seenDev[dev] = true
		others = append(others, DiskMetric{
			Mount:      mount,
			Device:     dev,
			TotalBytes: total,
			UsedBytes:  used,
			AvailBytes: avail,
			UsedPct:    clampPct(float64(used) / float64(total) * 100),
		})
	}

	var out []DiskMetric
	if dataVol != nil {
		out = append(out, *dataVol)
	} else if root != nil {
		out = append(out, *root)
	}
	out = append(out, others...)
	return out
}

// parsePSOutput parses `ps -axww -o pid=,ppid=,user=,%cpu=,%mem=,rss=,state=,etime=,comm=`
// and optional `ps -axww -o pid=,args=` into ProcessInfo entries.
func parsePSOutput(metaRaw, argsRaw string) []ProcessInfo {
	argsByPID := map[int]string{}
	for _, line := range strings.Split(argsRaw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		sp := strings.IndexAny(line, " \t")
		if sp <= 0 {
			continue
		}
		pid, err := strconv.Atoi(line[:sp])
		if err != nil {
			continue
		}
		argsByPID[pid] = truncateStr(strings.TrimSpace(line[sp+1:]), maxCmdLen)
	}

	var out []ProcessInfo
	for _, line := range strings.Split(metaRaw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := splitNFields(line, 9)
		if len(fields) < 9 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			continue
		}
		cpuPct, _ := strconv.ParseFloat(fields[3], 64)
		memPct, _ := strconv.ParseFloat(fields[4], 64)
		rssK, _ := strconv.ParseUint(fields[5], 10, 64)
		state := normalizeProcState(fields[6])
		comm := strings.TrimSpace(fields[8])
		name := path.Base(comm)
		if name == "." || name == "/" || name == "" {
			name = comm
		}
		cmdline := argsByPID[pid]
		if cmdline == "" {
			cmdline = comm
		}
		out = append(out, ProcessInfo{
			PID:      pid,
			PPID:     ppid,
			Name:     name,
			Command:  cmdline,
			User:     fields[2],
			CPUPct:   round1(cpuPct),
			MemPct:   round1(memPct),
			RSSBytes: rssK * 1024,
			State:    state,
			Elapsed:  fields[7],
		})
	}
	return out
}

// splitNFields splits s on runs of whitespace into at most n parts, leaving
// the remainder intact in the last part.
func splitNFields(s string, n int) []string {
	out := make([]string, 0, n)
	i := 0
	for len(out) < n-1 {
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		if i >= len(s) {
			return out
		}
		start := i
		for i < len(s) && s[i] != ' ' && s[i] != '\t' {
			i++
		}
		out = append(out, s[start:i])
	}
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	if i < len(s) {
		out = append(out, s[i:])
	}
	return out
}

func normalizeProcState(s string) string {
	if s == "" {
		return "?"
	}
	switch s[0] {
	case 'R':
		return "R"
	case 'S':
		return "S"
	case 'D', 'U':
		return "D"
	case 'T', 't':
		return "T"
	case 'Z':
		return "Z"
	case 'I':
		return "I"
	default:
		return s[:1]
	}
}
