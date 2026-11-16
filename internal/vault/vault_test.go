package vault

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// testKDF keeps Argon2id fast in tests.
var testKDF = KDF{Time: 1, Memory: 64, Threads: 1}

func init() { minKDFMemory = testKDF.Memory }

func str(s string) *string { return &s }

func boolp(b bool) *bool { return &b }

func openTest(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.KDF = testKDF
	return s
}

const pass = "correct horse"

// newVault is a vault at path with the test passphrase, unlocked.
func newVault(t *testing.T, path string) *Store {
	t.Helper()
	s := openTest(t, path)
	if err := s.SetPassphrase(pass); err != nil {
		t.Fatal(err)
	}
	return s
}

// reopen opens the vault at path again and unlocks it.
func reopen(t *testing.T, path string) *Store {
	t.Helper()
	s := openTest(t, path)
	if err := s.Unlock(pass); err != nil {
		t.Fatal(err)
	}
	return s
}

// edit changes the vault's file as a program could.
func edit(t *testing.T, path string, f func(raw map[string]any)) {
	t.Helper()
	var raw map[string]any
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	f(raw)
	b, _ = json.Marshal(raw)
	os.WriteFile(path, b, 0o600)
}

// A new vault asks for a passphrase before its first value, and opens
// again only with it; when the passphrase was set is kept.
func TestPassphraseFirst(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := openTest(t, path)
	if st := s.Status(); st.Mode != ModeNone || st.Locked || !st.Setup {
		t.Fatalf("empty vault %+v", st)
	}
	if err := s.Set("TOKEN", Update{Value: str("v1")}); !errors.Is(err, ErrNoPassphrase) {
		t.Fatalf("first set: %v", err)
	}
	if err := s.Unlock(pass); !errors.Is(err, ErrNoPassphrase) {
		t.Fatalf("unlock without a passphrase: %v", err)
	}
	if err := s.SetPassphrase("short"); !errors.Is(err, ErrWeak) {
		t.Errorf("weak: %v", err)
	}
	now := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	if err := s.SetPassphrase(pass); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPassphrase("another one"); !errors.Is(err, ErrHasPassphrase) {
		t.Errorf("second passphrase: %v", err)
	}
	if err := s.Set("TOKEN", Update{Value: str("s3cr3t-value"), Description: str("the key")}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "s3cr3t") {
		t.Fatal("the value is stored in the clear")
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
			t.Errorf("mode %v", fi.Mode().Perm())
		}
	}
	if err := s.Verify(pass); err != nil {
		t.Errorf("verify: %v", err)
	}
	if err := s.Verify("wrong horse"); !errors.Is(err, ErrPassphrase) {
		t.Errorf("verify wrong: %v", err)
	}
	s2 := openTest(t, path)
	if st := s2.Status(); st.Mode != ModePassphrase || !st.Locked || st.Setup || !st.PassphraseSet.Equal(now) {
		t.Fatalf("reopened %+v", st)
	}
	if _, err := s2.Value("TOKEN"); !errors.Is(err, ErrLocked) {
		t.Errorf("locked value: %v", err)
	}
	if err := s2.Unlock("wrong horse"); !errors.Is(err, ErrPassphrase) {
		t.Errorf("wrong passphrase: %v", err)
	}
	if st := s2.Status(); !st.Locked {
		t.Error("unlocked by a wrong passphrase")
	}
	if err := s2.Unlock(pass); err != nil {
		t.Fatal(err)
	}
	if v, err := s2.Value("TOKEN"); err != nil || v != "s3cr3t-value" {
		t.Errorf("value %q %v", v, err)
	}
	// Names and descriptions are readable while locked; deleting needs no key.
	s2.Lock()
	if len(s2.List()) != 1 {
		t.Error("list while locked")
	}
	if err := s2.Set("TOKEN", Update{Description: str("x")}); !errors.Is(err, ErrLocked) {
		t.Errorf("change while locked: %v", err)
	}
	if err := s2.Delete("TOKEN"); err != nil {
		t.Error(err)
	}
}

