package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
)

// fakeHerdr writes a herdr stand-in that reports version and records its
// arguments in <path>.args.
func fakeHerdr(t *testing.T, path, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
echo "$@" >> "$0.args"
case "$*" in
  --version) echo "herdr ` + version + `" ;;
  *"status server --json"*) echo '{"status":"not_running","running":false,"version":null,"restart_needed":false}' ;;
  "update --handoff") echo "updated" ;;
esac
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

// noInstalledHerdr hides every herdr of the host from resolveHerdr.
func noInstalledHerdr(t *testing.T) {
	saved := systemHerdrPaths
	systemHerdrPaths = nil
	t.Cleanup(func() { systemHerdrPaths = saved })
	t.Setenv("HERDR_BIN", "")
	t.Setenv("PATH", t.TempDir())
	t.Setenv("SHELL", "/usr/bin/false") // the login-shell lookup finds nothing
}

// An installed herdr wins; the managed copy of the bundled one only stands
// in for a missing installation.
func TestResolveHerdrPrefersInstalledOverManaged(t *testing.T) {
	noInstalledHerdr(t)
	a := testAgent(t)
	if bin, err := a.resolveHerdr(""); err == nil {
		t.Fatalf("resolved %q without an installation or a bundled herdr", bin)
	}

	a.bundledHerdr = filepath.Join(t.TempDir(), "herdr")
	fakeHerdr(t, a.bundledHerdr, "0.9.5")
	if bin, err := a.resolveHerdr(""); err != nil || bin != a.managedHerdrPath() {
		t.Fatalf("managed: %q %v", bin, err)
	}

	installed := filepath.Join(a.home, ".local", "bin", "herdr")
	fakeHerdr(t, installed, "0.9.4")
	a.herdrCache = map[string]string{}
	if bin, err := a.resolveHerdr(""); err != nil || bin != installed {
		t.Fatalf("installed: %q %v", bin, err)
	}
}

func TestManagedHerdrFollowsNewerBundles(t *testing.T) {
	a := testAgent(t)
	if a.managedHerdr() != "" {
		t.Fatal("managed herdr without a bundle or a copy")
	}
	a.bundledHerdr = filepath.Join(t.TempDir(), "herdr")
	fakeHerdr(t, a.bundledHerdr, "0.9.5")
	managed := a.managedHerdrPath()
	if got := a.managedHerdr(); got != managed {
		t.Fatalf("got %q", got)
	}
	if st, _ := os.Stat(filepath.Dir(managed)); st.Mode().Perm() != 0o700 {
		t.Fatalf("managed directory mode %v", st.Mode().Perm())
	}
	version := func() string { return herdrVersion(context.Background(), managed) }

	// An update installed a newer herdr: the older bundle does not replace it.
	fakeHerdr(t, managed, "0.9.7")
	a.managedHerdr()
	if v := version(); v != "0.9.7" {
		t.Fatalf("updated copy replaced by an older bundle: %s", v)
	}
	// An application upgrade brought a newer bundle.
	fakeHerdr(t, a.bundledHerdr, "0.10.0")
	a.managedHerdr()
	if v := version(); v != "0.10.0" {
		t.Fatalf("copy not refreshed from a newer bundle: %s", v)
	}
	// Without a bundle (e.g. a development core) the copy is still used.
	a.bundledHerdr = ""
	if got := a.managedHerdr(); got != managed {
		t.Fatalf("got %q", got)
	}
}

