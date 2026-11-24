// Command yamuxpeer is hashicorp/yamux with the configuration of the core
// and the agent (agentproto.YamuxConfig) over stdin and stdout, for the
// interop tests of backend/shared/yamux.ts while both implementations exist.
//
//	yamuxpeer server         accept streams and answer their command
//	yamuxpeer client <bytes> open streams to the other end and check them
//
// A stream's first line is its command: "echo" (copy back until EOF),
// "sink" (read to EOF, answer "<n> <sha256>"), "source <n> <seed>" (write
// n bytes of the test pattern). Results go to stderr as PASS/FAIL lines.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/hashicorp/yamux"

	"veldr/internal/agentproto"
)

type stdio struct{}

func (stdio) Read(p []byte) (int, error)  { return os.Stdin.Read(p) }
func (stdio) Write(p []byte) (int, error) { return os.Stdout.Write(p) }
func (stdio) Close() error                { os.Stdout.Close(); return os.Stdin.Close() }

// xs is xorshift32, the test pattern of yamux.test.ts.
type xs struct{ s uint32 }

func (x *xs) Read(p []byte) (int, error) {
	for i := range p {
		x.s ^= x.s << 13
		x.s ^= x.s >> 17
		x.s ^= x.s << 5
		p[i] = byte(x.s)
	}
	return len(p), nil
}

func pattern(n, seed int64) io.Reader {
	return io.LimitReader(&xs{uint32(seed)*2654435761 | 1}, n)
}

func sum(r io.Reader) (int64, string) {
	h := sha256.New()
	n, _ := io.Copy(h, r)
	return n, hex.EncodeToString(h.Sum(nil))
}

func serve(s *yamux.Stream) {
	defer s.Close()
	r := bufio.NewReader(s)
	line, err := r.ReadString('\n')
	if err != nil {
		return
	}
	f := strings.Fields(line)
	switch f[0] {
	case "echo":
		io.Copy(s, r)
	case "sink":
		n, h := sum(r)
		fmt.Fprintf(s, "%d %s\n", n, h)
	case "source":
		n, _ := strconv.ParseInt(f[1], 10, 64)
		seed, _ := strconv.ParseInt(f[2], 10, 64)
		io.Copy(s, pattern(n, seed))
	}
}

func report(ok bool, format string, a ...any) {
	word := "PASS"
	if !ok {
		word = "FAIL"
	}
	fmt.Fprintf(os.Stderr, word+" "+format+"\n", a...)
}

func client(sess *yamux.Session, size int64) {
	var wg sync.WaitGroup
	var mu sync.Mutex
	var bad []string
	for i := int64(0); i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st, err := sess.OpenStream()
			if err != nil {
				mu.Lock()
				bad = append(bad, err.Error())
				mu.Unlock()
				return
			}
			n := size * (i + 1) / 32
			fmt.Fprintf(st, "echo\n")
			go func() { io.Copy(st, pattern(n, i)); st.Close() }()
			m, got := sum(st)
			_, want := sum(pattern(n, i))
			if m != n || got != want {
				mu.Lock()
				bad = append(bad, fmt.Sprintf("echo %d: %d of %d bytes", i, m, n))
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	report(len(bad) == 0, "go client: 32 concurrent echo streams %v", bad)

	st, _ := sess.OpenStream()
	fmt.Fprintf(st, "sink\n")
	io.Copy(st, pattern(size, 7))
	st.Close() // a half-close: the answer still arrives
	line, _ := bufio.NewReader(st).ReadString('\n')
	n, h := sum(pattern(size, 7))
	report(line == fmt.Sprintf("%d %s\n", n, h), "go client: sink, half-close, answer %q", strings.TrimSpace(line))

	st, _ = sess.OpenStream()
	fmt.Fprintf(st, "source %d 9\n", size)
	m, got := sum(st)
	_, want := sum(pattern(size, 9))
	report(m == size && got == want, "go client: source of %d bytes, got %d", size, m)

	_, err := sess.Ping()
	report(err == nil, "go client: ping (%v)", err)
	sess.Close()
}

func main() {
	cfg := agentproto.YamuxConfig(log.New(os.Stderr, "", 0))
	if len(os.Args) > 1 && os.Args[1] == "client" {
		size, _ := strconv.ParseInt(os.Args[2], 10, 64)
		sess, err := yamux.Client(stdio{}, cfg)
		if err != nil {
			log.Fatal(err)
		}
		client(sess, size)
		return
	}
	sess, err := yamux.Server(stdio{}, cfg)
	if err != nil {
		log.Fatal(err)
	}
	for {
		st, err := sess.AcceptStream()
		if err != nil {
			return
		}
		go serve(st)
	}
}
