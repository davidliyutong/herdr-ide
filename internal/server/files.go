package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
)

func (s *Server) machine(w http.ResponseWriter, r *http.Request) *machines.Machine {
	mc := s.mg.Get(r.PathValue("id"))
	if mc == nil {
		http.Error(w, "unknown machine", http.StatusNotFound)
		return nil
	}
	return mc
}

var extraTypes = map[string]string{
	".mkv": "video/x-matroska", ".mov": "video/quicktime", ".webm": "video/webm", ".mp4": "video/mp4",
	".m4v": "video/mp4", ".avif": "image/avif", ".webp": "image/webp", ".heic": "image/heic",
	".flac": "audio/flac", ".opus": "audio/ogg", ".md": "text/markdown; charset=utf-8",
	".log": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8",
	".go": "text/plain; charset=utf-8", ".rs": "text/plain; charset=utf-8", ".toml": "text/plain; charset=utf-8",
	".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8",
}

func contentType(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if t, ok := extraTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		// Never let a file be rendered as an active document from our origin.
		if strings.HasPrefix(t, "text/html") || strings.Contains(t, "javascript") || strings.Contains(t, "xhtml") {
			return "text/plain; charset=utf-8"
		}
		return t
	}
	return "application/octet-stream"
}

func parseRange(h string, size int64) (start, length int64, ok bool) {
	if !strings.HasPrefix(h, "bytes=") || strings.Contains(h, ",") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(h, "bytes=")
	a, b, found := strings.Cut(spec, "-")
	if !found {
		return 0, 0, false
	}
	if a == "" {
		n, err := strconv.ParseInt(b, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		if n > size {
			n = size
		}
		return size - n, n, true
	}
	st, err := strconv.ParseInt(a, 10, 64)
	if err != nil || st < 0 || st >= size {
		return 0, 0, false
	}
	end := size - 1
	if b != "" {
		e, err := strconv.ParseInt(b, 10, 64)
		if err != nil || e < st {
			return 0, 0, false
		}
		if e < end {
			end = e
		}
	}
	return st, end - st + 1, true
}

// fileCSP keeps a file opened as a document from running script on our
// origin.
const fileCSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"

// handleFile streams a file from a machine with HTTP Range support, so videos
// can seek without downloading everything.
func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	rep, err := requestAgent(ctx, mc, agentproto.Header{Op: agentproto.OpFsStat, Path: p})
	cancel()
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if rep.Stat.IsDir {
		http.Error(w, "is a directory", http.StatusBadRequest)
		return
	}
	serveFile(w, r, mc, rep.Stat, r.URL.Query().Get("download") == "1")
}

// serveFile streams the file st describes, as an attachment when download.
// serveFile serves a file of a machine, or the range asked for, and reports
// whether the whole response was written.
func serveFile(w http.ResponseWriter, r *http.Request, mc *machines.Machine, st *agentproto.Stat, download bool) bool {
	etag := fmt.Sprintf(`W/"%x-%x"`, st.Size, st.ModTime)
	h := w.Header()
	h.Set("ETag", etag)
	h.Set("Last-Modified", time.UnixMilli(st.ModTime).UTC().Format(http.TimeFormat))
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	ctype := contentType(st.Path)
	h.Set("Content-Type", ctype)
	// Opened as a document, a file must not run script on our origin. PDFs
	// are exempt because the browser's PDF viewer refuses sandboxed frames.
	if ctype != "application/pdf" {
		h.Set("Content-Security-Policy", fileCSP)
	}
	if download {
		h.Set("Content-Disposition", attachment(filepath.Base(st.Path)))
	}
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	start, length, partial := int64(0), st.Size, false
	if rh := r.Header.Get("Range"); rh != "" {
		if a, n, ok := parseRange(rh, st.Size); ok {
			start, length, partial = a, n, true
		} else if st.Size > 0 {
			h.Set("Content-Range", fmt.Sprintf("bytes */%d", st.Size))
			http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
			return false
		}
	}
	h.Set("Content-Length", strconv.FormatInt(length, 10))
	if partial {
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, st.Size))
		w.WriteHeader(http.StatusPartialContent)
	}
	if r.Method == http.MethodHead || length == 0 {
		return true
	}
	conn, _, err := mc.Open(r.Context(), agentproto.Header{Op: agentproto.OpFsRead, Path: st.Path, Offset: start, Length: length})
	if err != nil {
		return false
	}
	defer conn.Close()
	// A request that ends (the browser left, a download cancelled from the
	// panel) stops reading the agent's stream.
	defer endWith(r.Context(), conn)()
	_, err = io.CopyN(w, ctxReader{r.Context(), conn}, length)
	return err == nil
}

