package plugin

import (
	"path/filepath"
	"strings"

	"herdr-ide/internal/store"
)

// The core's database: core.db beside the settings file (core-<instance>.db
// beside settings-<instance>.json), a database the plugins' features share
// (store.OpenShared), each with tables of its own (store.DB.Migrate). The
// core keeps it open while it runs (internal/server), so a plugin's use
// takes the open pool. A core without a settings file keeps no state
// there either.

// CoreDBFile is the core's database beside the settings file
// settingsFile; "" for "".
func CoreDBFile(settingsFile string) string {
	if settingsFile == "" {
		return ""
	}
	name := strings.Replace(filepath.Base(settingsFile), "settings", "core", 1)
	return filepath.Join(filepath.Dir(settingsFile), strings.TrimSuffix(name, filepath.Ext(name))+".db")
}

// OpenDB opens the core's database for a use of h's plugin, as
// store.OpenShared (read-only with store.ErrNewer); the caller closes it.
// nil, nil when the core keeps no settings file.
func OpenDB(h Host) (*store.DB, error) {
	st := h.Settings()
	if st == nil || st.Path() == "" {
		return nil, nil
	}
	return store.OpenShared(CoreDBFile(st.Path()))
}
