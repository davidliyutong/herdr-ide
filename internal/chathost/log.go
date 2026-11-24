//go:build unix

package chathost

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"sync"
	"time"

	"veldr/internal/store"
)

// The host's log file in the instance's data directory, one for each host
// of a shared home (store.HostFile: chat-host-<host>.log): what the host
// logs, beside its standard error, which only its hidden terminal shows.
// It is started again once it reaches LogMax bytes, the one before kept
// (chat-host.old-<host>.log); the files of other hosts nobody wrote for
// store.HostFileRetention go when a host opens its own.
const (
	LogName    = "chat-host.log"
	OldLogName = "chat-host.old.log"
	LogMax     = 1 << 20
)

// logFile is the host's log file, started again past max bytes.
type logFile struct {
	mu        sync.Mutex
	path, old string
	max       int64
	f         *os.File
	size      int64
}

// OpenLog opens the host's log file in the data directory base (0600),
// for a log that is written to it as well: what is written past LogMax
// bytes goes to a new file, the one before kept as the old one.
func OpenLog(base string) (io.WriteCloser, error) {
	if err := os.MkdirAll(base, 0o700); err != nil {
		return nil, err
	}
	for _, name := range []string{LogName, OldLogName} {
		store.PruneHostFiles(base, name, store.HostFileRetention, time.Now())
	}
	l := &logFile{path: store.HostFile(base, LogName), old: store.HostFile(base, OldLogName), max: LogMax}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *logFile) open() error {
	f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		f.Close()
		return errors.Join(err, errors.New("chathost: the log is not a regular file"))
	}
	f.Chmod(0o600)
	l.f, l.size = f, st.Size()
	return nil
}

// Write appends p, after starting a new file when p would take the file
// past its bounds.
func (l *logFile) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return 0, fs.ErrClosed
	}
	if l.size > 0 && l.size+int64(len(p)) > l.max {
		l.f.Close()
		l.f = nil
		if err := os.Rename(l.path, l.old); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return 0, err
		}
		if err := l.open(); err != nil {
			return 0, err
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}

func (l *logFile) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// Tee is a writer to each of ws, whatever one of them answers: a log that
// goes to a file and to a terminal nobody reads stops at neither.
func Tee(ws ...io.Writer) io.Writer { return tee(ws) }

type tee []io.Writer

func (t tee) Write(p []byte) (int, error) {
	for _, w := range t {
		w.Write(p)
	}
	return len(p), nil
}
