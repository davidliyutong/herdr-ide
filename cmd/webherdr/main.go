// Command webherdr is the terminal-first, multi-machine, agent-native web IDE
// for herdr. It serves the web UI and orchestrates agents on every machine.
//
//	webherdr [serve] [flags]       run the server (default)
//	webherdr fetch-assets DIR      download code-server and extensions for
//	                               air-gapped installs (use with --seed-dir)
//	webherdr version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"webherdr/internal/agentproto"
	"webherdr/internal/brand"
	"webherdr/internal/codeserver"
	"webherdr/internal/embedded"
	"webherdr/internal/machines"
	"webherdr/internal/server"
	"webherdr/internal/transport"
	"webherdr/web"
)

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

// codeServerFlags are shared by serve and fetch-assets.
type codeServerFlags struct {
	version, tarballURL, extensionURL string
	seedDirs                          listFlag
	offline                           bool
}

func (f *codeServerFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&f.version, "code-server-version", codeserver.DefaultVersion, "code-server release to install on machines")
	fs.StringVar(&f.tarballURL, "code-server-url", codeserver.DefaultTarballURL, "code-server download URL template ({version}, {asset}, {file}); point at a mirror")
	fs.StringVar(&f.extensionURL, "extension-url", codeserver.DefaultExtensionURL, "VS Code extension (VSIX) download URL template ({publisher}, {name}, {version}, {file})")
	fs.Var(&f.seedDirs, "seed-dir", "directory with pre-downloaded code-server tarballs and VSIXs, searched before downloading (repeatable; see fetch-assets)")
	fs.BoolVar(&f.offline, "offline", false, "never download; artifacts must come from --seed-dir or the cache")
}

func (f *codeServerFlags) manager(logger *log.Logger) *codeserver.Manager {
	cs := codeserver.New(logger)
	cs.Version = f.version
	cs.TarballURL = f.tarballURL
	cs.ExtensionURL = f.extensionURL
	cs.SeedDirs = f.seedDirs
	cs.Offline = f.offline
	cs.BridgeVSIX = embedded.BridgeVSIX
	return cs
}

func main() {
	args := os.Args[1:]
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	logger := log.New(os.Stderr, brand.CoreBin+": ", log.LstdFlags)
	switch cmd {
	case "version":
		fmt.Println(brand.CoreBin, agentproto.Version)
	case "serve":
		serve(args, logger)
	case "fetch-assets":
		fetchAssets(args, logger)
	default:
		fmt.Fprintf(os.Stderr, "usage: %s [serve] [flags] | fetch-assets [flags] DIR | version\n", brand.CoreBin)
		os.Exit(2)
	}
}

func fetchAssets(args []string, logger *log.Logger) {
	fl := flag.NewFlagSet("fetch-assets", flag.ExitOnError)
	var csf codeServerFlags
	csf.register(fl)
	platforms := fl.String("platforms", strings.Join(codeserver.AllAssets, ","), "code-server assets to fetch")
	fl.Usage = func() {
		fmt.Fprintf(fl.Output(), "usage: %s fetch-assets [flags] DIR\n\nDownloads and verifies everything machines need, for carrying into an\nair-gapped network. Then run: %s --offline --seed-dir DIR\n\n", brand.CoreBin, brand.CoreBin)
		fl.PrintDefaults()
	}
	fl.Parse(args)
	if fl.NArg() != 1 {
		fl.Usage()
		os.Exit(2)
	}
	cs := csf.manager(logger)
	files, err := cs.FetchAssets(context.Background(), fl.Arg(0), strings.Split(*platforms, ","))
	for _, f := range files {
		fmt.Println(filepath.Join(fl.Arg(0), f))
	}
	if err != nil {
		logger.Fatal(err)
	}
}