// endWith stops reads of an agent's stream that wait for data and closes it
// once ctx ends, and returns the function that stops waiting for that.
// Closing a stream alone only ends its writes.
func endWith(ctx context.Context, conn net.Conn) func() bool {
	return context.AfterFunc(ctx, func() {
		conn.SetReadDeadline(time.Now())
		conn.Close()
	})
}

// ctxReader stops reading once ctx ends. A yamux stream still returns what
// it received past its read deadline, and while the agent keeps sending,
// that never runs out.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// attachment is a Content-Disposition saving the response as name (RFC 2231
// encoding for names that are not plain ASCII).
func attachment(name string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": name})
}

// maxDownloadPaths bounds the paths of one download (the agent's limit).
const maxDownloadPaths = 1000

// downloadPaths checks the paths of a download: absolute, cleaned, without
// repeats, at most maxDownloadPaths.
func downloadPaths(raw []string) ([]string, error) {
	if len(raw) == 0 || len(raw) > maxDownloadPaths {
		return nil, fmt.Errorf("between 1 and %d paths", maxDownloadPaths)
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(raw))
	for _, p := range raw {
		if !strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) {
			return nil, fmt.Errorf("not an absolute path: %q", p)
		}
		p = path.Clean(p)
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out, nil
}

// archiveName is the file name of a zip of paths: the one path's name, or
// the name of the directory holding them all.
func archiveName(paths []string) string {
	dir := paths[0]
	if len(paths) > 1 {
		dir = path.Dir(paths[0])
		for _, p := range paths[1:] {
			for dir != "/" && !strings.HasPrefix(p, dir+"/") {
				dir = path.Dir(dir)
			}
		}
	}
	if base := path.Base(dir); base != "/" && base != "." {
		return base + ".zip"
	}
	return "download.zip"
}

