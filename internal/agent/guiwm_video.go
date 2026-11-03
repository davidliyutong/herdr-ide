package agent

import (
	"math/bits"
	"slices"
	"time"

	"github.com/jezek/xgb/damage"

	"herdr-ide/internal/agentproto"
)

// Video for windows that keep changing (--gui-video). While a watched
// window's viewers all decode video, the agent has an encoder, and most
// recent ticks changed a large part of the window, its changes are sent as
// frames of a video stream of the whole window instead of pictures of the
// changed area. Once it stops changing, the existing settling sends it
// again as PNG, so still pictures end up exact (video blurs colored text).
// Layers (menus, tooltips) stay pictures. The stream ends after videoIdle
// without changes, when viewers change, the window is resized (a new one
// starts) or the encoder fails (pictures until videoRetry has passed).

// trackMotion records whether the window's pending changes cover a large
// part of it; called once per tick.
func (wm *windowManager) trackMotion(m *managedWin) {
	d := m.dirty.clip(m.w, m.h)
	big := !d.empty() && d.w*d.h*videoMotionShare >= m.w*m.h
	m.motion <<= 1
	if big {
		m.motion |= 1
	}
}

// videoKindsFor returns the stream kinds both the viewers and the encoder
// handle, in the viewers' order, and notes why there are none.
func (wm *windowManager) videoKindsFor(m *managedWin) []string {
	m.fallback = ""
	if len(m.codecs) == 0 {
		return nil
	}
	var bin string
	var kinds []string
	if wm.tools != nil {
		bin, kinds = wm.tools()
	}
	if bin == "" {
		m.fallback = "unavailable"
		return nil
	}
	var out []string
	for _, c := range m.codecs {
		if slices.Contains(kinds, c) {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		m.fallback = "no_codec"
	}
	return out
}

// videoJob returns the window's next video frame, if it is (or now becomes)
// sent as video and has changed.
func (wm *windowManager) videoJob(m *managedWin, now time.Time) (capture, bool) {
	kinds := wm.videoKindsFor(m)
	if len(kinds) > 0 && (m.w > videoMaxSide || m.h > videoMaxSide) {
		kinds, m.fallback = nil, "too_large"
	}
	if m.vid != nil && (m.vid.w != m.w || m.vid.h != m.h || !slices.Equal(kinds, m.vid.kinds)) {
		// Resized, or the kinds changed: the viewers now decode a preferred
		// stream, or a viewer does not decode this one. A stream of a later
		// kind because the first would not open (all NVENC sessions in use)
		// is kept until it ends.
		wm.stopVideo(m)
	}
	if len(kinds) == 0 {
		wm.stopVideo(m)
		return capture{}, false
	}
	if m.vid == nil {
		if now.Before(m.vidRetry) {
			m.fallback = "failed"
			return capture{}, false
		}
		if bits.OnesCount16(m.motion&0xfff) < videoMotionTicks || m.w < videoMinSide || m.h < videoMinSide {
			return capture{}, false
		}
	}
	if m.dirty.clip(m.w, m.h).empty() {
		if m.vid != nil && now.Sub(m.lastVideo) > videoIdle {
			wm.stopVideo(m)
		}
		return capture{}, false
	}
	if m.damage != 0 {
		damage.Subtract(wm.x, m.damage, 0, 0)
	}
	j := capture{window: m.id, layer: m.id, r: m.all(), video: true, vid: m.vid, kinds: kinds, key: m.keyWanted || m.vid == nil}
	m.keyWanted = false
	m.lastVideo = now
	// Sent again as PNG once the window settles.
	m.dirty, m.lossy = rect{}, m.all()
	return j, true
}

// idleVideo ends the window's stream after videoIdle without frames, also
// while its flow holds frames back (a viewer that stopped acknowledging
// must not keep an encoder and its GPU session).
func (wm *windowManager) idleVideo(m *managedWin, now time.Time) {
	if m.vid != nil && now.Sub(m.lastVideo) > videoIdle {
		wm.stopVideo(m)
	}
}

// stopVideo ends the window's stream: the pump closes the encoder, browsers
// drop their decoder.
func (wm *windowManager) stopVideo(m *managedWin) {
	if m.vid == nil {
		return
	}
	wm.retired = append(wm.retired, m.vid)
	m.vid = nil
	wm.emit(agentproto.GUIEvent{Ev: "video", Video: &agentproto.GUIVideo{Window: uint32(m.id)}})
}

// videoResult applies what sending a video frame did to the window m (nil
// when it is gone): a started encoder becomes its stream, a failure sends it
// as pictures until videoRetry.
func (wm *windowManager) videoResult(m *managedWin, c frameCost, now time.Time) {
	if c.vidErr != nil {
		wm.logger.Printf("gui: video of window %d: %v", c.window, c.vidErr)
		if c.started != nil {
			wm.retired = append(wm.retired, c.started)
		}
		if m == nil {
			return
		}
		if m.vid != nil && m.vid == c.vid {
			wm.stopVideo(m)
		}
		m.vidRetry = now.Add(min(videoRetry<<min(m.vidFails, 10), videoRetryMax))
		m.vidFails++
		m.fallback = "failed"
		m.dirty = m.all()
		return
	}
	if c.started == nil {
		return
	}
	if m == nil || !m.watched || m.vid != nil {
		wm.retired = append(wm.retired, c.started)
		if m != nil && m.vid == nil {
			wm.emit(agentproto.GUIEvent{Ev: "video", Video: &agentproto.GUIVideo{Window: uint32(m.id)}})
		}
		return
	}
	m.vid = c.started
	m.vidFails = 0
}

// encodeVideo encodes the captured window as the next frame of its
// stream, starting a stream when the window has none yet.
func (wm *windowManager) encodeVideo(j capture, pix []byte, f *frame) {
	t := time.Now()
	e, key := j.vid, j.key
	if e == nil {
		bin, _ := wm.tools()
		var err error
		if e, err = startEncoder(bin, j.r.w, j.r.h, j.kinds); err != nil {
			f.cost.vidErr = err
			return
		}
		f.cost.started, key = e, true
	}
	data, isKey, err := e.encode(pix, key)
	if err != nil {
		f.cost.vidErr = err
		return
	}
	f.cost.encode = time.Since(t)
	f.cost.bytes = len(data)
	f.cost.enc = agentproto.GUIEncVideo
	if isKey {
		f.cost.enc = agentproto.GUIEncVideoKey
	}
	f.data = data
}
