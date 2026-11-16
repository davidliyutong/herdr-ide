package usage

// Kimi Code's sign-in renewed as the CLI renews it: under its lock (held
// fresh, stale, abandoned, released by the CLI after it renewed), the
// refresh's form and headers, the rotated tokens written back with the
// file's other members and mode, refusals not tried again until the file
// changes, failures, and no token in a reply.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// kimiFake is Kimi's token endpoint and usage endpoint.
type kimiFake struct {
	api      *fakeAPI
	e        *Env
	file     string
	asked    atomic.Int64
	mu       sync.Mutex
	form     url.Values
	header   http.Header
	answer   func(w http.ResponseWriter)
	bearers  []string
	oldToken string
}

const kimiOldRefresh = "r-old-SECRET"
const kimiNewRefresh = "r-new-SECRET"

func kimiJWT(tag string) string { return jwt(map[string]any{"user_id": "k-1", "tag": tag}) }

func kimiCreds(access, refresh string, expiresAt int64) string {
	return fmt.Sprintf(`{
  "access_token": %q,
  "refresh_token": %q,
  "expires_at": %d,
  "scope": "kimi-code",
  "token_type": "Bearer",
  "expires_in": 900,
  "custom": {"keep": [1, "<&>"]}
}
`, access, refresh, expiresAt)
}

