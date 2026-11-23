package vault

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// The KEKs are the contract's (design/testdata/vault-unlock/kek.json, made
// with Node's crypto): the ECDH secret from either private key, and each
// kind's HKDF.
func TestKEKVectors(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "design", "testdata", "vault-unlock", "kek.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Enclave struct{ SEPriv, EphPriv, SEPub, EphPub, Z, ShellSecret, KEK string }
		Hello   struct{ Signature, Challenge, ShellSecret, KEK string }
		PRF     struct{ Output, Salt, KEK string }
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	d := func(s string) []byte {
		t.Helper()
		b, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil || len(b) == 0 {
			t.Fatalf("%q: %v", s, err)
		}
		return b
	}
	e := v.Enclave
	sePriv, err := ecdh.P256().NewPrivateKey(d(e.SEPriv))
	if err != nil {
		t.Fatal(err)
	}
	ephPriv, err := ecdh.P256().NewPrivateKey(d(e.EphPriv))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(sePriv.PublicKey().Bytes(), d(e.SEPub)) || !bytes.Equal(ephPriv.PublicKey().Bytes(), d(e.EphPub)) {
		t.Fatal("the public keys are not the private keys'")
	}
	z1, err := ephPriv.ECDH(sePriv.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	z2, _ := sePriv.ECDH(ephPriv.PublicKey())
	if !bytes.Equal(z1, d(e.Z)) || !bytes.Equal(z2, d(e.Z)) {
		t.Fatalf("Z %x %x", z1, z2)
	}
	if k := EnclaveKEK(d(e.Z), d(e.ShellSecret), d(e.EphPub), d(e.SEPub)); !bytes.Equal(k, d(e.KEK)) {
		t.Errorf("enclave KEK %x", k)
	}
	h := v.Hello
	if k := HelloKEK(d(h.Signature), d(h.ShellSecret), d(h.Challenge)); !bytes.Equal(k, d(h.KEK)) {
		t.Errorf("hello KEK %x", k)
	}
	if k := PRFKEK(d(v.PRF.Output), d(v.PRF.Salt)); !bytes.Equal(k, d(v.PRF.KEK)) {
		t.Errorf("prf KEK %x", k)
	}
}

const (
	install = "install-0123456789"
	origin  = "https://localhost:8080"
	rpID    = "localhost"
	deskID  = "d1"
	webID   = "w1"
)

var credential = []byte{1, 2, 3, 4}

func rnd(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	rand.Read(b)
	return b
}

// fixture is a vault with a variable, the desktop authenticator and a
// WebAuthn credential, on a clock the test moves.
type fixture struct {
	t    *testing.T
	path string
	s    *Store
	now  time.Time
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{t: t, path: filepath.Join(t.TempDir(), "vault.json"), now: time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)}
	f.s = openTest(t, f.path)
	f.s.now = f.clock
	if err := f.s.SetPassphrase(pass, win); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Set("KEY", Update{Value: str("secret")}); err != nil {
		t.Fatal(err)
	}
	if err := f.s.UpdateGuard(func(g *Guard) error {
		g.Authenticators = []Authenticator{
			{ID: deskID, Kind: KindDesktop, Label: "Desktop"},
			{ID: webID, Kind: KindWebAuthn, Label: "Key", Origin: origin, RPID: rpID, Credential: credential, PublicKey: []byte("spki")},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixture) clock() time.Time { return f.now }

// reopen opens the file again (another start of the core), locked.
func (f *fixture) reopen() *Store {
	f.s = openTest(f.t, f.path)
	f.s.now = f.clock
	return f.s
}

// enclave adds an enclave entry, the test playing the Secure Enclave, and
// returns it with its KEK as the shell would give it again.
func (f *fixture) enclave(inst string) (UnlockEntry, []byte) {
	f.t.Helper()
	se, _ := ecdh.P256().GenerateKey(rand.Reader)
	shell := rnd(f.t, 32)
	e, err := f.s.AddEnclave(deskID, inst, []byte("blob of "+inst), se.PublicKey().Bytes(), shell)
	if err != nil {
		f.t.Fatal(err)
	}
	eph, err := ecdh.P256().NewPublicKey(e.Enclave.EphPub)
	if err != nil {
		f.t.Fatal(err)
	}
	z, _ := se.ECDH(eph)
	return e, EnclaveKEK(z, shell, e.Enclave.EphPub, se.PublicKey().Bytes())
}

func (f *fixture) hello() (UnlockEntry, []byte) {
	f.t.Helper()
	challenge, sig, shell := rnd(f.t, 32), rnd(f.t, 256), rnd(f.t, 32)
	e, err := f.s.AddHello(deskID, install, HelloKeyName(install), challenge, []byte("rsa public key"), sig, shell)
	if err != nil {
		f.t.Fatal(err)
	}
	return e, HelloKEK(sig, shell, challenge)
}

func (f *fixture) prf() (UnlockEntry, []byte) {
	f.t.Helper()
	salt, out := rnd(f.t, 32), rnd(f.t, 32)
	e, err := f.s.AddPRF(webID, origin, rpID, credential, salt, out)
	if err != nil {
		f.t.Fatal(err)
	}
	return e, PRFKEK(out, salt)
}

// unlock is UnlockWith on a copy of kek (UnlockWith wipes it).
func (f *fixture) unlock(id string, kek []byte, verify VerifyUnlock) (Window, error) {
	return f.s.UnlockWith(id, slices.Clone(kek), 14, verify)
}

func (f *fixture) locked() bool { return f.s.Status().Locked }

// Each kind wraps the key: its KEK unlocks the vault after a lock and after
// another start, the window sealed with the passphrase comes back, the
// authenticator's use is recorded, and the KEK given is wiped.
func TestUnlockEachKind(t *testing.T) {
	for name, add := range map[string]func(*fixture) (UnlockEntry, []byte){
		"enclave": func(f *fixture) (UnlockEntry, []byte) { return f.enclave(install) },
		"hello":   (*fixture).hello,
		"prf":     (*fixture).prf,
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			e, kek := add(f)
			if e.Kind != name || len(e.ID) != 22 || e.Check != checkHash(f.s.f.Check) || len(f.s.UnlockEntries()) != 1 {
				t.Fatalf("entry %+v", e)
			}
			raw, _ := os.ReadFile(f.path)
			if !strings.Contains(string(raw), `"unlock"`) {
				t.Fatalf("not in the file: %s", raw)
			}
			f.s.Lock()
			f.now = f.now.Add(time.Hour)
			given := slices.Clone(kek)
			w, err := f.s.UnlockWith(e.ID, given, 14, nil)
			if err != nil || f.locked() || w != win {
				t.Fatalf("unlock %v %+v %+v", err, w, f.s.Status())
			}
			if !bytes.Equal(given, make([]byte, len(given))) {
				t.Error("the KEK was not wiped")
			}
			if v, err := f.s.Value("KEY"); err != nil || v != "secret" {
				t.Errorf("value %q %v", v, err)
			}
			g, _ := f.s.Guard()
			owner := ownerOf(g, &e)
			if owner < 0 || !g.Authenticators[owner].LastUsed.Equal(f.now) {
				t.Errorf("use not recorded: %+v", g.Authenticators)
			}
			s := f.reopen()
			if _, err := f.unlock(e.ID, kek, nil); err != nil || s.Status().Locked {
				t.Fatalf("after another start: %v", err)
			}
			// An unlocked vault stays as it is.
			if _, err := f.unlock(e.ID, kek, nil); err != nil || s.Status().Locked {
				t.Errorf("again: %v", err)
			}
			// Another KEK does not open it.
			s.Lock()
			// A KEK that does not open the wrap says so (ErrUnlockWrap), with
			// the code of any unlock that does not hold.
			if _, err := f.unlock(e.ID, rnd(t, 32), nil); !errors.Is(err, ErrUnlockFailed) || !errors.Is(err, ErrUnlockWrap) || Code(err) != "vault_proof" || !f.locked() {
				t.Errorf("another KEK: %v", err)
			}
			if _, err := f.unlock(e.ID, kek[:16], nil); !errors.Is(err, ErrUnlockFailed) || errors.Is(err, ErrUnlockWrap) || !f.locked() {
				t.Errorf("a short KEK: %v", err)
			}
		})
	}
}

// An edit of any member of an entry in the file (each parameter, the
// authenticator, the kind, the check, the wrapped bytes) does not open:
// the entry is dropped at Open when it no longer is a valid one or not
// one of the file's check (unlock_stale), else its wrap does not open
// (vault_proof); the vault stays locked either way.
func TestEditedEntriesDoNotOpen(t *testing.T) {
	flip := func(m map[string]any, k string) {
		b, _ := base64.StdEncoding.DecodeString(m[k].(string))
		b[len(b)-1] ^= 1
		m[k] = base64.StdEncoding.EncodeToString(b)
	}
	otherPoint := func() string {
		k, _ := ecdh.P256().GenerateKey(rand.Reader)
		return base64.StdEncoding.EncodeToString(k.PublicKey().Bytes())
	}
	type edit struct {
		kind string
		f    func(e map[string]any)
		want error
	}
	edits := map[string]edit{
		"enclave install":  {"enclave", func(e map[string]any) { e["enclave"].(map[string]any)["install"] = "install-9999999999" }, ErrUnlockFailed},
		"enclave blob":     {"enclave", func(e map[string]any) { flip(e["enclave"].(map[string]any), "blob") }, ErrUnlockFailed},
		"enclave sePub":    {"enclave", func(e map[string]any) { e["enclave"].(map[string]any)["sePub"] = otherPoint() }, ErrUnlockFailed},
		"enclave ephPub":   {"enclave", func(e map[string]any) { e["enclave"].(map[string]any)["ephPub"] = otherPoint() }, ErrUnlockFailed},
		"enclave bad pub":  {"enclave", func(e map[string]any) { flip(e["enclave"].(map[string]any), "sePub") }, ErrUnlockStale},
		"hello keyName":    {"hello", func(e map[string]any) { e["hello"].(map[string]any)["keyName"] = "other" }, ErrUnlockStale},
		"hello challenge":  {"hello", func(e map[string]any) { flip(e["hello"].(map[string]any), "challenge") }, ErrUnlockFailed},
		"hello publicKey":  {"hello", func(e map[string]any) { flip(e["hello"].(map[string]any), "publicKey") }, ErrUnlockFailed},
		"prf origin":       {"prf", func(e map[string]any) { e["prf"].(map[string]any)["origin"] = "https://evil.example" }, ErrUnlockFailed},
		"prf rpId":         {"prf", func(e map[string]any) { e["prf"].(map[string]any)["rpId"] = "evil.example" }, ErrUnlockFailed},
		"prf credential":   {"prf", func(e map[string]any) { flip(e["prf"].(map[string]any), "credential") }, ErrUnlockFailed},
		"prf salt":         {"prf", func(e map[string]any) { flip(e["prf"].(map[string]any), "salt") }, ErrUnlockFailed},
		"authenticator":    {"prf", func(e map[string]any) { e["authenticator"] = deskID }, ErrUnlockFailed},
		"kind":             {"hello", func(e map[string]any) { e["kind"] = "enclave" }, ErrUnlockStale},
		"check":            {"prf", func(e map[string]any) { e["check"] = strings.Repeat("0", 64) }, ErrUnlockStale},
		"wrapped":          {"prf", func(e map[string]any) { flip(e["wrapped"].(map[string]any), "ciphertext") }, ErrUnlockFailed},
		"wrapped nonce":    {"enclave", func(e map[string]any) { flip(e["wrapped"].(map[string]any), "nonce") }, ErrUnlockFailed},
		"another's params": {"prf", func(e map[string]any) { e["hello"] = map[string]any{"install": install} }, ErrUnlockStale},
	}
	for name, c := range edits {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			var e UnlockEntry
			var kek []byte
			switch c.kind {
			case "enclave":
				e, kek = f.enclave(install)
			case "hello":
				e, kek = f.hello()
			default:
				e, kek = f.prf()
			}
			f.s.Lock()
			editFile(t, f.path, func(raw map[string]any) { c.f(raw["unlock"].([]any)[0].(map[string]any)) })
			f.reopen()
			if _, err := f.unlock(e.ID, kek, nil); !errors.Is(err, c.want) || !f.locked() {
				t.Errorf("%v, want %v; locked %v", err, c.want, f.locked())
			}
		})
	}
}

