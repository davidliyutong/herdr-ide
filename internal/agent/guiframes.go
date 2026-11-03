package agent

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"runtime"
	"slices"
	"time"

	"github.com/jezek/xgb/damage"
	"github.com/jezek/xgb/shm"
	"github.com/jezek/xgb/xproto"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/jpegstrip"
)

// Sending windows. Every guiTick the pump collects what changed in watched
// windows, as far as their flow allows, captures it from the display
// (through shared memory where the server offers MIT-SHM), encodes the
// captures at the same time (JPEG in parallel row groups, PNG, video) and
// writes the frames in order.
//
// Flow: a window may have frames on their way until their bytes reach its
// budget, at most guiMaxInflight frames. The budget is what the connection
// delivers (the highest rate acknowledgements showed lately) in the shortest
// round trip seen (frame captured to drawn in the fastest viewer, which
// acknowledges it) plus a queue of the shorter of that round trip and
// guiQueueDelay or a quarter of it, whichever is longer: up to twice the
// round trip's worth on fast links, whose round trips vary a lot relative
// to the shortest, and about a quarter more on slow ones, where the queue
// would add most of the delay. Small video frames are not held back by a
// frame count. The budget keeps a queue, so round trips
// measured while sending are longer than the shortest: when none came
// within guiRTTProbe, one frame at a time is sent until one is drawn, which
// measures it again (as BBR's ProbeRTT does).

const (
	// guiMaxInflight bounds frames sent but not acknowledged per window.
	guiMaxInflight = 32
	// Budgets: the queue they may build, at least (also before anything
	// was measured), at most.
	guiQueueDelay = 30 * time.Millisecond
	guiMinBudget  = 64 << 10
	guiMaxBudget  = 8 << 20
	// guiRateWindow: the delivery rate is the highest of this long.
	guiRateWindow = 2 * time.Second
	// guiRTTProbe: the shortest round trip is measured again when no
	// round trip this short came for this long.
	guiRTTProbe = 10 * time.Second
	// guiJPEGQuality for changing areas; they are sent as PNG once settled.
	guiJPEGQuality = 85
	// A JPEG is coded in up to guiJPEGGroups row groups of at least
	// guiJPEGGroupPixels pixels at the same time.
	guiJPEGGroups      = 8
	guiJPEGGroupPixels = 64 << 10
	// guiShmMax bounds the shared memory segment captures go through.
	guiShmMax = 64 << 20
)

// flow is what a window has on its way and what was measured about the
// connection to its fastest viewer.
type flow struct {
	inflight  []sentFrame
	bytes     int       // of inflight (estimates until encoded)
	delivered int64     // bytes acknowledged since watched
	ackedAt   time.Time // of the last acknowledgement
	sentAt    time.Time // capture of the frame it acknowledged
	minRTT    time.Duration
	minRTTAt  time.Time // when a round trip this short came last
	maxRate   float64   // bytes per second
	rateAt    time.Time
	// Measuring the round trip again: one frame at a time until probeSeq
	// (the first frame sent alone, 0 before) is acknowledged.
	probing  bool
	probeSeq uint32
	// Estimates for frames not encoded yet: bytes per pixel of pictures,
	// bytes of the last video frame.
	bpp        float64
	videoBytes int
}

type sentFrame struct {
	seq   uint32
	at    time.Time // captured
	bytes int
	// When captured: flow.delivered, the time it was reached and the
	// capture of the frame acknowledged then. The delivery rate is measured
	// from there, over the longer of the time the bytes took to be sent and
	// to be acknowledged, so acknowledgements arriving together (the
	// browser draws in order) do not make it look faster.
	delivered   int64
	deliveredAt time.Time
	firstSent   time.Time
}

// budget is how many bytes may be on their way.
func (f *flow) budget() int {
	if f.minRTT == 0 || f.maxRate == 0 {
		return guiMinBudget
	}
	rtt := f.minRTT
	queue := min(rtt, max(rtt/4, guiQueueDelay))
	return max(guiMinBudget, min(int(f.maxRate*(rtt+queue).Seconds()), guiMaxBudget))
}

// room is the bytes and frames a window may send now.
func (f *flow) room(now time.Time) (bytes, frames int) {
	if !f.probing && f.minRTT != 0 && now.Sub(f.minRTTAt) > guiRTTProbe {
		f.probing, f.probeSeq = true, 0
	}
	if f.probing {
		if len(f.inflight) > 0 {
			return 0, 0
		}
		return max(f.budget(), 1), 1
	}
	return f.budget() - f.bytes, guiMaxInflight - len(f.inflight)
}

