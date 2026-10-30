package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
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

	"github.com/jezek/xgb"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// gui provides the virtual display that programs in panes draw their
// windows on (see docs/features/14-gui-windows.md). It is Xvfb, found on the
// machine or unpacked from the distribution's package in user space, so no
// privileged installation is needed.
//
// Ownership and reclamation: the display number is reserved in run/gui.json,
// so panes keep a valid environment across restarts; each Xvfb start writes
// a new cookie to run/xauth.server (Xvfb's) and run/xauth (the panes'). Xvfb
// runs in its own session and outlives the agent (programs would die with
// their display); it exits by itself guiIdleSeconds after its last client
// disconnected (-terminate).
//
// Other users can bind X sockets in /tmp, abstract ones included, and X
// clients cannot tell which server they reach. So a display number is only
// used while no other user's lock file, socket or listener is on it, and the
// agent sends the cookie only to a server whose peer credentials are this
// instance's Xvfb.
type gui struct {
	a  *Agent
	mu sync.Mutex

	wmMu sync.Mutex
	wm   *windowManager

	vglOnce sync.Once
	vgl     vglInfo
}

const (
	// guiIdleSeconds: Xvfb exits this long after its last client left. The
	// window manager is a client while an agent is connected.
	guiIdleSeconds = 6 * 3600
	// guiScreen is the size of the virtual screen; windows larger than it
	// still work, but input reaches only the part on the screen.
	guiScreen = "2560x1440x24"
	// guiFirstDisplay leaves the low numbers to real X servers.
	guiFirstDisplay = 20
)

type guiState struct {
	Display int    `json:"display"`
	Pid     int    `json:"pid,omitempty"`
	Bin     string `json:"bin,omitempty"`
}

type vglInfo struct {
	run     string
	preload string
	gpu     bool
}

func newGUI(a *Agent) *gui {
	g := &gui{a: a}
	go g.cleanStaging()
	return g
}

// stagingRetention: downloads left by a killed agent are removed after this.
const stagingRetention = time.Hour

// cleanStaging removes .fetch-* directories of installs that did not finish.
func (g *gui) cleanStaging() {
	ents, _ := os.ReadDir(g.root())
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), ".fetch-") {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > stagingRetention {
			os.RemoveAll(filepath.Join(g.root(), e.Name()))
		}
	}
}

// root holds unpacked Xvfb packages, shared by instances.
func (g *gui) root() string      { return filepath.Join(g.a.home, brand.DataDirName, "xvfb") }
func (g *gui) statePath() string { return filepath.Join(g.a.runDir, "gui.json") }

// xauthPath is the Xauthority file panes get (XAUTHORITY); serverAuthPath
// is Xvfb's own copy, so that programs changing theirs cannot leave the
// server without a cookie (an X server with none accepts any local user).
func (g *gui) xauthPath() string      { return filepath.Join(g.a.runDir, "xauth") }
func (g *gui) serverAuthPath() string { return filepath.Join(g.a.runDir, "xauth.server") }

// xTmp holds X servers' sockets and lock files; tests use their own.
var xTmp = "/tmp"

func xSocket(n int) string { return fmt.Sprintf("%s/.X11-unix/X%d", xTmp, n) }
func xLock(n int) string   { return fmt.Sprintf("%s/.X%d-lock", xTmp, n) }

// pidExists is processAlive that also counts other users' processes.
func pidExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// lockPid returns the pid in an X server lock file, 0 if there is none.
func lockPid(n int) int {
	b, err := os.ReadFile(xLock(n))
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return pid
}

// ownerOf returns the owner of path (not following links); ok is false when
// it does not exist.
func ownerOf(path string) (uid int, ok bool) {
	fi, err := os.Lstat(path)
	if err != nil {
		return 0, false
	}
	if st, isUnix := fi.Sys().(*syscall.Stat_t); isUnix {
		return int(st.Uid), true
	}
	return -1, true
}

// peerOf connects to a unix socket ("@name" for an abstract one) and returns
// the process and user listening there.
func peerOf(path string) (pid, uid int, err error) {
	c, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return 0, 0, err
	}
	defer c.Close()
	return peerCred(c.(*net.UnixConn))
}

// listeners are the sockets an X client may reach for display n: on Linux
// libxcb tries the abstract name first, and anyone can bind it.
func listeners(n int) []string {
	if runtime.GOOS == "linux" {
		return []string{"@" + xSocket(n), xSocket(n)}
	}
	return []string{xSocket(n)}
}

