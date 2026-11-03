package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/composite"
	"github.com/jezek/xgb/damage"
	"github.com/jezek/xgb/res"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// windowManager manages the top-level windows of the virtual display and
// streams them, one by one, to the core. Windows keep the size their program
// asks for and all sit at the origin; the window receiving input is raised
// first. Contents come from Composite's automatic redirection (each window
// has its own pixmap, so overlapping does not matter), changes from Damage,
// input goes through XTEST. Override-redirect windows (menus, tooltips) are
// layers of the window that had focus when they appeared.
type windowManager struct {
	x      *xgb.Conn
	root   xproto.Window
	check  xproto.Window
	out    io.ReadWriter
	logger *log.Logger
	resOK  bool
	atoms  map[string]xproto.Atom

	writeMu sync.Mutex

	mu      sync.Mutex
	wins    map[xproto.Window]*managedWin
	layers  map[xproto.Window]*layerWin
	focused xproto.Window
	top     xproto.Window
	cursor  uint32
	keys    map[byte]bool
	buttons map[byte]bool

	closeOnce sync.Once
	done      chan struct{}

	// tools returns the video encoder and the stream kinds it makes
	// (guivideo.go); nil or empty: pictures only.
	tools func() (string, []string)
	// retired encoders are closed by the pump after its current frames.
	retired []*videoEncoder
}

type rect struct{ x, y, w, h int }

func (r rect) empty() bool { return r.w <= 0 || r.h <= 0 }

func (r rect) union(o rect) rect {
	if r.empty() {
		return o
	}
	if o.empty() {
		return r
	}
	x0, y0 := min(r.x, o.x), min(r.y, o.y)
	x1, y1 := max(r.x+r.w, o.x+o.w), max(r.y+r.h, o.y+o.h)
	return rect{x0, y0, x1 - x0, y1 - y0}
}

// clip limits r to a w×h drawable.
func (r rect) clip(w, h int) rect {
	x0, y0 := max(r.x, 0), max(r.y, 0)
	x1, y1 := min(r.x+r.w, w), min(r.y+r.h, h)
	return rect{x0, y0, x1 - x0, y1 - y0}
}

// xwin is a window whose contents are captured.
type xwin struct {
	id         xproto.Window
	x, y, w, h int
	damage     damage.Damage
	dirty      rect // changed, not sent yet
	lossy      rect // sent as JPEG since the last lossless update
	changed    time.Time
}

func (w *xwin) all() rect { return rect{0, 0, w.w, w.h} }

type managedWin struct {
	xwin
	title, pane, socket string
	pid                 int
	transient           xproto.Window
	deleteWin           bool
	takeFocus           bool
	watched             bool
	seq, acked          uint32
	layers              []xproto.Window
	// inflight holds when each unacknowledged frame was captured.
	inflight []sentFrame
	stats    agentproto.GUIStats
	since    time.Time // start of the stats interval

	// Video: the stream kinds all viewers decode, the encoder while the
	// window is sent as video (set by the pump), which recent ticks changed
	// much of the window, and when to try again after the encoder failed.
	codecs    []string
	vid       *videoEncoder
	motion    uint16
	lastVideo time.Time
	keyWanted bool
	vidRetry  time.Time
	vidFails  int
	fallback  string
}

type sentFrame struct {
	seq uint32
	at  time.Time
}

type layerWin struct {
	xwin
	owner xproto.Window
}

const (
	// guiInflight bounds frames sent but not yet shown per window, which
	// adapts the frame rate to the connection.
	guiInflight = 3
	// guiTick is the shortest interval between frames (60 per second).
	guiTick = 16 * time.Millisecond
	// guiSettle is how long a window must stay unchanged before areas sent
	// as JPEG are sent again losslessly.
	guiSettle = 400 * time.Millisecond
	// guiPNGArea: smaller updates are sent as PNG.
	guiPNGArea = 128 * 128
	// guiTile bounds one captured rectangle, so that even a huge window
	// costs bounded memory per frame.
	guiTile = 1024
	// guiStatsEvery is how often a watched window's costs are reported.
	guiStatsEvery = time.Second
	// A window is sent as video once videoMotionTicks of the last 12 ticks
	// changed at least 1/videoMotionShare of it, until it was unchanged for
	// videoIdle. Smaller windows stay pictures.
	videoMotionTicks = 8
	videoMotionShare = 4
	videoIdle        = 5 * time.Second
	videoMinSide     = 64
	// After the encoder failed, pictures for videoRetry, doubling up to
	// videoRetryMax.
	videoRetry    = 5 * time.Second
	videoRetryMax = 5 * time.Minute
)

var wmAtoms = []string{
	"WM_PROTOCOLS", "WM_DELETE_WINDOW", "WM_TAKE_FOCUS", "WM_STATE", "UTF8_STRING",
	"_NET_WM_NAME", "_NET_WM_PID", "_NET_SUPPORTED", "_NET_SUPPORTING_WM_CHECK",
	"_NET_ACTIVE_WINDOW", "_NET_FRAME_EXTENTS", "_NET_CLIENT_LIST", "_NET_WM_STATE",
}