func TestVersionLess(t *testing.T) {
	for _, c := range []struct {
		a, b string
		less bool
	}{
		{"0.9.5", "0.9.6", true},
		{"0.9.10", "0.9.9", false},
		{"0.10.0", "0.9.9", false},
		{"0.9.5", "0.9.5", false},
		{"v0.9.5", "0.9.6", true},
		{"0.9.6-preview.3", "0.9.6", false},
		{"", "0.9.5", true},
	} {
		if got := versionLess(c.a, c.b); got != c.less {
			t.Errorf("versionLess(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestLatestHerdr(t *testing.T) {
	body := `{"version":"0.9.6","notes":"x"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
	defer srv.Close()
	saved := herdrManifestURL
	herdrManifestURL = srv.URL
	defer func() { herdrManifestURL = saved }()
	if v, err := latestHerdr(context.Background()); err != nil || v != "0.9.6" {
		t.Fatalf("%q %v", v, err)
	}
	body = `{"version":"0.9.6; rm -rf /"}`
	if _, err := latestHerdr(context.Background()); err == nil {
		t.Fatal("invalid version accepted")
	}
}

func herdrOp(t *testing.T, a *Agent, h agentproto.Header) *agentproto.HerdrStatus {
	t.Helper()
	c1, c2 := net.Pipe()
	h.Op = agentproto.OpHerdr
	go a.handleHerdr(context.Background(), c2, h)
	r := bufio.NewReader(c1)
	var rep agentproto.Reply
	for i, want := range []bool{false, true} { // an empty reply, then the result
		line, err := r.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		rep = agentproto.Reply{}
		if err := json.Unmarshal(line, &rep); err != nil || !rep.OK || (rep.Herdr != nil) != want {
			t.Fatalf("reply %d %s: %v", i, line, err)
		}
	}
	return rep.Herdr
}

// Only the application's own copy is updated; an installation of the user's
// is left to whatever installed it.
func TestUpdateOnlyTheManagedCopy(t *testing.T) {
	noInstalledHerdr(t)
	a := testAgent(t)
	installed := filepath.Join(a.home, ".local", "bin", "herdr")
	fakeHerdr(t, installed, "0.9.5")
	st := herdrOp(t, a, agentproto.Header{Action: "update"})
	if st.Error != "not_managed" || st.Managed || st.Bin != installed || st.Version != "0.9.5" {
		t.Fatalf("installed: %+v", st)
	}
	if args, _ := os.ReadFile(installed + ".args"); strings.Contains(string(args), "update") {
		t.Fatal("updated an installation of the user's")
	}

	os.Remove(installed)
	a.herdrCache = map[string]string{}
	a.bundledHerdr = filepath.Join(t.TempDir(), "herdr")
	fakeHerdr(t, a.bundledHerdr, "0.9.5")
	st = herdrOp(t, a, agentproto.Header{Action: "update", Session: "herdr-ide-dev"})
	if st.Error != "" || !st.Managed || st.Output != "updated" || st.Running {
		t.Fatalf("managed: %+v", st)
	}
	args, _ := os.ReadFile(a.managedHerdrPath() + ".args")
	if !strings.Contains(string(args), "update --handoff\n") || !strings.Contains(string(args), "--session herdr-ide-dev status server --json") {
		t.Fatalf("herdr invoked with:\n%s", args)
	}

	c1, c2 := net.Pipe()
	go a.handleHerdr(context.Background(), c2, agentproto.Header{Op: agentproto.OpHerdr, Action: "uninstall"})
	var rep agentproto.Reply
	if err := agentproto.ReadLine(c1, &rep); err != nil || rep.OK {
		t.Fatalf("unknown action accepted: %+v %v", rep, err)
	}
}

// Restarting stops a running server before starting one, only starts a
// server that is not running (herdr's stop fails without one), and starts
// none when the stop failed.
func TestRestartHerdrServer(t *testing.T) {
	noInstalledHerdr(t)
	a := testAgent(t)
	cfg, err := os.MkdirTemp("/tmp", "hr-") // short: macOS socket paths
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(cfg) })
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("HERDR_SOCKET_PATH", "")
	socket := a.herdrSocket("")
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(a.home, ".local", "bin", "herdr")
	os.MkdirAll(filepath.Dir(bin), 0o755)
	// The stand-in's server exits at once, so every start fails; its stop
	// removes the socket, or refuses. PATH is empty: commands need a path.
	fake := func(stop string) {
		t.Helper()
		os.Remove(bin + ".args")
		script := `#!/bin/sh
echo "$@" >> "$0.args"
case "$*" in
  --version) echo "herdr 0.9.5" ;;
  "status server --json") echo '{"running":false}' ;;
  "server stop") ` + stop + ` ;;
esac
`
		if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	calls := func() []string {
		b, _ := os.ReadFile(bin + ".args")
		var out []string
		for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			if strings.HasPrefix(l, "server") {
				out = append(out, l)
			}
		}
		return out
	}
	serve := func() { serveUnix(t, socket) }

	fake(`/bin/rm -f '` + socket + `'`)
	st := herdrOp(t, a, agentproto.Header{Action: "restart"})
	if got := calls(); st.Error != "start_failed" || strings.Join(got, ",") != "server" {
		t.Fatalf("not running: %+v %q", st, got)
	}

	serve()
	fake(`/bin/rm -f '` + socket + `'`)
	st = herdrOp(t, a, agentproto.Header{Action: "restart"})
	if got := calls(); st.Error != "start_failed" || strings.Join(got, ",") != "server stop,server" {
		t.Fatalf("running: %+v %q", st, got)
	}

	os.Remove(socket)
	serve()
	fake(`echo refused; exit 1`)
	st = herdrOp(t, a, agentproto.Header{Action: "restart"})
	if got := calls(); st.Error != "stop_failed" || !strings.Contains(st.Output, "refused") || strings.Join(got, ",") != "server stop" {
		t.Fatalf("stop refused: %+v %q", st, got)
	}

	// A stop that leaves the server answering, or that hangs, fails the
	// restart without a start.
	savedWait, savedTimeout := herdrStopWait, herdrStopTimeout
	herdrStopWait, herdrStopTimeout = 300*time.Millisecond, 300*time.Millisecond
	t.Cleanup(func() { herdrStopWait, herdrStopTimeout = savedWait, savedTimeout })
	fake(`exit 0`)
	st = herdrOp(t, a, agentproto.Header{Action: "restart"})
	if got := calls(); st.Error != "stop_failed" || !strings.Contains(st.Output, "still answers") || strings.Join(got, ",") != "server stop" {
		t.Fatalf("still answering: %+v %q", st, got)
	}
	fake(`/bin/sleep 5`)
	began := time.Now()
	st = herdrOp(t, a, agentproto.Header{Action: "restart"})
	if got := calls(); st.Error != "stop_failed" || !strings.Contains(st.Output, "did not return") || strings.Join(got, ",") != "server stop" {
		t.Fatalf("hanging stop: %+v %q", st, got)
	}
	if d := time.Since(began); d > 3*time.Second {
		t.Fatalf("hanging stop took %s", d)
	}

	// Another user's listener gets no herdr command at all.
	savedPeer := socketPeer
	socketPeer = func(*net.UnixConn) (int, int, error) { return 1, os.Getuid() + 1, nil }
	t.Cleanup(func() { socketPeer = savedPeer })
	fake(`/bin/rm -f '` + socket + `'`)
	for _, action := range []string{"restart", "stop", "start"} {
		st = herdrOp(t, a, agentproto.Header{Action: action})
		if got := calls(); st.Error != "foreign_server" || st.Running || len(got) != 0 {
			t.Fatalf("%s with a foreign listener: %+v %q", action, st, got)
		}
	}
}

// herdr removed, moved or reinstalled while the agent runs: every status
// resolves it afresh, reports a server that outlived its executable, and
// nothing is started or stopped without one.
func TestHerdrRemovedAndReinstalled(t *testing.T) {
	noInstalledHerdr(t)
	a := testAgent(t)
	cfg, err := os.MkdirTemp("/tmp", "hm-") // short: macOS socket paths
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(cfg) })
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("HERDR_SOCKET_PATH", "")
	socket := a.herdrSocket("")
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		t.Fatal(err)
	}

	installed := filepath.Join(a.home, ".local", "bin", "herdr")
	fakeHerdr(t, installed, "0.9.5")
	if st := herdrOp(t, a, agentproto.Header{Action: "status"}); st.Error != "" || st.Bin != installed {
		t.Fatalf("installed: %+v", st)
	}

	// Removed while its server runs: the server is still reported.
	serveUnix(t, socket)
	os.Remove(installed)
	st := herdrOp(t, a, agentproto.Header{Action: "status", HerdrBin: installed})
	if st.Error != "not_found" || st.Bin != "" || st.Version != "" || !st.Running {
		t.Fatalf("removed: %+v", st)
	}
	for _, action := range []string{"start", "stop", "restart"} {
		if st := herdrOp(t, a, agentproto.Header{Action: action, HerdrBin: installed}); st.Error != "not_found" || !st.Running {
			t.Fatalf("%s without herdr: %+v", action, st)
		}
	}
	inf := a.info(agentproto.Header{HerdrBin: installed})
	if inf.HerdrBin != "" || inf.HerdrError != agentproto.ErrHerdrNotFound.Error() || inf.HerdrSocket != socket {
		t.Fatalf("hello without herdr: %+v", inf)
	}

	// Installed again elsewhere: the stale path (the core's last one, or
	// herdr's SSH metadata) gives way to it.
	moved := filepath.Join(a.home, ".cargo", "bin", "herdr")
	fakeHerdr(t, moved, "0.10.0")
	if st := herdrOp(t, a, agentproto.Header{Action: "status", HerdrBin: installed}); st.Error != "" || st.Bin != moved || st.Version != "0.10.0" {
		t.Fatalf("moved: %+v", st)
	}
}

// Only a missing socket or a refused connection mean that no server runs;
// a listener that takes no connections may be a hung server.
func TestProbeServer(t *testing.T) {
	opErr := func(e syscall.Errno) error {
		return &net.OpError{Op: "dial", Net: "unix", Err: os.NewSyscallError("connect", e)}
	}
	for _, c := range []struct {
		err  error
		want serverState
	}{
		{opErr(syscall.ENOENT), serverAbsent},
		{opErr(syscall.ECONNREFUSED), serverAbsent},
		{opErr(syscall.EAGAIN), serverUnresponsive},
		{opErr(syscall.ETIMEDOUT), serverUnresponsive},
		{opErr(syscall.EACCES), serverForeign},
	} {
		if got := dialState(c.err); got != c.want {
			t.Errorf("%v: %d, want %d", c.err, got, c.want)
		}
	}
	dir, err := os.MkdirTemp("/tmp", "hp-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "s.sock")
	if st := probeServer(socket); st != serverAbsent {
		t.Fatalf("no socket: %d", st)
	}
	serveUnix(t, socket)
	if st := probeServer(socket); st != serverOurs {
		t.Fatalf("own listener: %d", st)
	}
	saved := socketPeer
	defer func() { socketPeer = saved }()
	tries := 0
	socketPeer = func(*net.UnixConn) (int, int, error) { tries++; return 0, 0, syscall.ENOTCONN }
	if st := probeServer(socket); st != serverForeign || tries != 3 {
		t.Fatalf("unidentified peer: %d after %d tries", st, tries)
	}
}

// serveUnix listens on socket like herdr: a connection stays open until the
// client closes it.
func serveUnix(t *testing.T, socket string) {
	t.Helper()
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				io.Copy(io.Discard, c)
				c.Close()
			}()
		}
	}()
}

// The client socket follows herdr's client_socket_path rules.
func TestHerdrClientSocket(t *testing.T) {
	a := testAgent(t)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HERDR_SOCKET_PATH", "")
	t.Setenv("HERDR_CLIENT_SOCKET_PATH", "")
	cfg := filepath.Join(a.home, ".config", "herdr")
	for _, c := range []struct{ session, env, legacy, want string }{
		{"", "", "", filepath.Join(cfg, "herdr-client.sock")},
		{"default", "", "", filepath.Join(cfg, "herdr-client.sock")},
		{"dev", "", "", filepath.Join(cfg, "sessions", "dev", "herdr-client.sock")},
		{"", "/x/foo.sock", "/y/c.sock", "/x/foo-client.sock"},
		{"", "", "/y/c.sock", "/y/c.sock"},
		{"dev", "/x/foo.sock", "/y/c.sock", filepath.Join(cfg, "sessions", "dev", "herdr-client.sock")},
	} {
		t.Setenv("HERDR_SOCKET_PATH", c.env)
		t.Setenv("HERDR_CLIENT_SOCKET_PATH", c.legacy)
		if got := a.herdrClientSocket(c.session); got != c.want {
			t.Errorf("%+v: got %s", c, got)
		}
	}
}
