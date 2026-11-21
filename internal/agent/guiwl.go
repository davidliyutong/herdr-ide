//go:build unix

package agent

import (
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"time"

	"golang.org/x/sys/unix"
)

// The GPU display is Xwayland, an X server that draws with the GPU (glamor)
// and gives its clients DRI3, which Vulkan and OpenGL drivers present
// through. Xwayland shows its screen in a window of a Wayland compositor;
// here nobody looks at that window, because the agent captures the windows
// of programs from the X side (guiwm.go). So the compositor is this one,
// which shows nothing: the machine's binary run as "gui-wl", with one client,
// the Xwayland on the other end of a socket pair. It tells Xwayland which
// GPU to use (wl_drm, which Xwayland before 24.1 cannot do without) and
// which buffer layouts clients may share with it (linux-dmabuf), releases
// every buffer as soon as it is committed, and answers frame callbacks at
// guiFrameRate. It opens no file and listens nowhere; it ends when its
// client does.

const (
	// guiFrameRate paces Xwayland's own screen updates and the frames of
	// programs that wait for the display (vertical sync).
	guiFrameRate = 60
	// Bounds on what the one client may make the compositor hold.
	wlMaxObjects = 4096
	wlMaxFDs     = 64
	wlMaxMessage = 4096 // a Wayland message is at most this long
	// wlServerIDs is where the ids of objects the server creates begin.
	wlServerIDs = 0xff000000
)

// DRM formats (fourcc) of the buffers Xwayland makes for the depths 24, 32
// and 30, and the same with red and blue swapped.
var wlFormats = []uint32{
	0x34325258, // XR24
	0x34325241, // AR24
	0x34324258, // XB24
	0x34324241, // AB24
	0x30335241, // AR30
	0x30334241, // AB30
}

type wlModifier struct {
	format uint32
	mod    uint64
}

// nvidiaModifiers are the buffer layouts offered on an NVIDIA GPU. Its
// driver shares buffers only with a layout both sides name (a program
// whose driver finds none it has copies every frame through the CPU), and
// which ones a GPU has is known to its driver alone. A layout is a number
// made of five fields (DRM_FORMAT_MOD_NVIDIA_BLOCK_LINEAR_2D in
// drm_fourcc.h), so every one the fields can name is offered, and linear:
// Xwayland and the programs take those their driver has.
func nvidiaModifiers() []wlModifier {
	var out []wlModifier
	for _, f := range wlFormats {
		out = append(out, wlModifier{f, 0}) // DRM_FORMAT_MOD_LINEAR
		for _, kind := range []uint64{0xfe, 0x06, 0x08} {
			for gen := uint64(0); gen < 3; gen++ {
				for sector := uint64(0); sector < 2; sector++ {
					for compression := uint64(0); compression < 5; compression++ {
						for height := uint64(0); height < 6; height++ {
							out = append(out, wlModifier{f, 0x03<<56 | 0x10 | height | kind<<12 | gen<<20 | sector<<22 | compression<<23})
						}
					}
				}
			}
		}
	}
	return out
}

type wlObject struct {
	iface   string
	version uint32
	// wl_surface: the buffer and the frame callbacks of the next commit,
	// whether it is a toplevel's, and whether that was configured.
	buffer     uint32
	attached   bool
	frames     []uint32
	toplevel   bool
	configured bool
	// xdg_surface: its wl_surface; xdg_toplevel: its xdg_surface.
	parent uint32
}

type wlGlobal struct {
	iface   string
	version uint32
}

type wlServer struct {
	fd      int
	device  string
	mods    []wlModifier
	logger  *log.Logger
	globals []wlGlobal

	in      []byte
	fds     []int
	out     []byte
	objects map[uint32]*wlObject
	nextID  uint32
	serial  uint32
	// due are the frame callbacks answered at the next tick.
	due []uint32
}

func newWLServer(fd int, device string, mods []wlModifier, logger *log.Logger) *wlServer {
	s := &wlServer{fd: fd, device: device, mods: mods, logger: logger, nextID: wlServerIDs,
		objects: map[uint32]*wlObject{1: {iface: "wl_display", version: 1}}}
	s.globals = []wlGlobal{
		{"wl_compositor", 4},
		{"wl_shm", 1},
		{"wl_output", 2},
		{"xdg_wm_base", 1},
		{"wl_drm", 2},
	}
	if len(mods) > 0 {
		s.globals = append(s.globals, wlGlobal{"zwp_linux_dmabuf_v1", 3})
	}
	return s
}

