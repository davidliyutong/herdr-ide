package usage

// Kimi Code's sign-in, renewed as Kimi Code renews it (its packages/oauth,
// CLI 2.2.0): its access token lasts about 15 minutes and the CLI renews
// it only while it runs, with a refresh token that is good once (each
// refresh returns a new one). So a renewal here must do what the CLI does,
// under the CLI's own lock, and write the new tokens back where the CLI
// reads them; otherwise the CLI would be left with a spent refresh token
// and signed out.
//
//   - Lock: proper-lockfile 4.1.2 on <home>/oauth/kimi-code (the CLI first
//     creates that empty file and its directory): the lock is the
//     directory <home>/oauth/kimi-code.lock, made with mkdir; its holder
//     sets its mtime every 2.5 s (update = stale/2); others treat it as
//     stale once its mtime is 5 s old (stale: 5000), remove it with rmdir
//     and mkdir it again; the CLI retries 120 times every 0.5 s. A holder
//     whose lock changed under it is compromised (the CLI's process throws),
//     so a lock is only ever taken over when its holder is gone.
//   - Inside the lock the CLI reads its credential file again and refreshes
//     only if the token still needs it (another process may just have).
//   - Refresh: POST https://auth.kimi.com/api/oauth/token,
//     application/x-www-form-urlencoded client_id, grant_type=refresh_token
//     and refresh_token, Accept: application/json, with its identity
//     headers (User-Agent kimi-code-cli/<version>, the version the
//     updater recorded in <home>/updates/install.json, X-Msh-Platform,
//     X-Msh-Version, X-Msh-Device-Name, X-Msh-Device-Model,
//     X-Msh-Os-Version, X-Msh-Device-Id from <home>/device_id); 3 attempts,
//     1 s and 2 s apart, for network errors and 429/500/502/503/504; 401,
//     403 or invalid_grant is a refusal. The answer needs access_token,
//     refresh_token and expires_in (seconds); expires_at is now +
//     expires_in, scope "" and token_type "Bearer" when not given.
//   - The credential file <home>/credentials/kimi-code.json holds
//     {access_token, refresh_token, expires_at (Unix seconds), scope,
//     token_type, expires_in} as JSON.stringify(…, null, 2) and a newline,
//     written to <file>.tmp.<pid>.<8 hex>, fsynced, chmodded and renamed.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// kimiClientID is Kimi Code's OAuth client.
	kimiClientID = "17e5f671-d194-4dfb-9706-5516cb48c098"
	// kimiSlot is the credential slot of Kimi Code's default host
	// (auth.kimi.com, api.kimi.com/coding/v1): credentials/kimi-code.json,
	// locked as oauth/kimi-code. The CLI keeps other hosts' sign-ins in
	// kimi-code-env-<hash>.json, whose host the name does not say: those
	// are never renewed here.
	kimiSlot = "kimi-code"
	// kimiCLIVersion is the version of Kimi Code whose renewal this
	// follows: sent as the CLI sends its own when the installed one's is
	// not known (kimiVersion).
	kimiCLIVersion = "2.2.0"
	kimiPlatform   = "kimi_code_cli"
	kimiProduct    = "kimi-code-cli"
	// kimiLockStale is the CLI's proper-lockfile stale time: a lock whose
	// mtime is older is stale.
	kimiLockStale = 5 * time.Second
	// kimiLockAbandoned is how old a lock must be before it is taken over
	// here: stale by the CLI's rule and much older, so a CLI whose event
	// loop stalled a few seconds keeps its lock (taken over, it would find
	// it compromised and fail); a holder that is gone left it this old.
	kimiLockAbandoned = 30 * time.Second
	// kimiRefreshMargin: a token that ends sooner than this is renewed
	// first (a request takes at most Timeout).
	kimiRefreshMargin = time.Minute
	kimiAttempts      = 3
)

// Tests shorten these.
var (
	// kimiLockUpdate is how often the lock's holder sets its mtime, as
	// proper-lockfile does (update = stale/2).
	kimiLockUpdate = kimiLockStale / 2
	// kimiLockWait is how long a lock held by the CLI is waited for before
	// this poll gives up (the next one tries again).
	kimiLockWait  = 8 * time.Second
	kimiLockRetry = 500 * time.Millisecond
	// kimiBackoff is the wait before attempt n+1 (the CLI's 2^n s).
	kimiBackoff = func(n int) time.Duration { return time.Duration(1<<n) * time.Second }
)

