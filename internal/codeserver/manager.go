// Package codeserver provisions code-server on machines and keeps it
// running. Artifacts are resolved on the core host (see artifacts.go) and
// uploaded through the agent, so machines need no internet access.
package codeserver

import (
	"context"
	"errors"
	"fmt"
	"herdr-ide/internal/brand"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
)

// DefaultVersion is the code-server release installed on machines.
const DefaultVersion = "4.144.0"

// Phases reported while code-server is prepared; the UI translates them.
const (
	PhaseIdle          = "idle"
	PhaseCheck         = "check"
	PhaseDownload      = "download"
	PhaseUpload        = "upload"
	PhaseInstallBridge = "install_bridge"
	PhaseInstallExt    = "install_ext"
	PhaseStart         = "start"
	PhaseReady         = "ready"
	PhaseError         = "error"
)

// Status is reported to the UI while code-server is being prepared.
type Status struct {
	Phase string `json:"phase"`
	// Detail qualifies the phase (version, extension id).
	Detail string `json:"detail,omitempty"`
	Error  string `json:"error,omitempty"`
	Ready  bool   `json:"ready"`
	// Progress of the current download/upload in bytes.
	Done  int64 `json:"done,omitempty"`
	Total int64 `json:"total,omitempty"`
}

type machineState struct {
	mu     sync.Mutex // serializes Ensure
	status Status
	// agentSession identifies the agent session code-server was verified on;
	// a reconnect means the process may be gone.
	session any
}

// Manager tracks code-server per machine.
type Manager struct {
	Version  string
	CacheDir string
	// SeedDirs are searched before CacheDir (air-gapped installs).
	SeedDirs []string
	// Offline forbids downloads; artifacts must be seeded or cached.
	Offline bool
	// TarballURL and ExtensionURL are download templates (mirrors).
	TarballURL   string
	ExtensionURL string
	Logger       *log.Logger
	// BridgeVSIX returns the bundled bridge extension, if any.
	BridgeVSIX func() []byte
	// Extensions are downloaded on the core host and installed on machines.
	Extensions []Extension

	mu     sync.Mutex
	states map[string]*machineState
	dl     sync.Mutex // one download at a time
}

// New returns a manager with defaults.
func New(logger *log.Logger) *Manager {
	cache, _ := os.UserCacheDir()
	return &Manager{
		Version:      DefaultVersion,
		CacheDir:     filepath.Join(cache, brand.Slug, "code-server"),
		TarballURL:   DefaultTarballURL,
		ExtensionURL: DefaultExtensionURL,
		Logger:       logger,
		Extensions:   append([]Extension(nil), DefaultExtensions...),
		states:       map[string]*machineState{},
	}
}

func (mg *Manager) state(id string) *machineState {
	mg.mu.Lock()
	defer mg.mu.Unlock()
	s := mg.states[id]
	if s == nil {
		s = &machineState{status: Status{Phase: PhaseIdle}}
		mg.states[id] = s
	}
	return s
}

func (mg *Manager) setStatus(id string, fn func(*Status)) {
	mg.mu.Lock()
	defer mg.mu.Unlock()
	fn(&mg.states[id].status)
}

// Status returns the preparation status for a machine.
func (mg *Manager) Status(id string) Status {
	s := mg.state(id)
	mg.mu.Lock()
	defer mg.mu.Unlock()
	return s.status
}

// Invalidate marks code-server as needing a check (e.g. after proxy errors).
func (mg *Manager) Invalidate(id string) {
	mg.state(id)
	mg.setStatus(id, func(s *Status) {
		if s.Ready {
			*s = Status{Phase: PhaseIdle}
		}
	})
}

// Ready reports whether code-server is usable on the machine's current
// agent session.
func (mg *Manager) Ready(m *machines.Machine) bool {
	s := mg.state(m.ID())
	mg.mu.Lock()
	defer mg.mu.Unlock()
	return s.status.Ready && s.session == any(m.Session())
}

