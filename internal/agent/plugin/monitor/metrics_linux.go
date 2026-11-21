//go:build linux

package monitor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const linuxClkTck = 100.0

// CollectMetrics gathers a Linux host's CPU, memory, per-GPU, network, disk I/O
// and filesystem usage.
func (c *Collector) CollectMetrics(ctx context.Context) (*Metrics, error) {
	now := time.Now()
	m := baseMetrics(now)

	// Run GPU probing concurrently with /proc reads so nvidia-smi does not stall
	// local file reads.
	var (
		gpus []GPUMetric
		wg   sync.WaitGroup
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		gpus = collectLinuxGPUs(ctx)
	}()

	// CPU: on the very first call (no previous sample), take two samples 100ms
	// apart so the first dashboard hover immediately displays live usage.
	if b, err := os.ReadFile("/proc/stat"); err == nil {
		total, cores, ok := parseProcStat(string(b))
		if ok {
			c.mu.Lock()
			first := !c.hasPrevCPU
			prevTotal := c.prevCPU
			prevCores := c.prevPerCore
			c.prevCPU = total
			c.prevPerCore = cores
			c.hasPrevCPU = true
			c.mu.Unlock()

			if first {
				select {
				case <-ctx.Done():
				case <-time.After(100 * time.Millisecond):
					if b2, err := os.ReadFile("/proc/stat"); err == nil {
						if t2, c2, ok2 := parseProcStat(string(b2)); ok2 {
							prevTotal, prevCores = total, cores
							total, cores = t2, c2
							c.mu.Lock()
							c.prevCPU = t2
							c.prevPerCore = c2
							c.mu.Unlock()
						}
					}
				}
			}
			m.CPU.UsagePct = cpuDeltaPct(prevTotal, total)
			if len(cores) > 0 && len(cores) == len(prevCores) {
				m.CPU.PerCore = make([]float64, len(cores))
				for i := range cores {
					m.CPU.PerCore[i] = cpuDeltaPct(prevCores[i], cores[i])
				}
			}
		}
	}

	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(b))
		if len(fields) >= 3 {
			l1, _ := strconv.ParseFloat(fields[0], 64)
			l5, _ := strconv.ParseFloat(fields[1], 64)
			l15, _ := strconv.ParseFloat(fields[2], 64)
			m.CPU.Load1, m.CPU.Load5, m.CPU.Load15 = round1(l1), round1(l5), round1(l15)
		}
	}

	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(b))
		if len(fields) > 0 {
			if up, err := strconv.ParseFloat(fields[0], 64); err == nil && up > 0 {
				m.UptimeSec = uint64(up)
			}
		}
	}

	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		m.Memory = parseProcMeminfo(string(b))
	}

	if b, err := os.ReadFile("/proc/net/dev"); err == nil {
		m.Network = c.computeNetRates(now, parseProcNetDev(string(b)))
	}

	if b, err := os.ReadFile("/proc/diskstats"); err == nil {
		rd, wr := parseProcDiskstats(string(b))
		m.DiskIO = c.computeDiskIORates(now, rd, wr)
	}

	m.Disks = collectLinuxDisks()

	wg.Wait()
	if gpus != nil {
		m.GPUs = gpus
	}
	return &m, nil
}

func collectLinuxGPUs(ctx context.Context) []GPUMetric {
	var out []GPUMetric
	if _, err := exec.LookPath("nvidia-smi"); err == nil {
		raw, err := runCmd(ctx, "nvidia-smi",
			"--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
			"--format=csv,noheader,nounits")
		if err == nil {
			out = append(out, parseNvidiaSMICSV(raw)...)
		}
	}
	// Also scan DRM sysfs for AMD GPUs (amdgpu exposes gpu_busy_percent and VRAM).
	amd := collectDRMSysfsGPUs("/sys/class/drm", len(out))
	out = append(out, amd...)
	return out
}

