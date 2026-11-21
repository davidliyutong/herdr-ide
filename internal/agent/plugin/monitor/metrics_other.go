//go:build unix && !linux && !darwin

package monitor

import (
	"context"
	"runtime"
	"time"
)

// CollectMetrics returns basic host identity on unsupported Unix systems.
func (c *Collector) CollectMetrics(_ context.Context) (*Metrics, error) {
	m := baseMetrics(time.Now())
	return &m, nil
}

// CollectProcesses falls back to POSIX ps on other Unix systems.
func (c *Collector) CollectProcesses(ctx context.Context) (*ProcessesReply, error) {
	now := time.Now()
	metaRaw, err := runCmd(ctx, "ps", "-axww", "-o", "pid=,ppid=,user=,%cpu=,%mem=,rss=,state=,etime=,comm=")
	if err != nil {
		return nil, err
	}
	argsRaw, _ := runCmd(ctx, "ps", "-axww", "-o", "pid=,args=")
	procs := parsePSOutput(metaRaw, argsRaw)
	return &ProcessesReply{
		Processes:   procs,
		Total:       len(procs),
		Cores:       runtime.NumCPU(),
		TimestampMs: now.UnixMilli(),
	}, nil
}