// A value is sealed with the file's version, its name, machines and flag:
// a value moved to another variable, or machines or the flag changed in
// the file to let a machine read it, no longer opens.
func TestMetadataBindsValues(t *testing.T) {
	for name, f := range map[string]func(entries []any){
		"swapped values": func(e []any) {
			a, b := e[0].(map[string]any), e[1].(map[string]any)
			a["value"], b["value"] = b["value"], a["value"]
		},
		"machines widened": func(e []any) { e[0].(map[string]any)["machines"] = []any{"*"} },
		"machine added":    func(e []any) { e[0].(map[string]any)["machines"] = []any{"box", "evil"} },
		"flag dropped":     func(e []any) { e[0].(map[string]any)["injectOnly"] = false },
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "vault.json")
			s := newVault(t, path)
			s.Set("A", Update{Value: str("alpha"), Machines: &[]string{"box"}, InjectOnly: boolp(true)})
			s.Set("B", Update{Value: str("bravo")})
			edit(t, path, func(raw map[string]any) { f(raw["entries"].([]any)) })
			if _, err := reopen(t, path).Value("A"); !errors.Is(err, ErrCorrupt) {
				t.Errorf("edited value opened: %v", err)
			}
		})
	}
	// Changed through the store, the value follows.
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	s.Set("A", Update{Value: str("alpha")})
	if err := s.Set("A", Update{Machines: &[]string{"m1"}, InjectOnly: boolp(true)}); err != nil {
		t.Fatal(err)
	}
	if err := s.Allow("A", "m2"); err != nil {
		t.Fatal(err)
	}
	if v, err := reopen(t, path).Value("A"); err != nil || v != "alpha" {
		t.Fatalf("value %q %v", v, err)
	}
}

// The additional data has one text per content: machine lists that a
// separator would make alike are told apart, and machine ids with control
// characters are refused.
func TestADIsInjective(t *testing.T) {
	a := adOf(&Entry{Name: "A", Machines: []string{"!\x01*"}})
	b := adOf(&Entry{Name: "A", Machines: []string{"!", "*"}})
	if a == b {
		t.Fatal("two machine lists give the same additional data")
	}
	if adOf(&Entry{Name: "A", InjectOnly: true}) == adOf(&Entry{Name: "A"}) {
		t.Fatal("the flag is not in the additional data")
	}
	s := newVault(t, filepath.Join(t.TempDir(), "vault.json"))
	if err := s.Set("A", Update{Value: str("x"), Machines: &[]string{"a\x01b"}}); !errors.Is(err, ErrInvalid) {
		t.Errorf("control character: %v", err)
	}
	s.Set("A", Update{Value: str("x")})
	if err := s.Allow("A", "a\nb"); !errors.Is(err, ErrInvalid) {
		t.Errorf("allow with a newline: %v", err)
	}
}

// A file of another version (development versions sealed values with less
// additional data), a mode this version does not know or variables
// without a passphrase do not open; an empty one of another version does.
func TestOtherVersionsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	newVault(t, path).Set("A", Update{Value: str("alpha")})
	// The code tells the UI why: another version, or a file it cannot read.
	for name, c := range map[string]struct {
		f    func(raw map[string]any)
		code string
	}{
		"older version":  {func(raw map[string]any) { raw["version"] = 2 }, "version"},
		"keychain mode":  {func(raw map[string]any) { raw["mode"] = "keychain" }, "version"},
		"no passphrase":  {func(raw map[string]any) { delete(raw, "mode") }, "invalid"},
		"no parameters":  {func(raw map[string]any) { delete(raw, "kdf") }, "invalid"},
		"no check value": {func(raw map[string]any) { delete(raw, "check") }, "invalid"},
	} {
		t.Run(name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "vault.json")
			b, _ := os.ReadFile(path)
			os.WriteFile(p, b, 0o600)
			edit(t, p, c.f)
			if _, err := Open(p); err == nil || Code(err) != c.code {
				t.Errorf("opened, or not %s: %v", c.code, err)
			}
		})
	}
	garbled := filepath.Join(t.TempDir(), "vault.json")
	os.WriteFile(garbled, []byte(`{"version":3,`), 0o600)
	if _, err := Open(garbled); Code(err) != "invalid" {
		t.Errorf("a file that is not JSON: %v", err)
	}
	empty := filepath.Join(t.TempDir(), "vault.json")
	os.WriteFile(empty, []byte(`{"version":1,"entries":[]}`), 0o600)
	if s, err := Open(empty); err != nil || !s.Status().Setup {
		t.Errorf("empty file of an earlier version: %v", err)
	}
}