func serve(args []string, logger *log.Logger) {
	fl := flag.NewFlagSet("serve", flag.ExitOnError)
	var (
		listen       = fl.String("listen", "127.0.0.1:7780", "address to listen on")
		insecure     = fl.Bool("insecure-listen", false, "allow a non-loopback --listen without --proxy-secret-file (anyone reaching the port gets shell access)")
		proxySecret  = fl.String("proxy-secret-file", "", "file with a secret the reverse proxy sends in the "+server.ProxySecretHeader+" header; required for requests that do not come from loopback")
		readOnly     = fl.Bool("read-only", false, "watch only: no input, no mutating herdr calls, no uploads, no VS Code")
		auditLog     = fl.String("audit-log", "", "append security-relevant events as JSON lines to this file")
		userHeader   = fl.String("user-header", "", "request header carrying the authenticated user, for the audit log (e.g. Tailscale-User-Login)")
		instance     = fl.String("instance", "", "state instance: machines use ~/"+brand.DataDirName+"-<instance> (lets a development core run next to the daily one)")
		localSession = fl.String("local-session", "default", "herdr session name on the local machine")
		localOnly    = fl.Bool("local-only", false, "do not connect to herdr's saved SSH machines")
		csIdle       = fl.Duration("code-server-idle", 20*time.Minute, "stop a machine's code-server after this long without VS Code connections (0 disables)")
		agentDir     = fl.String("agent-dir", "", "directory with uncompressed "+brand.AgentBin+"-<os>-<arch> builds (development)")
		extDir       = fl.String("ext-dir", "", "directory containing "+brand.BridgeExt+".vsix (development)")
		webDir       = fl.String("web-dir", "", "serve the UI from this directory instead of the embedded build (development)")
		only         listFlag
		origins      listFlag
		extraSSH     listFlag
		csf          codeServerFlags
	)
	fl.Var(&origins, "allowed-origin", "browser origin of the reverse proxy, e.g. https://ide.example.com (repeatable)")
	fl.Var(&only, "machine", "connect only these machines, by id, label or ssh target (repeatable)")
	fl.Var(&extraSSH, "ssh", "extra ssh target (~/.ssh/config alias or user@host) not saved in herdr (repeatable)")
	csf.register(fl)
	fl.Parse(args)

	if !brand.ValidInstance(*instance) {
		logger.Fatalf("--instance must be lowercase letters, digits and dashes")
	}
	embedded.AgentDir = *agentDir
	embedded.ExtDir = *extDir

	secret := ""
	if *proxySecret != "" {
		b, err := os.ReadFile(*proxySecret)
		if err != nil {
			logger.Fatal(err)
		}
		secret = strings.TrimSpace(string(b))
		if len(secret) < 16 {
			logger.Fatalf("%s: secret must be at least 16 characters", *proxySecret)
		}
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		logger.Fatal(err)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		switch {
		case secret != "":
		case *insecure:
			logger.Printf("WARNING: listening on %s without authentication (--insecure-listen); anyone reaching it gets shell access to every machine", *listen)
		default:
			logger.Fatalf("refusing to listen on %s: the server has no authentication of its own. Keep it on loopback behind an authenticating reverse proxy, or pass --proxy-secret-file (or --insecure-listen to accept the risk)", *listen)
		}
	}

	specs := selectSpecs(machines.LoadSpecs(*localSession, extraSpecs(extraSSH)), *localOnly, extraSSH, only)
	controlDir, err := transport.ControlDir()
	if err != nil {
		logger.Fatal(err)
	}
	dial := func(ctx context.Context, spec machines.Spec) (*transport.Session, string, error) {
		switch spec.Kind {
		case machines.KindLocal:
			s, err := transport.DialLocal(ctx, *instance, logger)
			return s, runtime.GOOS + "/" + runtime.GOARCH, err
		case machines.KindSSH:
			s, p, err := transport.DialSSH(ctx, transport.SSHOptions{
				Target: spec.Target, ControlDir: controlDir, Agents: embedded.Agent, Logger: logger, Instance: *instance,
			})
			platform := ""
			if p != nil {
				platform = p.OS + "/" + p.Arch
			}
			return s, platform, err
		}
		return nil, "", errors.New("unknown machine kind " + spec.Kind)
	}
	mg := machines.NewManager(specs, dial, logger)

	var static fs.FS = web.Dist()
	if *webDir != "" {
		static = os.DirFS(*webDir)
	}
	var audit io.Writer
	if *auditLog != "" {
		f, err := os.OpenFile(*auditLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			logger.Fatal(err)
		}
		defer f.Close()
		audit = f
	}
	cs := csf.manager(logger)
	cs.RemoveLegacyCaches()
	srv := server.New(mg, server.Options{
		AllowedOrigins: origins,
		Static:         static,
		Logger:         logger,
		ControlDir:     controlDir,
		CodeServer:     cs,
		CodeServerIdle: *csIdle,
		ReadOnly:       *readOnly,
		ProxySecret:    secret,
		Audit:          audit,
		UserHeader:     *userHeader,
	})

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	go mg.Run(ctx)
	go srv.Run(ctx)

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		logger.Fatal(err)
	}
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 15 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		hs.Shutdown(sctx)
	}()
	mode := ""
	if *readOnly {
		mode = " (read-only)"
	}
	logger.Printf("%s %s listening on http://%s (%d machines)%s", brand.Name, agentproto.Version, ln.Addr(), len(specs), mode)
	if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatal(err)
	}
}

func extraSpecs(targets []string) []machines.Spec {
	var out []machines.Spec
	for _, t := range targets {
		out = append(out, machines.Spec{ID: t, Label: t, Kind: machines.KindSSH, Target: t, Enabled: true})
	}
	return out
}

// selectSpecs applies --local-only and --machine; each machine appears once.
func selectSpecs(specs []machines.Spec, localOnly bool, extraSSH, only []string) []machines.Spec {
	in := func(list []string, s machines.Spec) bool {
		for _, v := range list {
			if v == s.ID || v == s.Label || v == s.Target {
				return true
			}
		}
		return false
	}
	var out []machines.Spec
	for i, s := range specs {
		if localOnly && i > 0 && !in(extraSSH, s) {
			continue
		}
		if len(only) > 0 && !in(only, s) {
			continue
		}
		out = append(out, s)
	}
	return out
}