// x11DirSafe reports whether the socket directory cannot be used to mislead
// us: a real directory owned by root or us, sticky if group or others may
// write it.
// Xvfb creates it when it is missing.
func x11DirSafe() bool {
	fi, err := os.Lstat(xTmp + "/.X11-unix")
	if os.IsNotExist(err) {
		return true
	}
	if err != nil || !fi.IsDir() {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || (st.Uid != 0 && int(st.Uid) != os.Getuid()) {
		return false
	}
	return fi.Mode().Perm()&0o022 == 0 || fi.Mode()&os.ModeSticky != 0
}

// usable reports whether display n can serve this instance: no lock file,
// socket or listener of another user (who could pose as our X server and
// receive the cookie and the user's keystrokes), and any live server on it
// is the one this instance started (st.Pid).
func usable(n int, st guiState) bool { return usableBy(n, st, os.Getuid()) }

func usableBy(n int, st guiState, me int) bool {
	if uid, ok := ownerOf(xLock(n)); ok {
		if uid != me {
			return false
		}
		if pid := lockPid(n); pid > 0 && pidExists(pid) && pid != st.Pid {
			return false
		}
	}
	if uid, ok := ownerOf(xSocket(n)); ok && uid != me {
		return false
	}
	for _, l := range listeners(n) {
		if pid, uid, err := peerOf(l); err == nil && (uid != me || pid != st.Pid) {
			return false
		}
	}
	return true
}

func (g *gui) readState() guiState {
	var st guiState
	if b, err := os.ReadFile(g.statePath()); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

func (g *gui) writeState(st guiState) {
	b, _ := json.Marshal(st)
	_ = os.WriteFile(g.statePath(), b, 0o600)
}

// lock serializes reserving and starting the display between agents of
// the same instance (two cores, or a reconnect overlapping the old agent).
func (g *gui) lock() (unlock func()) {
	f, err := os.OpenFile(filepath.Join(g.a.runDir, "gui.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() {}
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX) != nil {
		f.Close()
		return func() {}
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}
}

// display returns the reserved display number, reserving another one when
// the previous one is in someone else's hands.
func (g *gui) display() (int, error) {
	if !x11DirSafe() {
		return 0, errors.New(xTmp + "/.X11-unix is not a directory owned by root or the user with the sticky bit")
	}
	st := g.readState()
	if st.Display > 0 && usable(st.Display, st) {
		return st.Display, nil
	}
	for n := guiFirstDisplay; n < guiFirstDisplay+500; n++ {
		_, e1 := os.Lstat(xSocket(n))
		_, e2 := os.Lstat(xLock(n))
		if os.IsNotExist(e1) && os.IsNotExist(e2) && usable(n, guiState{}) {
			g.writeState(guiState{Display: n})
			return n, nil
		}
	}
	return 0, errors.New("no free X display number")
}

// serverCookie is the cookie of the running display.
func (g *gui) serverCookie() ([]byte, error) {
	if c, err := readXauthCookie(g.serverAuthPath()); err == nil {
		return c, nil
	}
	// A display started by an earlier build shares the panes' file.
	return readXauthCookie(g.xauthPath())
}

// newCookie writes a fresh cookie for display n to the server's and the
// panes' Xauthority files. Each Xvfb start gets a new one.
func (g *gui) newCookie(n int) error {
	c := make([]byte, 16)
	if _, err := rand.Read(c); err != nil {
		return err
	}
	for _, p := range []string{g.serverAuthPath(), g.xauthPath()} {
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, xauthEntry(c, n), 0o600); err != nil {
			return err
		}
		if err := os.Rename(tmp, p); err != nil {
			return err
		}
	}
	return nil
}

const xauthName = "MIT-MAGIC-COOKIE-1"

// xauthEntry is one Xauthority record for display n with family FamilyWild,
// which libXau matches whatever the host name.
func xauthEntry(cookie []byte, n int) []byte {
	var b bytes.Buffer
	field := func(p []byte) {
		binary.Write(&b, binary.BigEndian, uint16(len(p)))
		b.Write(p)
	}
	binary.Write(&b, binary.BigEndian, uint16(0xffff))
	field(nil)
	field([]byte(strconv.Itoa(n)))
	field([]byte(xauthName))
	field(cookie)
	return b.Bytes()
}

func readXauthCookie(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	r := bytes.NewReader(b)
	var family uint16
	if err := binary.Read(r, binary.BigEndian, &family); err != nil {
		return nil, err
	}
	var fields [4][]byte
	for i := range fields {
		var n uint16
		if err := binary.Read(r, binary.BigEndian, &n); err != nil {
			return nil, err
		}
		fields[i] = make([]byte, n)
		if _, err := io.ReadFull(r, fields[i]); err != nil {
			return nil, err
		}
	}
	if string(fields[2]) != xauthName || len(fields[3]) != 16 {
		return nil, errors.New("not a cookie file")
	}
	return fields[3], nil
}

// findXvfb returns an Xvfb on the machine or one unpacked earlier.
func (g *gui) findXvfb() string {
	if p, err := exec.LookPath("Xvfb"); err == nil {
		return p
	}
	for _, p := range []string{"/usr/bin/Xvfb", "/usr/local/bin/Xvfb"} {
		if isExecutable(p) {
			return p
		}
	}
	for _, d := range g.unpacked() {
		if p := filepath.Join(d, "usr", "bin", "Xvfb"); isExecutable(p) {
			return p
		}
	}
	return ""
}

// unpacked lists unpacked Xvfb packages, most recently used first.
func (g *gui) unpacked() []string {
	ents, err := os.ReadDir(g.root())
	if err != nil {
		return nil
	}
	type dir struct {
		path string
		mod  time.Time
	}
	var dirs []dir
	for _, e := range ents {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if info, err := e.Info(); err == nil {
			dirs = append(dirs, dir{filepath.Join(g.root(), e.Name()), info.ModTime()})
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].mod.After(dirs[j].mod) })
	out := make([]string, len(dirs))
	for i, d := range dirs {
		out[i] = d.path
	}
	return out
}

// installable reports whether the distribution's Xvfb package can be
// fetched without privileges (Debian and derivatives).
func installable() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	_, e1 := exec.LookPath("apt-get")
	_, e2 := exec.LookPath("dpkg-deb")
	return e1 == nil && e2 == nil
}