// kimiRefreshMu runs one renewal at a time in this process; the lock
// directory keeps other processes (the CLI, other agents) out.
var kimiRefreshMu sync.Mutex

// errKimiLockBusy: the CLI held its lock for longer than kimiLockWait.
var errKimiLockBusy = errors.New("lock_busy")

// errKimiRefused: the provider refused the refresh token.
var errKimiRefused = errors.New("refused")

// kimiToken is what the credential file says about the tokens.
type kimiToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    any    `json:"expires_at"`
	ExpiresIn    any    `json:"expires_in"`
}

func readKimiToken(file string) (kimiToken, []byte, error) {
	var t kimiToken
	b, err := readFile(file)
	if err != nil {
		return t, nil, err
	}
	if err := json.Unmarshal(b, &t); err != nil {
		return t, b, err
	}
	return t, b, nil
}

// expiresAt is when the access token ends (Unix seconds, 0: unknown).
func (t kimiToken) expiresAt() int64 { return timeOf(t.ExpiresAt) }

// needsRefresh: the token ends within kimiRefreshMargin. A token whose end
// is unknown is used as it is, as the CLI does.
func (t kimiToken) needsRefresh(now time.Time) bool {
	exp := t.expiresAt()
	return exp > 0 && time.Unix(exp, 0).Sub(now) < kimiRefreshMargin
}

// kimiRenewable tells whether file's sign-in may be renewed here: the
// default slot, where the CLI locks (not on Windows, nor with
// KIMI_DISABLE_OAUTH_LOCK=1, where it renews without a lock).
func kimiRenewable(e *Env, file string) bool {
	return path.Base(file) == kimiSlot+".json" && e.GOOS != "windows" && e.getenv("KIMI_DISABLE_OAUTH_LOCK") != "1"
}

// renewKimi renews the access token of file under the CLI's lock and
// writes the new tokens back; it returns the token to use. errKimiLockBusy
// when the CLI held the lock too long, errKimiRefused when the provider
// refused the refresh token (then not tried again until the file
// changes), an *httpError for other failures.
func renewKimi(ctx context.Context, e *Env, file string) (kimiToken, error) {
	if b, err := readFile(file); err == nil && e.Memo.kimiRefused(file, b) {
		return kimiToken{}, errKimiRefused
	}
	kimiRefreshMu.Lock()
	defer kimiRefreshMu.Unlock()
	lk, err := lockKimi(ctx, path.Join(kimiHome(e), "oauth", kimiSlot))
	if err != nil {
		if errors.Is(err, errKimiLockBusy) {
			return kimiToken{}, err
		}
		return kimiToken{}, &httpError{Code: "lock_failed"}
	}
	defer lk.release()
	// The CLI (or another agent) may have renewed it meanwhile.
	tok, raw, err := readKimiToken(file)
	if err != nil || tok.AccessToken == "" {
		return kimiToken{}, &httpError{Code: "bad_credentials"}
	}
	if !tok.needsRefresh(e.now()) {
		return tok, nil
	}
	if e.Memo.kimiRefused(file, raw) {
		return kimiToken{}, errKimiRefused
	}
	if tok.RefreshToken == "" {
		e.Memo.keepKimiRefused(file, raw)
		return kimiToken{}, errKimiRefused
	}
	ans, err := kimiRefresh(ctx, e, tok.RefreshToken)
	if errors.Is(err, errKimiRefused) {
		e.Memo.keepKimiRefused(file, raw)
		return kimiToken{}, err
	}
	if err != nil {
		return kimiToken{}, err
	}
	// Written back even if the lock was taken over while the request ran
	// (this process stalled): the old refresh token is spent, and a CLI
	// whose own refresh is then refused reads the file again for these.
	out, err := kimiRewrite(raw, ans, e.now())
	if err != nil {
		return kimiToken{}, &httpError{Code: "bad_credentials"}
	}
	if err := writeKimiFile(file, out); err != nil {
		return kimiToken{}, &httpError{Code: "write_failed"}
	}
	nt, _, err := readKimiToken(file)
	if err != nil {
		return kimiToken{}, &httpError{Code: "write_failed"}
	}
	return nt, nil
}