// newWindowManager makes x the display's window manager.
func newWindowManager(x *xgb.Conn, out io.ReadWriter, logger *log.Logger) (*windowManager, error) {
	fail := func(err error) (*windowManager, error) {
		x.Close()
		return nil, err
	}
	for name, ext := range map[string]func(*xgb.Conn) error{"Composite": composite.Init, "DAMAGE": damage.Init, "XFIXES": xfixes.Init, "XTEST": xtest.Init} {
		if err := ext(x); err != nil {
			return fail(fmt.Errorf("the display lacks the %s extension: %w", name, err))
		}
	}
	if _, err := composite.QueryVersion(x, 0, 4).Reply(); err != nil {
		return fail(err)
	}
	if _, err := damage.QueryVersion(x, 1, 1).Reply(); err != nil {
		return fail(err)
	}
	if _, err := xfixes.QueryVersion(x, 5, 0).Reply(); err != nil {
		return fail(err)
	}
	wm := &windowManager{
		x:       x,
		root:    xproto.Setup(x).DefaultScreen(x).Root,
		out:     out,
		logger:  logger,
		atoms:   map[string]xproto.Atom{},
		wins:    map[xproto.Window]*managedWin{},
		layers:  map[xproto.Window]*layerWin{},
		keys:    map[byte]bool{},
		buttons: map[byte]bool{},
		done:    make(chan struct{}),
	}
	wm.resOK = res.Init(x) == nil
	for _, name := range wmAtoms {
		r, err := xproto.InternAtom(x, false, uint16(len(name)), name).Reply()
		if err != nil {
			return fail(err)
		}
		wm.atoms[name] = r.Atom
	}
	// Only one client may redirect the root's substructure. A manager being
	// replaced may still hold it for a moment.
	mask := uint32(xproto.EventMaskSubstructureRedirect | xproto.EventMaskSubstructureNotify | xproto.EventMaskPropertyChange)
	for i := 0; ; i++ {
		err := xproto.ChangeWindowAttributesChecked(x, wm.root, xproto.CwEventMask, []uint32{mask}).Check()
		if err == nil {
			break
		}
		if i >= 30 {
			return fail(errors.New("another window manager runs on the display"))
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := composite.RedirectSubwindowsChecked(x, wm.root, composite.RedirectAutomatic).Check(); err != nil {
		return fail(fmt.Errorf("composite redirect: %w", err))
	}
	xfixes.SelectCursorInput(x, wm.root, xfixes.CursorNotifyMaskDisplayCursor)
	if err := wm.setupEWMH(); err != nil {
		return fail(err)
	}
	return wm, nil
}

func (wm *windowManager) close() {
	wm.closeOnce.Do(func() {
		close(wm.done)
		wm.x.Close()
	})
}

// run serves the stream: windows that already exist are announced first.
func (wm *windowManager) run() error {
	wm.mu.Lock()
	wm.adopt()
	wm.mu.Unlock()
	errc := make(chan error, 2)
	go func() { errc <- wm.readCommands() }()
	go func() { errc <- wm.readEvents() }()
	go wm.pump()
	err := <-errc
	wm.close()
	if isClosedErr(err) {
		return nil
	}
	return err
}

func (wm *windowManager) emit(ev agentproto.GUIEvent) {
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	wm.writeMu.Lock()
	defer wm.writeMu.Unlock()
	_ = agentproto.WriteGUI(wm.out, agentproto.GUIJSON, b)
}

func (wm *windowManager) setupEWMH() error {
	id, err := xproto.NewWindowId(wm.x)
	if err != nil {
		return err
	}
	wm.check = id
	if err := xproto.CreateWindowChecked(wm.x, 0, id, wm.root, -1, -1, 1, 1, 0, xproto.WindowClassInputOnly, 0, 0, nil).Check(); err != nil {
		return err
	}
	for _, w := range []xproto.Window{wm.root, id} {
		wm.setWindows(w, wm.atoms["_NET_SUPPORTING_WM_CHECK"], []xproto.Window{id})
	}
	name := []byte(brand.Name)
	xproto.ChangeProperty(wm.x, xproto.PropModeReplace, id, wm.atoms["_NET_WM_NAME"], wm.atoms["UTF8_STRING"], 8, uint32(len(name)), name)
	var supported []byte
	for _, a := range []string{"_NET_WM_NAME", "_NET_WM_PID", "_NET_ACTIVE_WINDOW", "_NET_FRAME_EXTENTS", "_NET_CLIENT_LIST", "_NET_SUPPORTING_WM_CHECK"} {
		supported = append(supported, u32(uint32(wm.atoms[a]))...)
	}
	xproto.ChangeProperty(wm.x, xproto.PropModeReplace, wm.root, wm.atoms["_NET_SUPPORTED"], xproto.AtomAtom, 32, uint32(len(supported)/4), supported)
	return nil
}

func u32(v uint32) []byte {
	return []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}
}

func (wm *windowManager) setWindows(w xproto.Window, prop xproto.Atom, ids []xproto.Window) {
	var b []byte
	for _, id := range ids {
		b = append(b, u32(uint32(id))...)
	}
	xproto.ChangeProperty(wm.x, xproto.PropModeReplace, w, prop, xproto.AtomWindow, 32, uint32(len(ids)), b)
}

func (wm *windowManager) setCardinals(w xproto.Window, prop, typ xproto.Atom, vals ...uint32) {
	var b []byte
	for _, v := range vals {
		b = append(b, u32(v)...)
	}
	xproto.ChangeProperty(wm.x, xproto.PropModeReplace, w, prop, typ, 32, uint32(len(vals)), b)
}

// adopt takes over windows left on the display by a previous agent.
func (wm *windowManager) adopt() {
	tree, err := xproto.QueryTree(wm.x, wm.root).Reply()
	if err != nil {
		return
	}
	for _, w := range tree.Children {
		if w == wm.check {
			continue
		}
		attrs, err := xproto.GetWindowAttributes(wm.x, w).Reply()
		if err != nil || attrs.MapState != xproto.MapStateViewable || attrs.Class == xproto.WindowClassInputOnly {
			continue
		}
		if attrs.OverrideRedirect {
			wm.addLayer(w)
		} else {
			wm.manage(w)
		}
	}
}

func (wm *windowManager) readEvents() error {
	for {
		ev, xerr := wm.x.WaitForEvent()
		if ev == nil && xerr == nil {
			return io.EOF // connection closed
		}
		if ev != nil {
			wm.mu.Lock()
			wm.handleEvent(ev)
			wm.mu.Unlock()
		}
		// Errors are about windows that went away meanwhile.
	}
}

func (wm *windowManager) handleEvent(ev xgb.Event) {
	switch e := ev.(type) {
	case xproto.MapRequestEvent:
		wm.manage(e.Window)
	case xproto.ConfigureRequestEvent:
		wm.configureRequest(e)
	case xproto.MapNotifyEvent:
		if e.OverrideRedirect && wm.layers[e.Window] == nil {
			wm.addLayer(e.Window)
		}
	case xproto.UnmapNotifyEvent:
		wm.forget(e.Window)
	case xproto.DestroyNotifyEvent:
		wm.forget(e.Window)
	case xproto.ConfigureNotifyEvent:
		wm.configured(e)
	case xproto.PropertyNotifyEvent:
		if m := wm.wins[e.Window]; m != nil && (e.Atom == xproto.AtomWmName || e.Atom == wm.atoms["_NET_WM_NAME"]) {
			if t := wm.title(e.Window); t != m.title {
				m.title = t
				wm.emitWindow(m)
			}
		}
	case damage.NotifyEvent:
		w := wm.xwinOf(xproto.Window(e.Drawable))
		if w != nil {
			w.dirty = w.dirty.union(rect{int(e.Area.X), int(e.Area.Y), int(e.Area.Width), int(e.Area.Height)})
			w.changed = time.Now()
		}
	case xfixes.CursorNotifyEvent:
		if e.CursorSerial != wm.cursor {
			wm.cursor = e.CursorSerial
			go wm.sendCursor()
		}
	}
}

func (wm *windowManager) xwinOf(id xproto.Window) *xwin {
	if m := wm.wins[id]; m != nil {
		return &m.xwin
	}
	if l := wm.layers[id]; l != nil {
		return &l.xwin
	}
	return nil
}

func (wm *windowManager) newDamage(w xproto.Window) damage.Damage {
	id, err := damage.NewDamageId(wm.x)
	if err != nil {
		return 0
	}
	damage.Create(wm.x, id, xproto.Drawable(w), damage.ReportLevelDeltaRectangles)
	return id
}

// manage takes a top-level window: it goes to the origin, gets the window
// manager properties programs wait for, and is announced.
func (wm *windowManager) manage(w xproto.Window) {
	if wm.wins[w] != nil {
		xproto.MapWindow(wm.x, w)
		return
	}
	geo, err := xproto.GetGeometry(wm.x, xproto.Drawable(w)).Reply()
	if err != nil {
		return
	}
	xproto.ConfigureWindow(wm.x, w, xproto.ConfigWindowX|xproto.ConfigWindowY|xproto.ConfigWindowBorderWidth, []uint32{0, 0, 0})
	xproto.ChangeWindowAttributes(wm.x, w, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange})
	wm.setCardinals(w, wm.atoms["WM_STATE"], wm.atoms["WM_STATE"], 1, 0) // NormalState
	wm.setCardinals(w, wm.atoms["_NET_FRAME_EXTENTS"], xproto.AtomCardinal, 0, 0, 0, 0)
	xproto.MapWindow(wm.x, w)
	m := &managedWin{xwin: xwin{id: w, w: int(geo.Width), h: int(geo.Height)}}
	m.dirty = m.all()
	m.title = wm.title(w)
	m.transient = wm.window(w, xproto.AtomWmTransientFor)
	m.deleteWin, m.takeFocus = wm.protocols(w)
	m.pid = wm.pid(w)
	m.pane, m.socket = paneOf(m.pid)
	m.damage = wm.newDamage(w)
	wm.wins[w] = m
	wm.clientList()
	// A new window takes focus only when nothing has it or it is a dialog
	// of the focused window: keys typed meanwhile go where the user meant.
	if wm.wins[wm.focused] == nil || m.transient == wm.focused {
		wm.focus(m)
	}
	wm.emitWindow(m)
}

