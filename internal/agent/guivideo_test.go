package agent

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jezek/xgb/xproto"

	"herdr-ide/internal/agentproto"
)

// TestHelperEncoder is not a test of its own: run through fakeEncoder, it
// speaks the encoder's protocol (scripts/encoder/encoder.c). Each packet
// is "<kind> <frame number> <first pixel byte>"; key frames start with an
// H.264 sequence parameter set. GUI_TEST_ENCODER_DIE=n exits after n
// frames.
func TestHelperEncoder(t *testing.T) {
	if os.Getenv("GUI_TEST_ENCODER") == "" {
		t.Skip("helper process")
	}
	var w, h int
	kinds := ""
	args := os.Args[slices.Index(os.Args, "--")+1:]
	for i := 0; i+1 < len(args); i += 2 {
		switch args[i] {
		case "-w":
			fmt.Sscan(args[i+1], &w)
		case "-h":
			fmt.Sscan(args[i+1], &h)
		case "-kinds":
			kinds = args[i+1]
		}
	}
	name := map[string]string{"avc1": "h264_nvenc", "vp8": "libvpx"}[strings.Split(kinds, ",")[0]]
	if name == "" || os.Getenv("GUI_TEST_ENCODER_FAIL") != "" {
		fmt.Println("error no encoder for", kinds)
		os.Exit(1)
	}
	fmt.Printf("ok %s %d %d\n", name, (w+1)&^1, (h+1)&^1)
	die := -1
	fmt.Sscan(os.Getenv("GUI_TEST_ENCODER_DIE"), &die)
	frame := make([]byte, w*h*4)
	for n := 0; n != die; n++ {
		var hdr [8]byte
		if _, err := io.ReadFull(os.Stdin, hdr[:4]); err != nil {
			os.Exit(0)
		}
		if _, err := io.ReadFull(os.Stdin, frame); err != nil {
			os.Exit(0)
		}
		key := hdr[0]&1 != 0 || n == 0
		p := []byte(fmt.Sprintf("%s %d %d", kinds, n, frame[0]))
		if key {
			p = append([]byte{0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f}, p...)
			binary.LittleEndian.PutUint32(hdr[4:], 1)
		}
		binary.LittleEndian.PutUint32(hdr[:4], uint32(len(p)))
		os.Stdout.Write(hdr[:])
		os.Stdout.Write(p)
	}
	os.Exit(0)
}

// fakeEncoder is a script running TestHelperEncoder.
func fakeEncoder(t *testing.T, env ...string) string {
	p := filepath.Join(t.TempDir(), "encoder")
	script := "#!/bin/sh\nexec env GUI_TEST_ENCODER=1 " + strings.Join(env, " ") + " " + os.Args[0] + " -test.run='^TestHelperEncoder$' -- \"$@\"\n"
	if err := os.WriteFile(p, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return p
}

// The encoder process: the stream it chose, frames in and packets out,
// key frames on request, the codec string, and failures.
func TestEncoderProcess(t *testing.T) {
	e, err := startEncoder(fakeEncoder(t), 17, 10, []string{"avc1", "vp8"})
	if err != nil {
		t.Fatal(err)
	}
	if e.name != "h264_nvenc" || e.kind != "avc1" || e.cw != 18 || e.ch != 10 {
		t.Fatalf("encoder %+v", e)
	}
	frame := make([]byte, 17*10*4)
	frame[0] = 9
	p, key, err := e.encode(frame, false)
	if err != nil || !key || !bytes.HasSuffix(p, []byte("avc1,vp8 0 9")) {
		t.Fatalf("first frame %q key %v: %v", p, key, err)
	}
	if c := e.codec(p); c != "avc1.64001f" {
		t.Errorf("codec %s", c)
	}
	if p, key, _ = e.encode(frame, false); key || string(p) != "avc1,vp8 1 9" {
		t.Errorf("second frame %q key %v", p, key)
	}
	if _, key, _ = e.encode(frame, true); !key {
		t.Error("key frame not made on request")
	}
	e.close()

	if _, err := startEncoder(fakeEncoder(t, "GUI_TEST_ENCODER_FAIL=1"), 17, 10, []string{"vp8"}); err == nil || !strings.Contains(err.Error(), "no encoder") {
		t.Errorf("failing encoder: %v", err)
	}
	e, err = startEncoder(fakeEncoder(t, "GUI_TEST_ENCODER_DIE=1"), 17, 10, []string{"vp8"})
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	if c := e.codec([]byte("x")); c != "vp8" {
		t.Errorf("codec %s", c)
	}
	e.encode(frame, false)
	if _, _, err := e.encode(frame, false); err == nil {
		t.Error("an encoder that exited still encodes")
	}
}

func gzipped(b []byte) (*bytes.Buffer, string) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(b)
	zw.Close()
	sum := sha256.Sum256(b)
	return &buf, hex.EncodeToString(sum[:])
}

