//go:build unix

package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jezek/xgb/res"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// GPUs and the display (see docs/features/14-gui-windows.md, "GPU").
//
// The GPU display is Xwayland drawing with one GPU: the driver's first
// NVIDIA GPU where there are any, because NVIDIA's driver shows windows of
// Vulkan programs only from that one whatever the display draws with, and
// shares buffers with the display only on the same GPU; else the first GPU
// whose render node the user may open.
//
// On a machine with several NVIDIA GPUs a program that renders on another
// one than the first cannot create its window's swapchain. The library
// gpupick (scripts/gpupick), preloaded into a terminal's programs when the
// setting is on, leaves a program started with CUDA_VISIBLE_DEVICES only
// the GPUs that names, so the chosen one is its first.

// Where the kernel describes GPUs; tests use their own.
var (
	nvidiaProc = "/proc/driver/nvidia/gpus"
	drmSys     = "/sys/class/drm"
	drmDev     = "/dev/dri"
)

// nvidiaGPUs lists the machine's NVIDIA GPUs in PCI bus order, which is
// nvidia-smi's, from what the driver says about each
// (/proc/driver/nvidia/gpus/<pci address>/information, readable by anyone).
func nvidiaGPUs() []agentproto.GUIGPU {
	ents, err := os.ReadDir(nvidiaProc)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
	var out []agentproto.GUIGPU
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(nvidiaProc, name, "information"))
		if err != nil {
			continue
		}
		g := agentproto.GUIGPU{Minor: -1, PCI: strings.ToLower(name)}
		excluded := false
		for _, line := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			v = strings.TrimSpace(v)
			switch strings.TrimSpace(k) {
			case "Model":
				g.Model = v
			case "GPU UUID":
				g.UUID = v
			case "Device Minor":
				if n, err := strconv.Atoi(v); err == nil && n >= 0 {
					g.Minor = n
				}
			case "GPU Excluded":
				excluded = strings.EqualFold(v, "yes")
			}
		}
		// The UUID goes into a terminal's environment and is matched there.
		if excluded || g.Minor < 0 || !gpuUUID.MatchString(g.UUID) {
			continue
		}
		g.Index = len(out)
		out = append(out, g)
	}
	return out
}

// renderNodes lists the render nodes of the machine's GPUs in their order,
// with each one's PCI address and driver.
type renderNode struct {
	path, pci, driver string
}

func renderNodes() []renderNode {
	ents, err := os.ReadDir(drmDev)
	if err != nil {
		return nil
	}
	type numbered struct {
		n    int
		name string
	}
	var names []numbered
	for _, e := range ents {
		if n, err := strconv.Atoi(strings.TrimPrefix(e.Name(), "renderD")); err == nil && strings.HasPrefix(e.Name(), "renderD") {
			names = append(names, numbered{n, e.Name()})
		}
	}
	sort.Slice(names, func(i, j int) bool { return names[i].n < names[j].n })
	var out []renderNode
	for _, nm := range names {
		r := renderNode{path: filepath.Join(drmDev, nm.name)}
		if dev, err := filepath.EvalSymlinks(filepath.Join(drmSys, nm.name, "device")); err == nil {
			r.pci = strings.ToLower(filepath.Base(dev))
			if drv, err := filepath.EvalSymlinks(filepath.Join(dev, "driver")); err == nil {
				r.driver = filepath.Base(drv)
			}
		}
		out = append(out, r)
	}
	return out
}