func (wm *windowManager) emitWindow(m *managedWin) {
	wm.emit(agentproto.GUIEvent{Ev: "window", Window: &agentproto.GUIWindow{
		ID: uint32(m.id), Title: m.title, W: m.w, H: m.h, Pid: m.pid,
		Pane: m.pane, Socket: m.socket, Transient: uint32(m.transient),
	}})
}

func (wm *windowManager) clientList() {
	ids := make([]xproto.Window, 0, len(wm.wins))
	for id := range wm.wins {
		ids = append(ids, id)
	}
	wm.setWindows(wm.root, wm.atoms["_NET_CLIENT_LIST"], ids)
}

// configureRequest grants sizes; managed windows stay at the origin and in
// the stacking order the window manager chose.
func (wm *windowManager) configureRequest(e xproto.ConfigureRequestEvent) {
	m := wm.wins[e.Window]
	var mask uint16
	var vals []uint32
	add := func(bit uint16, v uint32) {
		mask |= bit
		vals = append(vals, v)
	}
	if m == nil {
		if e.ValueMask&xproto.ConfigWindowX != 0 {
			add(xproto.ConfigWindowX, uint32(int32(e.X)))
		}
		if e.ValueMask&xproto.ConfigWindowY != 0 {
			add(xproto.ConfigWindowY, uint32(int32(e.Y)))
		}
	}
	if e.ValueMask&xproto.ConfigWindowWidth != 0 {
		add(xproto.ConfigWindowWidth, uint32(e.Width))
	}
	if e.ValueMask&xproto.ConfigWindowHeight != 0 {
		add(xproto.ConfigWindowHeight, uint32(e.Height))
	}
	if m == nil {
		if e.ValueMask&xproto.ConfigWindowBorderWidth != 0 {
			add(xproto.ConfigWindowBorderWidth, uint32(e.BorderWidth))
		}
		if e.ValueMask&xproto.ConfigWindowSibling != 0 {
			add(xproto.ConfigWindowSibling, uint32(e.Sibling))
		}
		if e.ValueMask&xproto.ConfigWindowStackMode != 0 {
			add(xproto.ConfigWindowStackMode, uint32(e.StackMode))
		}
	}
	if mask != 0 {
		xproto.ConfigureWindow(wm.x, e.Window, mask, vals)
	}
	if m != nil {
		// ICCCM: tell the client where it is when the request was not
		// granted as asked.
		w, h := m.w, m.h
		if e.ValueMask&xproto.ConfigWindowWidth != 0 {
			w = int(e.Width)
		}
		if e.ValueMask&xproto.ConfigWindowHeight != 0 {
			h = int(e.Height)
		}
		ev := xproto.ConfigureNotifyEvent{Event: e.Window, Window: e.Window, X: 0, Y: 0, Width: uint16(w), Height: uint16(h)}
		xproto.SendEvent(wm.x, false, e.Window, xproto.EventMaskStructureNotify, string(ev.Bytes()))
	}
}

