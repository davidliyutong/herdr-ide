package agent

import (
	"context"
	"errors"
	"fmt"
	"herdr-ide/internal/brand"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"

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

const maxExecOutput = 8 << 20

type cappedBuffer struct {
	buf       []byte
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	room := maxExecOutput - len(c.buf)
	if room <= 0 {
		c.truncated = true
		return len(p), nil
	}
	if len(p) > room {
		c.buf = append(c.buf, p[:room]...)
		c.truncated = true
		return len(p), nil
	}
	c.buf = append(c.buf, p...)
	return len(p), nil
}

func (a *Agent) handleExec(ctx context.Context, st net.Conn, h agentproto.Header) error {
	defer st.Close()
	if len(h.Argv) == 0 {
		return agentproto.Fail(st, errors.New("exec: empty argv"))
	}
	timeout := 30 * time.Second
	if h.Timeout > 0 {
		timeout = time.Duration(h.Timeout) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	argv := h.Argv
	if argv[0] == "herdr" {
		bin, err := a.resolveHerdr(h.HerdrBin)
		if err != nil {
			return agentproto.Fail(st, err)
		}
		argv = append([]string{bin}, herdrArgs(h.Session, argv[1:]...)...)
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = cleanEnv()
	if h.Cwd != "" {
		cwd, err := a.expand(h.Cwd)
		if err != nil {
			return agentproto.Fail(st, err)
		}
		cmd.Dir = cwd
	}
	var stdout, stderr cappedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := &agentproto.ExecResult{
		Stdout:    string(stdout.buf),
		Stderr:    string(stderr.buf),
		Truncated: stdout.truncated || stderr.truncated,
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			res.ExitCode = ee.ExitCode()
		} else {
			return agentproto.Fail(st, err)
		}
	}
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, Exec: res})
}