var (
	unsafeVersion = regexp.MustCompile(`[^A-Za-z0-9.+~-]`)
	// A version directory name: starts with a digit, so never "." or "..".
	versionName = regexp.MustCompile(`^[0-9][A-Za-z0-9.+~_-]*$`)
)

// install fetches the distribution's xvfb package with apt-get download
// (verified against apt's signed package lists) and unpacks it below root.
// It relies on the libraries, xkbcomp and keyboard data an X server or
// Xwayland already brought onto the machine.
func (g *gui) install(ctx context.Context) error {
	if !installable() {
		return errors.New("Xvfb is not installed and cannot be fetched without apt-get and dpkg-deb")
	}
	if err := os.MkdirAll(g.root(), 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(g.root(), ".fetch-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "apt-get", "download", "xvfb")
	cmd.Dir = tmp
	cmd.Env = cleanEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("apt-get download xvfb: %v: %s", err, lastN(string(out), 400))
	}
	debs, _ := filepath.Glob(filepath.Join(tmp, "xvfb_*.deb"))
	if len(debs) != 1 {
		return errors.New("apt-get download xvfb produced no package")
	}
	ver, err := runOutput(ctx, "dpkg-deb", "-f", debs[0], "Version")
	if err != nil {
		return err
	}
	ver = unsafeVersion.ReplaceAllString(strings.TrimSpace(ver), "_")
	if !versionName.MatchString(ver) {
		return fmt.Errorf("xvfb package with an unexpected version %q", ver)
	}
	dest := filepath.Join(g.root(), ver)
	if isExecutable(filepath.Join(dest, "usr", "bin", "Xvfb")) {
		now := time.Now()
		return os.Chtimes(dest, now, now)
	}
	stage := filepath.Join(tmp, "root")
	if _, err := runOutput(ctx, "dpkg-deb", "-x", debs[0], stage); err != nil {
		return err
	}
	if !isExecutable(filepath.Join(stage, "usr", "bin", "Xvfb")) {
		return errors.New("the xvfb package contains no usr/bin/Xvfb")
	}
	os.RemoveAll(dest)
	if err := os.Rename(stage, dest); err != nil {
		return err
	}
	g.prune(dest)
	return nil
}

// prune removes unpacked packages other than keep that were not used for
// versionRetention.
func (g *gui) prune(keep string) {
	cutoff := time.Now().Add(-versionRetention)
	for _, d := range g.unpacked() {
		if d == keep {
			continue
		}
		if info, err := os.Stat(d); err == nil && info.ModTime().Before(cutoff) {
			os.RemoveAll(d)
		}
	}
}

// running reports whether the Xvfb this instance started serves display n:
// every socket a client may reach (on Linux the abstract one too, which
// clients try first) answers with that process and our user.
func (g *gui) running(n int) bool {
	st := g.readState()
	if st.Pid == 0 || st.Display != n {
		return false
	}
	for _, l := range listeners(n) {
		pid, uid, err := peerOf(l)
		if err != nil || uid != os.Getuid() || pid != st.Pid {
			return false
		}
	}
	return true
}

// terminateArgs makes Xvfb exit guiIdleSeconds after its last client left.
// The delay needs xorg-server 21.1; older servers exit at once instead.
func terminateArgs(bin string) (args []string, delay bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-help")
	cmd.Env = cleanEnv()
	out, _ := cmd.CombinedOutput()
	if strings.Contains(string(out), "-terminate [delay]") {
		return []string{"-terminate", strconv.Itoa(guiIdleSeconds)}, true
	}
	return []string{"-terminate"}, false
}

// start runs Xvfb on the reserved display unless it is running.
func (g *gui) start() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	defer g.lock()()
	n, err := g.display()
	if err != nil {
		return err
	}
	if g.running(n) {
		return nil
	}
	bin := g.findXvfb()
	if bin == "" {
		return errors.New("Xvfb is not installed")
	}
	if err := g.newCookie(n); err != nil {
		return err
	}
	if rel, err := filepath.Rel(g.root(), bin); err == nil && !strings.HasPrefix(rel, "..") {
		dir := filepath.Join(g.root(), strings.Split(rel, string(filepath.Separator))[0])
		now := time.Now()
		_ = os.Chtimes(dir, now, now) // in use: keep it in cleanups
	}
	terminate, delay := terminateArgs(bin)
	args := append([]string{fmt.Sprintf(":%d", n),
		"-nolisten", "tcp", "-auth", g.serverAuthPath(),
		"-screen", "0", guiScreen}, terminate...)
	cmd := exec.Command(bin, args...)
	cmd.Env = cleanEnv()
	// Its own session: it survives the agent and the ssh connection.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	logPath := filepath.Join(g.a.base, "xvfb.log")
	if lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		cmd.Stdout = lf
		cmd.Stderr = lf
		defer lf.Close()
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	g.writeState(guiState{Display: n, Pid: cmd.Process.Pid, Bin: bin})
	deadline := time.After(15 * time.Second)
	for !g.running(n) {
		select {
		case <-exited:
			out, _ := os.ReadFile(logPath)
			return fmt.Errorf("Xvfb exited: %s", lastN(string(out), 600))
		case <-deadline:
			// Not answering, or someone else answers on one of its sockets.
			cmd.Process.Kill()
			return fmt.Errorf("Xvfb did not take display :%d within 15 s", n)
		case <-time.After(100 * time.Millisecond):
		}
	}
	// -terminate counts from the last client leaving: one connection arms
	// it, so a display nobody attaches to still exits. (Without the delay
	// the server would exit right away; the next attach is its first client.)
	if delay {
		if x, err := g.connect(n); err == nil {
			x.Close()
		}
	}
	return nil
}