func (wm *windowManager) configured(e xproto.ConfigureNotifyEvent) {
	if m := wm.wins[e.Window]; m != nil {
		m.x, m.y = int(e.X), int(e.Y)
		if int(e.Width) != m.w || int(e.Height) != m.h {
			m.w, m.h = int(e.Width), int(e.Height)
			m.dirty = m.all()
			wm.emitWindow(m)
		}
		return
	}
	if l := wm.layers[e.Window]; l != nil {
		resized := int(e.Width) != l.w || int(e.Height) != l.h
		l.x, l.y, l.w, l.h = int(e.X), int(e.Y), int(e.Width), int(e.Height)
		if resized {
			l.dirty = l.all()
		}
		wm.emitLayer(l)
	}
}

// addLayer attaches an override-redirect window to the window it belongs
// to: its transient-for window, else the focused one.
func (wm *windowManager) addLayer(w xproto.Window) {
	geo, err := xproto.GetGeometry(wm.x, xproto.Drawable(w)).Reply()
	if err != nil {
		return
	}
	owner := wm.wins[wm.window(w, xproto.AtomWmTransientFor)]
	if owner == nil {
		owner = wm.wins[wm.focused]
	}
	if owner == nil {
		for _, m := range wm.wins {
			owner = m
			break
		}
	}
	if owner == nil {
		return // nothing to show it with
	}
	l := &layerWin{xwin: xwin{id: w, x: int(geo.X), y: int(geo.Y), w: int(geo.Width), h: int(geo.Height)}, owner: owner.id}
	l.dirty = l.all()
	l.damage = wm.newDamage(w)
	wm.layers[w] = l
	owner.layers = append(owner.layers, w)
	wm.emitLayer(l)
}

func (wm *windowManager) emitLayer(l *layerWin) {
	owner := wm.wins[l.owner]
	if owner == nil {
		return
	}
	wm.emit(agentproto.GUIEvent{Ev: "layer", Layer: &agentproto.GUILayer{
		ID: uint32(l.id), Window: uint32(l.owner), X: l.x - owner.x, Y: l.y - owner.y, W: l.w, H: l.h,
	}})
}