func collectDRMSysfsGPUs(drmRoot string, startIdx int) []GPUMetric {
	ents, err := os.ReadDir(drmRoot)
	if err != nil {
		return nil
	}
	var cards []string
	for _, e := range ents {
		name := e.Name()
		if strings.HasPrefix(name, "card") && !strings.Contains(name, "-") {
			if _, err := strconv.Atoi(name[4:]); err == nil {
				cards = append(cards, name)
			}
		}
	}
	sort.Strings(cards)
	var out []GPUMetric
	for _, card := range cards {
		dev := filepath.Join(drmRoot, card, "device")
		vendorBytes, err := os.ReadFile(filepath.Join(dev, "vendor"))
		if err != nil {
			continue
		}
		vendorID := strings.ToLower(strings.TrimSpace(string(vendorBytes)))
		// Skip NVIDIA (already queried via nvidia-smi).
		if vendorID == "0x10de" {
			continue
		}
		vendor := ""
		switch vendorID {
		case "0x1002":
			vendor = "amd"
		case "0x8086":
			vendor = "intel"
		default:
			continue
		}
		g := GPUMetric{
			Index:  startIdx + len(out),
			Name:   strings.ToUpper(vendor) + " GPU (" + card + ")",
			Vendor: vendor,
		}
		if b, err := os.ReadFile(filepath.Join(dev, "product_name")); err == nil {
			if s := strings.TrimSpace(string(b)); s != "" {
				g.Name = s
			}
		}
		hasMetric := false
		if b, err := os.ReadFile(filepath.Join(dev, "gpu_busy_percent")); err == nil {
			if v, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64); err == nil {
				g.UtilPct = floatPtr(clampPct(v))
				hasMetric = true
			}
		}
		if b, err := os.ReadFile(filepath.Join(dev, "mem_info_vram_used")); err == nil {
			if v, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64); err == nil {
				g.MemUsedBytes = v
				hasMetric = true
			}
		}
		if b, err := os.ReadFile(filepath.Join(dev, "mem_info_vram_total")); err == nil {
			if v, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64); err == nil && v > 0 {
				g.MemTotalBytes = v
				p := clampPct(float64(g.MemUsedBytes) / float64(v) * 100)
				g.MemPct = &p
				hasMetric = true
			}
		}
		if hwmonEnts, err := os.ReadDir(filepath.Join(dev, "hwmon")); err == nil {
			for _, h := range hwmonEnts {
				if b, err := os.ReadFile(filepath.Join(dev, "hwmon", h.Name(), "temp1_input")); err == nil {
					if mc, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64); err == nil && mc > 0 {
						g.TempC = floatPtr(mc / 1000.0)
						hasMetric = true
						break
					}
				}
			}
		}
		if hasMetric {
			out = append(out, g)
		}
	}
	return out
}

var skipFSTypes = map[string]bool{
	"proc": true, "sysfs": true, "tmpfs": true, "devtmpfs": true, "devpts": true,
	"cgroup": true, "cgroup2": true, "pstore": true, "securityfs": true, "debugfs": true,
	"tracefs": true, "hugetlbfs": true, "mqueue": true, "fusectl": true, "configfs": true,
	"binfmt_misc": true, "autofs": true, "squashfs": true, "overlay": true, "nsfs": true,
	"ramfs": true, "efivarfs": true, "bpf": true, "rpc_pipefs": true, "fuse.portal": true,
}

func collectLinuxDisks() []DiskMetric {
	b, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil
	}
	seenDev := map[string]bool{}
	var out []DiskMetric
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		dev, mount, fsType := fields[0], unescapeMountPath(fields[1]), fields[2]
		if skipFSTypes[fsType] {
			continue
		}
		if !strings.HasPrefix(dev, "/") && !strings.Contains(dev, ":") {
			continue
		}
		if strings.HasPrefix(mount, "/snap/") || strings.HasPrefix(mount, "/boot/efi") {
			continue
		}
		if seenDev[dev] {
			continue
		}
		var st syscall.Statfs_t
		if err := syscall.Statfs(mount, &st); err != nil || st.Blocks == 0 {
			continue
		}
		seenDev[dev] = true
		bsize := uint64(st.Bsize)
		total := st.Blocks * bsize
		avail := st.Bavail * bsize
		free := st.Bfree * bsize
		var used uint64
		if total > free {
			used = total - free
		}
		out = append(out, DiskMetric{
			Mount:      mount,
			Device:     dev,
			FSType:     fsType,
			TotalBytes: total,
			UsedBytes:  used,
			AvailBytes: avail,
			UsedPct:    clampPct(float64(used) / float64(total) * 100),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Mount == "/" {
			return true
		}
		if out[j].Mount == "/" {
			return false
		}
		return out[i].Mount < out[j].Mount
	})
	return out
}

func unescapeMountPath(s string) string {
	s = strings.ReplaceAll(s, `\040`, " ")
	s = strings.ReplaceAll(s, `\011`, "\t")
	return s
}

