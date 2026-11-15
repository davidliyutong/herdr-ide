package server

import (
	"context"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/transport"
)

// handleAuth runs an interactive ssh login for a machine in a PTY on the core
// host and bridges it to a WebSocket. The ControlMaster it creates is reused
// by the BatchMode agent connection afterwards; without a control directory
// (Windows, whose ssh shares no connections and which has no PTY here) a
// login would hold nothing, and it is refused.
func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	st := mc.State()
	if st.Kind != machines.KindSSH {
		http.Error(w, "not an ssh machine", http.StatusBadRequest)
		return
	}
	// A stored target ValidTarget refuses never reaches ssh.
	if !machines.ValidTarget(st.Target) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": machines.CodeInvalidTarget})
		return
	}
	if s.opts.ControlDir == "" {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "ssh_login_unsupported"})
		return
	}
	s.audit.log(r, "ssh.auth", map[string]any{"machine": mc.ID(), "target": st.Target})
	servePTY(w, r, transport.AuthCommand(s.opts.ControlDir, st.Target))
	mc.Wake()
}

// servePTY runs argv in a PTY on the core host, sized as the browser asked,
// and bridges it to a WebSocket until the command ends or the browser
// leaves, which ends the command; the socket closes with the reason "done".
func servePTY(w http.ResponseWriter, r *http.Request, argv []string) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	// ctx is the command's. Reading has its own: a cancelled read closes the
	// socket at once, without the close frame that carries the reason.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	readCtx, stopRead := context.WithCancel(r.Context())
	defer stopRead()

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	if cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000 {
		cols, rows = 100, 24
	}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		conn.Write(ctx, websocket.MessageText, []byte("failed to start "+filepath.Base(argv[0])+": "+err.Error()+"\r\n"))
		return
	}
	defer f.Close()
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		buf := make([]byte, 32<<10)
		for {
			n, err := f.Read(buf)
			if n > 0 {
				if conn.Write(ctx, websocket.MessageBinary, buf[:n]) != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		cancel()
	}()
	go func() {
		for {
			_, data, err := conn.Read(readCtx)
			if err != nil {
				cancel()
				return
			}
			if _, err := f.Write(data); err != nil && err != io.EOF {
				cancel()
				return
			}
		}
	}()
	cmd.Wait()
	// The command's last output can still be in the PTY: forward it before
	// closing, without waiting long for descendants that keep the PTY open.
	select {
	case <-drained:
	case <-time.After(ptyDrainTimeout):
	}
	conn.Close(websocket.StatusNormalClosure, "done")
}

// ptyDrainTimeout bounds how long servePTY forwards output after the command
// exited. Its session's terminal is normally hung up then, which ends the
// forwarding at once; the bound covers platforms where it is not.
const ptyDrainTimeout = 2 * time.Second
