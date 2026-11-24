// Package brand holds the product's names. Every identifier that contains the
// product name at runtime (binaries, directories, protocol prefixes, storage
// keys) derives from these constants; web/src/brand.ts and the bridge
// extension's src/brand.ts mirror them (brand_test.go keeps them in sync).
//
// scripts/rename.sh renames the project in one step. Persisted names
// (DataDirName, the cache directory, browser storage keys, the bridge
// extension id) are migrated rather than abandoned: rename.sh records the old
// values in the Legacy* lists below; the core copies its configuration, the
// web UI its storage, and the migrate plugin moves a machine's workspaces
// from the previous namespace when the user asks.
package brand

import "strings"

const (
	// Name is the display name.
	Name = "herdr-ide"
	// Slug is the lowercase identifier used for binaries, directories,
	// protocol prefixes and storage keys.
	Slug = "herdr-ide"
	// EnvPrefix prefixes environment variables.
	EnvPrefix = "HERDR_IDE_"

	// CoreBin is the name of the binary: the core and, on machines, the
	// agent it starts.
	CoreBin = Slug
	// BridgeExt is the VS Code bridge extension name; its publisher is Slug.
	BridgeExt = Slug + "-bridge"

	// DataDirName is the per-machine state directory below $HOME.
	DataDirName = "." + Slug
)

// Previous names, appended by scripts/rename.sh. Oldest last.
var (
	// LegacyDataDirNames are the data directories of previous names.
	LegacyDataDirNames = []string{".webherdr"}
	// LegacySlugs name old cache directories (removed by the core).
	LegacySlugs = []string{"webherdr"}
	// LegacyBridgeExtIDs are uninstalled from code-server.
	LegacyBridgeExtIDs = []string{"webherdr.webherdr-bridge"}
)

// BridgeExtID is the extension identifier (publisher.name) in code-server.
const BridgeExtID = Slug + "." + BridgeExt

// Env returns the name of a product environment variable.
func Env(name string) string { return EnvPrefix + name }

// DataDir returns the state directory name for an instance. Instances let
// several cores (e.g. a development build next to the daily one) share
// machines without sharing sockets, code-server or settings.
func DataDir(instance string) string {
	if instance == "" {
		return DataDirName
	}
	return DataDirName + "-" + instance
}

// ValidInstance reports whether s is usable as an instance name.
func ValidInstance(s string) bool {
	if s == "" || len(s) > 32 {
		return s == ""
	}
	return strings.Trim(s, "abcdefghijklmnopqrstuvwxyz0123456789-") == ""
}

// AgentDir holds uploaded agents (shared by instances; one directory per
// build) relative to $HOME.
const AgentDir = DataDirName + "/agent"

// LegacyDataDirs are the data directories a previous name gave the
// namespace whose data directory is named dataDir (DataDir of an
// instance), newest name first.
func LegacyDataDirs(dataDir string) []string {
	suffix, ok := strings.CutPrefix(dataDir, DataDirName)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(LegacySlugs))
	for _, s := range LegacySlugs {
		out = append(out, "."+s+suffix)
	}
	return out
}