// connect opens an X connection to display n, sending the cookie only to
// this instance's Xvfb (checked on the connection and on every socket).
func (g *gui) connect(n int) (*xgb.Conn, error) {
	cookie, err := g.serverCookie()
	if err != nil {
		return nil, err
	}
	conn, err := net.DialTimeout("unix", xSocket(n), 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("display :%d is not running", n)
	}
	if pid, uid, err := peerCred(conn.(*net.UnixConn)); err != nil || uid != os.Getuid() || pid != g.readState().Pid || !g.running(n) {
		conn.Close()
		return nil, fmt.Errorf("display :%d is not served by this instance's Xvfb", n)
	}
	x, err := xgb.NewConnNetWithCookieHex(conn, hex.EncodeToString(cookie))
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("connect to the display: %w", err)
	}
	return x, nil
}

// virtualGL finds VirtualGL and checks its EGL back end once per agent.
func (g *gui) virtualGL() vglInfo {
	g.vglOnce.Do(func() {
		run, err := exec.LookPath("vglrun")
		if err != nil {
			if !isExecutable("/opt/VirtualGL/bin/vglrun") {
				return
			}
			run = "/opt/VirtualGL/bin/vglrun"
		}
		g.vgl.run = run
		// vglrun preloads these by name; absolute paths keep working when
		// they are not on the loader's default path.
		var libs []string
		for _, name := range []string{"libdlfaker.so", "libvglfaker.so"} {
			for _, d := range []string{"/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/opt/VirtualGL/lib64", "/opt/VirtualGL/lib"} {
				if real, ok := rootOnly(filepath.Join(d, name)); ok {
					libs = append(libs, real)
					break
				}
			}
		}
		if len(libs) == 2 {
			g.vgl.preload = strings.Join(libs, ":")
		}
		// VirtualGL's own eglinfo (not Mesa's), next to the real vglrun;
		// distributions link vglrun into /usr/bin.
		eglinfo := "/opt/VirtualGL/bin/eglinfo"
		if real, err := filepath.EvalSymlinks(run); err == nil && isExecutable(filepath.Join(filepath.Dir(real), "eglinfo")) {
			eglinfo = filepath.Join(filepath.Dir(real), "eglinfo")
		}
		if isExecutable(eglinfo) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, eglinfo, "egl0")
			cmd.Env = cleanEnv()
			g.vgl.gpu = cmd.Run() == nil
		}
	})
	return g.vgl
}