func TestChangePassphrase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	s.Set("A", Update{Value: str("alpha"), Machines: &[]string{"m"}})
	if err := s.ChangePassphrase("wrong horse", "battery staple"); !errors.Is(err, ErrPassphrase) {
		t.Errorf("wrong current: %v", err)
	}
	if err := s.ChangePassphrase(pass, "short"); !errors.Is(err, ErrWeak) {
		t.Errorf("weak: %v", err)
	}
	s.Lock()
	if err := s.ChangePassphrase(pass, "battery staple"); err != nil {
		t.Fatal(err)
	}
	s2 := openTest(t, path)
	if err := s2.Unlock(pass); !errors.Is(err, ErrPassphrase) {
		t.Errorf("old passphrase: %v", err)
	}
	if err := s2.Unlock("battery staple"); err != nil {
		t.Fatal(err)
	}
	if v, err := s2.Value("A"); err != nil || v != "alpha" {
		t.Errorf("value %q %v", v, err)
	}

	// A change that fails (a value that does not open) leaves a locked
	// vault locked, under the old passphrase.
	s2.Set("B", Update{Value: str("beta")})
	s2.Lock()
	edit(t, path, func(raw map[string]any) {
		for _, e := range raw["entries"].([]any) {
			if e.(map[string]any)["name"] == "B" {
				e.(map[string]any)["value"] = map[string]any{"nonce": "AAAAAAAAAAAAAAAA", "ciphertext": "AAAA"}
			}
		}
	})
	s3 := openTest(t, path)
	if err := s3.ChangePassphrase("battery staple", "another staple"); !errors.Is(err, ErrCorrupt) || Code(err) != "corrupt" {
		t.Fatalf("change over a value that does not open: %v", err)
	}
	if st := s3.Status(); !st.Locked {
		t.Error("a failed change unlocked the vault")
	}
	if _, err := s3.Value("A"); !errors.Is(err, ErrLocked) {
		t.Errorf("value after a failed change: %v", err)
	}
	if err := s3.Unlock("battery staple"); err != nil {
		t.Errorf("the old passphrase after a failed change: %v", err)
	}
}

func TestValidation(t *testing.T) {
	s := newVault(t, filepath.Join(t.TempDir(), "vault.json"))
	for _, name := range []string{"", "1A", "A-B", "A B", "ä", strings.Repeat("A", 129)} {
		if err := s.Set(name, Update{Value: str("x")}); !errors.Is(err, ErrInvalidName) {
			t.Errorf("name %q: %v", name, err)
		}
	}
	if err := s.Set("_ok1", Update{Value: str("x")}); err != nil {
		t.Error(err)
	}
	if err := s.Set("BIG", Update{Value: str(strings.Repeat("x", MaxValue+1))}); Code(err) != "invalid" {
		t.Errorf("big value: %v", err)
	}
	if err := s.Set("DESC", Update{Value: str("x"), Description: str(strings.Repeat("d", MaxDescription+1))}); Code(err) != "invalid" {
		t.Errorf("long description: %v", err)
	}
	if err := s.Set("NEW", Update{Description: str("no value")}); Code(err) != "value_required" {
		t.Errorf("no value: %v", err)
	}
	ms := []string{"m1", "m1", "*"}
	if err := s.Set("_ok1", Update{Machines: &ms}); err != nil {
		t.Error(err)
	}
	i, _ := s.Get("_ok1")
	if strings.Join(i.Machines, ",") != "m1,*" || !i.Allows("other") {
		t.Errorf("machines %v", i.Machines)
	}
	// Changing the description keeps the value.
	if err := s.Set("_ok1", Update{Description: str("d")}); err != nil {
		t.Error(err)
	}
	if v, _ := s.Value("_ok1"); v != "x" {
		t.Errorf("value %q", v)
	}
	if err := s.Delete("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("delete: %v", err)
	}
	if err := s.Set("ALLOW", Update{Value: str("x")}); err != nil {
		t.Fatal(err)
	}
	if err := s.Allow("ALLOW", "m2"); err != nil {
		t.Fatal(err)
	}
	if i, _ := s.Get("ALLOW"); !i.Allows("m2") || i.Allows("m3") {
		t.Errorf("allow %v", i.Machines)
	}
}

