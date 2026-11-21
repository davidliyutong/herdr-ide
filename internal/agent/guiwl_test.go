//go:build unix

package agent

import (
	"encoding/binary"
	"io"
	"log"
	"os"
	"slices"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// wlClient speaks the client's side of the wire protocol to a compositor
// under test.
type wlClient struct {
	t  *testing.T
	fd int
	in []byte
}

type wlEvent struct {
	id     uint32
	opcode uint16
	body   []byte
}

func (e wlEvent) u32(i int) uint32 { return binary.LittleEndian.Uint32(e.body[4*i:]) }

// startCompositor runs a compositor for a client on a socket pair.
func startCompositor(t *testing.T, mods []wlModifier) (*wlClient, chan error) {
	t.Helper()
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	s := newWLServer(pair[0], "/dev/dri/renderD128", mods, log.New(io.Discard, "", 0))
	go func() {
		err := s.serve()
		s.closeFDs()
		unix.Close(pair[0])
		done <- err
	}()
	c := &wlClient{t: t, fd: pair[1]}
	t.Cleanup(func() { unix.Close(c.fd) })
	return c, done
}

// send writes a request; vals are uint32 and string, fds go with it.
func (c *wlClient) send(id uint32, opcode uint16, fds []int, vals ...any) {
	c.t.Helper()
	var body []byte
	for _, v := range vals {
		switch v := v.(type) {
		case uint32:
			body = binary.LittleEndian.AppendUint32(body, v)
		case string:
			n := len(v) + 1
			body = binary.LittleEndian.AppendUint32(body, uint32(n))
			body = append(body, v...)
			body = append(body, make([]byte, (n+3)&^3-len(v))...)
		}
	}
	msg := binary.LittleEndian.AppendUint32(nil, id)
	msg = binary.LittleEndian.AppendUint32(msg, uint32(8+len(body))<<16|uint32(opcode))
	msg = append(msg, body...)
	var oob []byte
	if len(fds) > 0 {
		oob = unix.UnixRights(fds...)
	}
	if err := unix.Sendmsg(c.fd, msg, oob, nil, 0); err != nil {
		c.t.Fatal(err)
	}
}

// next returns the next event, waiting at most a second for it.
func (c *wlClient) next() (wlEvent, bool) {
	c.t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		if len(c.in) >= 8 {
			size := int(binary.LittleEndian.Uint32(c.in[4:]) >> 16)
			if len(c.in) >= size {
				e := wlEvent{id: binary.LittleEndian.Uint32(c.in), opcode: uint16(binary.LittleEndian.Uint32(c.in[4:])), body: slices.Clone(c.in[8:size])}
				c.in = c.in[size:]
				return e, true
			}
		}
		left := time.Until(deadline)
		if left <= 0 {
			return wlEvent{}, false
		}
		pfd := []unix.PollFd{{Fd: int32(c.fd), Events: unix.POLLIN}}
		if n, _ := unix.Poll(pfd, int(left/time.Millisecond)+1); n == 0 {
			continue
		}
		buf := make([]byte, 256<<10)
		n, err := unix.Read(c.fd, buf)
		if err != nil || n == 0 {
			return wlEvent{}, false
		}
		c.in = append(c.in, buf[:n]...)
	}
}

// until reads events up to one of object id with opcode, which it returns
// with those before it.
func (c *wlClient) until(id uint32, opcode uint16) (wlEvent, []wlEvent) {
	c.t.Helper()
	var before []wlEvent
	for {
		e, ok := c.next()
		if !ok {
			c.t.Fatalf("no event %d of object %d; got %+v", opcode, id, before)
		}
		if e.id == id && e.opcode == opcode {
			return e, before
		}
		before = append(before, e)
	}
}

// sync makes a round trip: everything sent before is handled after it.
func (c *wlClient) sync(id uint32) []wlEvent {
	c.t.Helper()
	c.send(1, 0, nil, id)
	_, before := c.until(id, 0)
	if e, _ := c.until(1, 1); e.u32(0) != id {
		c.t.Fatalf("delete_id %d after the callback %d", e.u32(0), id)
	}
	return before
}

// globals asks for the registry at id and returns the globals by name.
func (c *wlClient) globals(registry uint32) map[string]uint32 {
	c.t.Helper()
	c.send(1, 1, nil, registry)
	names := map[string]uint32{}
	for _, e := range c.sync(90) {
		if e.id == registry && e.opcode == 0 {
			n := int(e.u32(1))
			names[string(e.body[8:8+n-1])] = e.u32(0)
		}
	}
	return names
}

