package transport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"webherdr/internal/brand"
)

// ErrAuthRequired means ssh could not authenticate without user interaction.
var ErrAuthRequired = errors.New("ssh authentication required")

// AgentSource returns the agent binary for a platform and its version tag.
type AgentSource func(goos, goarch string) (bin []byte, version string, err error)

// SSHOptions configures DialSSH.
type SSHOptions struct {
	Target     string
	ControlDir string
	Agents     AgentSource
	Logger     *log.Logger
	// Instance selects the agent's state directory (brand.DataDir).
	Instance string
}

// Platform is the remote OS/arch reported by uname.
type Platform struct {
	OS, Arch, Home string
}

// ControlDir returns the private directory holding our ssh control sockets.
// It lives in /tmp because unix socket paths are limited to ~104 bytes; as
// /tmp is shared, both levels must be real directories owned by us and not
// accessible to anyone else, otherwise another local user could plant
// control sockets and hijack every ssh connection.
func ControlDir() (string, error) {
	parent := filepath.Join("/tmp", fmt.Sprintf("%s-%d", brand.Slug, os.Getuid()))
	dir := filepath.Join(parent, "s")
	for _, d := range []string{parent, dir} {
		if err := os.Mkdir(d, 0o700); err != nil && !os.IsExist(err) {
			return "", err
		}
		if err := checkPrivateDir(d); err != nil {
			return "", err
		}
	}
	return dir, nil
}