func openable(path string) bool {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// gpuNode chooses the GPU the display draws with: its render node, whether
// NVIDIA's driver runs it, and then its minor.
func gpuNode(gpus []agentproto.GUIGPU) (node string, nvidia bool, minor *int) {
	nodes := renderNodes()
	if len(gpus) > 0 {
		first := gpus[0]
		for _, g := range gpus {
			if g.Minor < first.Minor {
				first = g
			}
		}
		for _, r := range nodes {
			if r.pci == first.PCI && openable(r.path) {
				m := first.Minor
				return r.path, true, &m
			}
		}
	}
	for _, r := range nodes {
		if !openable(r.path) {
			continue
		}
		if r.driver == "nvidia" {
			for _, g := range gpus {
				if g.PCI == r.pci {
					m := g.Minor
					return r.path, true, &m
				}
			}
			return r.path, true, nil
		}
		return r.path, false, nil
	}
	return "", false, nil
}

// findXwayland returns an Xwayland on the machine.
func findXwayland() string {
	if p, err := exec.LookPath("Xwayland"); err == nil {
		return p
	}
	for _, p := range []string{"/usr/bin/Xwayland", "/usr/local/bin/Xwayland"} {
		if isExecutable(p) {
			return p
		}
	}
	return ""
}

type gpuDisplay struct {
	bin, node string
	nvidia    bool
	minor     *int
}

// gpuDisplay tells what the GPU display would run with; false where there
// can be none, or after an attempt failed (accelErr): the next agent tries
// again.
func (g *gui) gpuDisplay() (gpuDisplay, bool) {
	if runtime.GOOS != "linux" {
		return gpuDisplay{}, false
	}
	g.accelMu.Lock()
	failed := g.accelErr != ""
	g.accelMu.Unlock()
	if failed {
		return gpuDisplay{}, false
	}
	d := gpuDisplay{bin: findXwayland()}
	if d.bin == "" {
		return d, false
	}
	d.node, d.nvidia, d.minor = gpuNode(nvidiaGPUs())
	return d, d.node != ""
}

// wanted is the kind of display to start for what the core asked for.
func (g *gui) wanted(asked string) string {
	if asked != agentproto.GUIXvfb {
		if _, ok := g.gpuDisplay(); ok {
			return agentproto.GUIXwayland
		}
	}
	return agentproto.GUIXvfb
}

// compositorCommand is the command that runs the GPU display's compositor
// (guiwl.go) with its client's socket as file descriptor 3; tests replace
// it.
var compositorCommand = func(node string, nvidia bool) (*exec.Cmd, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	args := []string{"gui-wl", "--device", node}
	if nvidia {
		args = append(args, "--nvidia")
	}
	return exec.Command(exe, args...), nil
}

// ownClient tells whether process pid is one of the instance's own that
// uses the display without showing anything: this agent, another one, or a
// display keeper.
func ownClient(pid int) bool {
	if pid == os.Getpid() {
		return true
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil {
		return false
	}
	argv := bytes.Split(b, []byte{0})
	if len(argv) < 2 || !strings.HasPrefix(filepath.Base(string(argv[0])), brand.CoreBin) {
		return false
	}
	return string(argv[1]) == "gui-keep" || string(argv[1]) == "agent"
}

// user returns a process that uses display n besides the instance's own
// (0 when there is none, -1 when that cannot be told). Only an unused
// display may be replaced by one of another kind, which ends its clients'
// connections.
func (g *gui) user(n int) int {
	x, err := g.connect(n)
	if err != nil {
		return -1
	}
	defer x.Close()
	if res.Init(x) != nil {
		return -1
	}
	r, err := res.QueryClientIds(x, 1, []res.ClientIdSpec{{Client: 0, Mask: res.ClientIdMaskLocalClientPID}}).Reply()
	if err != nil {
		return -1
	}
	for _, id := range r.Ids {
		if len(id.Value) == 0 {
			return -1
		}
		// The server counts itself among its clients.
		if pid := int(id.Value[0]); pid != g.readState().Pid && !ownClient(pid) {
			return pid
		}
	}
	return 0
}

// stop ends the display server of st on display n and waits until it is
// gone, so that another one can take the number.
func (g *gui) stop(n int, st guiState) {
	if st.Pid <= 1 || !g.running(n) {
		return
	}
	start, err := procStart(st.Pid)
	proc := serverProc{pid: st.Pid, start: start}
	same := func() bool {
		if err != nil {
			return pidExists(st.Pid)
		}
		return proc.alive()
	}
	syscall.Kill(st.Pid, syscall.SIGTERM)
	for deadline := time.Now().Add(5 * time.Second); same(); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			if same() {
				syscall.Kill(st.Pid, syscall.SIGKILL)
				time.Sleep(200 * time.Millisecond)
			}
			break
		}
	}
	// A server that was killed leaves its files; they are this user's.
	if !same() {
		os.Remove(xSocket(n))
		os.Remove(xLock(n))
	}
}

