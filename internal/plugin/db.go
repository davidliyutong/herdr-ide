package plugin

import (
	"path/filepath"
	"strings"
	"time"

	"herdr-ide/internal/store"
)

// The core's database: core[-<instance>]-<host>[-<id>].db beside the
// settings file (settings[-<instance>].json), named per host (store.HostFile)
// so two cores sharing an NFS home directory never collide in SQLite WAL mode.
// A database the plugins' features share (store.OpenShared), each with tables
// of its own (store.DB.Migrate). The core keeps it open while it runs
// (internal/server), so a plugin's use takes the open pool. A core without a
// settings file keeps no state there either.

// CoreDBBase is the un-hosted database file name beside settingsFile
// (e.g. "core.db", "core-dev.db"); "" for "".
func CoreDBBase(settingsFile string) string {
	if settingsFile == "" {
		return ""
	}
	name := strings.Replace(filepath.Base(settingsFile), "settings", "core", 1)
	return strings.TrimSuffix(name, filepath.Ext(name)) + ".db"
}

// CoreDBFile is the core's per-host database beside the settings file
// settingsFile; "" for "".
func CoreDBFile(settingsFile string) string {
	base := CoreDBBase(settingsFile)
	if base == "" {
		return ""
	}
	return store.HostFile(filepath.Dir(settingsFile), base)
}

// OpenCoreDB opens the core's per-host database beside settingsFile,
// migrating any legacy un-hosted core[-<instance>].db into it first and
// cleaning up the legacy file once confirmed complete. nil, nil for "".
func OpenCoreDB(settingsFile string) (*store.DB, error) {
	if settingsFile == "" {
		return nil, nil
	}
	target := CoreDBFile(settingsFile)
	legacy := filepath.Join(filepath.Dir(settingsFile), CoreDBBase(settingsFile))
	if _, err := store.MigrateLegacy(legacy, target); err != nil {
		return nil, err
	}
	return store.OpenShared(target)
}

// OpenDB opens the core's database for a use of h's plugin, as
// store.OpenShared (read-only with store.ErrNewer); the caller closes it.
// nil, nil when the core keeps no settings file.
func OpenDB(h Host) (*store.DB, error) {
	st := h.Settings()
	if st == nil || st.Path() == "" {
		return nil, nil
	}
	return OpenCoreDB(st.Path())
}

// PruneCoreDBs removes unused core databases of other hosts (after
// store.HostFileRetention) and any remaining legacy un-hosted core database
// (after store.LegacyFileRetention) in the settings directory.
func PruneCoreDBs(h Host) {
	st := h.Settings()
	if st == nil || st.Path() == "" {
		return
	}
	removed, err := store.PruneHostFiles(filepath.Dir(st.Path()), CoreDBBase(st.Path()), store.HostFileRetention, time.Now())
	if err != nil {
		if l := h.Logger(); l != nil {
			l.Printf("pruning old core databases: %v", err)
		}
	} else if len(removed) > 0 {
		if l := h.Logger(); l != nil {
			l.Printf("removed unused core databases: %v", removed)
		}
	}
}
