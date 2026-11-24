// Package brand holds the product's names. Every identifier that contains the
// product name at runtime (binaries, directories, protocol prefixes, storage
// keys) derives from these constants; web/src/brand.ts and the bridge
// extension's src/brand.ts mirror them (brand_test.go keeps them in sync).
//
// scripts/rename.sh renames the project in one step; the renamed version
// starts with namespaces of its own (docs/features/11-naming-and-renames.md).
package brand

import "strings"

const (
	// Name is the display name.
	Name = "veldr"
	// Slug is the lowercase identifier used for binaries, directories,
	// protocol prefixes and storage keys.
	Slug = "veldr"
	// Domain is the product's domain; reversed, it begins the desktop
	// app's id (desktop/src/platform.ts APP_ID).
	Domain = "veldr.app"
	// EnvPrefix prefixes environment variables.
	EnvPrefix = "VELDR_"

	// CoreBin is the name of the binary: the core and, on machines, the
	// agent it starts.
	CoreBin = Slug
	// BridgeExt is the VS Code bridge extension name; its publisher is Slug.
	BridgeExt = Slug + "-bridge"

	// DataDirName is the per-machine state directory below $HOME.
	DataDirName = "." + Slug
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
