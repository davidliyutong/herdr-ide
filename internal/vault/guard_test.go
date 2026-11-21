package vault

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The guard (authenticators, the rule to verify each Allow) is sealed with
// the key: read and changed only while the vault is unlocked, not readable
// in the file, and not one a file edited without the key can carry; a new
// passphrase ends the authenticators and keeps the rule.
func TestGuard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	if g, err := s.Guard(); err != nil || len(g.Authenticators) != 0 || g.VerifyEachAllow {
		t.Fatalf("a new vault's guard: %+v %v", g, err)
	}
	a := Authenticator{ID: "a1", Kind: KindWebAuthn, Label: "Touch ID", RPID: "localhost", Credential: []byte{1, 2}, Algorithm: -7,
		PublicKey: []byte("spki"), Created: time.Now().UTC().Truncate(time.Second)}
	if err := s.UpdateGuard(func(g *Guard) error {
		g.Authenticators = append(g.Authenticators, a)
		g.VerifyEachAllow = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "Touch ID") || strings.Contains(string(b), "localhost") || !strings.Contains(string(b), `"guard"`) {
		t.Fatalf("the file: %s", b)
	}
	// Another start reads it once unlocked, not before.
	s2 := openTest(t, path)
	if _, err := s2.Guard(); !errors.Is(err, ErrLocked) {
		t.Fatalf("a locked vault's guard: %v", err)
	}
	if err := s2.UpdateGuard(func(*Guard) error { return nil }); !errors.Is(err, ErrLocked) {
		t.Fatalf("changing a locked vault's guard: %v", err)
	}
	if err := s2.Unlock(pass); err != nil {
		t.Fatal(err)
	}
	g, err := s2.Guard()
	if err != nil || len(g.Authenticators) != 1 || g.Authenticators[0].Label != "Touch ID" || string(g.Authenticators[0].PublicKey) != "spki" || !g.VerifyEachAllow {
		t.Fatalf("guard %+v %v", g, err)
	}
	// A change that fails changes nothing; too many are refused.
	if err := s2.UpdateGuard(func(g *Guard) error { g.Authenticators = nil; return errors.New("no") }); err == nil {
		t.Fatal("a failed change went through")
	}
	if err := s2.UpdateGuard(func(g *Guard) error {
		for range MaxAuthenticators {
			g.Authenticators = append(g.Authenticators, a)
		}
		return nil
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("too many authenticators: %v", err)
	}
	if g, _ := s2.Guard(); len(g.Authenticators) != 1 {
		t.Fatalf("after refused changes: %+v", g)
	}

	// The guard of another vault (another key), or one changed in the
	// file, does not open.
	other := newVault(t, filepath.Join(t.TempDir(), "other.json"))
	if err := other.UpdateGuard(func(g *Guard) error {
		g.Authenticators = []Authenticator{{ID: "theirs", Kind: KindWebAuthn}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var mine, theirs map[string]json.RawMessage
	json.Unmarshal(b, &mine)
	ob, _ := os.ReadFile(filepath.Join(filepath.Dir(other.path), "other.json"))
	json.Unmarshal(ob, &theirs)
	mine["guard"] = theirs["guard"]
	edited, _ := json.Marshal(mine)
	os.WriteFile(path, edited, 0o600)
	s3 := openTest(t, path)
	if err := s3.Unlock(pass); err != nil {
		t.Fatal(err)
	}
	if _, err := s3.Guard(); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("another vault's guard: %v", err)
	}
	// The variables are not behind it.
	if err := s3.Set("KEY", Update{Value: str("v"), Machines: &[]string{"m1"}}); err != nil {
		t.Fatalf("a variable beside a guard that does not open: %v", err)
	}

	// A new passphrase ends the authenticators and keeps the rule.
	os.WriteFile(path, b, 0o600)
	s4 := openTest(t, path)
	if err := s4.ChangePassphrase(pass, "another horse"); err != nil {
		t.Fatal(err)
	}
	if g, err := s4.Guard(); err != nil || len(g.Authenticators) != 0 || !g.VerifyEachAllow {
		t.Fatalf("after a new passphrase: %+v %v", g, err)
	}
	// Without the rule nothing is left to seal.
	if err := s4.UpdateGuard(func(g *Guard) error { g.VerifyEachAllow = false; return nil }); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), `"guard"`) {
		t.Fatalf("an empty guard in the file: %s", b)
	}
}

// A suspended vault is locked with the key held: nothing is read or sealed,
// the guard stays readable for a proof, Resume or the passphrase unlocks
// it; Lock forgets the key, after which nothing resumes it.
func TestSuspend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	if err := s.Set("KEY", Update{Value: str("v"), Machines: &[]string{"m1"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateGuard(func(g *Guard) error {
		g.Authenticators = []Authenticator{{ID: "a1", Kind: KindWebAuthn, Label: "Laptop"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	s.Suspend()
	if st := s.Status(); !st.Locked || !s.Held() {
		t.Fatalf("suspended: %+v, held %v", st, s.Held())
	}
	if _, err := s.Value("KEY"); !errors.Is(err, ErrLocked) {
		t.Errorf("a value of a suspended vault: %v", err)
	}
	if err := s.Set("KEY", Update{Value: str("w")}); !errors.Is(err, ErrLocked) {
		t.Errorf("a change: %v", err)
	}
	if err := s.Allow("KEY", "m2"); !errors.Is(err, ErrLocked) {
		t.Errorf("an allow: %v", err)
	}
	if _, err := s.Export([]string{"KEY"}); !errors.Is(err, ErrLocked) {
		t.Errorf("an export: %v", err)
	}
	if err := s.Import([]Import{{Name: "NEW", Value: "x"}}); !errors.Is(err, ErrLocked) {
		t.Errorf("an import: %v", err)
	}
	if s.Exempt("m1", "claude") {
		t.Error("exempt while suspended")
	}
	if _, err := s.Guard(); err != nil {
		t.Errorf("the guard of a suspended vault: %v", err)
	}
	// A proof is recorded (it is how a suspended vault is unlocked); the
	// user's changes of the guard wait for an unlocked vault.
	at := time.Now().UTC().Truncate(time.Second)
	count := uint32(7)
	if err := s.RecordProof("a1", at, &count); err != nil {
		t.Errorf("recording a proof on a suspended vault: %v", err)
	}
	if err := s.RecordProof("nope", at, nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("recording another authenticator's proof: %v", err)
	}
	if g, _ := s.Guard(); g.Authenticators[0].SignCount != 7 || !g.Authenticators[0].LastUsed.Equal(at) {
		t.Errorf("recorded %+v", g.Authenticators[0])
	}
	if err := s.UpdateGuard(func(g *Guard) error { g.Authenticators = nil; return nil }); !errors.Is(err, ErrLocked) {
		t.Errorf("changing the guard of a suspended vault: %v", err)
	}
	if g, _ := s.Guard(); len(g.Authenticators) != 1 {
		t.Errorf("changed while suspended: %+v", g)
	}
	if err := s.Resume(); err != nil || s.Status().Locked {
		t.Fatalf("resume %v, %+v", err, s.Status())
	}
	if v, err := s.Value("KEY"); err != nil || v != "v" {
		t.Errorf("after resume %q %v", v, err)
	}
	// The passphrase unlocks a suspended vault, a wrong one does not.
	s.Suspend()
	if err := s.Unlock("wrong horse"); !errors.Is(err, ErrPassphrase) || !s.Status().Locked {
		t.Errorf("a wrong passphrase: %v %+v", err, s.Status())
	}
	if err := s.Unlock(pass); err != nil || s.Status().Locked {
		t.Errorf("the passphrase: %v %+v", err, s.Status())
	}
	// A new passphrase unlocks it too.
	s.Suspend()
	if err := s.ChangePassphrase(pass, "another horse"); err != nil || s.Status().Locked {
		t.Errorf("a new passphrase: %v %+v", err, s.Status())
	}
	s.Suspend()
	s.Lock()
	if s.Held() || !errors.Is(s.Resume(), ErrLocked) || !s.Status().Locked {
		t.Errorf("resumed without a key: %+v", s.Status())
	}
	s.Suspend() // nothing to keep
	if err := s.Unlock("another horse"); err != nil || s.Status().Locked {
		t.Errorf("unlock after a lock: %v %+v", err, s.Status())
	}
}

// Exemptions are sealed in the guard: bounded and checked, read only while
// the vault is unlocked, for one app on one machine; a removed machine's go
// at once or at the next unlock; a new passphrase ends them.
func TestExemptions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	add := func(m, app string) error {
		return s.UpdateGuard(func(g *Guard) error {
			g.Exempt = append(g.Exempt, Exemption{ID: m + app, Machine: m, App: app, Created: time.Now().UTC()})
			return nil
		})
	}
	if err := add("m1", "claude"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), "claude") || !strings.Contains(string(b), `"guard"`) {
		t.Fatalf("the file: %s", b)
	}
	if !s.Exempt("m1", "claude") || s.Exempt("m2", "claude") || s.Exempt("m1", "codex") || s.Exempt("m1", "") || s.Exempt("", "claude") {
		t.Error("exempt for another machine or app")
	}
	for _, bad := range [][2]string{{"m1", ""}, {"m1", " claude"}, {"m1", "a\nb"}, {"m1", strings.Repeat("x", 65)}, {"*", "claude"}, {"", "claude"}} {
		if err := add(bad[0], bad[1]); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if err := s.UpdateGuard(func(g *Guard) error {
		for i := range MaxExemptions {
			g.Exempt = append(g.Exempt, Exemption{ID: "x", Machine: "m" + strconv.Itoa(i), App: "a"})
		}
		return nil
	}); !errors.Is(err, ErrInvalid) {
		t.Errorf("too many: %v", err)
	}
	// Read again from the file once unlocked.
	s2 := openTest(t, path)
	if s2.Exempt("m1", "claude") {
		t.Error("exempt while locked")
	}
	if err := s2.Unlock(pass); err != nil || !s2.Exempt("m1", "claude") {
		t.Fatalf("after the unlock: %v", err)
	}
	// A removed machine: at once while unlocked...
	if _, err := s2.ForgetMachine("m1"); err != nil || s2.Exempt("m1", "claude") {
		t.Errorf("forgotten while unlocked: %v", err)
	}
	if g, _ := s2.Guard(); len(g.Exempt) != 0 {
		t.Errorf("guard %+v", g)
	}
	// ...and at the next unlock while locked, even if it comes back.
	if err := s2.UpdateGuard(func(g *Guard) error {
		g.Exempt = []Exemption{{ID: "e", Machine: "m1", App: "claude"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	s2.Lock()
	if _, err := s2.ForgetMachine("m1"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); !strings.Contains(string(b), `"forgotten"`) {
		t.Errorf("not forgotten in the file: %s", b)
	}
	s3 := openTest(t, path)
	if err := s3.Unlock(pass); err != nil {
		t.Fatal(err)
	}
	if g, _ := s3.Guard(); len(g.Exempt) != 0 || s3.Exempt("m1", "claude") {
		t.Errorf("after the unlock: %+v", g)
	}
	// A new passphrase ends them, as it ends the authenticators.
	if err := s3.UpdateGuard(func(g *Guard) error {
		g.Exempt = []Exemption{{ID: "e", Machine: "m2", App: "claude"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s3.ChangePassphrase(pass, "another horse"); err != nil {
		t.Fatal(err)
	}
	if g, _ := s3.Guard(); len(g.Exempt) != 0 {
		t.Errorf("after a new passphrase: %+v", g)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), `"guard"`) {
		t.Errorf("an empty guard in the file: %s", b)
	}
}

// An app to exempt has a name the kernels keep whole (at most 15 bytes) and
// is no shell or interpreter, which runs any script, versions included.
func TestCheckApp(t *testing.T) {
	for _, ok := range []string{"claude", "codex", "cursor-agent", "aider", strings.Repeat("x", MaxApp), "gemini"} {
		if err := CheckApp(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for name, want := range map[string]error{
		strings.Repeat("x", MaxApp+1): ErrAppTooLong, "claude-code-cli-x": ErrAppTooLong,
		"sh": ErrAppGeneric, "bash": ErrAppGeneric, "zsh": ErrAppGeneric, "fish": ErrAppGeneric, "dash": ErrAppGeneric,
		"node": ErrAppGeneric, "python": ErrAppGeneric, "python3": ErrAppGeneric, "python3.12": ErrAppGeneric, "Python3": ErrAppGeneric,
		"ruby": ErrAppGeneric, "perl": ErrAppGeneric, "env": ErrAppGeneric, "node22": ErrAppGeneric, "bun": ErrAppGeneric,
		"": ErrInvalid, " claude": ErrInvalid, "cl\x07ude": ErrInvalid,
	} {
		if err := CheckApp(name); !errors.Is(err, want) {
			t.Errorf("%q: %v, want %v", name, err, want)
		}
	}
	if Code(ErrAppTooLong) != "app_too_long" || Code(ErrAppGeneric) != "app_generic" {
		t.Error("codes")
	}
}