// Fields a later version adds are kept.
func TestUnknownFieldsAreKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	os.WriteFile(path, []byte(`{"version":3,"future":{"x":1},"entries":[]}`), 0o600)
	s := openTest(t, path)
	if err := s.SetPassphrase(pass); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("A", Update{Value: str("v")}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), `"future"`) {
		t.Errorf("lost unknown field: %s", b)
	}
}

// Argon2 parameters out of bounds in the file fail Open with an error, not
// a panic or a key derivation that exhausts the core's memory.
func TestKDFParametersAreChecked(t *testing.T) {
	salt := make([]byte, 16)
	for _, k := range []KDF{
		{Salt: salt, Time: 1, Memory: 64, Threads: 0},
		{Salt: salt, Time: 0, Memory: 64, Threads: 1},
		{Salt: salt, Time: 11, Memory: 64, Threads: 1},
		{Salt: salt, Time: 1, Memory: 2 << 20, Threads: 1},
		{Salt: salt, Time: 1, Memory: 64, Threads: 17},
		{Salt: salt[:8], Time: 1, Memory: 64, Threads: 1},
	} {
		path := filepath.Join(t.TempDir(), "vault.json")
		b, _ := json.Marshal(map[string]any{"version": FileVersion, "mode": ModePassphrase, "kdf": k, "check": Sealed{}, "entries": []any{}})
		os.WriteFile(path, b, 0o600)
		if _, err := Open(path); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: %v", k, err)
		}
	}
	// The production bound on memory.
	k := KDF{Salt: salt, Time: 1, Memory: 64, Threads: 1}
	prev := minKDFMemory
	minKDFMemory = 8 << 10
	defer func() { minKDFMemory = prev }()
	if err := validKDF(&k); err == nil {
		t.Error("64 KiB accepted")
	}
	k.Memory = DefaultKDF.Memory
	if err := validKDF(&k); err != nil {
		t.Error(err)
	}
}

