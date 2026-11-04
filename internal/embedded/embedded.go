// Package embedded carries build artifacts compiled into the herdr-ide binary:
// the per-platform agents (gzip), the VS Code bridge extension and, when
// built (scripts/build-ffmpeg.sh), the encoder machines send program
// windows as video with.
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

//go:embed all:encoder
var encoderFS embed.FS

type encoderEntry struct {
	gz     []byte
	digest string
}

var (
	encoderMu    sync.Mutex
	encoderCache = map[string]encoderEntry{}
)

// Encoder returns the gzip-compressed video encoder for goos/goarch and the
// SHA-256 of the uncompressed binary; an error when this build has none.
func Encoder(goos, goarch string) ([]byte, string, error) {
	key := goos + "-" + goarch
	encoderMu.Lock()
	defer encoderMu.Unlock()
	if e, ok := encoderCache[key]; ok {
		return e.gz, e.digest, nil
	}
	gz, err := fs.ReadFile(encoderFS, "encoder/encoder-"+key+".gz")
	if err != nil {
		return nil, "", fmt.Errorf("no video encoder for %s in this build", key)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil, "", err
	}
	h := sha256.New()
	if _, err := io.Copy(h, zr); err != nil {
		return nil, "", err
	}
	e := encoderEntry{gz: gz, digest: hex.EncodeToString(h.Sum(nil))}
	encoderCache[key] = e
	return e.gz, e.digest, nil
}