// --- gpupick ----------------------------------------------------------

var gpuUUID = regexp.MustCompile(`^GPU-[0-9a-fA-F-]{8,64}$`)

func (g *gui) pickRoot() string { return filepath.Join(g.a.home, brand.DataDirName, "gpupick") }

var (
	pickDigestOnce sync.Once
	pickDigestHex  string
)

// pickDigest is the SHA-256 of the library this build carries.
func pickDigest() string {
	pickDigestOnce.Do(func() {
		sum := sha256.Sum256(pickLib)
		pickDigestHex = hex.EncodeToString(sum[:])
	})
	return pickDigestHex
}

func (g *gui) pickFile() string {
	return filepath.Join(g.pickRoot(), pickDigest()[:16], "gpupick.so")
}

// pickPath returns the library when it is installed as this build has it,
// hashing it once per agent.
func (g *gui) pickPath() string {
	if len(pickLib) == 0 {
		return ""
	}
	p := g.pickFile()
	g.pickMu.Lock()
	defer g.pickMu.Unlock()
	if g.pickOK != p {
		info, err := os.Lstat(p)
		if err != nil || !info.Mode().IsRegular() {
			return ""
		}
		if got, err := fileDigest(p); err != nil || got != pickDigest() {
			return ""
		}
		g.pickOK = p
	}
	now := time.Now()
	os.Chtimes(filepath.Dir(p), now, now) // in use
	return p
}

// installPick writes the library below the data directory (shared by
// instances) unless it is there, and checks that the dynamic loader takes
// it: a home directory mounted noexec, or a C library it was not built
// for, would make every program of a terminal complain.
func (g *gui) installPick() error {
	if len(pickLib) == 0 {
		return fmt.Errorf("gui: no GPU selection library for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	g.pickInstallMu.Lock()
	defer g.pickInstallMu.Unlock()
	if g.pickPath() != "" {
		return nil
	}
	root := g.pickRoot()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(root, ".fetch-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	staged := filepath.Join(tmp, "gpupick.so")
	if err := os.WriteFile(staged, pickLib, 0o600); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", ":")
	cmd.Env = append(cleanEnv(), "LD_PRELOAD="+staged)
	if out, err := cmd.CombinedOutput(); err != nil || len(bytes.TrimSpace(out)) > 0 {
		return fmt.Errorf("gui: the GPU selection library cannot be preloaded: %v %s", err, lastN(string(out), 300))
	}
	dir := filepath.Dir(g.pickFile())
	if err := os.Rename(tmp, dir); err != nil {
		if g.pickPath() != "" {
			return nil
		}
		os.RemoveAll(dir) // a damaged copy
		if err := os.Rename(tmp, dir); err != nil {
			if g.pickPath() != "" {
				return nil
			}
			return err
		}
	}
	pruneBuilds(root, dir)
	if g.pickPath() == "" {
		return errors.New("gui: the installed GPU selection library is not usable")
	}
	return nil
}

// pruneBuilds removes the directories below root other than keep that were
// not used for versionRetention, and installs that did not finish.
func pruneBuilds(root, keep string) {
	ents, _ := os.ReadDir(root)
	for _, e := range ents {
		p := filepath.Join(root, e.Name())
		info, err := e.Info()
		if err != nil || p == keep {
			continue
		}
		limit := versionRetention
		if strings.HasPrefix(e.Name(), ".fetch-") {
			limit = stagingRetention
		}
		if time.Since(info.ModTime()) > limit {
			os.RemoveAll(p)
		}
	}
}
