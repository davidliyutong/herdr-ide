//go:build unix

package agent

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"time"

	"veldr/internal/brand"
	"veldr/internal/hostdirs"
)

// Retention for files the agent creates on machines.
const (
	uploadRetention = 7 * 24 * time.Hour
	logRetention    = 7 * 24 * time.Hour
	// Builds of other cores are kept this long after their last use.
	versionRetention = 14 * 24 * time.Hour
)

// housekeepers are plugins' own retention rules, run with housekeeping on
// the data directory.
var housekeepers []func(base string, now time.Time)

// housekeepInterval is how often a running agent applies its retention
// rules: a node runs for weeks.
const housekeepInterval = 24 * time.Hour

// housekeep runs housekeeping now and every housekeepInterval until ctx
// ends.
func (a *Agent) housekeep(ctx context.Context) {
	t := time.NewTicker(housekeepInterval)
	defer t.Stop()
	for {
		housekeeping(a.base, a.hostDir, a.logger)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// housekeeping bounds disk use: old uploads and code-server logs go away,
// other hosts' directories unused for long go (pruneHosts), and this
// agent's build directory and this host's directories are touched, so
// that other cores' and hosts' cleanups keep them.
func housekeeping(base, hostDir string, logger *log.Logger) {
	now := time.Now()
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if filepath.Base(filepath.Dir(dir)) == "agent" {
			_ = os.Chtimes(dir, now, now)
		}
	}
	_ = os.Chtimes(hostDir, now, now)
	if xvfb := filepath.Join(filepath.Dir(base), brand.DataDirName, hostdirs.HostsDir, filepath.Base(hostDir)); xvfb != hostDir {
		_ = os.Chtimes(xvfb, now, now) // the Xvfb packages' host directory
	}
	pruneOlder(filepath.Join(base, "uploads"), now.Add(-uploadRetention), logger)
	pruneOlder(filepath.Join(hostDir, "cs-data", "logs"), now.Add(-logRetention), logger)
	pruneHosts(filepath.Join(base, hostdirs.HostsDir), filepath.Base(hostDir), now, logger)
	for _, h := range housekeepers {
		h(base, now)
	}
}

// Other hosts' directories (a home several hosts share): their files go
// after hostRetention unused, except the terminal core's executable,
// which a core that ran all along without an agent may still run from
// (removing it on NFS would end that core); the whole directory goes
// after hostExeRetention.
const (
	hostRetention    = 30 * 24 * time.Hour
	hostExeRetention = 180 * 24 * time.Hour
)

// pruneHosts applies the retention of other hosts' directories in dir;
// mine is this host's.
func pruneHosts(dir, mine string, now time.Time, logger *log.Logger) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if e.Name() == mine || !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < hostRetention {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if now.Sub(info.ModTime()) >= hostExeRetention {
			if err := os.RemoveAll(p); err != nil {
				logger.Printf("prune host %s: %v", e.Name(), err)
			}
			continue
		}
		files, _ := os.ReadDir(p)
		for _, f := range files {
			if f.Name() == "hc" {
				continue
			}
			if err := os.RemoveAll(filepath.Join(p, f.Name())); err != nil {
				logger.Printf("prune host %s: %v", e.Name(), err)
			}
		}
		// Removing changed the directory's time: keep its age.
		_ = os.Chtimes(p, info.ModTime(), info.ModTime())
	}
}

// pruneOlder removes direct children of dir not modified since cutoff.
func pruneOlder(dir string, cutoff time.Time, logger *log.Logger) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			logger.Printf("prune %s: %v", e.Name(), err)
		}
	}
}