// The compositor gives Xwayland what it needs to start with a GPU: the
// globals, the device, the buffer layouts; a toplevel is configured at its
// first commit; a committed buffer is released at once, its descriptor
// closed, and the frame callback answered a frame later; ids are given back.
func TestCompositor(t *testing.T) {
	mods := []wlModifier{{wlFormats[0], 0}, {wlFormats[0], 0x0300000000606014}}
	c, done := startCompositor(t, mods)
	names := c.globals(2)
	for _, want := range []string{"wl_compositor", "wl_shm", "wl_output", "xdg_wm_base", "wl_drm", "zwp_linux_dmabuf_v1"} {
		if names[want] == 0 {
			t.Fatalf("no global %s in %v", want, names)
		}
	}
	c.send(2, 0, nil, names["wl_compositor"], "wl_compositor", uint32(4), uint32(3))
	c.send(2, 0, nil, names["xdg_wm_base"], "xdg_wm_base", uint32(1), uint32(4))
	c.send(2, 0, nil, names["wl_drm"], "wl_drm", uint32(2), uint32(5))
	c.send(2, 0, nil, names["zwp_linux_dmabuf_v1"], "zwp_linux_dmabuf_v1", uint32(3), uint32(6))
	c.send(2, 0, nil, names["wl_output"], "wl_output", uint32(2), uint32(7))
	var device string
	var layouts []uint64
	outputDone := false
	for _, e := range c.sync(91) {
		switch {
		case e.id == 5 && e.opcode == 0:
			device = string(e.body[4 : 4+e.u32(0)-1])
		case e.id == 6 && e.opcode == 1:
			layouts = append(layouts, uint64(e.u32(1))<<32|uint64(e.u32(2)))
		case e.id == 7 && e.opcode == 2:
			outputDone = true
		}
	}
	if device != "/dev/dri/renderD128" || !slices.Equal(layouts, []uint64{0, 0x0300000000606014}) || !outputDone {
		t.Fatalf("device %q, layouts %x, output described: %v", device, layouts, outputDone)
	}

	// A toplevel: surface 10, xdg_surface 11, xdg_toplevel 12.
	c.send(3, 0, nil, uint32(10))
	c.send(4, 2, nil, uint32(11), uint32(10))
	c.send(11, 1, nil, uint32(12))
	c.send(10, 6, nil)
	if _, before := c.until(11, 0); len(before) != 1 || before[0].id != 12 || before[0].opcode != 0 {
		t.Fatalf("before the surface's configure: %+v", before)
	}

	// A buffer of the GPU (its descriptor is a pipe's end here), attached
	// with a frame callback and committed.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	c.send(5, 3, []int{int(w.Fd())}, uint32(20), uint32(64), uint32(64), wlFormats[0], uint32(0), uint32(256), uint32(0), uint32(0), uint32(0), uint32(0))
	w.Close()
	c.send(10, 1, nil, uint32(20), uint32(0), uint32(0))
	c.send(10, 3, nil, uint32(21))
	start := time.Now()
	c.send(10, 6, nil)
	if _, before := c.until(20, 0); len(before) != 0 {
		t.Fatalf("before the buffer's release: %+v", before)
	}
	c.until(21, 0)
	if e, _ := c.until(1, 1); e.u32(0) != 21 {
		t.Fatalf("delete_id %d, not the callback's", e.u32(0))
	}
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Errorf("frame callback after %v", d)
	}
	// The compositor closed the buffer's descriptor: the pipe has no writer.
	r.SetReadDeadline(time.Now().Add(time.Second))
	if n, err := r.Read(make([]byte, 1)); n != 0 || err != io.EOF {
		t.Errorf("the buffer's descriptor is still open: %d, %v", n, err)
	}
	// Destroying gives the id back, so it can name the next buffer.
	c.send(20, 0, nil)
	if e, _ := c.until(1, 1); e.u32(0) != 20 {
		t.Fatalf("delete_id %d, not the buffer's", e.u32(0))
	}
	c.send(5, 1, nil, uint32(20), uint32(1), uint32(64), uint32(64), uint32(256), wlFormats[0])
	c.sync(92)

	unix.Close(c.fd)
	c.fd = -1
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serve ended with %v after its client left", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("the compositor outlives its client")
	}
}

// A client that breaks the protocol is left: a request for an object that
// does not exist, an id that is taken, a message of no length.
func TestCompositorProtocolErrors(t *testing.T) {
	for name, bad := range map[string]func(c *wlClient){
		"unknown object": func(c *wlClient) { c.send(77, 0, nil) },
		"id taken":       func(c *wlClient) { c.send(1, 1, nil, uint32(2)); c.send(1, 1, nil, uint32(2)) },
		"server id":      func(c *wlClient) { c.send(1, 1, nil, uint32(wlServerIDs+1)) },
		"short message": func(c *wlClient) {
			unix.Write(c.fd, []byte{1, 0, 0, 0, 0, 0, 4, 0})
		},
		"descriptor missing": func(c *wlClient) {
			names := c.globals(2)
			c.send(2, 0, nil, names["wl_shm"], "wl_shm", uint32(1), uint32(3))
			c.send(3, 0, nil, uint32(4), uint32(4096))
		},
		"bad string length": func(c *wlClient) {
			names := c.globals(2)
			c.send(2, 0, nil, names["wl_shm"], uint32(0xffffffff), uint32(1), uint32(3))
		},
	} {
		t.Run(name, func(t *testing.T) {
			c, done := startCompositor(t, nil)
			c.t = t
			bad(c)
			select {
			case err := <-done:
				if err == nil {
					t.Error("serve ended without an error")
				}
			case <-time.After(2 * time.Second):
				t.Error("the compositor goes on")
			}
		})
	}
}

// The layouts offered on NVIDIA GPUs include those its driver names on a
// Blackwell GPU (as a compositor that asks the driver lists them), linear,
// and every format Xwayland makes buffers of.
func TestNvidiaModifiers(t *testing.T) {
	mods := nvidiaModifiers()
	for _, f := range wlFormats {
		for _, want := range []uint64{0, 0x0300000000606010, 0x0300000000606015, 0x0300000000e08010, 0x0300000000e08015} {
			if !slices.Contains(mods, wlModifier{f, want}) {
				t.Errorf("format %#x lacks layout %#x", f, want)
			}
		}
	}
	// One event each: a registry bind must stay well below what a socket
	// buffers.
	if len(mods)*20 > 128<<10 {
		t.Errorf("%d layouts", len(mods))
	}
}