// kimiAnswer is a successful refresh.
type kimiAnswer struct {
	AccessToken, RefreshToken, Scope, TokenType string
	ExpiresIn                                   float64
}

// kimiRefresh asks the token endpoint as the CLI does, with its retries.
// Once a request is sent its answer is waited for even if ctx ends (the
// refresh token is spent once the provider answers, so the answer must be
// written back); no new attempt starts after ctx ended.
func kimiRefresh(ctx context.Context, e *Env, refresh string) (kimiAnswer, error) {
	form := url.Values{"client_id": {kimiClientID}, "grant_type": {"refresh_token"}, "refresh_token": {refresh}}.Encode()
	headers := kimiHeaders(e)
	var last error
	for n := 0; n < kimiAttempts; n++ {
		if n > 0 {
			select {
			case <-ctx.Done():
				return kimiAnswer{}, last
			case <-time.After(kimiBackoff(n - 1)):
			}
		}
		if ctx.Err() != nil {
			return kimiAnswer{}, &httpError{Code: "network"}
		}
		status, m, err := postForm(ctx, e.Client, e.URLs.KimiToken, headers, form)
		if err != nil {
			last = err
			continue
		}
		if status == http.StatusOK && str(m["access_token"]) != "" {
			return kimiAnswerOf(m)
		}
		if status == http.StatusUnauthorized || status == http.StatusForbidden || str(m["error"]) == "invalid_grant" {
			return kimiAnswer{}, errKimiRefused
		}
		switch status {
		case 429, 500, 502, 503, 504:
			last = &httpError{Status: status, Code: "http_" + strconv.Itoa(status)}
			continue
		}
		if status >= 300 && status < 400 {
			// Not followed (the client follows none): the refresh token
			// goes to the fixed host only.
			return kimiAnswer{}, &httpError{Status: status, Code: "http_3xx"}
		}
		return kimiAnswer{}, &httpError{Status: status, Code: "http_" + strconv.Itoa(status)}
	}
	return kimiAnswer{}, last
}

// kimiAnswerOf reads a token answer: access_token, refresh_token and a
// positive expires_in are required.
func kimiAnswerOf(m map[string]any) (kimiAnswer, error) {
	a := kimiAnswer{AccessToken: str(m["access_token"]), RefreshToken: str(m["refresh_token"]), Scope: str(m["scope"]), TokenType: "Bearer"}
	if s, ok := m["token_type"].(string); ok {
		a.TokenType = s
	}
	in, ok := num(m["expires_in"])
	if a.RefreshToken == "" || !ok || in <= 0 || math.IsInf(in, 0) {
		return kimiAnswer{}, &httpError{Code: "bad_response"}
	}
	a.ExpiresIn = in
	return a, nil
}

