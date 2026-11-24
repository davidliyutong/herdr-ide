// Package agentproto defines the stream protocol spoken between the herdr-ide
// core and a herdr-ide-agent over a yamux session.
//
// Every yamux stream starts with one JSON header line written by the opener,
// answered by one JSON reply line. After a successful reply the stream carries
// op-specific raw bytes (a socket pipe, file contents, ...).
package agentproto

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
)

// Version is the agent protocol/build version. Overridden at link time.
var Version = "dev"

// parseVersion reads a build's version as the build names it (git describe: the
// tag, "v" and three numbers, then the commits after it, "-<n>-g<hash>",
// and "-dirty", which scripts/build.sh follows with the build's time so
// that two builds of local changes are told apart); ok false for any other
// (a development build, "dev"). What follows "-dirty" does not order
// builds: builds of local changes at one commit are of the same age, and
// the page reminds the user to restart a host of another build
// (internal/plugins/chat).
func parseVersion(v string) (n [4]int, ok bool) {
	v = strings.TrimPrefix(v, "v")
	if base, _, dirty := strings.Cut(v, "-dirty"); dirty {
		v = base
	}
	base, after, more := strings.Cut(v, "-")
	parts := strings.Split(base, ".")
	if len(parts) != 3 {
		return n, false
	}
	for i, p := range parts {
		x, err := strconv.Atoi(p)
		if err != nil || x < 0 {
			return n, false
		}
		n[i] = x
	}
	if more {
		commits, hash, ok := strings.Cut(after, "-g")
		x, err := strconv.Atoi(commits)
		if !ok || err != nil || x < 0 || hash == "" {
			return n, false
		}
		n[3] = x
	}
	return n, true
}

// OlderVersion tells whether build version a is older than b: both are
// known (parseVersion) and a comes before b.
func OlderVersion(a, b string) bool {
	x, ok1 := parseVersion(a)
	y, ok2 := parseVersion(b)
	return ok1 && ok2 && slices.Compare(x[:], y[:]) < 0
}

type Op string

const (
	// OpHello returns Info about the agent host.
	OpHello Op = "hello"
	// OpFsStat, OpFsList return metadata in the reply.
	OpFsStat Op = "fs.stat"
	OpFsList Op = "fs.list"
	// OpFsRead streams Length bytes starting at Offset after the reply.
	OpFsRead Op = "fs.read"
	// OpFsWrite reads raw bytes until the opener closes its write side, then
	// writes them atomically to Path and sends a second reply line.
	OpFsWrite Op = "fs.write"
	// OpFsArchive streams Paths as one zip archive after the reply and then
	// closes the stream; nothing is written on the machine. With
	// Header.Chunked the archive comes as ChunkWriter chunks.
	OpFsArchive Op = "fs.archive"
	// OpDialUnix dials a unix socket below the agent run directory.
	OpDialUnix Op = "dial-unix"
	// OpCodeServer manages the code-server installation and process.
	OpCodeServer Op = "code-server"
	// OpBridge is opened by the agent towards the core for every VS Code
	// bridge extension connection.
	OpBridge Op = "bridge"
	// OpGUI manages the virtual display (actions status, install, start,
	// keep, shells) and, with action attach, streams its windows (see
	// gui.go).
	OpGUI Op = "gui"
	// OpHC manages the agent's own herdr-core: the executable the core
	// uploads and the terminal core of the agent's instance (actions status,
	// install, start, restart, stop). An install carries the gzip-compressed
	// executable as ChunkWriter chunks after a first reply, checked against
	// Header.Digest; every action ends with a reply with HC.
	OpHC Op = "hc"
	// OpHCAPI dials the terminal core's socket and pipes raw bytes
	// (internal/hc). It starts nothing.
	OpHCAPI Op = "hc-api"
	// OpDetect tells which coding agents run in the terminal core's
	// terminals and what they do (internal/agent/detect): after the reply,
	// DetectEvent lines from the agent until either side closes the stream.
	// It starts nothing and writes nothing.
	OpDetect Op = "detect"
	// OpPrivacy reports in Privacy what macOS's Full Disk Access lets the
	// agent's own process and the terminal core's do. It starts no terminal
	// core and reads no file.
	OpPrivacy Op = "privacy"
	// OpPlugin runs Action of the agent's side of Plugin with Params (JSON)
	// and replies with its result in Reply.Plugin; an action that streams
	// writes JSON lines after the reply until either side closes the stream
	// (internal/agent/plugin). Params and results larger than MaxInline
	// follow their line as a body (Header.ParamsLength,
	// Reply.PluginLength).
	OpPlugin Op = "plugin"
	// OpVault is opened by the agent towards the core for every connection
	// of an MCP server (the mcp command) to <run>/vault.sock: after the
	// core's reply, one VaultRequest line and one VaultResponse line
	// (vault.go).
	OpVault Op = "vault"
	// OpNodeDrain is opened by a node towards each core it serves once
	// another node took over its socket: the core connects again, which
	// reaches the new node, moves to that session and closes this one.
	OpNodeDrain Op = "node.drain"
)