// Compositor is the "gui-wl" command: the compositor of a GPU display for
// the client on fd (one end of a socket pair), which is told to use the
// GPU of the render node device. It returns when the client is gone.
func Compositor(fd int, device string, nvidia bool, logger *log.Logger) error {
	var mods []wlModifier
	if nvidia {
		mods = nvidiaModifiers()
	}
	s := newWLServer(fd, device, mods, logger)
	defer s.closeFDs()
	return s.serve()
}

var errWLProtocol = errors.New("gui-wl: the client broke the protocol")

// wlArgs reads the arguments of a request.
type wlArgs struct {
	b   []byte
	bad bool
}

func (a *wlArgs) u32() uint32 {
	if len(a.b) < 4 {
		a.bad = true
		return 0
	}
	v := binary.LittleEndian.Uint32(a.b)
	a.b = a.b[4:]
	return v
}

func (a *wlArgs) str() string {
	n := uint64(a.u32())
	padded := (n + 3) &^ 3
	if n == 0 || padded > uint64(len(a.b)) {
		a.bad = a.bad || n != 0
		return ""
	}
	v := string(a.b[:n-1])
	a.b = a.b[padded:]
	return v
}

// event queues an event of object id; the values are uint32, int32, string
// and []byte (an array).
func (s *wlServer) event(id uint32, opcode uint16, vals ...any) {
	var body []byte
	for _, v := range vals {
		switch v := v.(type) {
		case uint32:
			body = binary.LittleEndian.AppendUint32(body, v)
		case int32:
			body = binary.LittleEndian.AppendUint32(body, uint32(v))
		case string:
			n := len(v) + 1
			body = binary.LittleEndian.AppendUint32(body, uint32(n))
			body = append(body, v...)
			body = append(body, make([]byte, (n+3)&^3-len(v))...)
		case []byte:
			body = binary.LittleEndian.AppendUint32(body, uint32(len(v)))
			body = append(body, v...)
			body = append(body, make([]byte, (len(v)+3)&^3-len(v))...)
		default:
			panic(fmt.Sprintf("gui-wl: event value %T", v))
		}
	}
	s.out = binary.LittleEndian.AppendUint32(s.out, id)
	s.out = binary.LittleEndian.AppendUint32(s.out, uint32(8+len(body))<<16|uint32(opcode))
	s.out = append(s.out, body...)
}