// forget drops a window that was unmapped or destroyed.
func (wm *windowManager) forget(w xproto.Window) {
	if m := wm.wins[w]; m != nil {
		delete(wm.wins, w)
		if m.vid != nil {
			wm.retired = append(wm.retired, m.vid)
			m.vid = nil
		}
		if m.damage != 0 {
			damage.Destroy(wm.x, m.damage)
		}
		for _, id := range m.layers {
			if l := wm.layers[id]; l != nil {
				l.owner = 0
			}
		}
		if wm.focused == w {
			wm.focused = 0
		}
		if wm.top == w {
			wm.top = 0
		}
		wm.clientList()
		wm.emit(agentproto.GUIEvent{Ev: "gone", ID: uint32(w)})
		return
	}
	if l := wm.layers[w]; l != nil {
		delete(wm.layers, w)
		if l.damage != 0 {
			damage.Destroy(wm.x, l.damage)
		}
		if owner := wm.wins[l.owner]; owner != nil {
			for i, id := range owner.layers {
				if id == w {
					owner.layers = append(owner.layers[:i], owner.layers[i+1:]...)
					break
				}
			}
			wm.emit(agentproto.GUIEvent{Ev: "layer_gone", ID: uint32(w), Layer: &agentproto.GUILayer{ID: uint32(w), Window: uint32(l.owner)}})
		}
	}
}

// property reads a window property (at most 64 KiB).
func (wm *windowManager) property(w xproto.Window, prop, typ xproto.Atom) []byte {
	r, err := xproto.GetProperty(wm.x, false, w, prop, typ, 0, 16384).Reply()
	if err != nil || r == nil {
		return nil
	}
	return r.Value
}

func (wm *windowManager) title(w xproto.Window) string {
	b := wm.property(w, wm.atoms["_NET_WM_NAME"], wm.atoms["UTF8_STRING"])
	if len(b) == 0 {
		b = wm.property(w, xproto.AtomWmName, xproto.GetPropertyTypeAny)
	}
	return strings.TrimRight(string(b), "\x00")
}

func le32(b []byte) uint32 {
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
}

func (wm *windowManager) window(w xproto.Window, prop xproto.Atom) xproto.Window {
	if b := wm.property(w, prop, xproto.AtomWindow); len(b) >= 4 {
		return xproto.Window(le32(b))
	}
	return 0
}

func (wm *windowManager) protocols(w xproto.Window) (deleteWin, takeFocus bool) {
	b := wm.property(w, wm.atoms["WM_PROTOCOLS"], xproto.AtomAtom)
	for i := 0; i+4 <= len(b); i += 4 {
		switch xproto.Atom(le32(b[i:])) {
		case wm.atoms["WM_DELETE_WINDOW"]:
			deleteWin = true
		case wm.atoms["WM_TAKE_FOCUS"]:
			takeFocus = true
		}
	}
	return
}

// pid is the process that owns a window: _NET_WM_PID, else the X-Resource
// extension's view of the client (local connections only).
func (wm *windowManager) pid(w xproto.Window) int {
	if b := wm.property(w, wm.atoms["_NET_WM_PID"], xproto.AtomCardinal); len(b) >= 4 {
		return int(le32(b))
	}
	if !wm.resOK {
		return 0
	}
	r, err := res.QueryClientIds(wm.x, 1, []res.ClientIdSpec{{Client: uint32(w), Mask: res.ClientIdMaskLocalClientPID}}).Reply()
	if err != nil {
		return 0
	}
	for _, id := range r.Ids {
		if len(id.Value) > 0 {
			return int(id.Value[0])
		}
	}
	return 0
}

// paneOf returns the herdr pane (and herdr socket) a process was started
// in, from its environment or that of its nearest ancestor that has one.
func paneOf(pid int) (pane, socket string) {
	for i := 0; i < 8 && pid > 1; i++ {
		if env, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ"); err == nil {
			for _, kv := range bytes.Split(env, []byte{0}) {
				k, v, _ := strings.Cut(string(kv), "=")
				switch k {
				case "HERDR_PANE_ID":
					pane = v
				case "HERDR_SOCKET_PATH":
					socket = v
				}
			}
			if pane != "" {
				return pane, socket
			}
		}
		pid = parentPid(pid)
	}
	return "", ""
}

func parentPid(pid int) int {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	// The command name in parentheses may contain spaces.
	if i := bytes.LastIndexByte(b, ')'); i >= 0 {
		f := strings.Fields(string(b[i+1:]))
		if len(f) >= 2 {
			ppid, _ := strconv.Atoi(f[1])
			return ppid
		}
	}
	return 0
}

// raise puts m and its layers on top, so input at its position reaches it.
func (wm *windowManager) raise(m *managedWin) {
	if wm.top == m.id {
		return
	}
	xproto.ConfigureWindow(wm.x, m.id, xproto.ConfigWindowStackMode, []uint32{xproto.StackModeAbove})
	for _, id := range m.layers {
		xproto.ConfigureWindow(wm.x, id, xproto.ConfigWindowStackMode, []uint32{xproto.StackModeAbove})
	}
	wm.top = m.id
}

func (wm *windowManager) focus(m *managedWin) {
	wm.raise(m)
	xproto.SetInputFocus(wm.x, xproto.InputFocusPointerRoot, m.id, xproto.TimeCurrentTime)
	if m.takeFocus {
		wm.clientMessage(m.id, wm.atoms["WM_PROTOCOLS"], uint32(wm.atoms["WM_TAKE_FOCUS"]), xproto.TimeCurrentTime)
	}
	wm.setWindows(wm.root, wm.atoms["_NET_ACTIVE_WINDOW"], []xproto.Window{m.id})
	wm.focused = m.id
}