// estimate is the expected size of a picture of r.
func (f *flow) estimate(r rect) int {
	bpp := f.bpp
	if bpp == 0 {
		bpp = 0.1 // JPEG of a rendered scene
	}
	return int(float64(r.w*r.h)*bpp) + 1
}

// ackedAt takes the frames up to seq off the inflight list, measuring the
// round trip of seq and what was delivered meanwhile.
func (m *managedWin) ackedAt(seq uint32, now time.Time) {
	n := 0
	for _, f := range m.inflight {
		if int32(f.seq-seq) > 0 {
			break
		}
		m.flow.bytes -= f.bytes
		m.flow.delivered += int64(f.bytes)
		if f.seq == seq {
			rtt := now.Sub(f.at)
			m.stats.Latency += rtt.Microseconds()
			m.stats.Acked++
			if d := max(now.Sub(f.deliveredAt), f.at.Sub(f.firstSent)); rtt > 0 && d > 0 {
				m.flow.sample(rtt, float64(m.flow.delivered-f.delivered)/d.Seconds(), now)
			}
			m.flow.sentAt = f.at
		}
		if m.flow.probing && f.seq == m.flow.probeSeq {
			// Sent with nothing else on its way: the round trip without
			// a queue, shorter or longer than before.
			m.flow.minRTT, m.flow.minRTTAt = now.Sub(f.at), now
			m.flow.probing, m.flow.probeSeq = false, 0
		}
		n++
	}
	m.inflight = m.inflight[n:]
	m.flow.ackedAt = now
}

