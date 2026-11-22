package codex

import (
	"io"
	"sync"
	"time"
)

// The waits of a graceful end (process.end) and of the pipes after it;
// variables for the tests.
var (
	// closeWait is how long the app-server has to exit once its input is
	// closed before it gets SIGTERM.
	closeWait = 2 * time.Second
	// killWait is how long it has after SIGTERM before SIGKILL.
	killWait = 5 * time.Second
	// drainWait is how long what the app-server wrote before its end is
	// read once it is gone.
	drainWait = time.Second
)

// stderrKeep is how much of the end of the app-server's standard error is
// kept, for the error of a session that ended.
const stderrKeep = 8 << 10

// process is an app-server: a process group of its own, a pipe to its
// input and one from its output, and the end of its standard error.
type process struct {
	pid    int
	stdin  io.WriteCloser
	stdout io.ReadCloser
	tail   *ring

	exited  chan struct{} // closed once the process was waited for
	waitErr error         // its exit, valid once exited is closed
	endOnce sync.Once
}

func newProcess(pid int, stdin io.WriteCloser, stdout io.ReadCloser) *process {
	return &process{pid: pid, stdin: stdin, stdout: stdout, tail: &ring{max: stderrKeep}, exited: make(chan struct{})}
}

// ring keeps the last max bytes written to it.
type ring struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (r *ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.b = append(r.b, p...)
	if over := len(r.b) - r.max; over > 0 {
		r.b = append(r.b[:0], r.b[over:]...)
	}
	return len(p), nil
}

func (r *ring) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.b)
}
