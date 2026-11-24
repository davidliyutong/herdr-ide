//go:build unix

// Package migrate is the machine side of the migrate plugin
// (internal/plugins/migrate): the namespace a previous product name left on
// this machine (brand.LegacySlugs), which the previous version may still
// run. Its terminal core keeps running for the user to move workspaces and
// tabs into this namespace at their own pace; nothing of it is moved or
// removed unless asked.
//
// The previous namespace is laid out as versions before per-host
// directories did (docs/features/11-naming-and-renames.md): the data
// directory ~/.<slug>[-<instance>] with run/ (sockets), hc/herdr-core and
// the terminal core's session <slug>[-<instance>].
//
// Actions (agentproto.MigrateAction*):
//
//   - status: whether there is a previous namespace, its terminal core runs,
//     and one of its nodes answers (its UI is connected).
//   - scan: its layout document and live terminals, with the coding agent
//     each runs and the session the machine finds from the agent's process.
//   - release: writes its layout without what was moved (at the version
//     read, else conflict) and ends the moved terminals.
//   - stop: stops its terminal core (ending its terminals).
//   - remove: removes its data directory and the terminal core's state, once
//     neither its terminal core nor a node of it runs.
//
// Replies carry codes, never an error's text with a path.
package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"veldr/internal/agent/detect"
	"veldr/internal/agent/plugin"
	"veldr/internal/agent/sessions"
	"veldr/internal/agentkinds"
	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/hc"
)

// ID names the plugin on every side.
const ID = "migrate"

// layoutDocument is the clients' layout document's name in a terminal
// core (web/src/term/layout.ts).
const layoutDocument = "layout"

func init() { plugin.Register(ID, handle) }

func handle(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
	ns := find(env)
	switch action {
	case agentproto.MigrateActionStatus:
		return plugin.Reply(st, ns.status(ctx), nil)
	case agentproto.MigrateActionScan:
		scan, err := ns.scan(ctx)
		return plugin.Reply(st, scan, err)
	case agentproto.MigrateActionRelease:
		var req agentproto.MigrateRelease
		if err := plugin.Decode(params, &req); err != nil {
			return plugin.Reply(st, nil, err)
		}
		return plugin.Reply(st, struct{}{}, ns.release(ctx, req))
	case agentproto.MigrateActionStop:
		return plugin.Reply(st, struct{}{}, ns.stop(ctx))
	case agentproto.MigrateActionRemove:
		return plugin.Reply(st, struct{}{}, ns.remove(ctx))
	}
	return plugin.Reply(st, nil, plugin.Errorf("bad_params", "migrate: unknown action %q", action))
}

// namespace is a previous name's namespace on this machine; slug is ""
// when there is none.
type namespace struct {
	slug, base, home string
	instance         string // the instance part of the data directory ("" or "-<name>")
}

// find returns the namespace of the newest previous name that has a data
// directory beside env's.
func find(env *plugin.Env) namespace {
	name := filepath.Base(env.Base)
	suffix, _ := strings.CutPrefix(name, brand.DataDirName)
	for i, d := range brand.LegacyDataDirs(name) {
		p := filepath.Join(env.Home, d)
		if fi, err := os.Lstat(p); err == nil && fi.IsDir() {
			return namespace{slug: brand.LegacySlugs[i], base: p, home: env.Home, instance: suffix}
		}
	}
	return namespace{home: env.Home}
}

func (ns namespace) runDir() string     { return filepath.Join(ns.base, "run") }
func (ns namespace) hcSocket() string   { return filepath.Join(ns.runDir(), "hc.sock") }
func (ns namespace) nodeSocket() string { return filepath.Join(ns.runDir(), "node.sock") }
func (ns namespace) hcBin() string      { return filepath.Join(ns.base, "hc", "herdr-core") }
func (ns namespace) session() string    { return ns.slug + ns.instance }

// stateDir is herdr-core's state directory of the namespace's session.
func (ns namespace) stateDir() string {
	state := os.Getenv("XDG_STATE_HOME")
	if !filepath.IsAbs(state) {
		state = filepath.Join(ns.home, ".local", "state")
	}
	return filepath.Join(state, "herdr-core", ns.session())
}

