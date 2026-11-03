package agent

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// Video encoding of program windows (--gui-video). The core brings an
// encoder built on ffmpeg (scripts/build-ffmpeg.sh, scripts/encoder) and
// pushes it to ~/<data>/video/<digest prefix>/encoder, shared by
// instances; the agent runs it only when its SHA-256 is the digest the core
// sent. Builds not used for versionRetention are removed. Without one, or
// when it cannot encode, windows are sent as pictures.

// videoMaxBinary bounds what an install may write.
const videoMaxBinary = 256 << 20

// videoKinds are the stream kinds the encoder can make, in the order they
// are probed: avc1 (H.264 through NVENC, else VA-API on Intel and AMD GPUs)
// and vp8 (libvpx, on the CPU).
var videoKinds = []string{"avc1", "vp8"}

func (g *gui) videoRoot() string { return filepath.Join(g.a.home, brand.DataDirName, "video") }

func validDigest(d string) bool {
	if len(d) != 64 {
		return false
	}
	_, err := hex.DecodeString(d)
	return err == nil && strings.ToLower(d) == d
}

func (g *gui) videoDir(digest string) string { return filepath.Join(g.videoRoot(), digest[:16]) }

func fileDigest(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, videoMaxBinary)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// videoReady returns the encoder with the digest when it is installed,
// hashing it once per agent.
func (g *gui) videoReady(digest string) (string, bool) {
	if !validDigest(digest) {
		return "", false
	}
	g.videoMu.Lock()
	defer g.videoMu.Unlock()
	dir := g.videoDir(digest)
	bin := filepath.Join(dir, "encoder")
	if g.videoBin != bin {
		info, err := os.Lstat(bin)
		if err != nil || !info.Mode().IsRegular() {
			return "", false
		}
		if got, err := fileDigest(bin); err != nil || got != digest {
			return "", false
		}
		g.videoBin, g.videoKinds = bin, nil
	}
	now := time.Now()
	os.Chtimes(dir, now, now) // in use
	return bin, true
}

// installVideo writes the gzip-compressed encoder read from r, checks its
// digest and moves it into place.
func (g *gui) installVideo(digest string, r io.Reader) error {
	if !validDigest(digest) {
		return errors.New("gui: bad encoder digest")
	}
	if _, ok := g.videoReady(digest); ok {
		_, _ = io.Copy(io.Discard, r)
		return nil
	}
	root := g.videoRoot()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(root, ".fetch-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	zr, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(tmp, "encoder"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(zr, videoMaxBinary+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n > videoMaxBinary {
		return errors.New("gui: encoder too large")
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != digest {
		return fmt.Errorf("gui: encoder sha256 %s does not match expected %s", got, digest)
	}
	dir := g.videoDir(digest)
	os.RemoveAll(dir) // a damaged copy
	if err := os.Rename(tmp, dir); err != nil {
		return err
	}
	g.pruneVideo(dir)
	if _, ok := g.videoReady(digest); !ok {
		return errors.New("gui: installed encoder is not usable")
	}
	return nil
}

// pruneVideo removes other builds unused for versionRetention, and
// installs that did not finish.
func (g *gui) pruneVideo(keep string) {
	ents, _ := os.ReadDir(g.videoRoot())
	for _, e := range ents {
		p := filepath.Join(g.videoRoot(), e.Name())
		info, err := e.Info()
		if err != nil || p == keep {
			continue
		}
		limit := versionRetention
		if strings.HasPrefix(e.Name(), ".fetch-") {
			limit = stagingRetention
		}
		if time.Since(info.ModTime()) > limit {
			os.RemoveAll(p)
		}
	}
}

// videoKindsOf returns the stream kinds bin makes on this machine, probed
// once per agent by encoding a small frame.
func (g *gui) videoKindsOf(bin string) []string {
	g.videoMu.Lock()
	if g.videoBin == bin && g.videoKinds != nil {
		defer g.videoMu.Unlock()
		return g.videoKinds
	}
	g.videoMu.Unlock()
	// Probing takes seconds (GPU initialization); windows are sent as
	// pictures meanwhile.
	out := []string{}
	for _, k := range videoKinds {
		e, err := startEncoder(bin, 256, 144, []string{k})
		if err == nil {
			_, _, err = e.encode(make([]byte, 256*144*4), true)
			e.close()
		}
		if err == nil {
			out = append(out, k)
		} else {
			g.a.logger.Printf("gui: video %s unavailable: %v", k, err)
		}
	}
	g.videoMu.Lock()
	if g.videoBin == bin {
		g.videoKinds = out
	}
	g.videoMu.Unlock()
	return out
}

// videoStatus is the display's status with whether the encoder with the
// digest is installed and which stream kinds it makes here.
func (g *gui) videoStatus(digest string) *agentproto.GUIStatus {
	st := g.status()
	if bin, ok := g.videoReady(digest); ok {
		st.Video = true
		st.VideoEncoders = g.videoKindsOf(bin)
	}
	return st
}

// videoTools returns the encoder and the kinds it makes once installed and
// probed.
func (g *gui) videoTools() (string, []string) {
	g.videoMu.Lock()
	defer g.videoMu.Unlock()
	if g.videoKinds == nil {
		return "", nil
	}
	return g.videoBin, g.videoKinds
}

// videoEncoder is a running encoder process for one window size.
type videoEncoder struct {
	cmd    *exec.Cmd
	in     *os.File
	out    *os.File
	rd     *bufio.Reader
	stderr *limitedBuffer
	name   string   // h264_nvenc, h264_vaapi, libvpx
	kind   string   // avc1, vp8
	kinds  []string // what it was started for, in order
	w, h   int      // window size
	cw, ch int      // coded size
}

// videoStart bounds starting an encoder (GPU initialization) and
// videoFrameTimeout writing a frame to it and reading its packet back.
const (
	videoStart     = 15 * time.Second
	videoMaxPacket = 64 << 20
)

var videoFrameTimeout = 3 * time.Second

// startEncoder starts bin for a w×h window, making the first of kinds it
// can. The process dies with the agent.
func startEncoder(bin string, w, h int, kinds []string) (*videoEncoder, error) {
	cmd := exec.Command(bin, "-w", strconv.Itoa(w), "-h", strconv.Itoa(h), "-kinds", strings.Join(kinds, ","))
	cmd.Env = cleanEnv()
	cmd.SysProcAttr = encoderProcAttr()
	// Pipes of our own (not StdinPipe) take deadlines both ways.
	ir, in, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		ir.Close()
		in.Close()
		return nil, err
	}
	cmd.Stdin, cmd.Stdout = ir, pw
	stderr := &limitedBuffer{n: 4096}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{ir, in, pr, pw} {
			f.Close()
		}
		return nil, err
	}
	ir.Close()
	pw.Close()
	e := &videoEncoder{cmd: cmd, in: in, out: pr, rd: bufio.NewReaderSize(pr, 1<<20), stderr: stderr, w: w, h: h, kinds: slices.Clone(kinds)}
	pr.SetReadDeadline(time.Now().Add(videoStart))
	line, err := e.rd.ReadString('\n')
	f := strings.Fields(line)
	if err != nil || len(f) < 2 || f[0] != "ok" {
		e.close()
		msg := strings.TrimSpace(strings.TrimPrefix(line, "error"))
		if msg == "" && err != nil {
			msg = err.Error()
		}
		return nil, fmt.Errorf("encoder: %s %s", msg, stderr.String())
	}
	e.name = f[1]
	if len(f) >= 4 {
		e.cw, _ = strconv.Atoi(f[2])
		e.ch, _ = strconv.Atoi(f[3])
	}
	e.kind = map[string]string{"h264_nvenc": "avc1", "h264_vaapi": "avc1", "libvpx": "vp8"}[e.name]
	return e, nil
}