// hasFocus reports whether the keyboard focus is in m (or one of its
// subwindows).
func (wm *windowManager) hasFocus(m *managedWin) bool {
	r, err := xproto.GetInputFocus(wm.x).Reply()
	if err != nil {
		return false
	}
	// 0 is None, 1 PointerRoot.
	for w, i := r.Focus, 0; w > 1 && w != wm.root && i < 32; i++ {
		if w == m.id {
			return true
		}
		t, err := xproto.QueryTree(wm.x, w).Reply()
		if err != nil {
			return false
		}
		w = t.Parent
	}
	return false
}

func (wm *windowManager) clientMessage(w xproto.Window, typ xproto.Atom, data ...uint32) {
	for len(data) < 5 {
		data = append(data, 0)
	}
	ev := xproto.ClientMessageEvent{Format: 32, Window: w, Type: typ, Data: xproto.ClientMessageDataUnionData32New(data)}
	xproto.SendEvent(wm.x, false, w, xproto.EventMaskNoEvent, string(ev.Bytes()))
}

// closeWindow asks the program to close the window (WM_DELETE_WINDOW), or
// disconnects it when it does not support that.
func (wm *windowManager) closeWindow(m *managedWin) {
	if m.deleteWin {
		wm.clientMessage(m.id, wm.atoms["WM_PROTOCOLS"], uint32(wm.atoms["WM_DELETE_WINDOW"]), xproto.TimeCurrentTime)
		return
	}
	xproto.KillClient(wm.x, uint32(m.id))
}

func (wm *windowManager) readCommands() error {
	for {
		kind, payload, err := agentproto.ReadGUI(wm.out)
		if err != nil {
			return err
		}
		if kind != agentproto.GUIJSON {
			continue
		}
		var c agentproto.GUICommand
		if json.Unmarshal(payload, &c) != nil {
			continue
		}
		wm.mu.Lock()
		wm.command(c)
		wm.mu.Unlock()
	}
}

func (wm *windowManager) command(c agentproto.GUICommand) {
	if c.Cmd == "release" {
		wm.releaseAll()
		return
	}
	m := wm.wins[xproto.Window(c.ID)]
	if m == nil {
		return
	}
	switch c.Cmd {
	case "watch":
		// A first viewer: nothing is on its way to anyone.
		m.watched = true
		m.acked = m.seq
		m.inflight = nil
		m.stats = agentproto.GUIStats{}
		m.since = time.Now()
		m.codecs = c.Codecs
		m.keyWanted = true
		wm.refresh(m)
	case "unwatch":
		m.watched = false
	case "codecs":
		m.codecs = c.Codecs
	case "keyframe":
		m.keyWanted = true
	case "ack":
		if c.Seq > m.acked && c.Seq <= m.seq {
			m.acked = c.Seq
			m.ackedAt(c.Seq, time.Now())
		}
	case "refresh":
		m.codecs = c.Codecs
		m.keyWanted = true
		wm.refresh(m)
	case "focus":
		wm.focus(m)
	case "close":
		wm.closeWindow(m)
	case "pointer":
		wm.raise(m)
		wm.motion(m, c.X, c.Y)
	case "button":
		if c.Down && wm.focused != m.id {
			wm.focus(m) // click to focus
		}
		wm.raise(m)
		wm.motion(m, c.X, c.Y)
		if c.Button >= 1 && c.Button <= 9 {
			wm.fake(c.Down, false, byte(c.Button))
		}
	case "wheel":
		wm.raise(m)
		wm.motion(m, c.X, c.Y)
		click := func(b byte, n int) {
			for i := 0; i < min(n, 10); i++ {
				wm.fake(true, false, b)
				wm.fake(false, false, b)
			}
		}
		switch {
		case c.DY < 0:
			click(4, -c.DY)
		case c.DY > 0:
			click(5, c.DY)
		}
		switch {
		case c.DX < 0:
			click(6, -c.DX)
		case c.DX > 0:
			click(7, c.DX)
		}
	case "key":
		if c.Keycode >= 8 && c.Keycode <= 255 {
			// Programs can move the focus themselves; a key goes to the
			// window it was typed for.
			if c.Down && !wm.hasFocus(m) {
				wm.focus(m)
			}
			wm.fake(c.Down, true, byte(c.Keycode))
		}
	}
}

// refresh marks a window and its layers for sending in full.
func (wm *windowManager) refresh(m *managedWin) {
	m.dirty = m.all()
	for _, id := range m.layers {
		if l := wm.layers[id]; l != nil {
			l.dirty = l.all()
			wm.emitLayer(l)
		}
	}
}

func (wm *windowManager) motion(m *managedWin, x, y int) {
	xtest.FakeInput(wm.x, xproto.MotionNotify, 0, 0, wm.root, int16(m.x+x), int16(m.y+y), 0)
}

func (wm *windowManager) fake(down, key bool, detail byte) {
	var typ byte
	switch {
	case key && down:
		typ = xproto.KeyPress
	case key:
		typ = xproto.KeyRelease
	case down:
		typ = xproto.ButtonPress
	default:
		typ = xproto.ButtonRelease
	}
	pressed := wm.buttons
	if key {
		pressed = wm.keys
	}
	if down {
		pressed[detail] = true
	} else {
		delete(pressed, detail)
	}
	xtest.FakeInput(wm.x, typ, detail, 0, wm.root, 0, 0, 0)
}

