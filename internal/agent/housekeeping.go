package agent

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"herdr-ide/internal/brand"
)

// Retention for files the agent creates on machines.
const (
	uploadRetention = 7 * 24 * time.Hour
	logRetention    = 7 * 24 * time.Hour
	// Builds of other cores are kept this long after their last use.
	versionRetention = 14 * 24 * time.Hour
)

// migrateLegacyDataDir moves state left by a previous product name (see
// brand.LegacyDataDirNames) to base, once.
func migrateLegacyDataDir(home, base string, logger *log.Logger) {
	if _, err := os.Lstat(base); err == nil {
		return
	}
	for _, name := range brand.LegacyDataDirNames {
		old := filepath.Join(home, name)
		if st, err := os.Lstat(old); err == nil && st.IsDir() {
			// A code-server still running from the old directory would keep
			// answering on the moved socket while its files are gone.
			killListener(filepath.Join(old, "run", "cs.sock"))
			if err := os.Rename(old, base); err != nil {
				logger.Printf("migrate %s -> %s: %v", old, base, err)
			} else {
				logger.Printf("migrated %s -> %s", old, base)
			}
			return
		}
	}
}

// housekeeping bounds disk use: old uploads and code-server logs go away, and
// this agent's build directory is touched so other cores' cleanup keeps it.
func housekeeping(base string, logger *log.Logger) {
	now := time.Now()
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if filepath.Base(filepath.Dir(dir)) == "agent" {
			_ = os.Chtimes(dir, now, now)
		}
	}
	pruneOlder(filepath.Join(base, "uploads"), now.Add(-uploadRetention), logger)
	pruneOlder(filepath.Join(base, "cs-data", "logs"), now.Add(-logRetention), logger)
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
