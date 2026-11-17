package vault

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