// rootOnly resolves p and reports whether the file and every directory
// above it can be changed by root only: libraries preloaded into every
// program of a pane must not be replaceable by other users.
func rootOnly(p string) (string, bool) {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", false
	}
	for q := real; ; q = filepath.Dir(q) {
		fi, err := os.Stat(q)
		if err != nil {
			return "", false
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || fi.Mode().Perm()&0o022 != 0 && fi.Mode()&os.ModeSticky == 0 {
			return "", false
		}
		if q == "/" {
			return real, true
		}
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (g *gui) status() *agentproto.GUIStatus {
	st := &agentproto.GUIStatus{Supported: runtime.GOOS == "linux"}
	if !st.Supported {
		return st
	}
	st.Xvfb = g.findXvfb()
	st.Installable = st.Xvfb == "" && installable()
	unlock := g.lock()
	n, err := g.display()
	unlock()
	if err != nil {
		st.Error = err.Error()
		return st
	}
	st.Display = fmt.Sprintf(":%d", n)
	st.XAuthority = g.xauthPath()
	st.Running = g.running(n)
	if v := g.virtualGL(); v.run != "" {
		st.VGL, st.GPU, st.VGLPreload = v.run, v.gpu, v.preload
	}
	return st
}

// shells describes the processes among args (pids) that are this user's:
// their executable's name and whether they were started with display in
// their environment.
func (g *gui) shells(args []string, display string) []agentproto.GUIProc {
	var out []agentproto.GUIProc
	for _, a := range args[:min(len(args), 512)] {
		pid, err := strconv.Atoi(a)
		if err != nil || pid <= 1 {
			continue
		}
		dir := "/proc/" + strconv.Itoa(pid)
		env, err := os.ReadFile(dir + "/environ")
		if err != nil {
			continue // gone, or another user's
		}
		if len(env) == 0 {
			// Still in exec (the kernel sets the environment after the
			// parent sees it start), or started without any environment:
			// unknown, so the pane is left alone.
			continue
		}
		comm, _ := os.ReadFile(dir + "/comm")
		p := agentproto.GUIProc{Pid: pid, Comm: strings.TrimSpace(string(comm))}
		for _, kv := range bytes.Split(env, []byte{0}) {
			if string(kv) == "DISPLAY="+display {
				p.Display = true
				break
			}
		}
		out = append(out, p)
	}
	return out
}

func (g *gui) handle(ctx context.Context, st net.Conn, h agentproto.Header) error {
	defer st.Close()
	if runtime.GOOS != "linux" && h.Action != "status" {
		return agentproto.Fail(st, errors.New("gui: no virtual display on "+runtime.GOOS))
	}
	switch h.Action {
	case "status":
	case "install":
		if err := g.install(ctx); err != nil {
			return agentproto.Fail(st, err)
		}
	case "start":
		if err := g.start(); err != nil {
			return agentproto.Fail(st, err)
		}
	case "shells":
		gs := g.status()
		gs.Procs = g.shells(h.Args, gs.Display)
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, GUI: gs})
	case "attach":
		return g.attach(st)
	default:
		return agentproto.Fail(st, fmt.Errorf("gui: unknown action %q", h.Action))
	}
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, GUI: g.status()})
}

// attach runs the window manager for the stream until either ends. A newer
// attach replaces an older one.
func (g *gui) attach(st net.Conn) error {
	unlock := g.lock()
	n, err := g.display()
	unlock()
	if err != nil {
		return agentproto.Fail(st, err)
	}
	x, err := g.connect(n)
	if err != nil {
		return agentproto.Fail(st, err)
	}
	g.wmMu.Lock()
	if g.wm != nil {
		g.wm.close()
	}
	g.wmMu.Unlock()
	wm, err := newWindowManager(x, st, g.a.logger)
	if err != nil {
		return agentproto.Fail(st, err)
	}
	g.wmMu.Lock()
	g.wm = wm
	g.wmMu.Unlock()
	defer func() {
		g.wmMu.Lock()
		if g.wm == wm {
			g.wm = nil
		}
		g.wmMu.Unlock()
		wm.close()
	}()
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true, GUI: g.status()}); err != nil {
		return err
	}
	return wm.run()
}
