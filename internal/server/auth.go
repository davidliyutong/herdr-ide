package server

import (
	"context"
	"io"
	"net/http"
	"os/exec"
	"strconv"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	"webherdr/internal/machines"
	"webherdr/internal/transport"
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
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	argv := transport.AuthCommand(s.opts.ControlDir, st.Target)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	if cols <= 0 || rows <= 0 {
		cols, rows = 100, 24
	}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		conn.Write(ctx, websocket.MessageText, []byte("failed to start ssh: "+err.Error()+"\r\n"))
		return
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
	mc.Retry()
	conn.Close(websocket.StatusNormalClosure, "done")
}
