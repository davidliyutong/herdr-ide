// Package embedded carries build artifacts compiled into the herdr-ide binary:
// the per-platform agents (gzip) and the VS Code bridge extension.
package embedded

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"herdr-ide/internal/brand"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

//go:embed all:agents
var agentsFS embed.FS

// AgentDir, when set, is searched before the embedded agents. It holds
// uncompressed herdr-ide-agent-<os>-<arch> files (development builds).
var AgentDir string

type agentEntry struct {
	bin     []byte
	version string
}

var (
	cacheMu sync.Mutex
	cache   = map[string]agentEntry{}
)

// Agent returns the agent binary for goos/goarch and a content-derived
// version tag, so a rebuilt agent is always re-uploaded.
func Agent(goos, goarch string) ([]byte, string, error) {
	key := goos + "-" + goarch
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if e, ok := cache[key]; ok {
		return e.bin, e.version, nil
	}
	name := brand.AgentBin + "-" + key
	var bin []byte
	if AgentDir != "" {
		if b, err := os.ReadFile(filepath.Join(AgentDir, name)); err == nil {
			bin = b
		}
	}
	if bin == nil {
		gz, err := fs.ReadFile(agentsFS, "agents/"+name+".gz")
		if err != nil {
			return nil, "", fmt.Errorf("agent %s not bundled in this build", key)
		}
		zr, err := gzip.NewReader(bytes.NewReader(gz))
		if err != nil {
			return nil, "", err
		}
		bin, err = io.ReadAll(zr)
		if err != nil {
			return nil, "", err
		}
	}
	sum := sha256.Sum256(bin)
	e := agentEntry{bin: bin, version: hex.EncodeToString(sum[:])[:16]}
	cache[key] = e
	return e.bin, e.version, nil
}

//go:embed all:ext
var extFS embed.FS

// ExtDir, when set, is searched before the embedded extension (development).
var ExtDir string

// BridgeVSIX returns the herdr-ide-bridge VS Code extension, if bundled.
func BridgeVSIX() []byte {
	if ExtDir != "" {
		if b, err := os.ReadFile(filepath.Join(ExtDir, brand.BridgeExt+".vsix")); err == nil {
			return b
		}
	}
	b, _ := fs.ReadFile(extFS, "ext/"+brand.BridgeExt+".vsix")
	return b
}