// DetectEvent is one line of an OpDetect stream: the agent a terminal runs
// ("" when none does any more) and its status (working, blocked, idle,
// done, unknown; "" without an agent).
type DetectEvent struct {
	Terminal string `json:"terminal"`
	Agent    string `json:"agent"`
	Status   string `json:"status"`
	// Session is the id of the session the agent uses (a lower-case UUID,
	// agentkinds.ValidSessionID), "" when it is not known; only a stream
	// opened with Header.Sessions resolves it. SessionSource tells how it
	// was found (SessionFrom*).
	Session       string `json:"session,omitempty"`
	SessionSource string `json:"session_source,omitempty"`
}

// How a DetectEvent's session was found (DetectEvent.SessionSource).
const (
	// SessionFromArgv: the agent's command line names it (--session-id,
	// --resume).
	SessionFromArgv = "argv"
	// SessionFromPID: the agent's own record of its process names it.
	SessionFromPID = "pid"
	// SessionFromFD: the agent's process holds the session's transcript
	// open.
	SessionFromFD = "fd"
	// SessionFromStart: the only session an agent of the kind made in the
	// agent's directory since its process started (Codex), while no other
	// terminal runs that kind there.
	SessionFromStart = "start"
	// SessionFromHook: the agent's hook reported it.
	SessionFromHook = "hook"
	// SessionFromGuess: the newest session of the agent's directory since
	// the process started; a guess, which the UIs do not keep in the layout.
	SessionFromGuess = "guess"
)

// NodeHello is the line a client writes first on a node's socket, before
// anything else; the node answers a Reply with its Node. With NodeServe the
// connection then carries the client's yamux session; with NodeStop the
// node ends; with NodeTakeover the node gives its socket to the node that
// asks and drains (its sessions are told with OpNodeDrain).
type NodeHello struct {
	Op string `json:"op"`
	// Node is the build of the client's executable (`node dial`, the
	// core's for its own machine, or the node taking over).
	Node *NodeInfo `json:"node,omitempty"`
	// SSHConnection is SSH_CONNECTION of the ssh session that dialed the
	// node (`node dial`), which hello reports (Reply.SSH).
	SSHConnection string `json:"ssh_connection,omitempty"`
	// Client names the core (its process): the same for its sessions
	// after reconnects, another for another core.
	Client string `json:"client,omitempty"`
}

// NodeHello's operations.
const (
	NodeServe    = "serve"
	NodeStop     = "stop"
	NodeTakeover = "takeover"
)

// NodeInfo is a node's build, or the build of a client of one.
type NodeInfo struct {
	// Build is a digest of the executable, Version its version (Version),
	// ExeTime when the executable was written (Unix nanoseconds), Pid the
	// process.
	Build   string `json:"build"`
	Version string `json:"version"`
	ExeTime int64  `json:"exe_time"`
	Pid     int    `json:"pid,omitempty"`
}

// Newer reports whether build n is newer than o: by version when both are
// known (OlderVersion), else by when their executables were written.
func (n NodeInfo) Newer(o NodeInfo) bool {
	if n.Build == o.Build {
		return false
	}
	if _, ok := parseVersion(n.Version); ok {
		if _, ok := parseVersion(o.Version); ok && n.Version != o.Version {
			return OlderVersion(o.Version, n.Version)
		}
	}
	return n.ExeTime > o.ExeTime
}