// releaseAll lets go of keys and buttons held when a viewer lost focus.
func (wm *windowManager) releaseAll() {
	for k := range wm.keys {
		wm.fake(false, true, k)
	}
	for b := range wm.buttons {
		wm.fake(false, false, b)
	}
}

// ackedAt takes the frames up to seq off the inflight list, counting the
// latency of seq itself.
func (m *managedWin) ackedAt(seq uint32, now time.Time) {
	n := 0
	for _, f := range m.inflight {
		if int32(f.seq-seq) > 0 {
			break
		}
		if f.seq == seq {
			m.stats.Latency += now.Sub(f.at).Microseconds()
			m.stats.Acked++
		}
		n++
	}
	m.inflight = m.inflight[n:]
}

type capture struct {
	window, layer xproto.Window
	r             rect
	lossless      bool
	seq           uint32
	// A video frame of the whole window: with the window's encoder, or a
	// new stream of one of kinds when nil; key asks for a key frame.
	video bool
	vid   *videoEncoder
	kinds []string
	key   bool
}

// frameCost is what capturing and encoding one frame took.
type frameCost struct {
	window                   xproto.Window
	capture, convert, encode time.Duration
	pixels, bytes            int
	enc                      byte
	// Video: the encoder used, one that was started for the frame, or
	// the error that ended the window's video.
	vid, started *videoEncoder
	vidErr       error
}

// pump sends changed areas of watched windows at most every guiTick, with
// at most guiInflight frames per window waiting to be shown.
func (wm *windowManager) pump() {
	t := time.NewTicker(guiTick)
	defer t.Stop()
	// Encoders end with the stream.
	defer func() {
		wm.mu.Lock()
		for _, m := range wm.wins {
			if m.vid != nil {
				wm.retired = append(wm.retired, m.vid)
				m.vid = nil
			}
		}
		retired := wm.retired
		wm.retired = nil
		wm.mu.Unlock()
		for _, e := range retired {
			e.close()
		}
	}()
	for {
		select {
		case <-wm.done:
			return
		case <-t.C:
		}
		wm.mu.Lock()
		jobs := wm.collect(time.Now())
		wm.mu.Unlock()
		costs := make([]frameCost, 0, len(jobs))
		for _, j := range jobs {
			c, err := wm.send(j)
			if err != nil {
				if isClosedErr(err) {
					wm.close()
					return
				}
			}
			if c.enc != 0 || c.vidErr != nil || c.started != nil {
				costs = append(costs, c)
			}
		}
		wm.mu.Lock()
		wm.account(costs, time.Now())
		retired := wm.retired
		wm.retired = nil
		wm.mu.Unlock()
		for _, e := range retired {
			e.close()
		}
	}
}

// account adds frame costs to their windows' stats and reports the stats
// of watched windows every guiStatsEvery.
func (wm *windowManager) account(costs []frameCost, now time.Time) {
	for _, c := range costs {
		m := wm.wins[c.window]
		wm.videoResult(m, c, now)
		if m == nil || c.enc == 0 {
			continue
		}
		st := &m.stats
		st.Frames++
		switch c.enc {
		case agentproto.GUIEncJPEG:
			st.JPEG++
		case agentproto.GUIEncPNG:
			st.PNG++
		default:
			st.Video++
		}
		st.Pixels += int64(c.pixels)
		st.Bytes += int64(c.bytes)
		st.Capture += c.capture.Microseconds()
		st.Convert += c.convert.Microseconds()
		st.Encode += c.encode.Microseconds()
	}
	for _, m := range wm.wins {
		if !m.watched || now.Sub(m.since) < guiStatsEvery {
			continue
		}
		st := m.stats
		st.Window = uint32(m.id)
		st.Interval = now.Sub(m.since).Microseconds()
		if m.vid != nil {
			st.Encoder = m.vid.name
		}
		st.Fallback = m.fallback
		wm.emit(agentproto.GUIEvent{Ev: "stats", Stats: &st})
		m.stats = agentproto.GUIStats{}
		m.since = now
	}
}

// tiles splits r into rectangles of at most guiTile×guiTile, row by row.
func tiles(r rect) []rect {
	var out []rect
	for y := r.y; y < r.y+r.h; y += guiTile {
		for x := r.x; x < r.x+r.w; x += guiTile {
			out = append(out, rect{x, y, min(guiTile, r.x+r.w-x), min(guiTile, r.y+r.h-y)})
		}
	}
	return out
}

