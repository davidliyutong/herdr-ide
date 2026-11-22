package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MigrateLegacy copies a legacy un-hosted database at legacyPath into the
// per-host database at targetPath when targetPath does not exist yet, verifies
// the migrated database, and removes legacyPath (with its journal files) once
// migration is confirmed complete and no process holds legacyPath.
//
// It returns true when this call created targetPath from legacyPath.
func MigrateLegacy(legacyPath, targetPath string) (bool, error) {
	if !filepath.IsAbs(legacyPath) || !filepath.IsAbs(targetPath) {
		return false, fmt.Errorf("store: migration paths must be absolute")
	}
	legacyPath = resolveDir(filepath.Clean(legacyPath))
	targetPath = resolveDir(filepath.Clean(targetPath))
	if legacyPath == targetPath {
		return false, nil
	}
	if _, err := os.Lstat(targetPath); err == nil {
		return false, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	st, err := os.Lstat(legacyPath)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !st.Mode().IsRegular() || !owned(st) {
		return false, fmt.Errorf("%w: %s", ErrUnsafe, legacyPath)
	}
	for _, s := range journals {
		if err := notLink(legacyPath + s); err != nil {
			return false, err
		}
	}
	dir := filepath.Dir(targetPath)
	if err := privateDir(dir); err != nil {
		return false, err
	}
	walEmpty := true
	if wst, err := os.Lstat(legacyPath + "-wal"); err == nil && wst.Size() > 0 {
		walEmpty = false
	}
	if st.Size() == 0 && walEmpty {
		// An empty placeholder file with no data: remove if unheld and skip.
		removeUnheld(legacyPath, func() bool {
			cur, err := os.Lstat(legacyPath)
			return err == nil && cur.Size() == 0
		})
		return false, nil
	}

	src, err := open(legacyPath, DefaultBusyTimeout, false)
	if err != nil {
		return false, err
	}
	var rnd [8]byte
	rand.Read(rnd[:])
	tmp := filepath.Join(dir, ".migrate-"+hex.EncodeToString(rnd[:])+".db")
	defer os.Remove(tmp)
	// VACUUM INTO creates a standalone consistent copy of the database
	// including WAL contents, user_version, and all tables/rows.
	escaped := strings.ReplaceAll(tmp, "'", "''")
	if _, err := src.Exec("VACUUM INTO '" + escaped + "'"); err != nil {
		src.Close()
		return false, fmt.Errorf("store: migrate %s: %w", filepath.Base(legacyPath), err)
	}
	src.Close()
	snapshotMod := maxModTime(legacyPath)

	if modeBits {
		if err := os.Chmod(tmp, 0o600); err != nil {
			return false, err
		}
	}
	if err := verifyMigrated(tmp); err != nil {
		return false, fmt.Errorf("store: verify migrated %s: %w", filepath.Base(targetPath), err)
	}

	if err := os.Link(tmp, targetPath); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return false, nil
		}
		if _, statErr := os.Lstat(targetPath); statErr == nil {
			return false, nil
		}
		if rerr := os.Rename(tmp, targetPath); rerr != nil {
			if _, statErr := os.Lstat(targetPath); statErr == nil {
				return false, nil
			}
			return false, rerr
		}
	}

	// Migration to targetPath is confirmed complete: remove legacyPath now
	// if no process holds a lock on it and it was not written since snapshotMod.
	removeUnheld(legacyPath, func() bool {
		if !Exists(targetPath) {
			return false
		}
		return !maxModTime(legacyPath).After(snapshotMod)
	})
	return true, nil
}

func maxModTime(p string) time.Time {
	var latest time.Time
	for _, s := range append([]string{""}, journals...) {
		if st, err := os.Lstat(p + s); err == nil {
			if st.ModTime().After(latest) {
				latest = st.ModTime()
			}
		}
	}
	return latest
}

func verifyMigrated(p string) error {
	db, err := open(p, DefaultBusyTimeout, true)
	if err != nil {
		return err
	}
	defer db.Close()
	var res string
	if err := db.QueryRow("PRAGMA quick_check").Scan(&res); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if res != "ok" {
		return fmt.Errorf("quick_check: %q", res)
	}
	return nil
}