// The encoder the core pushes is used only with its digest; other builds
// go once unused for long, and so do installs that did not finish.
func TestInstallVideo(t *testing.T) {
	g := newGUI(testAgent(t))
	body, digest := gzipped([]byte("#!/bin/sh\n"))
	other, _ := gzipped([]byte("something else"))
	if err := g.installVideo(digest, other); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("wrong content installed: %v", err)
	}
	if _, ok := g.videoReady(digest); ok {
		t.Fatal("ready after a failed install")
	}
	if ents, _ := os.ReadDir(g.videoRoot()); len(ents) != 0 {
		t.Errorf("left %v", ents)
	}
	old := filepath.Join(g.videoRoot(), "0123456789abcdef")
	stale := filepath.Join(g.videoRoot(), ".fetch-1")
	for _, d := range []string{old, stale} {
		os.MkdirAll(d, 0o700)
		past := time.Now().Add(-versionRetention - time.Hour)
		os.Chtimes(d, past, past)
	}
	if err := g.installVideo(digest, body); err != nil {
		t.Fatal(err)
	}
	bin, ok := g.videoReady(digest)
	if info, err := os.Stat(bin); !ok || err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("installed %s %v", bin, err)
	}
	for _, d := range []string{old, stale} {
		if _, err := os.Stat(d); err == nil {
			t.Errorf("%s not pruned", d)
		}
	}
	// A changed file is not run.
	os.WriteFile(bin, []byte("changed"), 0o700)
	g.videoBin = ""
	if _, ok := g.videoReady(digest); ok {
		t.Error("changed encoder accepted")
	}
	if g.installVideo("../../x", body) == nil {
		t.Error("bad digest accepted")
	}
}

// When a window becomes video, stays video and goes back to pictures.
func TestVideoDecision(t *testing.T) {
	var out bytes.Buffer
	bin, kinds := "/enc", []string{"vp8"}
	m := &managedWin{xwin: xwin{id: 1, w: 640, h: 480}, watched: true, codecs: []string{"avc1"}}
	wm := &windowManager{out: &out, logger: testAgent(t).logger, wins: map[xproto.Window]*managedWin{1: m}, layers: map[xproto.Window]*layerWin{},
		tools: func() (string, []string) { return bin, kinds }}
	now := time.Now()
	tick := func() []capture {
		now = now.Add(guiTick)
		jobs := wm.collect(now)
		for _, j := range jobs {
			m.acked = j.seq
			m.ackedAt(j.seq, now)
		}
		return jobs
	}
	moving := func() { m.dirty = m.all() }

	moving()
	if j := tick(); len(j) == 0 || j[0].video || m.fallback != "no_codec" {
		t.Fatalf("no common codec: %+v (%s)", j, m.fallback)
	}
	m.codecs = []string{"avc1", "vp8"}
	m.motion = 0
	for i := 0; i < videoMotionTicks-1; i++ {
		moving()
		if j := tick(); len(j) == 0 || j[0].video {
			t.Fatalf("video after %d ticks of motion", i+2)
		}
	}
	moving()
	j := tick()
	if len(j) != 1 || !j[0].video || !j[0].key || j[0].vid != nil || !slices.Equal(j[0].kinds, []string{"vp8"}) {
		t.Fatalf("starting video: %+v", j)
	}
	// The pump started an encoder for it.
	enc := &videoEncoder{w: 640, h: 480, kind: "vp8", kinds: []string{"vp8"}, name: "libvpx"}
	wm.account([]frameCost{{window: 1, enc: agentproto.GUIEncVideoKey, started: enc}}, now)
	if m.vid != enc {
		t.Fatal("encoder not kept")
	}
	moving()
	if j := tick(); len(j) != 1 || !j[0].video || j[0].key || j[0].vid != enc {
		t.Fatalf("next frame: %+v", j)
	}
	// A small change is still a video frame; a viewer asking starts anew.
	m.dirty = rect{0, 0, 5, 5}
	m.keyWanted = true
	if j := tick(); len(j) != 1 || !j[0].video || !j[0].key {
		t.Fatalf("small change: %+v", j)
	}
	// Resized: a new stream.
	m.w, m.h = 800, 600
	moving()
	if j := tick(); len(j) != 1 || j[0].vid != nil || !slices.Contains(wm.retired, enc) {
		t.Fatalf("after resize: %+v", j)
	}
	// The encoder failed: pictures for a while.
	wm.account([]frameCost{{window: 1, vidErr: fmt.Errorf("gone")}}, now)
	moving()
	if j := tick(); len(j) == 0 || j[0].video || m.fallback != "failed" {
		t.Fatalf("after failure: %+v (%s)", j, m.fallback)
	}
	now = now.Add(videoRetry)
	moving()
	if j := tick(); len(j) != 1 || !j[0].video {
		t.Fatalf("after the retry delay: %+v", j)
	}
	// Still for videoIdle: the stream ends.
	enc2 := &videoEncoder{w: 800, h: 600, kind: "vp8", kinds: []string{"vp8"}}
	wm.account([]frameCost{{window: 1, enc: agentproto.GUIEncVideoKey, started: enc2}}, now)
	now = now.Add(videoIdle + time.Second)
	tick()
	if m.vid != nil || !slices.Contains(wm.retired, enc2) {
		t.Error("idle stream kept")
	}
	// The viewers now all decode a preferred stream: it replaces this one.
	kinds = []string{"avc1", "vp8"}
	enc3 := &videoEncoder{w: 800, h: 600, kind: "vp8", kinds: []string{"vp8"}}
	m.vid = enc3
	moving()
	if j := tick(); len(j) != 1 || j[0].vid != nil || j[0].kinds[0] != "avc1" || !slices.Contains(wm.retired, enc3) {
		t.Fatalf("preferred stream: %+v", j)
	}
	// H.264 would not open (all NVENC sessions in use) and the encoder made
	// VP8: the stream is kept, not restarted for H.264 on every frame.
	enc4 := &videoEncoder{w: 800, h: 600, kind: "vp8", kinds: []string{"avc1", "vp8"}}
	wm.account([]frameCost{{window: 1, enc: agentproto.GUIEncVideoKey, started: enc4}}, now)
	moving()
	if j := tick(); len(j) != 1 || j[0].vid != enc4 || slices.Contains(wm.retired, enc4) {
		t.Fatalf("stream of a later kind: %+v", j)
	}
	// No encoder on the machine.
	bin = ""
	moving()
	if tick(); m.fallback != "unavailable" {
		t.Errorf("fallback %q", m.fallback)
	}
}
