//go:build unix

// Package monitor is the machine side of the System Monitor & Task Manager
// plugin (docs/features/34-system-monitor.md): live host resource metrics
// (CPU, memory, per-GPU stats, network I/O, disk I/O and mounts, hardware
// temperatures and fan speeds), process
// listing for the task manager, and allowlisted process signaling.
package monitor

// Metrics is one snapshot of a machine's resource usage.
type Metrics struct {
	Hostname    string       `json:"hostname"`
	OS          string       `json:"os"`
	Arch        string       `json:"arch"`
	UptimeSec   uint64       `json:"uptimeSec"`
	TimestampMs int64        `json:"timestampMs"`
	CPU         CPUMetric    `json:"cpu"`
	Memory      MemoryMetric `json:"memory"`
	GPUs        []GPUMetric  `json:"gpus"`
	Network     NetMetric    `json:"network"`
	DiskIO      DiskIOMetric `json:"diskIO"`
	Disks       []DiskMetric `json:"disks"`
	Sensors     *Sensors     `json:"sensors,omitempty"`
}

// CPUMetric is overall and per-core CPU utilization plus load averages.
type CPUMetric struct {
	UsagePct float64   `json:"usagePct"`
	Cores    int       `json:"cores"`
	Load1    float64   `json:"load1"`
	Load5    float64   `json:"load5"`
	Load15   float64   `json:"load15"`
	PerCore  []float64 `json:"perCore,omitempty"`
}

// MemoryMetric is RAM and swap usage in bytes.
type MemoryMetric struct {
	TotalBytes     uint64  `json:"totalBytes"`
	UsedBytes      uint64  `json:"usedBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedPct        float64 `json:"usedPct"`
	SwapTotalBytes uint64  `json:"swapTotalBytes"`
	SwapUsedBytes  uint64  `json:"swapUsedBytes"`
}

// GPUMetric is one GPU's utilization, VRAM, temperature and power.
type GPUMetric struct {
	Index         int      `json:"index"`
	Name          string   `json:"name"`
	Vendor        string   `json:"vendor,omitempty"`
	UtilPct       *float64 `json:"utilPct,omitempty"`
	MemUsedBytes  uint64   `json:"memUsedBytes,omitempty"`
	MemTotalBytes uint64   `json:"memTotalBytes,omitempty"`
	MemPct        *float64 `json:"memPct,omitempty"`
	TempC         *float64 `json:"tempC,omitempty"`
	PowerW        *float64 `json:"powerW,omitempty"`
	PowerLimitW   *float64 `json:"powerLimitW,omitempty"`
}

// NetMetric is aggregate network throughput and per-interface counters.
type NetMetric struct {
	RxBytesPerSec float64        `json:"rxBytesPerSec"`
	TxBytesPerSec float64        `json:"txBytesPerSec"`
	RxBytes       uint64         `json:"rxBytes"`
	TxBytes       uint64         `json:"txBytes"`
	Interfaces    []NetInterface `json:"interfaces,omitempty"`
}

// NetInterface is one non-loopback network interface's traffic.
type NetInterface struct {
	Name          string  `json:"name"`
	RxBytesPerSec float64 `json:"rxBytesPerSec"`
	TxBytesPerSec float64 `json:"txBytesPerSec"`
	RxBytes       uint64  `json:"rxBytes"`
	TxBytes       uint64  `json:"txBytes"`
}

// DiskIOMetric is aggregate block-device read and write throughput.
type DiskIOMetric struct {
	ReadBytesPerSec  float64 `json:"readBytesPerSec"`
	WriteBytesPerSec float64 `json:"writeBytesPerSec"`
	ReadBytes        uint64  `json:"readBytes"`
	WriteBytes       uint64  `json:"writeBytes"`
}

// DiskMetric is one mounted filesystem's capacity and usage.
type DiskMetric struct {
	Mount      string  `json:"mount"`
	Device     string  `json:"device"`
	FSType     string  `json:"fsType,omitempty"`
	TotalBytes uint64  `json:"totalBytes"`
	UsedBytes  uint64  `json:"usedBytes"`
	AvailBytes uint64  `json:"availBytes"`
	UsedPct    float64 `json:"usedPct"`
}

// Sensors are a machine's hardware temperatures and fan speeds, each list
// sorted by chip, then label, and bounded by maxSensors.
type Sensors struct {
	Temps []TempSensor `json:"temps,omitempty"`
	Fans  []FanSensor  `json:"fans,omitempty"`
}

// TempSensor is one temperature reading in degrees Celsius, with the
// thresholds the hardware reports for it, if any.
type TempSensor struct {
	Chip  string   `json:"chip"`
	Label string   `json:"label"`
	TempC float64  `json:"tempC"`
	HighC *float64 `json:"highC,omitempty"`
	CritC *float64 `json:"critC,omitempty"`
}

// FanSensor is one fan's speed in revolutions per minute; 0 is a stopped fan.
type FanSensor struct {
	Chip   string   `json:"chip"`
	Label  string   `json:"label"`
	RPM    float64  `json:"rpm"`
	MinRPM *float64 `json:"minRpm,omitempty"`
	MaxRPM *float64 `json:"maxRpm,omitempty"`
}

// ProcessInfo is one running process for the Task Manager.
type ProcessInfo struct {
	PID         int     `json:"pid"`
	PPID        int     `json:"ppid"`
	Name        string  `json:"name"`
	Command     string  `json:"command"`
	User        string  `json:"user"`
	CPUPct      float64 `json:"cpuPct"`
	MemPct      float64 `json:"memPct"`
	RSSBytes    uint64  `json:"rssBytes"`
	State       string  `json:"state"`
	Elapsed     string  `json:"elapsed"`
	GPUMemBytes uint64  `json:"gpuMemBytes,omitempty"`
}

// ProcessesReply is the response of the processes action.
type ProcessesReply struct {
	Processes     []ProcessInfo `json:"processes"`
	Total         int           `json:"total"`
	Cores         int           `json:"cores"`
	MemTotalBytes uint64        `json:"memTotalBytes"`
	TimestampMs   int64         `json:"timestampMs"`
}

// SignalParams are the parameters of the signal action.
type SignalParams struct {
	PID    int    `json:"pid"`
	Signal string `json:"signal"`
}

// SignalReply is the response of the signal action.
type SignalReply struct {
	OK     bool   `json:"ok"`
	PID    int    `json:"pid"`
	Signal string `json:"signal"`
}