func checkPrivateDir(d string) error {
	st, err := os.Lstat(d)
	if err != nil {
		return err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !st.IsDir() || !ok || int(sys.Uid) != os.Getuid() {
		return fmt.Errorf("%s is not a directory owned by uid %d; refusing to use it for ssh control sockets", d, os.Getuid())
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s is accessible by other users (mode %v); run: chmod 700 %s", d, st.Mode().Perm(), d)
	}
	return nil
}

// SSHArgs returns the options shared by every ssh invocation for a target.
// The ControlMaster lets an interactive authentication (see AuthCommand) be
// reused by the BatchMode connections that follow.
func SSHArgs(controlDir string, batch bool) []string {
	args := []string{
		"-o", "ControlMaster=auto",
		"-o", "ControlPath=" + filepath.Join(controlDir, "%C"),
		"-o", "ControlPersist=600",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=4",
		"-o", "ConnectTimeout=10",
	}
	if batch {
		args = append(args, "-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0")
	} else {
		args = append(args, "-o", "BatchMode=no")
	}
	return args
}

// AuthCommand is run in an interactive terminal to authenticate a target.
func AuthCommand(controlDir, target string) []string {
	args := append([]string{"ssh"}, SSHArgs(controlDir, false)...)
	return append(args, "-t", target, "echo "+brand.Name+": authenticated; sleep 1")
}

func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// remoteSh wraps a POSIX script so it runs under /bin/sh whatever the login
// shell is.
func remoteSh(script string) string {
	return "exec /bin/sh -c " + shQuote(script)
}

func classifySSHError(stderr string, err error) error {
	s := strings.ToLower(stderr)
	for _, m := range []string{
		"permission denied", "host key verification failed", "authenticity of host",
		"remote host identification has changed", "too many authentication failures",
		"keyboard-interactive", "password:", "passphrase",
	} {
		if strings.Contains(s, m) {
			return fmt.Errorf("%w: %s", ErrAuthRequired, strings.TrimSpace(lastLines(stderr, 3)))
		}
	}
	msg := strings.TrimSpace(lastLines(stderr, 3))
	if msg == "" && err != nil {
		msg = err.Error()
	}
	return errors.New(msg)
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func (o SSHOptions) run(ctx context.Context, stdin io.Reader, script string) (string, error) {
	args := append(append([]string{"-T"}, SSHArgs(o.ControlDir, true)...), o.Target, remoteSh(script))
	cmd := exec.CommandContext(ctx, "ssh", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdin = stdin
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 255 {
			return "", classifySSHError(stderr.String(), err)
		}
		return stdout.String(), fmt.Errorf("remote command failed: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func normArch(m string) string {
	switch strings.TrimSpace(m) {
	case "x86_64", "amd64":
		return "amd64"
	case "aarch64", "arm64", "armv8l":
		return "arm64"
	}
	return strings.TrimSpace(m)
}

const agentDir = brand.AgentDir

// DialSSH probes the remote platform, uploads the matching agent if missing
// and starts it over ssh stdio.
func DialSSH(ctx context.Context, o SSHOptions) (*Session, *Platform, error) {
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	out, err := o.run(probeCtx, nil, `uname -s; uname -m; echo "$HOME"`)
	cancel()
	if err != nil {
		return nil, nil, err
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 3 {
		return nil, nil, fmt.Errorf("unexpected probe output %q", out)
	}
	p := &Platform{OS: strings.ToLower(strings.TrimSpace(lines[len(lines)-3])), Arch: normArch(lines[len(lines)-2]), Home: strings.TrimSpace(lines[len(lines)-1])}
	bin, version, err := o.Agents(p.OS, p.Arch)
	if err != nil {
		return nil, p, fmt.Errorf("no agent for %s/%s: %w", p.OS, p.Arch, err)
	}
	remotePath := "$HOME/" + agentDir + "/" + version + "/" + brand.AgentBin

	checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	out, err = o.run(checkCtx, nil, `if [ -x "`+remotePath+`" ]; then echo present; else echo absent; fi`)
	cancel()
	if err != nil {
		return nil, p, err
	}
	if strings.TrimSpace(out) != "present" {
		o.Logger.Printf("ssh %s: uploading agent %s (%s/%s, %d bytes)", o.Target, version, p.OS, p.Arch, len(bin))
		dir := "$HOME/" + agentDir + "/" + version
		script := `umask 077; mkdir -p "` + dir + `" && cat > "` + dir + `/.upload.$$" && chmod 700 "` + dir + `/.upload.$$" && mv -f "` + dir + `/.upload.$$" "` + remotePath + `"` +
			// Builds used by other cores are kept until unused for 14 days
			// (running agents touch their directory).
			`; find "$HOME/` + agentDir + `" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null; true`
		upCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		_, err = o.run(upCtx, bytes.NewReader(bin), script)
		cancel()
		if err != nil {
			return nil, p, fmt.Errorf("upload agent: %w", err)
		}
	}

	args := append(append([]string{"-T"}, SSHArgs(o.ControlDir, true)...), o.Target, remoteSh(`exec "`+remotePath+`" serve --instance '`+o.Instance+`'`))
	cmd := exec.Command("ssh", args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, p, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, p, err
	}
	stderr := &lineLogger{logger: o.Logger, prefix: "ssh " + o.Target + ": "}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, p, err
	}
	conn := &stdioConn{r: stdout, w: stdin}
	var waitOnce sync.Once
	var waitErr error
	wait := func() error {
		waitOnce.Do(func() { waitErr = cmd.Wait() })
		return waitErr
	}
	closer := closerFunc(func() error {
		stdin.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Signal(os.Interrupt)
			time.AfterFunc(3*time.Second, func() { _ = cmd.Process.Kill() })
		}
		go wait()
		return nil
	})
	s, err := newSession(conn, closer, o.Logger)
	if err != nil {
		closer.Close()
		return nil, p, err
	}
	go func() {
		err := wait()
		s.finish(classifySSHError(stderr.tail(), err))
	}()
	return s, p, nil
}

type stdioConn struct {
	r io.ReadCloser
	w io.WriteCloser
}

func (c *stdioConn) Read(p []byte) (int, error)  { return c.r.Read(p) }
func (c *stdioConn) Write(p []byte) (int, error) { return c.w.Write(p) }
func (c *stdioConn) Close() error {
	c.w.Close()
	return c.r.Close()
}

// lineLogger forwards ssh/agent stderr to the log and keeps a short tail.
type lineLogger struct {
	logger *log.Logger
	prefix string
	mu     sync.Mutex
	buf    []byte
	last   []string
}

func (l *lineLogger) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.buf = append(l.buf, p...)
	for {
		i := bytes.IndexByte(l.buf, '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(string(l.buf[:i]), "\r")
		l.buf = l.buf[i+1:]
		if line == "" {
			continue
		}
		l.logger.Print(l.prefix + line)
		l.last = append(l.last, line)
		if len(l.last) > 20 {
			l.last = l.last[len(l.last)-20:]
		}
	}
	return len(p), nil
}

func (l *lineLogger) tail() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(append(l.last, string(l.buf)), "\n")
}