// encode encodes one frame (w×h BGRX), as a key frame when key is set.
func (e *videoEncoder) encode(bgrx []byte, key bool) ([]byte, bool, error) {
	var hdr [8]byte
	if key {
		hdr[0] = 1
	}
	deadline := time.Now().Add(videoFrameTimeout)
	e.in.SetWriteDeadline(deadline)
	if _, err := e.in.Write(hdr[:4]); err != nil {
		return nil, false, err
	}
	if _, err := e.in.Write(bgrx[:e.w*e.h*4]); err != nil {
		return nil, false, err
	}
	e.out.SetReadDeadline(deadline)
	if _, err := io.ReadFull(e.rd, hdr[:]); err != nil {
		return nil, false, fmt.Errorf("encoder: %v %s", err, e.stderr.String())
	}
	n := binary.LittleEndian.Uint32(hdr[:4])
	if n == 0 || n > videoMaxPacket {
		return nil, false, fmt.Errorf("encoder: packet of %d bytes", n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(e.rd, b); err != nil {
		return nil, false, err
	}
	return b, binary.LittleEndian.Uint32(hdr[4:])&1 != 0, nil
}

// codec is the WebCodecs codec string of the stream, from its first (key)
// frame.
func (e *videoEncoder) codec(first []byte) string {
	if e.kind != "avc1" {
		return e.kind
	}
	// The sequence parameter set: profile, constraints, level.
	for i := 0; i+6 < len(first); i++ {
		if first[i] == 0 && first[i+1] == 0 && first[i+2] == 1 && first[i+3]&0x1f == 7 {
			return fmt.Sprintf("avc1.%02x%02x%02x", first[i+4], first[i+5], first[i+6])
		}
	}
	return "avc1.640033"
}

func (e *videoEncoder) close() {
	e.in.Close()
	done := make(chan struct{})
	go func() {
		e.cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		killGroup(e.cmd.Process.Pid)
		<-done
	}
	e.out.Close()
}

// limitedBuffer keeps the first n bytes written to it.
type limitedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
	n  int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if room := l.n - l.b.Len(); room > 0 {
		l.b.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

func (l *limitedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.TrimSpace(l.b.String())
}

func killGroup(pid int) {
	if pid > 0 {
		syscall.Kill(-pid, syscall.SIGKILL)
	}
}
