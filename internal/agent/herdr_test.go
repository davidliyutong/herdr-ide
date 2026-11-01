package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