func (wm *windowManager) collect(now time.Time) []capture {
	var jobs []capture
	for _, m := range wm.wins {
		budget := guiInflight - int(m.seq-m.acked)
		if !m.watched {
			wm.stopVideo(m)
			continue
		}
		wm.trackMotion(m)
		if budget <= 0 {
			if wm.changed(m) {
				m.stats.Waits++
			}
			continue
		}
		sent := false
		ws := []*xwin{&m.xwin}
		if j, ok := wm.videoJob(m, now); ok {
			jobs = append(jobs, j)
			budget--
			sent = true
			m.stats.Updates++
			ws = ws[:0] // only its layers, as pictures
		}
		for _, id := range m.layers {
			if l := wm.layers[id]; l != nil {
				ws = append(ws, &l.xwin)
			}
		}
		for _, w := range ws {
			if budget <= 0 {
				break
			}
			r, lossless := w.dirty.clip(w.w, w.h), false
			if r.empty() {
				// Settled: replace what was sent as JPEG.
				if w.lossy.empty() || now.Sub(w.changed) < guiSettle {
					continue
				}
				r, lossless = w.lossy.clip(w.w, w.h), true
				if r.empty() {
					w.lossy = rect{}
					continue
				}
			}
			ts := tiles(r)
			if !sent {
				sent = true
				m.stats.Updates++
			}
			var rest rect
			if len(ts) > budget {
				for _, t := range ts[budget:] {
					rest = rest.union(t)
				}
				ts = ts[:budget]
			}
			// What is left is sent at the next tick.
			if lossless {
				w.lossy = rest
			} else {
				w.dirty = rest
			}
			if w.damage != 0 {
				damage.Subtract(wm.x, w.damage, 0, 0)
			}
			for _, t := range ts {
				m.seq++
				budget--
				m.inflight = append(m.inflight, sentFrame{m.seq, now})
				jobs = append(jobs, capture{window: m.id, layer: w.id, r: t, lossless: lossless, seq: m.seq})
				if !lossless && t.w*t.h >= guiPNGArea {
					w.lossy = w.lossy.union(t)
				}
			}
		}
	}
	return jobs
}

// changed reports whether a window or one of its layers has changes not
// sent yet.
func (wm *windowManager) changed(m *managedWin) bool {
	if !m.dirty.empty() {
		return true
	}
	for _, id := range m.layers {
		if l := wm.layers[id]; l != nil && !l.dirty.empty() {
			return true
		}
	}
	return false
}

// send captures one rectangle and writes it as a frame. The cost has no
// encoding when nothing was sent.
func (wm *windowManager) send(j capture) (frameCost, error) {
	if j.video {
		return wm.sendVideo(j)
	}
	c := frameCost{window: j.window, pixels: j.r.w * j.r.h}
	t0 := time.Now()
	img, err := xproto.GetImage(wm.x, xproto.ImageFormatZPixmap, xproto.Drawable(j.layer),
		int16(j.r.x), int16(j.r.y), uint16(j.r.w), uint16(j.r.h), 0xffffffff).Reply()
	if err != nil || img == nil || len(img.Data) < j.r.w*j.r.h*4 {
		return frameCost{}, nil // the window went away
	}
	t1 := time.Now()
	rgba := bgrxToRGBA(img.Data, j.r.w, j.r.h)
	t2 := time.Now()
	var buf bytes.Buffer
	enc := agentproto.GUIEncJPEG
	if j.lossless || j.r.w*j.r.h < guiPNGArea {
		enc = agentproto.GUIEncPNG
		e := png.Encoder{CompressionLevel: png.BestSpeed}
		err = e.Encode(&buf, rgba)
	} else {
		err = jpeg.Encode(&buf, rgba, &jpeg.Options{Quality: 85})
	}
	if err != nil {
		return frameCost{}, nil
	}
	c.capture, c.convert, c.encode = t1.Sub(t0), t2.Sub(t1), time.Since(t2)
	c.bytes, c.enc = buf.Len(), enc
	h := agentproto.GUIFrameHeader{
		Window: uint32(j.window), Layer: uint32(j.layer),
		X: int16(j.r.x), Y: int16(j.r.y), W: uint16(j.r.w), H: uint16(j.r.h),
		Enc: enc, Seq: j.seq,
	}
	wm.writeMu.Lock()
	defer wm.writeMu.Unlock()
	return c, agentproto.WriteGUI(wm.out, agentproto.GUIFrame, h.Marshal(), buf.Bytes())
}

// bgrxToRGBA converts a 32 bits per pixel ZPixmap of a depth 24 visual.
func bgrxToRGBA(data []byte, w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	p := img.Pix
	for i := 0; i < w*h*4; i += 4 {
		p[i], p[i+1], p[i+2], p[i+3] = data[i+2], data[i+1], data[i], 0xff
	}
	return img
}

// sendCursor sends the current pointer image.
func (wm *windowManager) sendCursor() {
	r, err := xfixes.GetCursorImage(wm.x).Reply()
	if err != nil || r.Width == 0 || r.Height == 0 || len(r.CursorImage) < int(r.Width)*int(r.Height) {
		return
	}
	img := image.NewNRGBA(image.Rect(0, 0, int(r.Width), int(r.Height)))
	for i, v := range r.CursorImage[:int(r.Width)*int(r.Height)] {
		a := byte(v >> 24)
		rr, gg, bb := byte(v>>16), byte(v>>8), byte(v)
		if a != 0 && a != 0xff { // premultiplied
			rr, gg, bb = byte(int(rr)*255/int(a)), byte(int(gg)*255/int(a)), byte(int(bb)*255/int(a))
		}
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = rr, gg, bb, a
	}
	var buf bytes.Buffer
	if png.Encode(&buf, img) != nil {
		return
	}
	wm.emit(agentproto.GUIEvent{Ev: "cursor", Cursor: &agentproto.GUICursor{PNG: buf.Bytes(), XHot: int(r.Xhot), YHot: int(r.Yhot)}})
}
