package agent

import (
	"archive/zip"
	"compress/flate"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"

	"herdr-ide/internal/agentproto"
)

// maxArchivePaths bounds the paths of one fs.archive request.
const maxArchivePaths = 1000

// handleArchive streams the files and directories at h.Paths as one zip
// archive (docs/features/06-quick-look-and-files.md): each at the archive's
// root under its base name, directories with everything below them. The
// paths named are followed when they are symbolic links; links below them
// are stored as links. Irregular files (sockets, devices, FIFOs) and
// anything unreadable are left out. Nothing is written on the machine; the
// walk stops when the stream fails (the browser went away). With h.Chunked
// the archive is framed, and its end marked once it is complete.
func (a *Agent) handleArchive(st net.Conn, h agentproto.Header) error {
	defer st.Close()
	if len(h.Paths) == 0 || len(h.Paths) > maxArchivePaths {
		return agentproto.Fail(st, fmt.Errorf("archive: between 1 and %d paths", maxArchivePaths))
	}
	roots := make([]string, 0, len(h.Paths))
	for _, p := range h.Paths {
		full, err := a.expand(p)
		if err != nil {
			return agentproto.Fail(st, err)
		}
		if _, err := os.Stat(full); err != nil {
			return agentproto.Fail(st, err)
		}
		roots = append(roots, full)
	}
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		return err
	}
	if !h.Chunked {
		return writeArchive(st, roots)
	}
	cw := agentproto.ChunkWriter{W: st}
	if err := writeArchive(cw, roots); err != nil {
		return err
	}
	return cw.Finish()
}

// writeArchive writes roots as a zip to w; it fails only when w does.
func writeArchive(w io.Writer, roots []string) error {
	out := &stickyWriter{w: w}
	zw := zip.NewWriter(out)
	// Speed over size: the archive is made while it is downloaded.
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(w, flate.BestSpeed)
	})
	for i, name := range archiveNames(roots) {
		if err := addTree(zw, out, roots[i], name); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return out.err
}

// stickyWriter keeps the first write error, so a failed stream stops the
// walk while read errors of single files only cut those files short.
type stickyWriter struct {
	w   io.Writer
	err error
}

func (s *stickyWriter) Write(p []byte) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	n, err := s.w.Write(p)
	if err != nil {
		s.err = err
	}
	return n, err
}

// archiveNames are the names of roots at the archive's root: their base
// names, a repeated one with -1, -2… before its extension.
func archiveNames(roots []string) []string {
	taken := map[string]bool{}
	out := make([]string, len(roots))
	for i, r := range roots {
		base := filepath.Base(r)
		if base == string(filepath.Separator) || base == "." {
			base = "root"
		}
		ext := path.Ext(base)
		if ext == base {
			ext = ""
		}
		stem := strings.TrimSuffix(base, ext)
		name := base
		for n := 1; taken[name]; n++ {
			name = fmt.Sprintf("%s-%d%s", stem, n, ext)
		}
		taken[name] = true
		out[i] = name
	}
	return out
}

// addTree adds root and everything below it under name. It returns only
// the stream's error.
func addTree(zw *zip.Writer, out *stickyWriter, root, name string) error {
	walkRoot := root
	if real, err := filepath.EvalSymlinks(root); err == nil {
		walkRoot = real
	}
	_ = filepath.WalkDir(walkRoot, func(p string, d fs.DirEntry, err error) error {
		if out.err != nil {
			return out.err
		}
		if err != nil || d == nil {
			// Unreadable: left out (a directory's entries read so far stay).
			return nil
		}
		rel, rerr := filepath.Rel(walkRoot, p)
		if rerr != nil {
			return nil
		}
		entry := name
		if rel != "." {
			entry = name + "/" + filepath.ToSlash(rel)
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		addEntry(zw, p, entry, info)
		return out.err
	})
	return out.err
}

// addEntry adds one file, directory or symbolic link; others are left out.
func addEntry(zw *zip.Writer, p, entry string, info fs.FileInfo) {
	mode := info.Mode()
	switch {
	case mode.IsDir():
		hdr := &zip.FileHeader{Name: entry + "/", Method: zip.Store, Modified: info.ModTime()}
		hdr.SetMode(mode)
		_, _ = zw.CreateHeader(hdr)
	case mode&fs.ModeSymlink != 0:
		target, err := os.Readlink(p)
		if err != nil {
			return
		}
		hdr := &zip.FileHeader{Name: entry, Method: zip.Store, Modified: info.ModTime()}
		hdr.SetMode(mode)
		if w, err := zw.CreateHeader(hdr); err == nil {
			_, _ = io.WriteString(w, target)
		}
	case mode.IsRegular():
		f, err := os.Open(p)
		if err != nil {
			return
		}
		defer f.Close()
		hdr := &zip.FileHeader{Name: entry, Method: zip.Deflate, Modified: info.ModTime()}
		hdr.SetMode(mode)
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return
		}
		_, _ = io.Copy(w, f)
	}
}