// Header is the first line of every stream.
type Header struct {
	Op Op `json:"op"`

	// fs
	Path   string `json:"path,omitempty"`
	Offset int64  `json:"offset,omitempty"`
	Length int64  `json:"length,omitempty"`
	Mkdirs bool   `json:"mkdirs,omitempty"`
	// Unique (fs.write) keeps existing files: the file gets path's name if it
	// is free, else the first free one with -1, -2… before the extension.
	Unique bool `json:"unique,omitempty"`
	// Paths (fs.archive) are the files and directories to archive.
	Paths []string `json:"paths,omitempty"`
	// Chunked (fs.archive) frames the archive with ChunkWriter, ended by
	// its empty chunk once the archive is complete: a stream that ends
	// without it (the machine went away) carries a truncated archive.
	Chunked bool `json:"chunked,omitempty"`

	// code-server
	Action  string   `json:"action,omitempty"`
	Version string   `json:"version,omitempty"`
	Args    []string `json:"args,omitempty"`
	// Bin selects a code-server already installed on the machine instead of
	// the release in the agent's directory: an absolute or "~/" path, or
	// "auto" to search PATH and the usual install locations.
	Bin string `json:"bin,omitempty"`
	// URL (action download) is fetched by the machine itself; Digest is the
	// expected SHA-256, "" when unknown (the reply then reports it). With
	// OpHC, Digest is the SHA-256 of the executable to install, and of the
	// one a start or restart may run.
	URL    string `json:"url,omitempty"`
	Digest string `json:"digest,omitempty"`

	// Plugin (OpPlugin) names the plugin whose Action runs, with Params,
	// the action's own JSON.
	Plugin string          `json:"plugin,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	// ParamsLength (OpPlugin): the params are not in Params but follow
	// the header line, that many bytes of JSON (at most MaxBody); the
	// core sends params larger than MaxInline so.
	ParamsLength int64 `json:"params_length,omitempty"`

	// Process (OpVault) is the process connected to vault.sock (peer
	// credentials) and its parents, as the agent saw them.
	Process []VaultProcess `json:"process,omitempty"`

	// Sessions (OpDetect): the agent also resolves the session each
	// terminal's agent uses (DetectEvent.Session); without it the stream
	// reads no session file.
	Sessions bool `json:"sessions,omitempty"`
}

// Reply is the first line written back by the acceptor.
type Reply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	// Code classifies Error for ops that define codes (hc, plugins; fs.stat:
	// not_found, denied).
	Code string `json:"code,omitempty"`

	Info *Info `json:"info,omitempty"`
	// Node (NodeHello) is the node's build.
	Node *NodeInfo `json:"node,omitempty"`
	// SSH (OpHello) is the SSH_CONNECTION of the session the agent was
	// started in ("" when it was not started over ssh). It is apart from
	// Info, which every client of the core sees.
	SSH     string      `json:"ssh,omitempty"`
	Stat    *Stat       `json:"stat,omitempty"`
	Entries []Stat      `json:"entries,omitempty"`
	Exec    *ExecResult `json:"exec,omitempty"`
	CS      *CSStatus   `json:"cs,omitempty"`
	Bridge  *BridgeInfo `json:"bridge,omitempty"`
	GUI     *GUIStatus  `json:"gui,omitempty"`
	HC      *HCStatus   `json:"hc,omitempty"`

	Privacy *PrivacyStatus `json:"privacy,omitempty"`
	// Plugin is an OpPlugin action's result, the plugin's own JSON.
	Plugin json.RawMessage `json:"plugin,omitempty"`
	// PluginLength (OpPlugin): the result is not in Plugin but follows the
	// reply line, that many bytes of JSON (at most MaxBody); the agent
	// sends results larger than MaxInline so.
	PluginLength int64 `json:"plugin_length,omitempty"`

	// EntriesLength (fs.list): the entries are not in Entries but follow
	// the reply line, that many bytes of JSON (at most MaxBody); the agent
	// sends listings larger than MaxInline so: the names of a directory of
	// some ten thousand entries are more than a line's MaxHeaderLine.
	// Session.Open reads them into Entries.
	EntriesLength int64 `json:"entries_length,omitempty"`
}

// Full Disk Access as an OpPrivacy reply reports it.
const (
	AccessGranted = "granted"
	AccessDenied  = "denied"
	// AccessUnknown: not macOS, no terminal core running, no folder to
	// try, or another error.
	AccessUnknown = "unknown"
)

// PrivacyStatus is whether macOS's Full Disk Access lets a machine's
// processes open a folder only it opens: Files for the agent's own process
// (for the local machine the core's, which serves the file browser and
// starts code-server), Terminals for the terminal core's (whose executable
// is HC: the programs of its terminals have what it was granted).
type PrivacyStatus struct {
	Files     string `json:"files"`
	Terminals string `json:"terminals"`
	HC        string `json:"hc"`
}

// Info describes the agent host.
type Info struct {
	Version   string `json:"version"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Hostname  string `json:"hostname"`
	Home      string `json:"home"`
	User      string `json:"user"`
	DataDir   string `json:"data_dir"`
	RunDir    string `json:"run_dir"`
	UploadDir string `json:"upload_dir"`
}

type Stat struct {
	Name    string `json:"name"`
	Path    string `json:"path,omitempty"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	ModTime int64  `json:"mtime"` // unix milliseconds
	IsDir   bool   `json:"is_dir"`
	IsLink  bool   `json:"is_link,omitempty"`
}

// ExecResult is the output of a command the agent ran for an op
// (code-server's install-ext and uninstall-ext).
type ExecResult struct {
	ExitCode  int    `json:"exit_code"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated,omitempty"`
}