// handleDownload saves files and directories of a machine in the browser
// (GET /api/m/{id}/download?path=…&path=…): one file as itself, anything
// else as a zip the agent makes while it is downloaded (fs.archive).
func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	// A download the page follows in its downloads panel (downloads.go).
	d, w, r := s.trackDownload(w, r)
	defer d.finish()
	mc := s.machine(w, r)
	if mc == nil {
		d.fail(dlNotFound)
		return
	}
	paths, err := downloadPaths(r.URL.Query()["path"])
	if err != nil {
		d.fail(dlInvalid)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if r.Method != http.MethodHead { // the browser's check before a download
		s.audit.log(r, "file.download", map[string]any{"machine": mc.ID(), "paths": paths})
	}
	if len(paths) == 1 {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		rep, err := requestAgent(ctx, mc, agentproto.Header{Op: agentproto.OpFsStat, Path: paths[0]})
		cancel()
		if err != nil {
			d.fail(failCode(err))
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if !rep.Stat.IsDir {
			d.describe(filepath.Base(rep.Stat.Path), rep.Stat.Size)
			if serveFile(w, r, mc, rep.Stat, true) {
				d.done()
			} else if d.broken() {
				// Cancelled from the panel or the machine went away: the
				// browser must see a failed download.
				panic(http.ErrAbortHandler)
			}
			return
		}
	}
	zipHeaders := func() {
		h := w.Header()
		h.Set("Content-Type", "application/zip")
		h.Set("Content-Disposition", attachment(archiveName(paths)))
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", fileCSP)
	}
	if r.Method == http.MethodHead {
		zipHeaders()
		return
	}
	conn, _, err := mc.Open(r.Context(), agentproto.Header{Op: agentproto.OpFsArchive, Paths: paths})
	if err != nil {
		d.fail(failCode(err))
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	defer conn.Close()
	// A browser that cancels the download, or the panel, ends the agent's
	// walk.
	defer endWith(r.Context(), conn)()
	d.describe(archiveName(paths), -1)
	zipHeaders()
	if _, err := io.Copy(w, ctxReader{r.Context(), conn}); err != nil {
		if d.broken() || (d == nil && r.Context().Err() == nil) {
			// Cancelled from the panel or the machine went away mid-archive:
			// end the response unfinished, so the browser reports a failed
			// download, not a truncated zip.
			panic(http.ErrAbortHandler)
		}
		return
	}
	d.done()
}

// failCode is the download code for an agent's refusal: the machine is not
// connected, or the path is not there.
func failCode(err error) string {
	if errors.Is(err, machines.ErrNotConnected) {
		return dlUnavailable
	}
	return dlNotFound
}

func requestAgent(ctx context.Context, mc *machines.Machine, h agentproto.Header) (*agentproto.Reply, error) {
	conn, rep, err := mc.Open(ctx, h)
	if err != nil {
		return rep, err
	}
	conn.Close()
	if rep.Stat == nil && (h.Op == agentproto.OpFsStat || h.Op == agentproto.OpFsList) {
		return rep, errors.New("missing stat")
	}
	return rep, nil
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	rep, err := requestAgent(ctx, mc, agentproto.Header{Op: agentproto.OpFsList, Path: r.URL.Query().Get("path")})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dir": rep.Stat, "entries": rep.Entries})
}

const maxUpload = 4 << 30

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// uploadName makes a unique, shell-friendly file name for an upload: several
// clipboard images are all called "image.png", so a timestamp alone would let
// one overwrite another.
func uploadName(original string, now time.Time) string {
	base := unsafeName.ReplaceAllString(filepath.Base(original), "_")
	base = strings.Trim(base, "._")
	if base == "" {
		base = "upload"
	}
	if len(base) > 80 {
		base = base[len(base)-80:]
	}
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	return now.Format("20060102-150405") + "-" + hex.EncodeToString(rnd[:]) + "-" + base
}

// keptName is the name of an upload placed in a directory the user chose:
// its own base name without control characters (at most 200 bytes, keeping
// the end), or "upload".
func keptName(original string) string {
	base := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, filepath.Base(original))
	base = strings.TrimSpace(base)
	if base == "." || base == ".." || base == "/" || base == "" {
		base = "upload"
	}
	for len(base) > 200 {
		_, n := utf8.DecodeRuneInString(base)
		base = base[n:]
	}
	return base
}

// uploadHeader is the agent request that writes an upload named name: into
// the upload directory under a unique name, or with dir (absolute or ~/)
// into that existing directory under its own name, never replacing a file.
func uploadHeader(q url.Values, uploadDir string, now time.Time) (agentproto.Header, error) {
	dir := q.Get("dir")
	if dir == "" {
		return agentproto.Header{Op: agentproto.OpFsWrite, Path: filepath.Join(uploadDir, uploadName(q.Get("name"), now)), Mkdirs: true}, nil
	}
	if !filepath.IsAbs(dir) && dir != "~" && !strings.HasPrefix(dir, "~/") {
		return agentproto.Header{}, errors.New("dir must be absolute")
	}
	return agentproto.Header{Op: agentproto.OpFsWrite, Path: filepath.Join(dir, keptName(q.Get("name"))), Unique: true}, nil
}

// handleUpload writes the request body to a file on the machine (used for
// dropped files and pasted images handed to agents; see uploadHeader).
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	mc := s.machine(w, r)
	if mc == nil {
		return
	}
	st := mc.State()
	if st.Info == nil || st.Info.UploadDir == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "machine not connected"})
		return
	}
	h, err := uploadHeader(r.URL.Query(), st.Info.UploadDir, time.Now())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.audit.log(r, "file.upload", map[string]any{"machine": mc.ID(), "path": h.Path, "size": r.ContentLength})
	conn, _, err := mc.Open(r.Context(), h)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	defer conn.Close()
	cw := agentproto.ChunkWriter{W: conn}
	if _, err := io.Copy(cw, io.LimitReader(r.Body, maxUpload)); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	if err := cw.Finish(); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(conn, &rep); err != nil || !rep.OK {
		msg := rep.Error
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, rep.Stat)
}
