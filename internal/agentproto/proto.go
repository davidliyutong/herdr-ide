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
)

// Version is the agent protocol/build version. Overridden at link time.
var Version = "dev"

type Op string

const (
	// OpHello returns Info about the agent host.
	OpHello Op = "hello"
	// OpHerdrAPI dials the herdr public API socket and pipes raw bytes.
	OpHerdrAPI Op = "herdr-api"
	// OpHerdrClient dials herdr's client socket (the endpoint protocol used
	// by client-rendered shells) and pipes raw bytes.
	OpHerdrClient Op = "herdr-client"
	// OpExec runs a command and returns buffered output in the reply.
	OpExec Op = "exec"
	// OpFsStat, OpFsList return metadata in the reply.
	OpFsStat Op = "fs.stat"
	OpFsList Op = "fs.list"
	// OpFsRead streams Length bytes starting at Offset after the reply.
	OpFsRead Op = "fs.read"
	// OpFsWrite reads raw bytes until the opener closes its write side, then
	// writes them atomically to Path and sends a second reply line.
	OpFsWrite Op = "fs.write"
	// OpFsArchive streams Paths as one zip archive after the reply and then
	// closes the stream; nothing is written on the machine.
	OpFsArchive Op = "fs.archive"
	// OpDialUnix dials a unix socket below the agent run directory.
	OpDialUnix Op = "dial-unix"
	// OpCodeServer manages the code-server installation and process.
	OpCodeServer Op = "code-server"
	// OpBridge is opened by the agent towards the core for every VS Code
	// bridge extension connection.
	OpBridge Op = "bridge"
	// OpGUI manages the virtual display (actions status, install, start,
	// shells) and, with action attach, streams its windows (see gui.go).
	OpGUI Op = "gui"
	// OpHerdr manages the herdr in use and the server of Header.Session
	// (actions status, start, stop, restart, check, update). An empty reply
	// comes at once; a second reply line with Herdr follows when the action
	// is done.
	OpHerdr Op = "herdr"
)

// Header is the first line of every stream.
type Header struct {
	Op Op `json:"op"`

	// herdr selection
	Session  string `json:"session,omitempty"`
	HerdrBin string `json:"herdr_bin,omitempty"`

	// exec
	Argv    []string `json:"argv,omitempty"`
	Cwd     string   `json:"cwd,omitempty"`
	Timeout int      `json:"timeout_ms,omitempty"`

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

	// code-server
	Action  string   `json:"action,omitempty"`
	Version string   `json:"version,omitempty"`
	Args    []string `json:"args,omitempty"`
	// Bin selects a code-server already installed on the machine instead of
	// the release in the agent's directory: an absolute or "~/" path, or
	// "auto" to search PATH and the usual install locations.
	Bin string `json:"bin,omitempty"`
	// URL (action download) is fetched by the machine itself; Digest is the
	// expected SHA-256, "" when unknown (the reply then reports it).
	URL    string `json:"url,omitempty"`
	Digest string `json:"digest,omitempty"`
}

// Reply is the first line written back by the acceptor.
type Reply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`

	Info    *Info        `json:"info,omitempty"`
	Stat    *Stat        `json:"stat,omitempty"`
	Entries []Stat       `json:"entries,omitempty"`
	Exec    *ExecResult  `json:"exec,omitempty"`
	CS      *CSStatus    `json:"cs,omitempty"`
	Bridge  *BridgeInfo  `json:"bridge,omitempty"`
	GUI     *GUIStatus   `json:"gui,omitempty"`
	Herdr   *HerdrStatus `json:"herdr,omitempty"`
}

// ErrHerdrNotFound: the agent found no herdr executable on its host (not
// installed, or removed or moved since).
var ErrHerdrNotFound = errors.New("herdr binary not found (set HERDR_BIN or install herdr)")

// Info describes the agent host.
type Info struct {
	Version  string `json:"version"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Hostname string `json:"hostname"`
	Home     string `json:"home"`
	User     string `json:"user"`
	// HerdrBin is the herdr executable in use, with its version. Without
	// one, HerdrError tells why; HerdrSocket is set either way.
	HerdrBin     string `json:"herdr_bin,omitempty"`
	HerdrVersion string `json:"herdr_version,omitempty"`
	HerdrSocket  string `json:"herdr_socket,omitempty"`
	HerdrError   string `json:"herdr_error,omitempty"`
	DataDir      string `json:"data_dir"`
	RunDir       string `json:"run_dir"`
	UploadDir    string `json:"upload_dir"`
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

// HerdrStatus describes the herdr an agent uses and its session's server.
type HerdrStatus struct {
	Bin     string `json:"bin,omitempty"`
	Version string `json:"version,omitempty"`
	// Managed: Bin is the copy the application keeps and may update, not an
	// installation of the user's.
	Managed bool `json:"managed"`
	// Running is reported without Bin too: a server can outlive the removal
	// of its herdr.
	Running       bool   `json:"running"`
	ServerVersion string `json:"server_version,omitempty"`
	// RestartNeeded: the running server is from another herdr build.
	RestartNeeded bool `json:"restart_needed,omitempty"`
	// Latest is herdr's newest release (action check).
	Latest string `json:"latest,omitempty"`
	// Error is a code: not_found, start_failed, stop_failed, check_failed,
	// update_failed, not_managed. Output is herdr's own text for it, or the
	// output of an update.
	Error  string `json:"error,omitempty"`
	Output string `json:"output,omitempty"`
}

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