func editFile(t *testing.T, path string, fn func(raw map[string]any)) {
	t.Helper()
	edit(t, path, fn)
}

// A passphrase changed by the store drops every entry; one changed by an
// older build (which keeps the entries it does not know) leaves entries of
// another check, which Open drops.
func TestNewPassphraseEndsTheEntries(t *testing.T) {
	f := newFixture(t)
	e, kek := f.prf()
	f.enclave(install)
	before, _ := os.ReadFile(f.path)
	if err := f.s.ChangePassphrase(pass, "battery staple", win); err != nil {
		t.Fatal(err)
	}
	if len(f.s.UnlockEntries()) != 0 {
		t.Fatalf("entries after a new passphrase: %+v", f.s.UnlockEntries())
	}
	if b, _ := os.ReadFile(f.path); strings.Contains(string(b), `"unlock"`) {
		t.Fatalf("in the file: %s", b)
	}
	// The older build's change: the new check, the old entries.
	var old map[string]json.RawMessage
	json.Unmarshal(before, &old)
	editFile(t, f.path, func(raw map[string]any) {
		var u any
		json.Unmarshal(old["unlock"], &u)
		raw["unlock"] = u
	})
	s := f.reopen()
	if n := len(s.UnlockEntries()); n != 0 {
		t.Fatalf("entries of another check kept: %d", n)
	}
	if _, err := f.unlock(e.ID, kek, nil); !errors.Is(err, ErrUnlockStale) || Code(err) != "unlock_stale" {
		t.Errorf("an entry of another check: %v", err)
	}
	// Saved, they are gone from the file too.
	if err := s.Unlock("battery staple", win); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("KEY", Update{Description: str("d")}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(f.path); strings.Contains(string(b), `"unlock"`) {
		t.Errorf("written back: %s", b)
	}
}

// An entry whose authenticator is gone from the guard (an older copy of
// the file put back) is refused and removed; removing an authenticator
// removes its entries in the same write.
func TestOrphanEntries(t *testing.T) {
	f := newFixture(t)
	e, kek := f.prf()
	de, _ := f.enclave(install)
	copyOf, _ := os.ReadFile(f.path)
	if err := f.s.UpdateGuard(func(g *Guard) error {
		g.Authenticators = slices.DeleteFunc(g.Authenticators, func(a Authenticator) bool { return a.ID == webID })
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if l := f.s.UnlockEntries(); len(l) != 1 || l[0].ID != de.ID {
		t.Fatalf("entries after removing the authenticator: %+v", l)
	}
	if reopened := f.reopen(); len(reopened.UnlockEntries()) != 1 {
		t.Fatalf("in the file: %+v", reopened.UnlockEntries())
	}
	// The old entry put back.
	var old map[string]json.RawMessage
	json.Unmarshal(copyOf, &old)
	editFile(t, f.path, func(raw map[string]any) {
		var u any
		json.Unmarshal(old["unlock"], &u)
		raw["unlock"] = u
	})
	f.reopen()
	if len(f.s.UnlockEntries()) != 2 {
		t.Fatal("the old entries are not back")
	}
	called := false
	verify := func(Guard, Authenticator) (*uint32, error) { called = true; return nil, nil }
	if _, err := f.unlock(e.ID, kek, verify); !errors.Is(err, ErrUnlockOrphan) || !errors.Is(err, ErrUnlockStale) || Code(err) != "unlock_stale" || !f.locked() || called {
		t.Fatalf("an orphan entry: %v, locked %v, verified %v", err, f.locked(), called)
	}
	if l := f.s.UnlockEntries(); len(l) != 1 || l[0].ID != de.ID {
		t.Errorf("the orphan stays: %+v", l)
	}
	if l := f.reopen().UnlockEntries(); len(l) != 1 {
		t.Errorf("the orphan stays in the file: %+v", l)
	}
}

// The authenticator's proof is checked after the key opened and before it
// is installed: an error refuses (vault_proof) and leaves the vault
// locked, a counter is recorded, and a KEK that does not open never
// reaches the check.
func TestUnlockVerifies(t *testing.T) {
	f := newFixture(t)
	e, kek := f.prf()
	f.s.Lock()
	bad := errors.New("bad signature")
	var seen Authenticator
	if _, err := f.unlock(e.ID, kek, func(g Guard, a Authenticator) (*uint32, error) {
		seen = a
		return nil, bad
	}); !errors.Is(err, ErrUnlockFailed) || !errors.Is(err, bad) || errors.Is(err, ErrUnlockWrap) || Code(err) != "vault_proof" || !f.locked() || f.s.key != nil {
		t.Fatalf("a bad signature: %v, locked %v", err, f.locked())
	}
	if seen.ID != webID || string(seen.PublicKey) != "spki" {
		t.Errorf("verified with %+v", seen)
	}
	called := false
	if _, err := f.unlock(e.ID, rnd(t, 32), func(Guard, Authenticator) (*uint32, error) { called = true; return nil, nil }); !errors.Is(err, ErrUnlockFailed) || called {
		t.Errorf("a wrong KEK reached the check: %v %v", err, called)
	}
	count := uint32(9)
	if _, err := f.unlock(e.ID, kek, func(Guard, Authenticator) (*uint32, error) { return &count, nil }); err != nil || f.locked() {
		t.Fatal(err)
	}
	if g, _ := f.s.Guard(); g.Authenticators[1].SignCount != 9 {
		t.Errorf("counter %+v", g.Authenticators[1])
	}
	// The proof is checked before the window: a bad one is vault_proof
	// even when the passphrase is due.
	f.s.Lock()
	f.now = f.now.AddDate(0, 0, 30)
	if _, err := f.unlock(e.ID, kek, func(Guard, Authenticator) (*uint32, error) { return nil, bad }); !errors.Is(err, ErrUnlockFailed) {
		t.Errorf("a bad proof when due: %v", err)
	}
	if _, err := f.unlock(e.ID, kek, nil); !errors.Is(err, ErrPassphraseDue) {
		t.Errorf("due: %v", err)
	}
}

// The window: an unlock without the passphrase is allowed less than
// min(days, the days sealed) days after the passphrase was last checked
// with the key, not when there is none, it is in the future, it has
// ended; an older window put back in the file ends sooner; ForgetPassphrase
// ends it, also while locked.
func TestPassphraseWindow(t *testing.T) {
	f := newFixture(t)
	t0 := f.now
	e, kek := f.prf()
	if due := f.s.PassphraseDue(); !due.Equal(t0.AddDate(0, 0, 14)) {
		t.Errorf("due %v", due)
	}
	try := func(at time.Time, days int) error {
		t.Helper()
		f.s.Lock()
		f.now = at
		_, err := f.s.UnlockWith(e.ID, slices.Clone(kek), days, nil)
		if (err == nil) == f.locked() {
			t.Fatalf("%v and locked %v", err, f.locked())
		}
		return err
	}
	if err := try(t0.AddDate(0, 0, 14).Add(-time.Second), 14); err != nil {
		t.Errorf("within: %v", err)
	}
	if err := try(t0.AddDate(0, 0, 14), 14); !errors.Is(err, ErrPassphraseDue) || Code(err) != "passphrase_due" {
		t.Errorf("ended: %v", err)
	}
	if err := try(t0.Add(-time.Minute), 14); !errors.Is(err, ErrPassphraseDue) {
		t.Errorf("in the future: %v", err)
	}
	// A smaller setting now, or a larger one than sealed.
	if err := try(t0.AddDate(0, 0, 2), 1); !errors.Is(err, ErrPassphraseDue) {
		t.Errorf("smaller days now: %v", err)
	}
	if err := try(t0.AddDate(0, 0, 20), 90); !errors.Is(err, ErrPassphraseDue) {
		t.Errorf("larger days now: %v", err)
	}
	if err := try(t0.AddDate(0, 0, 3), 0); !errors.Is(err, ErrPassphraseDue) {
		t.Errorf("days below the bounds count as 1: %v", err)
	}
	// The passphrase again starts a new window, with the settings then.
	older, _ := os.ReadFile(f.path)
	f.now = t0.AddDate(0, 0, 10)
	if err := f.s.Unlock(pass, Window{Days: 30, AutoLock: time.Hour}); err != nil {
		t.Fatal(err)
	}
	if w, err := f.s.UnlockWith(e.ID, slices.Clone(kek), 90, nil); err != nil || w != (Window{Days: 30, AutoLock: time.Hour}) {
		t.Errorf("the new window %+v %v", w, err)
	}
	if err := try(t0.AddDate(0, 0, 39), 90); err != nil {
		t.Errorf("within the new window: %v", err)
	}
	// Verify with a window refreshes it while unlocked, not while locked.
	f.now = t0.AddDate(0, 0, 39)
	if err := f.s.Verify(pass, &Window{Days: 2}); err != nil {
		t.Fatal(err)
	}
	if !f.s.PassphraseDue().Equal(t0.AddDate(0, 0, 41)) {
		t.Errorf("after verify: %v", f.s.PassphraseDue())
	}
	f.s.Lock()
	if err := f.s.Verify(pass, &Window{Days: 90}); err != nil || !f.s.PassphraseDue().Equal(t0.AddDate(0, 0, 41)) {
		t.Errorf("verify while locked: %v %v", err, f.s.PassphraseDue())
	}
	// The older window put back in the file ends sooner, never later.
	var old map[string]json.RawMessage
	json.Unmarshal(older, &old)
	editFile(t, f.path, func(raw map[string]any) {
		var at, hint any
		json.Unmarshal(old["passphraseAt"], &at)
		json.Unmarshal(old["passphraseHint"], &hint)
		raw["passphraseAt"], raw["passphraseHint"] = at, hint
	})
	f.reopen()
	if err := try(t0.AddDate(0, 0, 13), 90); err != nil {
		t.Errorf("the older window: %v", err)
	}
	if err := try(t0.AddDate(0, 0, 15), 90); !errors.Is(err, ErrPassphraseDue) {
		t.Errorf("the older window ended: %v", err)
	}
	// Another vault's window, or none, is due.
	other := newFixture(t)
	otherRaw, _ := os.ReadFile(other.path)
	json.Unmarshal(otherRaw, &old)
	editFile(t, f.path, func(raw map[string]any) {
		var at any
		json.Unmarshal(old["passphraseAt"], &at)
		raw["passphraseAt"] = at
	})
	f.reopen()
	if err := try(t0.AddDate(0, 0, 1), 90); !errors.Is(err, ErrPassphraseDue) {
		t.Errorf("another vault's window: %v", err)
	}
	// ForgetPassphrase while locked: no key needed, written.
	f.s.Lock()
	if err := f.s.ForgetPassphrase(); err != nil {
		t.Fatal(err)
	}
	if !f.s.PassphraseDue().IsZero() {
		t.Error("a due date after forgetting")
	}
	if b, _ := os.ReadFile(f.path); strings.Contains(string(b), "passphraseAt") || strings.Contains(string(b), "passphraseHint") {
		t.Errorf("in the file: %s", b)
	}
	f.reopen()
	if err := try(t0.AddDate(0, 0, 1), 14); !errors.Is(err, ErrPassphraseDue) {
		t.Errorf("no window: %v", err)
	}
	if err := f.s.Unlock(pass, win); err != nil {
		t.Fatal(err)
	}
	if err := try(t0.AddDate(0, 0, 2), 14); err != nil {
		t.Errorf("after the passphrase: %v", err)
	}
}

// A file with the new members, opened and saved by a build that does not
// know them (they are in its rest), keeps them; a removed entry does not
// come back after a save and another Open.
func TestOlderBuildRoundTrip(t *testing.T) {
	f := newFixture(t)
	e, kek := f.prf()
	de, _ := f.enclave(install)
	// The older build: the members are unknown fields.
	old := f.reopen()
	raw, _ := os.ReadFile(f.path)
	var all map[string]json.RawMessage
	json.Unmarshal(raw, &all)
	old.f.rest = map[string]json.RawMessage{"unlock": all["unlock"], "passphraseAt": all["passphraseAt"], "passphraseHint": all["passphraseHint"]}
	old.f.Unlock, old.f.PassphraseAt, old.f.PassphraseHint = nil, nil, ""
	if err := old.Delete("KEY"); err != nil {
		t.Fatal(err)
	}
	s := f.reopen()
	if len(s.UnlockEntries()) != 2 || s.PassphraseDue().IsZero() {
		t.Fatalf("lost by an older build: %+v", s.UnlockEntries())
	}
	if _, err := f.unlock(e.ID, kek, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveUnlock(de.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveUnlock(de.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("removed twice: %v", err)
	}
	if err := s.RemoveUnlock("../x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("an invalid id: %v", err)
	}
	if err := s.Set("A", Update{Value: str("a")}); err != nil {
		t.Fatal(err)
	}
	if l := f.reopen().UnlockEntries(); len(l) != 1 || l[0].ID != e.ID {
		t.Errorf("after a save and an Open: %+v", l)
	}
	if _, ok := f.s.f.rest["unlock"]; ok {
		t.Error("the entries are kept as an unknown field")
	}
}

// Adding checks its input and the bounds: the authenticator must be the
// guard's, of the right kind; one entry per install (replaced), at most
// MaxDesktopUnlocks; one per credential (replaced); the vault unlocked.
func TestAddUnlockBounds(t *testing.T) {
	f := newFixture(t)
	s := f.s
	se, _ := ecdh.P256().GenerateKey(rand.Reader)
	pub, shell := se.PublicKey().Bytes(), rnd(t, 32)
	offCurve := slices.Clone(pub)
	offCurve[64] ^= 1
	for name, err := range map[string]error{
		"install":    func() error { _, err := s.AddEnclave(deskID, "short", []byte("b"), pub, shell); return err }(),
		"off curve":  func() error { _, err := s.AddEnclave(deskID, install, []byte("b"), offCurve, shell); return err }(),
		"compressed": func() error { _, err := s.AddEnclave(deskID, install, []byte("b"), pub[:33], shell); return err }(),
		"no blob":    func() error { _, err := s.AddEnclave(deskID, install, nil, pub, shell); return err }(),
		"big blob":   func() error { _, err := s.AddEnclave(deskID, install, make([]byte, maxBlob+1), pub, shell); return err }(),
		"shell":      func() error { _, err := s.AddEnclave(deskID, install, []byte("b"), pub, shell[:31]); return err }(),
		"keyName": func() error {
			_, err := s.AddHello(deskID, install, "other", rnd(t, 32), []byte("k"), []byte("s"), shell)
			return err
		}(),
		"challenge": func() error {
			_, err := s.AddHello(deskID, install, HelloKeyName(install), rnd(t, 16), []byte("k"), []byte("s"), shell)
			return err
		}(),
		"signature": func() error {
			_, err := s.AddHello(deskID, install, HelloKeyName(install), rnd(t, 32), []byte("k"), make([]byte, maxSignature+1), shell)
			return err
		}(),
		"publicKey": func() error {
			_, err := s.AddHello(deskID, install, HelloKeyName(install), rnd(t, 32), nil, []byte("s"), shell)
			return err
		}(),
		"output": func() error { _, err := s.AddPRF(webID, origin, rpID, credential, rnd(t, 32), rnd(t, 31)); return err }(),
		"salt":   func() error { _, err := s.AddPRF(webID, origin, rpID, credential, rnd(t, 8), rnd(t, 32)); return err }(),
		"origin": func() error {
			_, err := s.AddPRF(webID, strings.Repeat("o", maxOrigin+1), rpID, credential, rnd(t, 32), rnd(t, 32))
			return err
		}(),
		"rpId": func() error {
			_, err := s.AddPRF(webID, origin, "a\nb", credential, rnd(t, 32), rnd(t, 32))
			return err
		}(),
		"credential": func() error {
			_, err := s.AddPRF(webID, origin, rpID, make([]byte, maxCredential+1), rnd(t, 32), rnd(t, 32))
			return err
		}(),
		"no authent.": func() error { _, err := s.AddPRF("", origin, rpID, credential, rnd(t, 32), rnd(t, 32)); return err }(),
	} {
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, err := range map[string]error{
		"another authenticator": func() error { _, err := s.AddPRF("nope", origin, rpID, credential, rnd(t, 32), rnd(t, 32)); return err }(),
		"desktop as webauthn":   func() error { _, err := s.AddPRF(deskID, origin, rpID, credential, rnd(t, 32), rnd(t, 32)); return err }(),
		"another credential":    func() error { _, err := s.AddPRF(webID, origin, rpID, []byte{9}, rnd(t, 32), rnd(t, 32)); return err }(),
		"another origin": func() error {
			_, err := s.AddPRF(webID, "https://other", rpID, credential, rnd(t, 32), rnd(t, 32))
			return err
		}(),
		"webauthn as desktop": func() error { _, err := s.AddEnclave(webID, install, []byte("b"), pub, shell); return err }(),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(s.UnlockEntries()) != 0 {
		t.Fatalf("refused entries added: %+v", s.UnlockEntries())
	}
	// One per install: a new one replaces it, also of the other kind.
	first, _ := f.enclave(install)
	second, kek := f.enclave(install)
	if l := s.UnlockEntries(); len(l) != 1 || l[0].ID != second.ID || first.ID == second.ID {
		t.Fatalf("replaced: %+v", l)
	}
	hello, _ := f.hello()
	if l := s.UnlockEntries(); len(l) != 1 || l[0].ID != hello.ID {
		t.Fatalf("replaced by hello: %+v", l)
	}
	for i := range MaxDesktopUnlocks - 1 {
		f.enclave(install + string(rune('a'+i)))
	}
	if _, err := s.AddEnclave(deskID, install+"z", []byte("b"), pub, shell); !errors.Is(err, ErrInvalid) {
		t.Errorf("a fifth install: %v", err)
	}
	if _, err := s.AddEnclave(deskID, install, []byte("b"), pub, shell); err != nil {
		t.Errorf("replacing at the bound: %v", err)
	}
	// One per credential.
	p1, _ := f.prf()
	p2, pk := f.prf()
	l := s.UnlockEntries()
	if n := len(l); n != MaxDesktopUnlocks+1 || slices.ContainsFunc(l, func(e UnlockEntry) bool { return e.ID == p1.ID }) {
		t.Fatalf("one per credential: %+v", l)
	}
	// The copies are copies.
	l[len(l)-1].PRF.Salt[0] ^= 1
	s.Lock()
	if _, err := f.unlock(p2.ID, pk, nil); err != nil {
		t.Errorf("after changing a copy: %v", err)
	}
	if _, err := f.unlock(second.ID, kek, nil); !errors.Is(err, ErrUnlockStale) {
		t.Errorf("a replaced entry: %v", err)
	}
	// Locked, nothing is added.
	s.Lock()
	if _, err := s.AddPRF(webID, origin, rpID, credential, rnd(t, 32), rnd(t, 32)); !errors.Is(err, ErrLocked) {
		t.Errorf("added while locked: %v", err)
	}
	if _, err := f.unlock("nope", pk, nil); !errors.Is(err, ErrUnlockStale) {
		t.Errorf("no such entry: %v", err)
	}
}

// Purge wipes memguard's keys: the vault's key no longer opens (the
// vault's operations fail) until an unlock.
func TestPurge(t *testing.T) {
	f := newFixture(t)
	Purge()
	if _, err := f.s.Value("KEY"); !errors.Is(err, ErrMemory) || Code(err) != "memory" {
		t.Errorf("a value after the purge: %v (%s)", err, Code(err))
	}
	f.s.Lock()
	if err := f.s.Unlock(pass, win); err != nil {
		t.Fatal(err)
	}
	if v, err := f.s.Value("KEY"); err != nil || v != "secret" {
		t.Errorf("after an unlock %q %v", v, err)
	}
}