// sample keeps the shortest round trip since the window was watched (a
// queue the budget itself builds must not raise it) and the highest
// delivery rate of the last guiRateWindow.
func (f *flow) sample(rtt time.Duration, rate float64, now time.Time) {
	if f.minRTT == 0 || rtt <= f.minRTT {
		f.minRTT, f.minRTTAt = rtt, now
	}
	if rate >= f.maxRate || now.Sub(f.rateAt) > guiRateWindow {
		f.maxRate, f.rateAt = rate, now
	}
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

// frame is an encoded capture; no data: nothing to send.
type frame struct {
	cost frameCost
	data []byte
}

// pump sends changed areas of watched windows at most every guiTick.
func (wm *windowManager) pump() {
	t := time.NewTicker(guiTick)
	defer t.Stop()
	defer func() {
		// Encoders end with the stream.
		wm.mu.Lock()
		for _, m := range wm.wins {
			if m.vid != nil {
				wm.retired = append(wm.retired, m.vid)
				m.vid = nil
			}
		}
		wm.mu.Unlock()
		wm.closeRetired()
		if wm.seg != nil {
			wm.seg.free(wm.x)
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
		if !wm.send(jobs) {
			wm.close()
			return
		}
		wm.closeRetired()
	}
}

func (wm *windowManager) closeRetired() {
	wm.mu.Lock()
	retired := wm.retired
	wm.retired = nil
	wm.mu.Unlock()
	for _, e := range retired {
		e.close()
	}
}

// send captures, encodes and writes the frames of one tick; false when the
// stream is closed.
func (wm *windowManager) send(jobs []capture) bool {
	if len(jobs) == 0 {
		return true
	}
	grabs := wm.grab(jobs)
	done := make([]chan frame, len(jobs))
	for i := range jobs {
		done[i] = make(chan frame, 1)
		go func() { done[i] <- wm.encode(jobs[i], grabs[i]) }()
	}
	// In order, as each is ready; all are waited for, since captures may
	// point into the shared segment the next tick reuses.
	open := true
	costs := make([]frameCost, 0, len(jobs))
	for i, j := range jobs {
		f := <-done[i]
		wm.mu.Lock()
		wm.encoded(j, f)
		wm.mu.Unlock()
		if f.data != nil && open {
			if err := wm.write(j, f); err != nil && isClosedErr(err) {
				open = false
			}
		}
		if f.cost.enc != 0 || f.cost.vidErr != nil || f.cost.started != nil {
			costs = append(costs, f.cost)
		}
	}
	wm.mu.Lock()
	wm.account(costs, time.Now())
	wm.mu.Unlock()
	return open
}

// grabbed is a captured rectangle: w×h BGRX pixels, nil when the window
// went away.
type grabbed struct {
	pix     []byte
	capture time.Duration
}

// grab captures the rectangles of jobs, all requests sent before the
// first reply is read: into the shared segment where they fit, else
// through the connection.
func (wm *windowManager) grab(jobs []capture) []grabbed {
	need := 0
	for _, j := range jobs {
		need += j.r.w * j.r.h * 4
	}
	seg := wm.segment(need)
	type pending struct {
		viaShm bool
		shm    shm.GetImageCookie
		x      xproto.GetImageCookie
		off    int
	}
	ps := make([]pending, len(jobs))
	off := 0
	t0 := time.Now()
	for i, j := range jobs {
		d, x, y, w, h := xproto.Drawable(j.layer), int16(j.r.x), int16(j.r.y), uint16(j.r.w), uint16(j.r.h)
		if size := j.r.w * j.r.h * 4; seg != nil && off+size <= len(seg.data) {
			ps[i] = pending{viaShm: true, shm: shm.GetImage(wm.x, d, x, y, w, h, 0xffffffff, xproto.ImageFormatZPixmap, seg.id, uint32(off)), off: off}
			off += size
		} else {
			ps[i] = pending{x: xproto.GetImage(wm.x, xproto.ImageFormatZPixmap, d, x, y, w, h, 0xffffffff)}
		}
	}
	out := make([]grabbed, len(jobs))
	last := t0
	for i, p := range ps {
		size := jobs[i].r.w * jobs[i].r.h * 4
		if p.viaShm {
			r, err := p.shm.Reply()
			switch {
			case err == nil && r != nil && int(r.Size) >= size:
				out[i].pix = seg.data[p.off : p.off+size]
			case errors.As(err, new(shm.BadSegError)) || errors.As(err, new(xproto.AccessError)):
				// The segment, not the window: capture without it from now on.
				wm.logger.Printf("gui: shared memory capture failed, reading through the connection: %v", err)
				wm.shmOK = false
			}
		} else if r, err := p.x.Reply(); err == nil && r != nil && len(r.Data) >= size {
			out[i].pix = r.Data[:size]
		}
		now := time.Now()
		out[i].capture, last = now.Sub(last), now
	}
	return out
}

// segment returns a shared segment of at least need bytes (up to
// guiShmMax), nil without MIT-SHM.
func (wm *windowManager) segment(need int) *shmBuf {
	if !wm.shmOK || need == 0 {
		return nil
	}
	need = min(need, guiShmMax)
	if wm.seg != nil && len(wm.seg.data) >= need {
		return wm.seg
	}
	size := 8 << 20
	for size < need {
		size *= 2
	}
	if wm.seg != nil {
		wm.seg.free(wm.x)
		wm.seg = nil
	}
	seg, err := newShmBuf(wm.x, min(size, guiShmMax))
	if err != nil {
		wm.logger.Printf("gui: no shared memory capture: %v", err)
		wm.shmOK = false
		return nil
	}
	wm.seg = seg
	return seg
}

// encode turns a capture into a frame.
func (wm *windowManager) encode(j capture, g grabbed) (f frame) {
	f.cost = frameCost{window: j.window, pixels: j.r.w * j.r.h, capture: g.capture, vid: j.vid}
	if g.pix == nil {
		return f // the window went away
	}
	if j.video {
		wm.encodeVideo(j, g.pix, &f)
		return f
	}
	t := time.Now()
	if j.lossless || j.r.w*j.r.h < guiPNGArea {
		rgba := bgrxToRGBA(g.pix, j.r.w, j.r.h)
		f.cost.convert = time.Since(t)
		t = time.Now()
		var buf bytes.Buffer
		e := png.Encoder{CompressionLevel: png.BestSpeed}
		if e.Encode(&buf, rgba) != nil {
			return f
		}
		f.data, f.cost.enc = buf.Bytes(), agentproto.GUIEncPNG
	} else {
		groups := min(guiJPEGGroups, runtime.GOMAXPROCS(0), j.r.w*j.r.h/guiJPEGGroupPixels)
		data, err := jpegstrip.Encode(nil, g.pix, j.r.w*4, j.r.w, j.r.h, guiJPEGQuality, groups)
		if err != nil {
			return f
		}
		f.data, f.cost.enc = data, agentproto.GUIEncJPEG
	}
	f.cost.encode = time.Since(t)
	f.cost.bytes = len(f.data)
	return f
}

// encoded puts the size of an encoded frame in its window's flow, or takes
// a frame that will not be sent off it.
func (wm *windowManager) encoded(j capture, f frame) {
	m := wm.wins[j.window]
	if m == nil {
		return
	}
	i := slices.IndexFunc(m.inflight, func(s sentFrame) bool { return s.seq == j.seq })
	if i < 0 {
		return
	}
	if f.data == nil {
		m.flow.bytes -= m.inflight[i].bytes
		m.inflight = slices.Delete(m.inflight, i, i+1)
		if m.flow.probeSeq == j.seq {
			m.flow.probeSeq = 0 // the next frame probes
		}
		return
	}
	m.flow.bytes += len(f.data) - m.inflight[i].bytes
	m.inflight[i].bytes = len(f.data)
	switch f.cost.enc {
	case agentproto.GUIEncVideo, agentproto.GUIEncVideoKey:
		m.flow.videoBytes = len(f.data)
	default:
		bpp := float64(len(f.data)) / float64(j.r.w*j.r.h)
		if m.flow.bpp == 0 {
			m.flow.bpp = bpp
		} else {
			m.flow.bpp = 0.8*m.flow.bpp + 0.2*bpp
		}
	}
}

// write sends a frame, announcing a video stream it starts.
func (wm *windowManager) write(j capture, f frame) error {
	if e := f.cost.started; e != nil {
		wm.emit(agentproto.GUIEvent{Ev: "video", Video: &agentproto.GUIVideo{
			Window: uint32(j.window), Codec: e.codec(f.data), Encoder: e.name, W: e.cw, H: e.ch,
		}})
	}
	h := agentproto.GUIFrameHeader{
		Window: uint32(j.window), Layer: uint32(j.layer),
		X: int16(j.r.x), Y: int16(j.r.y), W: uint16(j.r.w), H: uint16(j.r.h),
		Enc: f.cost.enc, Seq: j.seq,
	}
	wm.writeMu.Lock()
	defer wm.writeMu.Unlock()
	return agentproto.WriteGUI(wm.out, agentproto.GUIFrame, h.Marshal(), f.data)
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
		st.Budget = int64(m.flow.budget())
		st.RTT = m.flow.minRTT.Microseconds()
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

// collect decides what each watched window sends this tick.
func (wm *windowManager) collect(now time.Time) []capture {
	var jobs []capture
	for _, m := range wm.wins {
		if !m.watched {
			wm.stopVideo(m)
			continue
		}
		wm.trackMotion(m)
		room, slots := m.flow.room(now)
		if room <= 0 || slots <= 0 {
			if wm.changed(m) {
				m.stats.Waits++
			}
			continue
		}
		take := func(j capture, est int) {
			m.seq++
			j.seq = m.seq
			// After a pause the rate is measured from now, not from the
			// last acknowledgement.
			from, first := m.flow.ackedAt, m.flow.sentAt
			if len(m.inflight) == 0 || from.IsZero() {
				from, first = now, now
			}
			m.inflight = append(m.inflight, sentFrame{seq: m.seq, at: now, bytes: est,
				delivered: m.flow.delivered, deliveredAt: from, firstSent: first})
			if m.flow.probing && m.flow.probeSeq == 0 {
				m.flow.probeSeq = m.seq
			}
			m.flow.bytes += est
			room -= est
			slots--
			jobs = append(jobs, j)
		}
		sent := false
		ws := []*xwin{&m.xwin}
		if j, ok := wm.videoJob(m, now); ok {
			take(j, max(m.flow.videoBytes, 1))
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
			if room <= 0 || slots <= 0 {
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
			if !sent {
				sent = true
				m.stats.Updates++
			}
			if w.damage != 0 {
				damage.Subtract(wm.x, w.damage, 0, 0)
			}
			// What does not fit is sent at a later tick.
			var rest rect
			for _, t := range tiles(r) {
				if room <= 0 || slots <= 0 {
					rest = rest.union(t)
					continue
				}
				take(capture{window: m.id, layer: w.id, r: t, lossless: lossless}, m.flow.estimate(t))
				if !lossless && t.w*t.h >= guiPNGArea {
					w.lossy = w.lossy.union(t)
				}
			}
			if lossless {
				w.lossy = rest
			} else {
				w.dirty = rest
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

// bgrxToRGBA converts a 32 bits per pixel ZPixmap of a depth 24 visual.
func bgrxToRGBA(data []byte, w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	p := img.Pix
	for i := 0; i < w*h*4; i += 4 {
		p[i], p[i+1], p[i+2], p[i+3] = data[i+2], data[i+1], data[i], 0xff
	}
	return img
}