// A removed machine leaves every variable's list: at once when the vault is
// unlocked (the values sealed again), else at the next unlock, and until
// then it may read nothing without asking. A value that does not open
// keeps the machine forgotten.
func TestForgetMachine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	ms := []string{"m1", "m2", "m3"}
	s.Set("A", Update{Value: str("a"), Machines: &ms})
	all := []string{"*"}
	s.Set("B", Update{Value: str("b"), Machines: &all})
	names, err := s.ForgetMachine("m1")
	if err != nil || strings.Join(names, ",") != "A" {
		t.Fatalf("forget %v %v", names, err)
	}
	s2 := openTest(t, path)
	if i, _ := s2.Get("A"); strings.Join(i.Machines, ",") != "m2,m3" {
		t.Errorf("A %v", i.Machines)
	}
	if i, _ := s2.Get("B"); strings.Join(i.Machines, ",") != "*" {
		t.Errorf("B %v", i.Machines)
	}
	if names, _ := s.ForgetMachine("m1"); names != nil {
		t.Errorf("again %v", names)
	}
	// Locked: forgotten at once, taken out at the unlock.
	if names, err := s2.ForgetMachine("m2"); err != nil || strings.Join(names, ",") != "A" {
		t.Fatalf("forget locked %v %v", names, err)
	}
	if i, _ := s2.Get("A"); strings.Join(i.Machines, ",") != "m3" || i.Allows("m2") {
		t.Errorf("A while locked %v", i.Machines)
	}
	s3 := openTest(t, path)
	if i, _ := s3.Get("A"); i.Allows("m2") {
		t.Errorf("reopened, m2 may read %v", i.Machines)
	}
	if err := s3.Unlock(pass); err != nil {
		t.Fatal(err)
	}
	if v, err := s3.Value("A"); err != nil || v != "a" {
		t.Errorf("value %q %v", v, err)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "forgotten") {
		t.Errorf("forgotten kept after the unlock: %s", b)
	}
	// A value that does not open loses the machine too (and stays
	// unreadable): the unlock works, the other values open and nothing
	// stays forgotten.
	s3.Set("C", Update{Value: str("c"), Machines: &[]string{"m4"}})
	s3.Set("D", Update{Value: str("d"), Machines: &[]string{"m4"}})
	s3.Lock()
	s3.ForgetMachine("m4")
	edit(t, path, func(raw map[string]any) {
		for _, e := range raw["entries"].([]any) {
			if e.(map[string]any)["name"] == "C" {
				e.(map[string]any)["value"] = map[string]any{"nonce": "AAAAAAAAAAAAAAAA", "ciphertext": "AAAA"}
			}
		}
	})
	s4 := reopen(t, path)
	if st := s4.Status(); st.Locked {
		t.Fatal("locked")
	}
	if i, _ := s4.Get("C"); i.Allows("m4") || len(i.Machines) != 0 {
		t.Errorf("C after a failed seal %v", i.Machines)
	}
	if _, err := s4.Value("C"); !errors.Is(err, ErrCorrupt) {
		t.Errorf("C opens: %v", err)
	}
	if i, _ := s4.Get("D"); i.Allows("m4") || len(i.Machines) != 0 {
		t.Errorf("D %v", i.Machines)
	}
	if v, err := s4.Value("D"); err != nil || v != "d" {
		t.Errorf("D value %q %v", v, err)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), "forgotten") || strings.Contains(string(b), "m4") {
		t.Errorf("m4 kept after the unlock: %s", b)
	}
	// The machine added again under the same id: allowing it, or choosing
	// it in the editor, lets it read again (also after reopening).
	if err := s4.Allow("D", "m4"); err != nil {
		t.Fatal(err)
	}
	if err := s4.Set("A", Update{Machines: &[]string{"m2", "m4"}}); err != nil {
		t.Fatal(err)
	}
	s5 := reopen(t, path)
	for _, n := range []string{"A", "D"} {
		if i, _ := s5.Get(n); !i.Allows("m4") {
			t.Errorf("%s does not let m4 read again: %v", n, i.Machines)
		}
	}
}

// A machine forgotten while the vault is locked, whose removal could not be
// written at the unlock, is taken out of the lists at the next change (an
// allow, a save or a deletion), and a machine that change names is then
// allowed: one added again under the same id is not blocked.
func TestForgottenAppliedAtTheNextChange(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("needs a directory the user cannot write")
	}
	dir := filepath.Join(t.TempDir(), "conf")
	path := filepath.Join(dir, "vault.json")
	s := newVault(t, path)
	s.Set("A", Update{Value: str("a"), Machines: &[]string{"m1", "m2"}})
	s.Set("B", Update{Value: str("b"), Machines: &[]string{"m1"}})
	s.Lock()
	s.ForgetMachine("m1")
	os.Chmod(dir, 0o500)
	err := s.Unlock(pass)
	os.Chmod(dir, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if i, _ := s.Get("A"); i.Allows("m1") {
		t.Fatalf("m1 reads while forgotten %v", i.Machines)
	}
	if err := s.Allow("B", "m1"); err != nil {
		t.Fatal(err)
	}
	if i, _ := s.Get("B"); !i.Allows("m1") {
		t.Errorf("B after allowing m1 again %v", i.Machines)
	}
	if i, _ := s.Get("A"); i.Allows("m1") || strings.Join(i.Machines, ",") != "m2" {
		t.Errorf("A %v", i.Machines)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "forgotten") {
		t.Errorf("forgotten kept: %s", b)
	}

	// A deletion while unlocked applies them too.
	s.Lock()
	s.ForgetMachine("m2")
	os.Chmod(dir, 0o500)
	err = s.Unlock(pass)
	os.Chmod(dir, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("B"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), "forgotten") || strings.Contains(string(b), "m2") {
		t.Errorf("m2 kept after a deletion: %s", b)
	}
}