func (s *wlServer) flush() error {
	for len(s.out) > 0 {
		n, err := unix.Write(s.fd, s.out)
		if err == unix.EINTR {
			continue
		}
		if err == unix.EAGAIN {
			// The client reads slower than it is answered: wait for room.
			pfd := []unix.PollFd{{Fd: int32(s.fd), Events: unix.POLLOUT}}
			if _, err := unix.Poll(pfd, -1); err != nil && err != unix.EINTR {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		s.out = s.out[n:]
	}
	return nil
}

func (s *wlServer) closeFDs() {
	for _, fd := range s.fds {
		unix.Close(fd)
	}
	s.fds = nil
}

// dropFD closes the next file descriptor the client sent: a request that
// carries one (a buffer's memory) is answered without looking at it.
func (s *wlServer) dropFD() bool {
	if len(s.fds) == 0 {
		return false
	}
	unix.Close(s.fds[0])
	s.fds = s.fds[1:]
	return true
}

func (s *wlServer) add(id uint32, iface string, version uint32) *wlObject {
	if id == 0 || id >= wlServerIDs || s.objects[id] != nil || len(s.objects) >= wlMaxObjects {
		return nil
	}
	o := &wlObject{iface: iface, version: version}
	s.objects[id] = o
	return o
}

// destroy forgets an object; the client may use the id of one of its own
// again once it is told so.
func (s *wlServer) destroy(id uint32) {
	delete(s.objects, id)
	if id < wlServerIDs {
		s.event(1, 1, id) // wl_display.delete_id
	}
}

// request handles one request; false when the client broke the protocol.
func (s *wlServer) request(id uint32, opcode uint16, a *wlArgs) bool {
	o := s.objects[id]
	if o == nil {
		return false
	}
	ok := true
	create := func(iface string, version uint32) *wlObject {
		n := s.add(a.u32(), iface, version)
		if n == nil {
			ok = false
			return &wlObject{}
		}
		return n
	}
	switch o.iface {
	case "wl_display":
		switch opcode {
		case 0: // sync
			cb := a.u32()
			s.serial++
			s.event(cb, 0, s.serial)
			s.event(1, 1, cb)
		case 1: // get_registry
			reg := a.u32()
			if s.add(reg, "wl_registry", 1) == nil {
				return false
			}
			for i, g := range s.globals {
				s.event(reg, 0, uint32(i+1), g.iface, g.version)
			}
		}
	case "wl_registry":
		if opcode != 0 { // bind
			break
		}
		name, iface, version, nid := a.u32(), a.str(), a.u32(), a.u32()
		if name == 0 || int(name) > len(s.globals) || s.globals[name-1].iface != iface ||
			version == 0 || version > s.globals[name-1].version || s.add(nid, iface, version) == nil {
			return false
		}
		switch iface {
		case "wl_shm":
			s.event(nid, 0, uint32(0)) // ARGB8888
			s.event(nid, 0, uint32(1)) // XRGB8888
		case "wl_output":
			w, h := guiScreenSize()
			s.event(nid, 0, int32(0), int32(0), int32(w*254/960), int32(h*254/960), int32(0), "virtual", "display", int32(0))
			s.event(nid, 1, uint32(3), int32(w), int32(h), int32(guiFrameRate*1000))
			s.event(nid, 3, int32(1)) // scale
			s.event(nid, 2)           // done
		case "wl_drm":
			s.event(nid, 0, s.device)
			s.event(nid, 1, wlFormats[0])
			s.event(nid, 1, wlFormats[1])
			s.event(nid, 3, uint32(1)) // capabilities: PRIME
		case "zwp_linux_dmabuf_v1":
			for _, m := range s.mods {
				s.event(nid, 1, m.format, uint32(m.mod>>32), uint32(m.mod))
			}
		}
	case "wl_compositor":
		switch opcode {
		case 0:
			create("wl_surface", o.version)
		case 1:
			create("wl_region", 1)
		}
	case "wl_surface":
		switch opcode {
		case 0:
			s.destroy(id)
		case 1: // attach
			o.buffer, o.attached = a.u32(), true
		case 3: // frame
			cb := a.u32()
			if s.add(cb, "wl_callback", 1) == nil {
				return false
			}
			o.frames = append(o.frames, cb)
		case 6: // commit
			s.commit(id, o)
		}
	case "xdg_wm_base":
		switch opcode {
		case 0:
			s.destroy(id)
		case 1:
			create("xdg_positioner", 1)
		case 2:
			create("xdg_surface", 1).parent = a.u32()
		}
	case "xdg_surface":
		switch opcode {
		case 0:
			s.destroy(id)
		case 1:
			create("xdg_toplevel", 1).parent = id
			if surf := s.objects[o.parent]; surf != nil && surf.iface == "wl_surface" {
				surf.toplevel = true
			}
		case 2:
			create("xdg_popup", 1)
		}
	case "wl_shm":
		if opcode == 0 { // create_pool
			create("wl_shm_pool", 1)
			ok = ok && s.dropFD()
		}
	case "wl_shm_pool":
		switch opcode {
		case 0:
			create("wl_buffer", 1)
		case 1:
			s.destroy(id)
		}
	case "wl_drm":
		switch opcode {
		case 0: // authenticate: a render node needs none
			s.event(id, 2)
		case 1, 2:
			create("wl_buffer", 1)
		case 3: // create_prime_buffer
			create("wl_buffer", 1)
			ok = ok && s.dropFD()
		}
	case "zwp_linux_dmabuf_v1":
		switch opcode {
		case 0:
			s.destroy(id)
		case 1:
			create("zwp_linux_buffer_params_v1", 1)
		}
	case "zwp_linux_buffer_params_v1":
		switch opcode {
		case 0:
			s.destroy(id)
		case 1: // add
			ok = s.dropFD()
		case 2: // create: the buffer is an object of the server's
			if len(s.objects) >= wlMaxObjects || s.nextID == ^uint32(0) {
				return false
			}
			s.nextID++
			s.objects[s.nextID] = &wlObject{iface: "wl_buffer", version: 1}
			s.event(id, 0, s.nextID)
		case 3: // create_immed
			create("wl_buffer", 1)
		}
	case "wl_region", "wl_buffer", "xdg_positioner", "xdg_toplevel", "xdg_popup", "wl_output":
		// Their first request destroys them (wl_output's from version 3,
		// which is not offered); what the others say changes nothing here.
		if opcode == 0 {
			s.destroy(id)
		}
	}
	return ok && !a.bad
}

// commit applies a surface's pending state: a toplevel is configured at its
// first commit, the buffer is released (nothing shows it) and the frame
// callbacks are answered at the next tick.
func (s *wlServer) commit(id uint32, o *wlObject) {
	if o.toplevel && !o.configured {
		o.configured = true
		for xid, x := range s.objects {
			if x.iface != "xdg_surface" || x.parent != id {
				continue
			}
			for tid, t := range s.objects {
				if t.iface == "xdg_toplevel" && t.parent == xid {
					// No size: the client keeps the one it asked for.
					s.event(tid, 0, int32(0), int32(0), []byte{})
				}
			}
			s.serial++
			s.event(xid, 0, s.serial)
		}
	}
	if o.attached {
		o.attached = false
		if b := s.objects[o.buffer]; b != nil && b.iface == "wl_buffer" {
			s.event(o.buffer, 0) // release
		}
	}
	s.due = append(s.due, o.frames...)
	o.frames = nil
}

func (s *wlServer) parse() error {
	for len(s.in) >= 8 {
		id := binary.LittleEndian.Uint32(s.in)
		word := binary.LittleEndian.Uint32(s.in[4:])
		size := int(word >> 16)
		if size < 8 || size > wlMaxMessage || size%4 != 0 {
			return errWLProtocol
		}
		if len(s.in) < size {
			return nil
		}
		if !s.request(id, uint16(word), &wlArgs{b: s.in[8:size]}) {
			return fmt.Errorf("%w (object %d, request %d)", errWLProtocol, id, uint16(word))
		}
		s.in = s.in[size:]
	}
	return nil
}

// tick answers the frame callbacks that are due.
func (s *wlServer) tick(start time.Time) {
	ms := uint32(time.Since(start) / time.Millisecond)
	for _, cb := range s.due {
		if o := s.objects[cb]; o != nil && o.iface == "wl_callback" {
			s.event(cb, 0, ms)
			s.destroy(cb)
		}
	}
	s.due = s.due[:0]
}

func (s *wlServer) serve() error {
	buf := make([]byte, 64<<10)
	oob := make([]byte, unix.CmsgSpace(4*28)) // libwayland sends at most 28 descriptors at once
	period := time.Second / guiFrameRate
	start := time.Now()
	// Ticks are a period apart while callbacks are due, and none happen
	// otherwise: an idle display costs nothing.
	var last, next time.Time
	for {
		timeout := -1
		if len(s.due) > 0 {
			if next.IsZero() {
				next = last.Add(period)
			}
			timeout = max(int((time.Until(next)+time.Millisecond-1)/time.Millisecond), 0)
		}
		pfd := []unix.PollFd{{Fd: int32(s.fd), Events: unix.POLLIN}}
		if _, err := unix.Poll(pfd, timeout); err != nil && err != unix.EINTR {
			return err
		}
		if pfd[0].Revents&(unix.POLLIN|unix.POLLHUP|unix.POLLERR) != 0 {
			n, oobn, _, _, err := unix.Recvmsg(s.fd, buf, oob, unix.MSG_DONTWAIT)
			switch {
			case err == unix.EAGAIN || err == unix.EINTR:
			case err != nil:
				return err
			case n == 0 && oobn == 0:
				return nil // the client is gone
			default:
				if oobn > 0 {
					msgs, _ := unix.ParseSocketControlMessage(oob[:oobn])
					for _, m := range msgs {
						fds, _ := unix.ParseUnixRights(&m)
						s.fds = append(s.fds, fds...)
					}
					if len(s.fds) > wlMaxFDs {
						return errWLProtocol
					}
				}
				s.in = append(s.in, buf[:n]...)
				if err := s.parse(); err != nil {
					return err
				}
			}
		}
		if now := time.Now(); len(s.due) > 0 && !next.IsZero() && !now.Before(next) {
			s.tick(start)
			last, next = now, time.Time{}
		}
		if err := s.flush(); err != nil {
			return err
		}
	}
}