// answers reports whether something accepts connections on the unix
// socket at p.
func answers(p string) bool {
	c, err := net.DialTimeout("unix", p, 2*time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// dial connects to the namespace's terminal core.
func (ns namespace) dial(ctx context.Context) (*hc.Conn, *hc.Hello, error) {
	c, err := net.DialTimeout("unix", ns.hcSocket(), 2*time.Second)
	if err != nil {
		return nil, nil, plugin.Errorf("not_running", "the previous terminal core does not run")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, hello, err := hc.Dial(ctx, c)
	if err != nil {
		c.Close()
		return nil, nil, plugin.Errorf("failed", "the previous terminal core does not answer")
	}
	return conn, hello, nil
}

func (ns namespace) status(ctx context.Context) agentproto.MigrateStatus {
	st := agentproto.MigrateStatus{Slug: ns.slug, Dir: ns.base}
	if ns.slug == "" {
		return st
	}
	st.Node = answers(ns.nodeSocket())
	conn, hello, err := ns.dial(ctx)
	if err != nil {
		return st
	}
	defer conn.Close()
	st.Running, st.Version = true, hello.Version
	if list, err := ns.live(ctx, conn); err == nil {
		st.Terminals = len(list)
	}
	return st
}

// live lists the namespace's live terminals, without the previous
// version's own helpers.
func (ns namespace) live(ctx context.Context, conn *hc.Conn) ([]hc.Terminal, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var list struct {
		Terminals []hc.Terminal `json:"terminals"`
	}
	if err := conn.Call(ctx, "terminal.list", map[string]any{}, &list); err != nil {
		return nil, err
	}
	var out []hc.Terminal
	for _, t := range list.Terminals {
		if t.State == "live" && !ns.hidden(t) {
			out = append(out, t)
		}
	}
	return out, nil
}

// hidden reports whether t is a helper of the previous version (its chat
// host), by name and label together as agentproto.Hidden decides for
// this version's.
func (ns namespace) hidden(t hc.Terminal) bool {
	name := ""
	if t.Name != nil {
		name = *t.Name
	}
	host := ns.slug + "-" + agentproto.HiddenChatHost
	return (name == host || strings.HasPrefix(name, host+"-")) && t.Labels[ns.slug+".hidden"] == agentproto.HiddenChatHost
}

var resolver = &sessions.Resolver{}

func (ns namespace) scan(ctx context.Context) (*agentproto.MigrateScan, error) {
	if ns.slug == "" {
		return nil, plugin.Errorf("none", "no previous namespace")
	}
	conn, hello, err := ns.dial(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	scan := &agentproto.MigrateScan{MigrateStatus: agentproto.MigrateStatus{Slug: ns.slug, Dir: ns.base, Running: true, Version: hello.Version, Node: answers(ns.nodeSocket())}}
	list, err := ns.live(ctx, conn)
	if err != nil {
		return nil, plugin.Errorf("failed", "the previous terminal core does not list its terminals")
	}
	scan.MigrateStatus.Terminals = len(list)
	for _, t := range list {
		scan.Terminals = append(scan.Terminals, describe(ctx, t))
	}
	var doc struct {
		Value   json.RawMessage `json:"value"`
		Version int64           `json:"version"`
	}
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := conn.Call(dctx, "doc.get", map[string]string{"name": layoutDocument}, &doc); err != nil {
		return nil, plugin.Errorf("failed", "the previous layout cannot be read")
	}
	scan.Layout, scan.LayoutVersion = doc.Value, doc.Version
	if len(scan.Layout) == 0 {
		scan.Layout = json.RawMessage("null")
	}
	return scan, nil
}

// describe tells what a live terminal runs: the foreground program when
// it is not the terminal's own, the coding agent it is and its session.
func describe(ctx context.Context, t hc.Terminal) agentproto.MigrateTerminal {
	mt := agentproto.MigrateTerminal{Address: t.Address, Cwd: t.Cwd, Title: t.Title}
	fg := t.Foreground
	if fg == nil {
		return mt
	}
	if fg.Cwd != "" {
		mt.Cwd = fg.Cwd
	}
	if t.PID == nil || fg.PID != *t.PID {
		mt.Program = fg.Name
	}
	kind := detect.Identify(fg.Name, fg.Argv)
	if kind == "" {
		return mt
	}
	mt.Agent = kind
	if k, ok := agentkinds.ByID(kind); ok && k.Transcript != "" {
		rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		found, ok := resolver.Resolve(rctx, kind, sessions.Proc{PID: fg.PID, Argv: fg.Argv, Cwd: fg.Cwd})
		cancel()
		if ok && found.Source != agentproto.SessionFromGuess && agentkinds.ValidSessionID(found.ID) {
			mt.Session = found.ID
		}
	}
	return mt
}

// address is the form of a terminal core's terminal address
// (web/src/term/layout.ts isAddress).
var address = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

func (ns namespace) release(ctx context.Context, req agentproto.MigrateRelease) error {
	if ns.slug == "" {
		return plugin.Errorf("none", "no previous namespace")
	}
	if len(req.Layout) == 0 || len(req.Layout) > agentproto.MaxMigrateLayout || !json.Valid(req.Layout) {
		return plugin.Errorf("bad_params", "layout: a JSON document")
	}
	for _, a := range req.Terminals {
		if !address.MatchString(a) {
			return plugin.Errorf("bad_params", "terminals: addresses")
		}
	}
	conn, _, err := ns.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	list, err := ns.live(ctx, conn)
	if err != nil {
		return plugin.Errorf("failed", "the previous terminal core does not list its terminals")
	}
	known := map[string]bool{}
	for _, t := range list {
		known[t.Address] = true
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	err = conn.Call(cctx, "doc.set", map[string]any{"name": layoutDocument, "value": req.Layout, "version": req.Version}, nil)
	var he *hc.Error
	if errors.As(err, &he) && he.Kind == "conflict" {
		return plugin.Errorf("conflict", "the previous layout changed")
	}
	if err != nil {
		return plugin.Errorf("failed", "the previous layout cannot be written")
	}
	for _, a := range req.Terminals {
		// Only the namespace's own live terminals: an address it no
		// longer has, or a helper's, is left alone.
		if known[a] {
			_ = conn.Call(cctx, "terminal.kill", map[string]string{"terminal": a}, nil)
		}
	}
	return nil
}

func (ns namespace) stop(ctx context.Context) error {
	if ns.slug == "" {
		return plugin.Errorf("none", "no previous namespace")
	}
	if !answers(ns.hcSocket()) {
		return nil
	}
	if fi, err := os.Stat(ns.hcBin()); err != nil || !fi.Mode().IsRegular() {
		return plugin.Errorf("failed", "the previous terminal core's executable is gone")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ns.hcBin(), "server", "stop", "--json")
	cmd.Env = append(cleanEnv(), "HC_SESSION="+ns.session(), "HC_SOCKET="+ns.hcSocket())
	cmd.Dir = ns.home
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Run(); err != nil {
		return plugin.Errorf("stop_failed", "the previous terminal core did not stop")
	}
	return nil
}

// cleanEnv is the agent's environment without the variables that select
// another terminal core.
func cleanEnv() []string {
	var out []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "HC_") {
			out = append(out, kv)
		}
	}
	return out
}

func (ns namespace) remove(ctx context.Context) error {
	if ns.slug == "" {
		return nil
	}
	if answers(ns.hcSocket()) {
		return plugin.Errorf("running", "the previous terminal core runs")
	}
	if answers(ns.nodeSocket()) {
		return plugin.Errorf("node", "the previous version is connected")
	}
	// The default namespace's directory also holds what the previous
	// version's other namespaces share (its builds): it stays while one of
	// them runs.
	if ns.instance == "" {
		others, _ := filepath.Glob(filepath.Join(ns.home, "."+ns.slug+"-*", "run", "*.sock"))
		for _, s := range others {
			if n := filepath.Base(s); (n == "hc.sock" || n == "node.sock") && answers(s) {
				return plugin.Errorf("in_use", "another namespace of the previous version runs")
			}
		}
	}
	if err := os.RemoveAll(ns.stateDir()); err != nil {
		return plugin.Errorf("failed", "the previous terminal core's state cannot be removed")
	}
	if err := os.RemoveAll(ns.base); err != nil {
		return plugin.Errorf("failed", "the previous data directory cannot be removed")
	}
	return nil
}