func newKimiFake(t *testing.T) *kimiFake {
	oldWait, oldRetry, oldBackoff := kimiLockWait, kimiLockRetry, kimiBackoff
	kimiLockWait, kimiLockRetry, kimiBackoff = 1500*time.Millisecond, 50*time.Millisecond, func(int) time.Duration { return 0 }
	t.Cleanup(func() { kimiLockWait, kimiLockRetry, kimiBackoff = oldWait, oldRetry, oldBackoff })
	f := &kimiFake{api: newFakeAPI(t)}
	f.e = testEnv(t, f.api)
	f.e.Memo = &Memo{}
	f.e.URLs.KimiToken = f.api.URL + "/api/oauth/token"
	f.answer = func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"access_token":%q,"refresh_token":%q,"expires_in":900,"scope":"kimi-code","token_type":"Bearer"}`, kimiJWT("new"), kimiNewRefresh)
	}
	f.api.replies["/api/oauth/token"] = func(w http.ResponseWriter, r *http.Request) {
		f.asked.Add(1)
		r.ParseForm()
		f.mu.Lock()
		f.form, f.header = r.PostForm, r.Header.Clone()
		f.mu.Unlock()
		f.answer(w)
	}
	f.api.replies["/coding/v1/usages"] = func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.bearers = append(f.bearers, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		f.mu.Unlock()
		w.Write([]byte(`{"usage":{"limit":"100","used":"10","resetTime":"2026-11-20T00:00:00Z"}}`))
	}
	f.file = filepath.Join(f.e.Home, ".kimi-code/credentials/kimi-code.json")
	f.oldToken = kimiJWT("old")
	write(t, f.file, kimiCreds(f.oldToken, kimiOldRefresh, testNow.Add(-time.Minute).Unix()))
	write(t, filepath.Join(f.e.Home, ".kimi-code/device_id"), "dev-1234\n")
	return f
}

func (f *kimiFake) limits(t *testing.T, refresh bool) Account {
	t.Helper()
	a := one(t, Limits(context.Background(), f.e, Options{Providers: []string{Kimi}, KimiRefresh: refresh}))
	b, _ := json.Marshal(a)
	for _, secret := range []string{f.oldToken, kimiJWT("new"), kimiJWT("cli"), kimiOldRefresh, kimiNewRefresh, "SECRET"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("a token in the reply: %s", b)
		}
	}
	return a
}

func (f *kimiFake) content(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(f.file)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (f *kimiFake) lockDir() string {
	return filepath.Join(f.e.Home, ".kimi-code/oauth/kimi-code.lock")
}

// holdLock is the CLI holding its lock: the directory, its mtime set every
// 100 ms until release (which removes it, as unlock does).
func (f *kimiFake) holdLock(t *testing.T) (release func()) {
	t.Helper()
	if err := os.MkdirAll(f.lockDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				os.Remove(f.lockDir())
				return
			case <-time.After(100 * time.Millisecond):
				now := time.Now()
				os.Chtimes(f.lockDir(), now, now)
			}
		}
	}()
	var once sync.Once
	release = func() { once.Do(func() { close(stop); <-done }) }
	t.Cleanup(release)
	return release
}

func TestKimiRefreshWritesRotatedTokensBack(t *testing.T) {
	f := newKimiFake(t)
	if err := os.Chmod(f.file, 0o640); err != nil {
		t.Fatal(err)
	}
	a := f.limits(t, true)
	if a.Status != StatusOK || a.ID != "k-1" || len(a.Windows) != 1 {
		t.Fatalf("account %+v", a)
	}
	if f.asked.Load() != 1 {
		t.Fatalf("token endpoint asked %d times", f.asked.Load())
	}
	// The CLI's form and headers.
	f.mu.Lock()
	form, h, bearers := f.form, f.header, f.bearers
	f.mu.Unlock()
	if form.Get("client_id") != kimiClientID || form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != kimiOldRefresh || len(form) != 3 {
		t.Errorf("form %v", form)
	}
	if h.Get("Content-Type") != "application/x-www-form-urlencoded" || h.Get("Accept") != "application/json" ||
		h.Get("User-Agent") != "kimi-code-cli/"+kimiCLIVersion || h.Get("X-Msh-Platform") != "kimi_code_cli" ||
		h.Get("X-Msh-Version") != kimiCLIVersion || h.Get("X-Msh-Device-Id") != "dev-1234" ||
		h.Get("X-Msh-Device-Name") == "" || h.Get("X-Msh-Device-Model") == "" || h.Get("X-Msh-Os-Version") == "" {
		t.Errorf("headers %v", h)
	}
	if len(bearers) != 1 || bearers[0] != kimiJWT("new") {
		t.Errorf("usage asked with %v", bearers)
	}
	// Written back as the CLI writes it, the file's other members kept.
	want := fmt.Sprintf(`{
  "access_token": %q,
  "refresh_token": %q,
  "expires_at": %d,
  "scope": "kimi-code",
  "token_type": "Bearer",
  "expires_in": 900,
  "custom": {
    "keep": [
      1,
      "<&>"
    ]
  }
}
`, kimiJWT("new"), kimiNewRefresh, testNow.Unix()+900)
	if got := f.content(t); got != want {
		t.Errorf("file\n%s\nwant\n%s", got, want)
	}
	if st, _ := os.Stat(f.file); st.Mode().Perm() != 0o640 {
		t.Errorf("mode %v", st.Mode())
	}
	ents, _ := os.ReadDir(filepath.Dir(f.file))
	if len(ents) != 1 {
		t.Errorf("left in credentials: %v", ents)
	}
	// The lock released; the file it locks there, as the CLI makes it.
	if _, err := os.Stat(f.lockDir()); !os.IsNotExist(err) {
		t.Errorf("lock left: %v", err)
	}
	if st, err := os.Stat(filepath.Join(f.e.Home, ".kimi-code/oauth/kimi-code")); err != nil || st.Size() != 0 {
		t.Errorf("lock target %v %v", st, err)
	}
	// Fresh now: used as it is.
	f.limits(t, true)
	if f.asked.Load() != 1 {
		t.Errorf("a fresh token renewed")
	}
}

func TestKimiRefreshOnlyWhenNeeded(t *testing.T) {
	f := newKimiFake(t)
	// Off: the expired token is reported, nothing written.
	before := f.content(t)
	if a := f.limits(t, false); a.Status != StatusStale || a.Code != "token_expired" || f.asked.Load() != 0 || f.content(t) != before {
		t.Fatalf("off: %+v, asked %d", a, f.asked.Load())
	}
	// Ten minutes left: used as it is.
	write(t, f.file, kimiCreds(f.oldToken, kimiOldRefresh, testNow.Add(10*time.Minute).Unix()))
	if a := f.limits(t, true); a.Status != StatusOK || f.asked.Load() != 0 {
		t.Fatalf("fresh: %+v, asked %d", a, f.asked.Load())
	}
	// Thirty seconds left: renewed first.
	write(t, f.file, kimiCreds(f.oldToken, kimiOldRefresh, testNow.Add(30*time.Second).Unix()))
	if a := f.limits(t, true); a.Status != StatusOK || f.asked.Load() != 1 {
		t.Fatalf("ending: %+v, asked %d", a, f.asked.Load())
	}
	// Another host's slot, or the CLI without its lock: never renewed.
	expired := kimiCreds(f.oldToken, kimiOldRefresh, testNow.Add(-time.Minute).Unix())
	write(t, f.file, expired)
	f.e.Getenv = func(k string) string {
		if k == "KIMI_DISABLE_OAUTH_LOCK" {
			return "1"
		}
		return ""
	}
	if a := f.limits(t, true); a.Code != "token_expired" || f.asked.Load() != 1 {
		t.Fatalf("lock disabled: %+v", a)
	}
	f.e.Getenv = func(string) string { return "" }
	os.Remove(f.file)
	scoped := filepath.Join(filepath.Dir(f.file), "kimi-code-env-0123456789abcdef.json")
	write(t, scoped, expired)
	if a := f.limits(t, true); a.Code != "token_expired" || f.asked.Load() != 1 {
		t.Fatalf("scoped slot: %+v", a)
	}
}

func TestKimiLockHeldByTheCLI(t *testing.T) {
	f := newKimiFake(t)
	f.holdLock(t)
	before := f.content(t)
	start := time.Now()
	a := f.limits(t, true)
	if a.Status != StatusStale || a.Code != "lock_busy" || f.asked.Load() != 0 || f.content(t) != before {
		t.Fatalf("held: %+v, asked %d", a, f.asked.Load())
	}
	if d := time.Since(start); d < kimiLockWait {
		t.Errorf("gave up after %v", d)
	}
	// Not broken: still there, still the CLI's.
	if st, err := os.Stat(f.lockDir()); err != nil || time.Since(st.ModTime()) > time.Second {
		t.Errorf("the CLI's lock: %v %v", st, err)
	}
}

func TestKimiLockStaleAndAbandoned(t *testing.T) {
	f := newKimiFake(t)
	// Stale by the CLI's rule (5 s) but not abandoned: a CLI whose loop
	// stalled keeps it.
	if err := os.MkdirAll(f.lockDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-10 * time.Second)
	os.Chtimes(f.lockDir(), old, old)
	if a := f.limits(t, true); a.Code != "lock_busy" || f.asked.Load() != 0 {
		t.Fatalf("stalled holder: %+v", a)
	}
	if st, err := os.Stat(f.lockDir()); err != nil || !st.ModTime().Equal(old.Truncate(time.Microsecond)) && st.ModTime().Sub(old).Abs() > time.Millisecond {
		t.Errorf("the lock was touched: %v %v", st, err)
	}
	// Abandoned: taken over, the token renewed, the lock removed.
	old = time.Now().Add(-time.Minute)
	os.Chtimes(f.lockDir(), old, old)
	if a := f.limits(t, true); a.Status != StatusOK || f.asked.Load() != 1 {
		t.Fatalf("abandoned: %+v, asked %d", a, f.asked.Load())
	}
	if _, err := os.Stat(f.lockDir()); !os.IsNotExist(err) {
		t.Errorf("lock left: %v", err)
	}
}

func TestKimiCLIRenewsMeanwhile(t *testing.T) {
	f := newKimiFake(t)
	release := f.holdLock(t)
	go func() {
		time.Sleep(300 * time.Millisecond)
		// The CLI renews and releases its lock.
		os.WriteFile(f.file, []byte(kimiCreds(kimiJWT("cli"), "r-cli-SECRET", testNow.Add(15*time.Minute).Unix())), 0o600)
		release()
	}()
	a := f.limits(t, true)
	if a.Status != StatusOK || f.asked.Load() != 0 {
		t.Fatalf("%+v, asked %d", a, f.asked.Load())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bearers) != 1 || f.bearers[0] != kimiJWT("cli") {
		t.Errorf("usage asked with %v", f.bearers)
	}
	if strings.Contains(f.content(t), kimiNewRefresh) {
		t.Error("the CLI's tokens overwritten")
	}
}

func TestKimiRenewsOnceInAProcess(t *testing.T) {
	f := newKimiFake(t)
	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			Limits(context.Background(), f.e, Options{Providers: []string{Kimi}, KimiRefresh: true})
		}()
	}
	wg.Wait()
	if f.asked.Load() != 1 {
		t.Errorf("token endpoint asked %d times", f.asked.Load())
	}
}

func TestKimiRefreshRefused(t *testing.T) {
	for _, c := range []struct {
		name   string
		answer func(w http.ResponseWriter)
	}{
		{"invalid_grant", func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"invalid_grant","error_description":"refresh token ` + kimiOldRefresh + ` revoked"}`))
		}},
		{"401", func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newKimiFake(t)
			f.answer = c.answer
			before := f.content(t)
			a := f.limits(t, true)
			if a.Status != StatusUnauth || a.Code != "unauthorized" || a.ID != "k-1" || f.asked.Load() != 1 || f.content(t) != before {
				t.Fatalf("refused: %+v, asked %d", a, f.asked.Load())
			}
			// Not tried again while the file is the same.
			if a = f.limits(t, true); a.Status != StatusUnauth || f.asked.Load() != 1 {
				t.Fatalf("again: %+v, asked %d", a, f.asked.Load())
			}
			// The user signed in again: tried with the new file.
			write(t, f.file, kimiCreds(f.oldToken, "r-relogin-SECRET", testNow.Add(-time.Minute).Unix()))
			f.answer = newKimiFake(t).answer
			if a = f.limits(t, true); a.Status != StatusOK || f.asked.Load() != 2 {
				t.Fatalf("after a new sign-in: %+v, asked %d", a, f.asked.Load())
			}
		})
	}
}

