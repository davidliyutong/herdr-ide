package server

import (
	"context"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/transport"
)

// handleAuth runs an interactive ssh login for a machine in a PTY on the core
// host and bridges it to a WebSocket. The ControlMaster it creates is reused
// by the BatchMode agent connection afterwards.
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
	s.audit.log(r, "ssh.auth", map[string]any{"machine": mc.ID(), "target": st.Target})
	servePTY(w, r, transport.AuthCommand(s.opts.ControlDir, st.Target), nil)
	mc.Retry()
}

// servePTY runs argv (with env, nil for the core's own) in a PTY on the core
// host, sized as the browser asked, and bridges it to a WebSocket until the
// command ends or the browser leaves, which ends the command. It reports
// whether the command ran.
func servePTY(w http.ResponseWriter, r *http.Request, argv []string, env []string) bool {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return false
	}
	defer conn.CloseNow()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	if cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000 {
		cols, rows = 100, 24
	}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		conn.Write(ctx, websocket.MessageText, []byte("failed to start "+filepath.Base(argv[0])+": "+err.Error()+"\r\n"))
		return false
	}
	defer f.Close()
	go func() {
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
			_, data, err := conn.Read(ctx)
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
	conn.Close(websocket.StatusNormalClosure, "done")
	return true
}