func platformAsset(os, arch string) (string, error) {
	switch os {
	case "linux":
	case "darwin":
		os = "macos"
	default:
		return "", fmt.Errorf("code-server has no build for %s", os)
	}
	if arch != "amd64" && arch != "arm64" {
		return "", fmt.Errorf("code-server has no build for %s/%s", os, arch)
	}
	return os + "-" + arch, nil
}

// Ensure installs and starts code-server on m. It is safe to call
// concurrently; callers share one run.
func (mg *Manager) Ensure(ctx context.Context, m *machines.Machine) error {
	id := m.ID()
	s := mg.state(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	if mg.Ready(m) {
		return nil
	}
	sess := m.Session()
	err := mg.ensure(ctx, m)
	mg.setStatus(id, func(st *Status) {
		if err != nil {
			st.Error = err.Error()
			st.Ready = false
			st.Phase = PhaseError
		} else {
			*st = Status{Phase: PhaseReady, Ready: true}
		}
	})
	if err == nil {
		mg.mu.Lock()
		s.session = any(sess)
		mg.mu.Unlock()
	} else {
		mg.Logger.Printf("code-server on %s: %v", m.Label(), err)
	}
	return err
}

func (mg *Manager) phase(id, p, detail string) {
	mg.setStatus(id, func(s *Status) { *s = Status{Phase: p, Detail: detail} })
}

func (mg *Manager) request(ctx context.Context, m *machines.Machine, h agentproto.Header) (*agentproto.Reply, error) {
	h.Op = agentproto.OpCodeServer
	h.Version = mg.Version
	conn, rep, err := m.Open(ctx, h)
	if err != nil {
		return rep, err
	}
	conn.Close()
	return rep, nil
}

// upload sends body through a chunked stream for actions that read data
// after the first reply and answer with a second one.
func (mg *Manager) upload(ctx context.Context, m *machines.Machine, h agentproto.Header, body io.Reader, progress func(int64)) (*agentproto.Reply, error) {
	h.Op = agentproto.OpCodeServer
	h.Version = mg.Version
	conn, _, err := m.Open(ctx, h)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	cw := agentproto.ChunkWriter{W: conn}
	buf := make([]byte, 256<<10)
	var done int64
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if _, err := cw.Write(buf[:n]); err != nil {
				return nil, err
			}
			done += int64(n)
			if progress != nil {
				progress(done)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return nil, rerr
		}
	}
	if err := cw.Finish(); err != nil {
		return nil, err
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(conn, &rep); err != nil {
		return nil, err
	}
	if !rep.OK {
		return &rep, errors.New(rep.Error)
	}
	return &rep, nil
}

func (mg *Manager) ensure(ctx context.Context, m *machines.Machine) error {
	id := m.ID()
	st := m.State()
	if st.Info == nil {
		return machines.ErrNotConnected
	}
	mg.phase(id, PhaseCheck, mg.Version)
	rep, err := mg.request(ctx, m, agentproto.Header{Action: "status"})
	if err != nil {
		return err
	}
	if !rep.CS.Installed {
		asset, err := platformAsset(st.Info.OS, st.Info.Arch)
		if err != nil {
			return err
		}
		mg.phase(id, PhaseDownload, mg.Version)
		path, err := mg.tarball(ctx, asset, func(done, total int64) {
			mg.setStatus(id, func(s *Status) { s.Done, s.Total = done, total })
		})
		if err != nil {
			return fmt.Errorf("code-server %s: %w", asset, err)
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		fi, _ := f.Stat()
		mg.setStatus(id, func(s *Status) { *s = Status{Phase: PhaseUpload, Detail: mg.Version, Total: fi.Size()} })
		_, err = mg.upload(ctx, m, agentproto.Header{Action: "install"}, f, func(n int64) {
			mg.setStatus(id, func(s *Status) { s.Done = n })
		})
		f.Close()
		if err != nil {
			return fmt.Errorf("install code-server: %w", err)
		}
	}
	if err := mg.ensureExtensions(ctx, m); err != nil {
		// Missing extensions do not prevent using VS Code.
		mg.Logger.Printf("code-server extensions on %s: %v", m.Label(), err)
	}
	mg.phase(id, PhaseStart, mg.Version)
	if _, err := mg.request(ctx, m, agentproto.Header{Action: "start"}); err != nil {
		return err
	}
	return nil
}

func (mg *Manager) marker(ctx context.Context, m *machines.Machine, name string, set bool) bool {
	h := agentproto.Header{Action: "marker", Path: name}
	if set {
		h.Args = []string{"set"}
	}
	rep, err := mg.request(ctx, m, h)
	return err == nil && rep.OK
}

func (mg *Manager) ensureExtensions(ctx context.Context, m *machines.Machine) error {
	id := m.ID()
	if mg.BridgeVSIX != nil {
		if vsix := mg.BridgeVSIX(); len(vsix) > 0 {
			name := "." + brand.BridgeExt + "-" + vsixContentHash(vsix)
			if !mg.marker(ctx, m, name, false) {
				mg.phase(id, PhaseInstallBridge, brand.BridgeExt)
				if _, err := mg.upload(ctx, m, agentproto.Header{Action: "install-ext", Path: brand.BridgeExt + ".vsix"}, bytesReader(vsix), nil); err != nil {
					return fmt.Errorf("bridge extension: %w", err)
				}
				mg.marker(ctx, m, name, true)
			}
		}
	}
	var errs []error
	if len(brand.LegacyBridgeExtIDs) > 0 && !mg.marker(ctx, m, "."+brand.Slug+"-legacy-removed", false) {
		h := agentproto.Header{Action: "uninstall-ext", Args: brand.LegacyBridgeExtIDs}
		if _, err := mg.request(ctx, m, h); err == nil {
			mg.marker(ctx, m, "."+brand.Slug+"-legacy-removed", true)
		}
	}
	for _, ext := range mg.Extensions {
		name := "." + brand.Slug + "-ext-" + ext.ID + "-" + ext.Version
		if mg.marker(ctx, m, name, false) {
			continue
		}
		mg.phase(id, PhaseInstallExt, ext.ID)
		path, err := mg.extension(ctx, ext)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", ext.ID, err))
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		_, err = mg.upload(ctx, m, agentproto.Header{Action: "install-ext", Path: ext.File()}, f, nil)
		f.Close()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", ext.ID, err))
			continue
		}
		mg.marker(ctx, m, name, true)
	}
	return errors.Join(errs...)
}

type byteReader struct {
	b []byte
}

func bytesReader(b []byte) io.Reader { return &byteReader{b: b} }

func (r *byteReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

// Dial connects to code-server's socket on m through the agent.
func (mg *Manager) Dial(ctx context.Context, m *machines.Machine) (net.Conn, error) {
	conn, _, err := m.Open(ctx, agentproto.Header{Op: agentproto.OpDialUnix, Path: "cs.sock"})
	return conn, err
}

// Stop shuts code-server down on m to release its memory; the next Ensure
// starts it again.
func (mg *Manager) Stop(ctx context.Context, m *machines.Machine) error {
	s := mg.state(m.ID())
	s.mu.Lock()
	defer s.mu.Unlock()
	mg.setStatus(m.ID(), func(st *Status) { *st = Status{Phase: PhaseIdle} })
	if m.Session() == nil {
		return nil
	}
	_, err := mg.request(ctx, m, agentproto.Header{Action: "stop"})
	return err
}

// Running lists machines whose code-server this manager considers ready.
func (mg *Manager) Running() []string {
	mg.mu.Lock()
	defer mg.mu.Unlock()
	var ids []string
	for id, s := range mg.states {
		if s.status.Ready {
			ids = append(ids, id)
		}
	}
	return ids
}