func TestKimiRefreshFailures(t *testing.T) {
	cases := []struct {
		name   string
		answer func(w http.ResponseWriter)
		code   string
		asked  int64
	}{
		{"server error retried", func(w http.ResponseWriter) { w.WriteHeader(http.StatusServiceUnavailable) }, "http_503", 3},
		{"other status", func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"invalid_request"}`))
		}, "http_400", 1},
		{"no refresh token", func(w http.ResponseWriter) {
			fmt.Fprintf(w, `{"access_token":%q,"expires_in":900}`, kimiJWT("new"))
		}, "bad_response", 1},
		{"redirect", func(w http.ResponseWriter) {
			w.Header().Set("Location", "https://elsewhere.example/")
			w.WriteHeader(http.StatusFound)
		}, "http_3xx", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newKimiFake(t)
			f.e.Client = &http.Client{Timeout: 5 * time.Second, CheckRedirect: noRedirect}
			f.answer = c.answer
			before := f.content(t)
			a := f.limits(t, true)
			if a.Status != StatusError || a.Code != c.code || f.asked.Load() != c.asked || f.content(t) != before {
				t.Fatalf("%+v, asked %d", a, f.asked.Load())
			}
			if _, err := os.Stat(f.lockDir()); !os.IsNotExist(err) {
				t.Errorf("lock left: %v", err)
			}
			// Tried again at the next poll (only a refusal waits for the file).
			f.limits(t, true)
			if f.asked.Load() != 2*c.asked {
				t.Errorf("next poll asked %d", f.asked.Load())
			}
		})
	}
	t.Run("network", func(t *testing.T) {
		f := newKimiFake(t)
		f.e.URLs.KimiToken = "http://127.0.0.1:1/api/oauth/token"
		if a := f.limits(t, true); a.Status != StatusError || a.Code != "network" {
			t.Fatalf("%+v", a)
		}
	})
}

func TestKimiRewriteKeepsTheCLIFormat(t *testing.T) {
	// The CLI's own file, as it writes it, comes back byte for byte with
	// the same answer.
	old := `{
  "access_token": "a",
  "refresh_token": "r",
  "expires_at": 1,
  "scope": "",
  "token_type": "Bearer",
  "expires_in": 900
}
`
	got, err := kimiRewrite([]byte(old), kimiAnswer{AccessToken: "a2", RefreshToken: "r2", TokenType: "Bearer", ExpiresIn: 899.5}, time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.NewReplacer(`"a"`, `"a2"`, `"r"`, `"r2"`, `1,`, `999.5,`, `900`, `899.5`).Replace(old)
	if string(got) != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestKimiLockKeptFreshAndNotRemovedOnceLost(t *testing.T) {
	oldUpdate := kimiLockUpdate
	kimiLockUpdate = 50 * time.Millisecond
	t.Cleanup(func() { kimiLockUpdate = oldUpdate })
	target := filepath.Join(t.TempDir(), "oauth", "kimi-code")
	l, err := lockKimi(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(target + ".lock")
	first := st.ModTime()
	time.Sleep(300 * time.Millisecond)
	st, _ = os.Stat(target + ".lock")
	if !st.ModTime().After(first) || !l.held() {
		t.Fatalf("not kept fresh: %v then %v", first, st.ModTime())
	}
	// Another holder took it over (as after a stall): no longer ours, and
	// release leaves theirs.
	os.Remove(target + ".lock")
	os.Mkdir(target+".lock", 0o755)
	theirs := time.Now().Add(-time.Second)
	os.Chtimes(target+".lock", theirs, theirs)
	time.Sleep(150 * time.Millisecond)
	if l.held() {
		t.Error("held after a takeover")
	}
	l.release()
	if st, err := os.Stat(target + ".lock"); err != nil || st.ModTime().Sub(theirs).Abs() > time.Millisecond {
		t.Errorf("their lock: %v %v", st, err)
	}
}
