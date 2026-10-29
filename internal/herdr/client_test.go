package herdr

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// fakeHerdr mimics herdr's socket: one request per connection, subscribe
// turns the connection into an event stream.
func fakeHerdr(t *testing.T, onSubscribe func(id string, w *bufio.Writer)) (dial func(context.Context) (net.Conn, error), conns *atomic.Int32) {
	dir := t.TempDir()
	path := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	conns = &atomic.Int32{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			conns.Add(1)
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				line, err := r.ReadBytes('\n')
				if err != nil {
					return
				}
				var req struct {
					ID     string          `json:"id"`
					Method string          `json:"method"`
					Params json.RawMessage `json:"params"`
				}
				json.Unmarshal(line, &req)
				w := bufio.NewWriter(c)
				switch req.Method {
				case "ping":
					w.WriteString(`{"id":"` + req.ID + `","result":{"type":"pong","protocol":22}}` + "\n")
				case "pane.close":
					w.WriteString(`{"id":"` + req.ID + `","error":{"code":"pane_not_found","message":"pane not found"}}` + "\n")
				case "events.subscribe":
					w.WriteString(`{"id":"` + req.ID + `","result":{"type":"subscription_started"}}` + "\n")
					w.Flush()
					onSubscribe(req.ID, w)
				}
				w.Flush()
			}()
		}
	}()
	return func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}, conns
}

func TestCallAndErrors(t *testing.T) {
	dial, conns := fakeHerdr(t, nil)
	c := &Client{Dial: dial}
	var pong struct {
		Type     string `json:"type"`
		Protocol int    `json:"protocol"`
	}
	if err := c.CallInto(context.Background(), "ping", nil, &pong); err != nil || pong.Protocol != 22 {
		t.Fatalf("ping = %+v %v", pong, err)
	}
	_, err := c.Call(context.Background(), "pane.close", map[string]string{"pane_id": "w9:p9"})
	var ae *APIError
	if !errors.As(err, &ae) || ae.Code != "pane_not_found" {
		t.Fatalf("err = %v", err)
	}
	if conns.Load() != 2 {
		t.Fatalf("expected one connection per request, got %d", conns.Load())
	}
}

func TestSubscribeEventsAndLost(t *testing.T) {
	dial, _ := fakeHerdr(t, func(id string, w *bufio.Writer) {
		w.WriteString(`{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"blocked"}}` + "\n")
		w.WriteString(`{"event":"layout_updated","data":{"type":"layout_updated"}}` + "\n")
		w.WriteString(`{"id":"` + id + `","error":{"code":"events_lost","message":"lagging"}}` + "\n")
	})
	c := &Client{Dial: dial}
	var got []string
	started := false
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := c.Subscribe(ctx, []map[string]any{{"type": "layout.updated"}}, func() { started = true }, func(ev Event) error {
		got = append(got, ev.Event)
		return nil
	})
	if !errors.Is(err, ErrEventsLost) {
		t.Fatalf("err = %v", err)
	}
	if !started || len(got) != 2 || got[0] != "pane.agent_status_changed" {
		t.Fatalf("started=%v events=%v", started, got)
	}
}
