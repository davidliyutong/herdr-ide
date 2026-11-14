package agent

import (
	"errors"
	"fmt"
	"herdr-ide/internal/brand"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"herdr-ide/internal/agentproto"
)

const maxListEntries = 20000

func statOf(path string, fi fs.FileInfo, isLink bool) agentproto.Stat {
	return agentproto.Stat{
		Name:    fi.Name(),
		Path:    path,
		Size:    fi.Size(),
		Mode:    uint32(fi.Mode().Perm()),
		ModTime: fi.ModTime().UnixMilli(),
		IsDir:   fi.IsDir(),
		IsLink:  isLink,
	}
}

func (a *Agent) handleFS(st net.Conn, h agentproto.Header) error {
	defer st.Close()
	path, err := a.expand(h.Path)
	if err != nil {
		return agentproto.Fail(st, err)
	}
	switch h.Op {
	case agentproto.OpFsStat:
		lfi, err := os.Lstat(path)
		if err != nil {
			return agentproto.Fail(st, err)
		}
		fi := lfi
		if lfi.Mode()&os.ModeSymlink != 0 {
			if t, err := os.Stat(path); err == nil {
				fi = t
			}
		}
		s := statOf(path, fi, lfi.Mode()&os.ModeSymlink != 0)
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, Stat: &s})

	case agentproto.OpFsList:
		ents, err := os.ReadDir(path)
		if err != nil {
			return agentproto.Fail(st, err)
		}
		out := make([]agentproto.Stat, 0, len(ents))
		for i, e := range ents {
			if i >= maxListEntries {
				break
			}
			full := filepath.Join(path, e.Name())
			isLink := e.Type()&os.ModeSymlink != 0
			fi, err := os.Stat(full)
			if err != nil {
				fi, err = e.Info()
				if err != nil {
					continue
				}
			}
			s := statOf("", fi, isLink)
			s.Name = e.Name()
			out = append(out, s)
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].IsDir != out[j].IsDir {
				return out[i].IsDir
			}
			return out[i].Name < out[j].Name
		})
		s := agentproto.Stat{Name: filepath.Base(path), Path: path, IsDir: true}
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, Stat: &s, Entries: out})

	case agentproto.OpFsRead:
		f, err := os.Open(path)
		if err != nil {
			return agentproto.Fail(st, err)
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil {
			return agentproto.Fail(st, err)
		}
		if fi.IsDir() {
			return agentproto.Fail(st, fmt.Errorf("%s is a directory", path))
		}
		if h.Offset < 0 || h.Offset > fi.Size() {
			return agentproto.Fail(st, errors.New("offset out of range"))
		}
		length := h.Length
		if length <= 0 || h.Offset+length > fi.Size() {
			length = fi.Size() - h.Offset
		}
		if _, err := f.Seek(h.Offset, io.SeekStart); err != nil {
			return agentproto.Fail(st, err)
		}
		s := statOf(path, fi, false)
		if err := agentproto.WriteLine(st, agentproto.Reply{OK: true, Stat: &s}); err != nil {
			return err
		}
		_, err = io.CopyN(st, f, length)
		return err

	case agentproto.OpFsWrite:
		dir := filepath.Dir(path)
		if h.Mkdirs {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return agentproto.Fail(st, err)
			}
		}
		tmp, err := os.CreateTemp(dir, "."+brand.Slug+"-upload-*")
		if err != nil {
			return agentproto.Fail(st, err)
		}
		if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return err
		}
		_, cerr := io.Copy(tmp, &agentproto.ChunkReader{R: st})
		if cerr == nil {
			cerr = tmp.Close()
		} else {
			tmp.Close()
		}
		mode := os.FileMode(0o644)
		if h.Args != nil && len(h.Args) > 0 && h.Args[0] == "exec" {
			mode = 0o755
		}
		if cerr == nil {
			cerr = os.Chmod(tmp.Name(), mode)
		}
		if cerr == nil && h.Unique {
			path, cerr = freeName(path)
		}
		if cerr == nil {
			cerr = os.Rename(tmp.Name(), path)
		}
		if cerr != nil {
			os.Remove(tmp.Name())
			return agentproto.Fail(st, cerr)
		}
		fi, err := os.Stat(path)
		if err != nil {
			return agentproto.Fail(st, err)
		}
		s := statOf(path, fi, false)
		return agentproto.WriteLine(st, agentproto.Reply{OK: true, Stat: &s})
	}
	return agentproto.Fail(st, fmt.Errorf("unknown fs op %q", h.Op))
}

// freeName claims path, or the first free name with -1, -2… before its
// extension, by creating it exclusively (a symlink there counts as taken);
// the upload is then renamed over the empty file it claimed.
func freeName(path string) (string, error) {
	dir, base := filepath.Split(path)
	ext := filepath.Ext(base)
	if ext == base {
		ext = "" // .env
	}
	stem := strings.TrimSuffix(base, ext)
	for i := 0; i < 1000; i++ {
		p := path
		if i > 0 {
			p = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
		}
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return p, f.Close()
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	return "", fmt.Errorf("no free name for %s", base)
}