// postForm posts form to url and returns the status and the decoded body
// (an empty map when it is not a JSON object). The body is never part of
// an error: it carries tokens.
func postForm(ctx context.Context, c *http.Client, u string, headers map[string]string, form string) (int, map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", u, strings.NewReader(form))
	if err != nil {
		return 0, nil, &httpError{Code: "bad_request"}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return 0, nil, &httpError{Code: "network"}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return 0, nil, &httpError{Code: "network"}
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	m := map[string]any{}
	if dec.Decode(&v) == nil {
		if o := obj(normalizeJSON(v)); o != nil {
			m = o
		}
	}
	return res.StatusCode, m, nil
}

// kimiHeaders are the identity headers the CLI sends with a refresh.
func kimiHeaders(e *Env) map[string]string {
	host, _ := os.Hostname()
	rel := osRelease()
	v := kimiVersion(e)
	h := map[string]string{
		"User-Agent":         kimiProduct + "/" + v,
		"X-Msh-Platform":     kimiPlatform,
		"X-Msh-Version":      v,
		"X-Msh-Device-Name":  asciiHeader(host),
		"X-Msh-Device-Model": asciiHeader(kimiDeviceModel(e.GOOS, rel)),
		"X-Msh-Os-Version":   asciiHeader(rel),
	}
	// The CLI makes the id on its first run; it is only read here.
	if b, err := readFile(path.Join(kimiHome(e), "device_id")); err == nil {
		if id := asciiHeader(strings.TrimSpace(string(b))); id != "unknown" && len(id) <= 128 {
			h["X-Msh-Device-Id"] = id
		}
	}
	return h
}

var kimiVersionRe = regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,31}$`)

// kimiVersion is the installed Kimi Code's version as its updater recorded
// it (<home>/updates/install.json, lastSuccess.version; the CLI sends the
// version it was built as), else kimiCLIVersion.
func kimiVersion(e *Env) string {
	f, err := os.Open(path.Join(kimiHome(e), "updates", "install.json"))
	if err != nil {
		return kimiCLIVersion
	}
	defer f.Close()
	var st struct {
		LastSuccess *struct {
			Version string `json:"version"`
		} `json:"lastSuccess"`
	}
	if json.NewDecoder(io.LimitReader(f, 64<<10)).Decode(&st) != nil || st.LastSuccess == nil || !kimiVersionRe.MatchString(st.LastSuccess.Version) {
		return kimiCLIVersion
	}
	return st.LastSuccess.Version
}

// asciiHeader keeps the printable ASCII of v, trimmed ("unknown" when
// nothing is left), as the CLI does.
func asciiHeader(v string) string {
	var b strings.Builder
	for _, r := range v {
		if r >= 0x20 && r <= 0x7e {
			b.WriteRune(r)
		}
	}
	if s := strings.TrimSpace(b.String()); s != "" {
		return s
	}
	return "unknown"
}

var plistVersion = regexp.MustCompile(`<key>ProductVersion</key>\s*<string>([^<]*)</string>`)

// kimiDeviceModel is Node's description of the machine as the CLI builds
// it: "macOS <version> <arch>", else "<OS> <release> <arch>".
func kimiDeviceModel(goos, release string) string {
	arch := map[string]string{"amd64": "x64", "386": "ia32"}[runtime.GOARCH]
	if arch == "" {
		arch = runtime.GOARCH
	}
	switch goos {
	case "darwin":
		v := release
		if b, err := os.ReadFile("/System/Library/CoreServices/SystemVersion.plist"); err == nil {
			if m := plistVersion.FindSubmatch(b); m != nil && len(bytes.TrimSpace(m[1])) > 0 {
				v = string(bytes.TrimSpace(m[1]))
			}
		}
		return "macOS " + v + " " + arch
	case "linux":
		return strings.TrimSpace("Linux " + release + " " + arch)
	}
	return strings.TrimSpace(goos + " " + release + " " + arch)
}

// field is a member of a JSON object, in the file's order.
type field struct {
	key string
	val json.RawMessage
}

// objectFields reads the members of a JSON object in their order.
func objectFields(b []byte) ([]field, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, errors.New("not an object")
	}
	var out []field
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, err
		}
		k, _ := t.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		out = append(out, field{k, v})
	}
	return out, nil
}

// kimiFields are the members the CLI writes, in its order.
var kimiFields = []string{"access_token", "refresh_token", "expires_at", "scope", "token_type", "expires_in"}

// kimiRewrite is the credential file with the refresh's tokens, as the CLI
// writes it: its members first, then any other member the file had, kept
// as it was.
func kimiRewrite(old []byte, a kimiAnswer, now time.Time) ([]byte, error) {
	fields, err := objectFields(old)
	if err != nil {
		return nil, err
	}
	vals := map[string]any{
		"access_token": a.AccessToken, "refresh_token": a.RefreshToken,
		"expires_at": float64(now.Unix()) + a.ExpiresIn, "scope": a.Scope, "token_type": a.TokenType, "expires_in": a.ExpiresIn,
	}
	var buf bytes.Buffer
	buf.WriteByte('{')
	put := func(k string, v []byte) {
		if buf.Len() > 1 {
			buf.WriteByte(',')
		}
		buf.Write(jsonString(k))
		buf.WriteByte(':')
		buf.Write(v)
	}
	for _, k := range kimiFields {
		v, err := marshalJS(vals[k])
		if err != nil {
			return nil, err
		}
		put(k, v)
	}
	seen := map[string]bool{}
	for _, k := range kimiFields {
		seen[k] = true
	}
	for _, f := range fields {
		if seen[f.key] {
			continue
		}
		seen[f.key] = true
		put(f.key, f.val)
	}
	buf.WriteByte('}')
	var out bytes.Buffer
	if err := json.Indent(&out, buf.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}

// marshalJS encodes v as JSON.stringify does for strings and numbers (no
// HTML escapes).
func marshalJS(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

func jsonString(s string) []byte {
	b, _ := marshalJS(s)
	return b
}

// writeKimiFile replaces file with data as the CLI does
// (<file>.tmp.<pid>.<8 hex>, fsync, chmod, rename), keeping the file's
// mode.
func writeKimiFile(file string, data []byte) error {
	st, err := os.Stat(file)
	if err != nil {
		return err
	}
	mode := st.Mode().Perm()
	var rnd [4]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp.%d.%s", file, os.Getpid(), hex.EncodeToString(rnd[:]))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, mode)
	}
	if err == nil {
		err = os.Rename(tmp, file)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

// kimiLock is the CLI's lock (proper-lockfile) held here.
type kimiLock struct {
	dir  string
	mu   sync.Mutex
	mt   time.Time // the mtime last set, as stat reports it
	at   time.Time // when it was last set
	lost bool
	stop chan struct{}
	done chan struct{}
}

// lockKimi takes the CLI's lock on target as proper-lockfile does: mkdir
// <target>.lock; a lock held by a live holder (its mtime set within
// kimiLockAbandoned) is waited for until kimiLockWait, never broken.
func lockKimi(ctx context.Context, target string) (*kimiLock, error) {
	// As the CLI prepares it: the directory and the empty file it locks.
	if err := os.MkdirAll(path.Dir(target), 0o777); err != nil {
		return nil, err
	}
	if f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o666); err == nil {
		f.Close()
	} else {
		return nil, err
	}
	dir := target + ".lock"
	deadline := time.Now().Add(kimiLockWait)
	for {
		ok, err := tryLock(dir)
		if err != nil {
			return nil, err
		}
		if ok {
			return startLock(dir)
		}
		if !time.Now().Before(deadline) {
			return nil, errKimiLockBusy
		}
		select {
		case <-ctx.Done():
			return nil, errKimiLockBusy
		case <-time.After(kimiLockRetry):
		}
	}
}

// tryLock makes the lock directory; an abandoned one is removed (rmdir)
// and made again, as proper-lockfile does with a stale one.
func tryLock(dir string) (bool, error) {
	err := os.Mkdir(dir, 0o777)
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return false, err
	}
	st, err := os.Stat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		// Released meanwhile.
		err = os.Mkdir(dir, 0o777)
		return err == nil, nil
	}
	if err != nil {
		return false, err
	}
	if !st.IsDir() || time.Since(st.ModTime()) <= kimiLockAbandoned {
		return false, nil
	}
	if err := os.Remove(dir); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return os.Mkdir(dir, 0o777) == nil, nil
}

// startLock keeps the lock fresh: its mtime set every kimiLockUpdate, as
// long as it is still the one set here.
func startLock(dir string) (*kimiLock, error) {
	l := &kimiLock{dir: dir, stop: make(chan struct{}), done: make(chan struct{})}
	if err := l.touch(); err != nil {
		_ = os.Remove(dir)
		return nil, err
	}
	go func() {
		defer close(l.done)
		t := time.NewTicker(kimiLockUpdate)
		defer t.Stop()
		for {
			select {
			case <-l.stop:
				return
			case <-t.C:
				if !l.held() || l.touch() != nil {
					l.mu.Lock()
					l.lost = true
					l.mu.Unlock()
					return
				}
			}
		}
	}()
	return l, nil
}

// touch sets the lock's mtime to now and notes it.
func (l *kimiLock) touch() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if err := os.Chtimes(l.dir, now, now); err != nil {
		return err
	}
	st, err := os.Stat(l.dir)
	if err != nil {
		return err
	}
	l.mt, l.at = st.ModTime(), now
	return nil
}

// held tells whether the lock is still the one set here: its mtime is the
// last one set, within the stale time.
func (l *kimiLock) held() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lost || time.Since(l.at) > kimiLockStale {
		return false
	}
	st, err := os.Stat(l.dir)
	return err == nil && st.ModTime().Equal(l.mt)
}

// release stops keeping the lock and removes it while it is still the one
// set here.
func (l *kimiLock) release() {
	close(l.stop)
	<-l.done
	if l.held() {
		_ = os.Remove(l.dir)
	}
}

// kimiFileSum identifies a credential file's content (in memory only).
func kimiFileSum(b []byte) [32]byte { return sha256.Sum256(b) }