// A renamed variable keeps its value (sealed again under its new name, read
// back after reopening), description, machines and flag; taken names,
// invalid names and a locked vault are refused.
func TestRename(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	if err := s.Set("OLD", Update{Value: str("v1"), Description: str("d"), Machines: &[]string{"box"}, InjectOnly: boolp(true)}); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("TAKEN", Update{Value: str("v2")}); err != nil {
		t.Fatal(err)
	}
	if err := s.Rename("OLD", "TAKEN"); !errors.Is(err, ErrExists) {
		t.Fatalf("taken name: %v", err)
	}
	if err := s.Rename("OLD", "1bad"); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("invalid name: %v", err)
	}
	if err := s.Rename("NOPE", "X"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := s.Rename("OLD", "NEW"); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Get("OLD"); ok {
		t.Fatal("the old name stays")
	}
	s2 := reopen(t, path)
	if v, err := s2.Value("NEW"); err != nil || v != "v1" {
		t.Fatalf("value after rename %q %v", v, err)
	}
	i, _ := s2.Get("NEW")
	if i.Description != "d" || !i.InjectOnly || len(i.Machines) != 1 || i.Machines[0] != "box" {
		t.Fatalf("info after rename %+v", i)
	}
	s2.Lock()
	if err := s2.Rename("NEW", "OTHER"); !errors.Is(err, ErrLocked) {
		t.Fatalf("locked: %v", err)
	}
}

// Set with To renames and changes a variable in one write: a refusal of any
// part changes nothing, so the same change can be tried again.
func TestSetRenames(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	s.Set("OLD", Update{Value: str("v1"), Description: str("d"), Machines: &[]string{"box"}})
	s.Set("TAKEN", Update{Value: str("v2")})
	for name, c := range map[string]struct {
		u   Update
		err error
	}{
		"taken name":     {Update{To: str("TAKEN"), Description: str("x")}, ErrExists},
		"invalid name":   {Update{To: str("1bad"), Description: str("x")}, ErrInvalidName},
		"invalid change": {Update{To: str("NEW"), Machines: &[]string{"a\nb"}}, ErrInvalid},
		"too long":       {Update{To: str("NEW"), Description: str(strings.Repeat("x", MaxDescription+1))}, ErrInvalid},
	} {
		if err := s.Set("OLD", c.u); !errors.Is(err, c.err) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := s.Set("NOPE", Update{To: str("NEW"), Value: str("v")}); !errors.Is(err, ErrNotFound) {
		t.Errorf("renaming a missing variable: %v", err)
	}
	if i, ok := s.Get("OLD"); !ok || i.Description != "d" {
		t.Fatalf("OLD after refusals %+v", i)
	}
	if err := s.Set("OLD", Update{To: str("NEW"), Description: str("new"), Machines: &[]string{"box", "gpu"}, InjectOnly: boolp(true)}); err != nil {
		t.Fatal(err)
	}
	s2 := reopen(t, path)
	if _, ok := s2.Get("OLD"); ok {
		t.Error("the old name stays")
	}
	i, _ := s2.Get("NEW")
	if i.Description != "new" || !i.InjectOnly || strings.Join(i.Machines, ",") != "box,gpu" {
		t.Errorf("renamed %+v", i)
	}
	if v, err := s2.Value("NEW"); err != nil || v != "v1" {
		t.Errorf("value %q %v", v, err)
	}
	if err := s2.Set("NEW", Update{To: str("NEWER"), Value: str("v3")}); err != nil {
		t.Fatal(err)
	}
	if v, err := s2.Value("NEWER"); err != nil || v != "v3" {
		t.Errorf("renamed with a new value %q %v", v, err)
	}
}