type CSStatus struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
	Running   bool   `json:"running"`
	Socket    string `json:"socket,omitempty"`
	Error     string `json:"error,omitempty"`
	// Bin is the code-server executable in use.
	Bin string `json:"bin,omitempty"`
	// Digest is the SHA-256 of a release the machine downloaded.
	Digest string `json:"digest,omitempty"`
}

// HCStatus describes the agent's herdr-core.
type HCStatus struct {
	// Digest is the SHA-256 of the installed executable, "" without one.
	Digest string `json:"digest,omitempty"`
	// Running: a core answers on Socket; Version is that core's.
	Running bool   `json:"running"`
	Version string `json:"version,omitempty"`
	// Session is the core's session name and Socket its API socket.
	Session string `json:"session"`
	Socket  string `json:"socket"`
}

// Codes of failed OpHC actions (Reply.Code).
const (
	HCNotInstalled = "not_installed"
	HCBadDigest    = "bad_digest"
	HCStartFailed  = "start_failed"
	HCStopFailed   = "stop_failed"
)

type BridgeInfo struct {
	ConnID string `json:"conn_id"`
}

// WriteLine writes v as one JSON line.
func WriteLine(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

// MaxHeaderLine bounds header and reply lines.
const MaxHeaderLine = 1 << 20

// MaxInline is the largest JSON an OpPlugin header or reply carries in its
// line (Header.Params, Reply.Plugin); larger JSON follows the line as a
// body of at most MaxBody bytes, which is not read byte by byte as lines
// are.
const (
	MaxInline = 32 << 10
	MaxBody   = 64 << 20
)

// ReadBody reads the n bytes of JSON that follow a line (Header.ParamsLength,
// Reply.PluginLength).
func ReadBody(r io.Reader, n int64) (json.RawMessage, error) {
	if n < 0 || n > MaxBody {
		return nil, fmt.Errorf("agentproto: body of %d bytes", n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, fmt.Errorf("agentproto: body: %w", err)
	}
	return b, nil
}

// ReadLine reads one JSON line byte by byte so that no bytes following the
// line are consumed from r.
func ReadLine(r io.Reader, v any) error {
	buf := make([]byte, 0, 256)
	one := make([]byte, 1)
	for {
		n, err := r.Read(one)
		if n == 1 {
			if one[0] == '\n' {
				break
			}
			buf = append(buf, one[0])
			if len(buf) > MaxHeaderLine {
				return errors.New("agentproto: line too long")
			}
			continue
		}
		if err != nil {
			if err == io.EOF && len(buf) > 0 {
				break
			}
			return err
		}
	}
	if err := json.Unmarshal(buf, v); err != nil {
		return fmt.Errorf("agentproto: bad line %q: %w", truncate(buf, 120), err)
	}
	return nil
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n]) + "..."
	}
	return string(b)
}

// Fail writes a failed reply.
func Fail(w io.Writer, err error) error {
	return WriteLine(w, Reply{OK: false, Error: err.Error()})
}

// ChunkWriter frames a byte stream as [u32 big-endian length][data] chunks
// terminated by a zero-length chunk. yamux streams cannot be half-closed, so
// uploads use this framing to signal the end of data and still read a reply.
type ChunkWriter struct{ W io.Writer }

func (c ChunkWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := len(p)
		if n > 1<<20 {
			n = 1 << 20
		}
		var hdr [4]byte
		hdr[0], hdr[1], hdr[2], hdr[3] = byte(n>>24), byte(n>>16), byte(n>>8), byte(n)
		if _, err := c.W.Write(hdr[:]); err != nil {
			return written, err
		}
		if _, err := c.W.Write(p[:n]); err != nil {
			return written, err
		}
		written += n
		p = p[n:]
	}
	return written, nil
}

// Finish writes the terminating zero-length chunk.
func (c ChunkWriter) Finish() error {
	_, err := c.W.Write([]byte{0, 0, 0, 0})
	return err
}

// ChunkReader reads a ChunkWriter stream and returns io.EOF at its end.
type ChunkReader struct {
	R    io.Reader
	left int
	done bool
}

func (c *ChunkReader) Read(p []byte) (int, error) {
	if c.done {
		return 0, io.EOF
	}
	if c.left == 0 {
		var hdr [4]byte
		if _, err := io.ReadFull(c.R, hdr[:]); err != nil {
			return 0, io.ErrUnexpectedEOF
		}
		c.left = int(hdr[0])<<24 | int(hdr[1])<<16 | int(hdr[2])<<8 | int(hdr[3])
		if c.left == 0 {
			c.done = true
			return 0, io.EOF
		}
	}
	if len(p) > c.left {
		p = p[:c.left]
	}
	n, err := c.R.Read(p)
	c.left -= n
	if err == io.EOF {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}