// CollectProcesses lists processes on Linux from /proc, enriching per-process
// GPU VRAM when nvidia-smi is available.
func (c *Collector) CollectProcesses(ctx context.Context) (*ProcessesReply, error) {
	now := time.Now()

	var (
		gpuProcs map[int]uint64
		wg       sync.WaitGroup
	)
	if _, err := exec.LookPath("nvidia-smi"); err == nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if raw, err := runCmd(ctx, "nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"); err == nil {
				gpuProcs = parseNvidiaComputeApps(raw)
			}
		}()
	}

	var memTotal uint64
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		memTotal = parseProcMeminfo(string(b)).TotalBytes
	}
	var sysUptime float64
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if fields := strings.Fields(string(b)); len(fields) > 0 {
			sysUptime, _ = strconv.ParseFloat(fields[0], 64)
		}
	}
	pageSize := uint64(os.Getpagesize())

	ents, err := os.ReadDir("/proc")
	if err != nil {
		wg.Wait()
		return nil, err
	}

	c.mu.Lock()
	prevTicks := c.prevProcTicks
	prevTime := c.prevProcTime
	c.mu.Unlock()

	dt := now.Sub(prevTime).Seconds()
	hasPrev := !prevTime.IsZero() && dt > 0.05 && dt < 60

	curTicks := make(map[int]uint64, len(ents))
	uidCache := map[uint32]string{}
	lookupUser := func(uid uint32) string {
		if name, ok := uidCache[uid]; ok {
			return name
		}
		u, err := user.LookupId(strconv.FormatUint(uint64(uid), 10))
		name := strconv.FormatUint(uint64(uid), 10)
		if err == nil && u.Username != "" {
			name = u.Username
		}
		uidCache[uid] = name
		return name
	}

	procs := make([]ProcessInfo, 0, len(ents))
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		pdir := filepath.Join("/proc", e.Name())
		statBytes, err := os.ReadFile(filepath.Join(pdir, "stat"))
		if err != nil {
			continue
		}
		ps, ok := parseLinuxProcStat(string(statBytes))
		if !ok {
			continue
		}
		ticks := ps.utime + ps.stime
		curTicks[pid] = ticks

		var cpuPct float64
		if hasPrev {
			if pt, ok := prevTicks[pid]; ok && ticks >= pt {
				cpuPct = round1((float64(ticks-pt) / linuxClkTck) / dt * 100.0)
			}
		} else if sysUptime > 0 {
			procAge := sysUptime - float64(ps.startTime)/linuxClkTck
			if procAge > 0.5 {
				cpuPct = round1((float64(ticks) / linuxClkTck) / procAge * 100.0)
			}
		}

		rssBytes := uint64(ps.rssPages) * pageSize
		var memPct float64
		if memTotal > 0 {
			memPct = round1(float64(rssBytes) / float64(memTotal) * 100.0)
		}

		cmdline := ps.comm
		if cb, err := os.ReadFile(filepath.Join(pdir, "cmdline")); err == nil && len(cb) > 0 {
			cmdline = formatProcCmdline(cb)
		}

		username := ""
		if fi, err := os.Stat(pdir); err == nil {
			if st, ok := fi.Sys().(*syscall.Stat_t); ok {
				username = lookupUser(st.Uid)
			}
		}

		elapsed := ""
		if sysUptime > 0 {
			age := int64(sysUptime - float64(ps.startTime)/linuxClkTck)
			if age < 0 {
				age = 0
			}
			elapsed = formatElapsed(age)
		}

		procs = append(procs, ProcessInfo{
			PID:      pid,
			PPID:     ps.ppid,
			Name:     ps.comm,
			Command:  truncateStr(cmdline, maxCmdLen),
			User:     username,
			CPUPct:   cpuPct,
			MemPct:   memPct,
			RSSBytes: rssBytes,
			State:    normalizeProcState(ps.state),
			Elapsed:  elapsed,
		})
	}

	c.mu.Lock()
	c.prevProcTicks = curTicks
	c.prevProcTime = now
	c.mu.Unlock()

	wg.Wait()
	if len(gpuProcs) > 0 {
		for i := range procs {
			if mem, ok := gpuProcs[procs[i].PID]; ok {
				procs[i].GPUMemBytes = mem
			}
		}
	}

	return &ProcessesReply{
		Processes:     procs,
		Total:         len(procs),
		Cores:         runtime.NumCPU(),
		MemTotalBytes: memTotal,
		TimestampMs:   now.UnixMilli(),
	}, nil
}

type linuxProcStat struct {
	comm      string
	state     string
	ppid      int
	utime     uint64
	stime     uint64
	startTime uint64
	rssPages  int64
}

func parseLinuxProcStat(raw string) (linuxProcStat, bool) {
	openIdx := strings.IndexByte(raw, '(')
	closeIdx := strings.LastIndexByte(raw, ')')
	if openIdx < 0 || closeIdx <= openIdx || closeIdx+2 >= len(raw) {
		return linuxProcStat{}, false
	}
	comm := raw[openIdx+1 : closeIdx]
	fields := strings.Fields(raw[closeIdx+2:])
	// fields[0]=state, [1]=ppid, [11]=utime, [12]=stime, [19]=starttime, [21]=rss
	if len(fields) < 22 {
		return linuxProcStat{}, false
	}
	ppid, _ := strconv.Atoi(fields[1])
	utime, _ := strconv.ParseUint(fields[11], 10, 64)
	stime, _ := strconv.ParseUint(fields[12], 10, 64)
	startTime, _ := strconv.ParseUint(fields[19], 10, 64)
	rss, _ := strconv.ParseInt(fields[21], 10, 64)
	if rss < 0 {
		rss = 0
	}
	return linuxProcStat{
		comm:      comm,
		state:     fields[0],
		ppid:      ppid,
		utime:     utime,
		stime:     stime,
		startTime: startTime,
		rssPages:  rss,
	}, true
}

func formatProcCmdline(b []byte) string {
	parts := make([]string, 0, 8)
	for _, seg := range strings.Split(string(b), "\x00") {
		if seg != "" {
			parts = append(parts, seg)
		}
	}
	return strings.Join(parts, " ")
}

func formatElapsed(sec int64) string {
	days := sec / 86400
	rem := sec % 86400
	h := rem / 3600
	m := (rem % 3600) / 60
	s := rem % 60
	if days > 0 {
		return fmt.Sprintf("%d-%02d:%02d:%02d", days, h, m, s)
	}
	if h > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%02d:%02d", m, s)
}
