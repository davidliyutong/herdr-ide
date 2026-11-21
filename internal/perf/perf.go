// Package perf says what the core's own process uses: processor time and
// memory, for the settings' Performance page. It measures this process
// only, not the agents, terminal cores and ssh connections it starts.
package perf

import (
	"runtime"
	"time"
)

// Usage is the core process's use of the system at one moment.
type Usage struct {
	// CPUMs is the processor time the process has used since it started
	// (user and system), in milliseconds; a client turns two samples into
	// a share of the time between them.
	CPUMs int64 `json:"cpu_ms"`
	// Memory is what the Go runtime holds from the system, in bytes.
	Memory uint64 `json:"memory"`
	// Goroutines is how many goroutines run.
	Goroutines int `json:"goroutines"`
	// UptimeMs is how long the process has run, in milliseconds.
	UptimeMs int64 `json:"uptime_ms"`
	// CPUs is how many processors the process may use at once.
	CPUs int `json:"cpus"`
}

var started = time.Now()

// Sample measures the process now.
func Sample() Usage {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return Usage{
		CPUMs:      cpuTime().Milliseconds(),
		Memory:     m.Sys - m.HeapReleased,
		Goroutines: runtime.NumGoroutine(),
		UptimeMs:   time.Since(started).Milliseconds(),
		CPUs:       runtime.GOMAXPROCS(0),
	}
}
