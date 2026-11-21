package usage

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"hash/fnv"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

// parseLog reads a log into ent (whose Size and MTime are the file's): on
// from where old ended when the log only grew (old's records, models and
// parser state carried over), else from the start. A log that is not
// gzipped may be growing: its last line counts once it ends. It returns
// how many bytes it read. OpenCode's database is read whole (its rows
// change in place), from since on, until ctx ends.
func parseLog(ctx context.Context, lf logFile, old, ent *fileEntry, since int64) (int64, error) {
	if lf.kind == logOpenCode {
		return parseOpenCodeDB(ctx, lf.path, ent, since)
	}
	f, err := openRegular(lf.path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	gzipped := strings.HasSuffix(lf.path, ".gz")
	var r io.Reader = f
	from := int64(0)
	if !gzipped && old != nil && old.Kind == lf.kind && old.Off > 0 && old.Off <= ent.Size && ent.MTime >= old.MTime &&
		(lf.kind != logCodex || old.Codex != nil) && endsLine(f, old.Off) {
		from = old.Off
		ent.Records = old.Records
		ent.Models = old.Models
		if old.Codex != nil {
			st := *old.Codex
			ent.Codex = &st
		}
		if _, err := f.Seek(from, io.SeekStart); err != nil {
			return 0, err
		}
	}
	if gzipped {
		gz, err := gzip.NewReader(f)
		if err != nil {
			return 0, err
		}
		defer gz.Close()
		r = gz
	}
	var end int64
	if parse := logParsers[lf.kind]; parse != nil {
		end, err = parse(lf.path, r, gzipped, ent)
	}
	if !gzipped {
		ent.Off = from + end
	}
	return ent.Size - from, err
}

// logParser reads a log of one kind from r into ent and returns the offset
// after its last complete line; with final a last line that does not end
// counts too (r is the whole of a gzipped log).
type logParser func(file string, r io.Reader, final bool, ent *fileEntry) (int64, error)

// logParsers are the parsers of the kinds of log files.
var logParsers = map[string]logParser{
	logClaude: perLine(parseClaudeLine),
	logCodex: func(file string, r io.Reader, _ bool, ent *fileEntry) (int64, error) {
		return parseCodexLog(file, r, ent)
	},
	logGrok:       perLine(parseGrokUpdate),
	logGrokLegacy: perLine(func(_ string, line []byte, ent *fileEntry) { parseGrokUnified(line, ent) }),
	logGrokEvents: func(file string, r io.Reader, final bool, ent *fileEntry) (int64, error) {
		if ent.Models == nil {
			ent.Models = map[string]string{}
		}
		return eachLine(r, final, func(line []byte) { parseGrokEvent(line, ent) })
	},
}

// perLine is the parser of a log whose lines are read one by one.
func perLine(fn func(file string, line []byte, ent *fileEntry)) logParser {
	return func(file string, r io.Reader, final bool, ent *fileEntry) (int64, error) {
		return eachLine(r, final, func(line []byte) { fn(file, line, ent) })
	}
}

// endsLine tells whether the byte before off is a newline: a log read on
// from off was not rewritten up to there.
func endsLine(f *os.File, off int64) bool {
	var b [1]byte
	_, err := f.ReadAt(b[:], off-1)
	return err == nil && b[0] == '\n'
}

// eachLine calls fn with every non-empty line of r shorter than maxLine
// that ends with a newline, and with final also with a last one that does
// not; it returns the offset after the last newline.
func eachLine(r io.Reader, final bool, fn func([]byte)) (int64, error) {
	br := bufio.NewReaderSize(r, 64<<10)
	var buf []byte
	var off, end int64
	long := false
	for {
		chunk, err := br.ReadSlice('\n')
		off += int64(len(chunk))
		if !long {
			if len(buf)+len(chunk) > maxLine {
				long, buf = true, buf[:0]
			} else {
				buf = append(buf, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		complete := len(chunk) > 0 && chunk[len(chunk)-1] == '\n'
		if !long && (complete || final && err == io.EOF) {
			if line := bytes.TrimSpace(buf); len(line) > 0 {
				fn(line)
			}
		}
		if complete {
			end = off
		}
		buf, long = buf[:0], false
		if err != nil {
			if err == io.EOF {
				return end, nil
			}
			return end, err
		}
	}
}

func hashKey(parts ...string) string {
	h := fnv.New64a()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return strconv.FormatUint(h.Sum64(), 36)
}

func isoTime(s string) int64 {
	if s == "" {
		return 0
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.Unix()
	}
	if len(s) >= 19 {
		if t, err := time.Parse("2006-01-02T15:04:05", s[:19]); err == nil {
			return t.Unix()
		}
	}
	return 0
}

func projectName(cwd string) string {
	cwd = strings.TrimRight(cwd, "/")
	if cwd == "" {
		return ""
	}
	return path.Base(cwd)
}
