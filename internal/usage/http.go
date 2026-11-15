package usage

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"time"
)

// Timeout bounds every request to a provider.
const Timeout = 15 * time.Second

// maxBody bounds a provider's answer.
const maxBody = 4 << 20

// NewClient is the client for the providers: the proxy of HTTPS_PROXY (and
// NO_PROXY), a 15 s timeout, no cookies, and no redirects (a provider's
// 3xx is an error, http_3xx, so credentials go to the fixed hosts only).
func NewClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = http.ProxyFromEnvironment
	return &http.Client{Timeout: Timeout, Transport: tr, CheckRedirect: noRedirect}
}

// noRedirect stops at the first answer: a redirect is returned as it is.
func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// httpError is a request that failed: Code for the account, RetryAfter in
// seconds for a 429.
type httpError struct {
	Status     int
	Code       string
	RetryAfter int64
}

func (e *httpError) Error() string { return e.Code }

// getJSON asks url with headers and decodes the answer into out.
func getJSON(ctx context.Context, c *http.Client, method, url string, headers map[string]string, body []byte, out any) error {
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return &httpError{Code: "bad_request"}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "usage-monitor")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.Do(req)
	if err != nil {
		return &httpError{Code: "network"}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
	if err != nil {
		return &httpError{Code: "network"}
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return &httpError{Status: res.StatusCode, Code: "unauthorized"}
	case res.StatusCode == http.StatusTooManyRequests:
		return &httpError{Status: res.StatusCode, Code: "rate_limited", RetryAfter: retryAfter(res.Header.Get("Retry-After"), time.Now())}
	case res.StatusCode < 200 || res.StatusCode > 299:
		return &httpError{Status: res.StatusCode, Code: "http_" + strconv.Itoa(res.StatusCode)}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return &httpError{Code: "bad_response"}
	}
	return nil
}

// retryAfter reads a Retry-After header (seconds or an HTTP date); 60 s
// when it says nothing usable, at most a day.
func retryAfter(h string, now time.Time) int64 {
	h = strings.TrimSpace(h)
	var s int64 = 60
	if n, err := strconv.ParseInt(h, 10, 64); err == nil && n > 0 {
		s = n
	} else if t, err := http.ParseTime(h); err == nil {
		if d := int64(t.Sub(now).Seconds()); d > 0 {
			s = d
		}
	}
	return min(s, 86400)
}

// failed marks a with the error of a request.
func failed(a Account, err error) Account {
	var he *httpError
	if !errors.As(err, &he) {
		a.Status, a.Code = StatusError, "failed"
		return a
	}
	a.Code = he.Code
	switch he.Code {
	case "unauthorized":
		a.Status = StatusUnauth
	default:
		a.Status = StatusError
		a.RetryAfter = he.RetryAfter
	}
	return a
}

// normalizeJSON turns json.Number values into float64 so that num and
// friends see one type.
func normalizeJSON(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			x[k] = normalizeJSON(e)
		}
	case []any:
		for i, e := range x {
			x[i] = normalizeJSON(e)
		}
	case json.Number:
		if f, err := x.Float64(); err == nil {
			return f
		}
		return x.String()
	}
	return v
}

// getMap asks url and returns the decoded object.
func getMap(ctx context.Context, c *http.Client, method, url string, headers map[string]string, body []byte) (map[string]any, error) {
	var v any
	if err := getJSON(ctx, c, method, url, headers, body, &v); err != nil {
		return nil, err
	}
	m := obj(normalizeJSON(v))
	if m == nil {
		return nil, &httpError{Code: "bad_response"}
	}
	return m, nil
}

// keychain reads a generic password of the user's macOS keychain with
// security(1); it fails without prompting where no one can answer.
func keychain(ctx context.Context, service string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-s", service, "-w").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// runCommand runs a program with env and returns its standard output (at
// most maxBody); ctx bounds it. On Unix it runs in a process group of its
// own, which is killed when ctx ends and again once the program exited, so
// nothing it started (agy's helpers) outlives it.
func runCommand(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = env
	cmd.Stdin = nil
	var out bytes.Buffer
	cmd.Stdout = &limitWriter{w: &out, n: maxBody}
	cmd.WaitDelay = 2 * time.Second
	ownGroup(cmd)
	err := cmd.Run()
	killGroup(cmd)
	return out.Bytes(), err
}

// systemTool is the program at abs when it is there, else its name looked
// up on the PATH.
func systemTool(abs string) string {
	if st, err := os.Stat(abs); err == nil && !st.IsDir() {
		return abs
	}
	return path.Base(abs)
}

type limitWriter struct {
	w io.Writer
	n int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	q := p
	if len(q) > l.n {
		q = q[:l.n]
	}
	l.n -= len(q)
	if _, err := l.w.Write(q); err != nil {
		return 0, err
	}
	return len(p), nil
}

// lookPath finds a program on the PATH of environ, then in the places
// installers put programs that a login shell would add.
func lookPath(environ func() []string) func(string) (string, error) {
	return func(name string) (string, error) {
		var dirs []string
		for _, kv := range environ() {
			if v, ok := strings.CutPrefix(kv, "PATH="); ok {
				dirs = strings.Split(v, ":")
			}
		}
		if home, err := os.UserHomeDir(); err == nil {
			dirs = append(dirs, path.Join(home, ".local/bin"), path.Join(home, "bin"), path.Join(home, ".antigravity/bin"))
		}
		dirs = append(dirs, "/usr/local/bin", "/opt/homebrew/bin")
		for _, d := range dirs {
			if d == "" || !path.IsAbs(d) {
				continue
			}
			p := path.Join(d, name)
			if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
				return p, nil
			}
		}
		return "", fmt.Errorf("%s not found", name)
	}
}

// localClient reaches the local language server on 127.0.0.1:port only:
// whatever the URL names, it dials that address, uses no proxy, and accepts
// the server's self-signed certificate.
func localClient(port int) *http.Client {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", addr)
		},
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true}, // the language server's own certificate, on loopback only
		TLSHandshakeTimeout: 5 * time.Second,
	}
	return &http.Client{Timeout: 5 * time.Second, Transport: tr, CheckRedirect: noRedirect}
}
