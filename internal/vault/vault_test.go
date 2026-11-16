package vault

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// testKDF keeps Argon2id fast in tests.
var testKDF = KDF{Time: 1, Memory: 64, Threads: 1}

func init() { minKDFMemory = testKDF.Memory }

func str(s string) *string { return &s }

func openTest(t *testing.T, path string, keys KeyStore) *Store {
	t.Helper()
	s, err := Open(path, keys, "vault.json")
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
	s := openTest(t, path, &MemKeyStore{})
	if err := s.SetPassphrase(pass); err != nil {
		t.Fatal(err)
	}
	return s
}

// A new vault asks for a passphrase before its first value, keeps nothing
// in the keychain, and opens again only with the passphrase.
func TestPassphraseFirst(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	keys := &MemKeyStore{}
	s := openTest(t, path, keys)
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
	if err := s.SetPassphrase(pass); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPassphrase("another one"); !errors.Is(err, ErrHasPassphrase) {
		t.Errorf("second passphrase: %v", err)
	}
	if err := s.Set("TOKEN", Update{Value: str("s3cr3t-value"), Description: str("the key")}); err != nil {
		t.Fatal(err)
	}
	if len(keys.Keys) != 0 {
		t.Fatalf("keychain %v", keys.Keys)
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
	s2 := openTest(t, path, keys)
	if st := s2.Status(); st.Mode != ModePassphrase || !st.Locked || st.Setup {
		t.Fatalf("reopened %+v", st)
	}
	if _, err := s2.Value("TOKEN"); !errors.Is(err, ErrLocked) {
		t.Errorf("locked value: %v", err)
	}
	if err := s2.Unlock("wrong horse"); !errors.Is(err, ErrPassphrase) {
		t.Errorf("wrong passphrase: %v", err)
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

// A value is sealed with its name, machines and flag: a value moved to
// another variable, or machines or the flag changed in the file to let a
// machine read it, no longer opens.
func TestMetadataBindsValues(t *testing.T) {
	edit := func(t *testing.T, path string, f func(entries []any)) {
		t.Helper()
		var raw map[string]any
		b, _ := os.ReadFile(path)
		json.Unmarshal(b, &raw)
		f(raw["entries"].([]any))
		b, _ = json.Marshal(raw)
		os.WriteFile(path, b, 0o600)
	}
	reopen := func(t *testing.T, path string) *Store {
		t.Helper()
		s := openTest(t, path, nil)
		if err := s.Unlock(pass); err != nil {
			t.Fatal(err)
		}
		return s
	}
	for name, f := range map[string]func(entries []any){
		"swapped values": func(e []any) {
			a, b := e[0].(map[string]any), e[1].(map[string]any)
			a["value"], b["value"] = b["value"], a["value"]
		},
		"machines widened": func(e []any) { e[0].(map[string]any)["machines"] = []any{"*"} },
		"flag dropped":     func(e []any) { e[0].(map[string]any)["injectOnly"] = false },
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "vault.json")
			s := newVault(t, path)
			s.Set("A", Update{Value: str("alpha"), Machines: &[]string{"box"}, InjectOnly: boolp(true)})
			s.Set("B", Update{Value: str("bravo")})
			edit(t, path, f)
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

// A vault of an earlier version, its key in the keychain and its values
// sealed with their names only, opens with the key, is sealed again with
// the machines, asks for a passphrase, and then leaves the keychain.
func TestKeychainVaultConverts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	keys := &MemKeyStore{Keys: map[string]string{"vault.json": base64.StdEncoding.EncodeToString(key)}}
	check, _ := seal(key, []byte(checkText), checkAD)
	v, _ := seal(key, []byte("old-secret"), "OLD")
	f := map[string]any{"version": 1, "mode": ModeKeychain, "check": check, "entries": []any{
		map[string]any{"name": "OLD", "machines": []string{"box"}, "value": v},
	}}
	b, _ := json.Marshal(f)
	os.WriteFile(path, b, 0o600)
	s := openTest(t, path, keys)
	if st := s.Status(); st.Mode != ModeKeychain || st.Locked || !st.Setup {
		t.Fatalf("keychain vault %+v", st)
	}
	if got, err := s.Value("OLD"); err != nil || got != "old-secret" {
		t.Fatalf("keychain value %q %v", got, err)
	}
	b, _ = os.ReadFile(path)
	if !strings.Contains(string(b), `"version": 2`) {
		t.Errorf("not sealed again: %s", b)
	}
	if err := s.SetPassphrase(pass); err != nil {
		t.Fatal(err)
	}
	if len(keys.Keys) != 0 {
		t.Errorf("keychain kept %v", keys.Keys)
	}
	s2 := openTest(t, path, keys)
	if st := s2.Status(); st.Mode != ModePassphrase || !st.Locked {
		t.Fatalf("converted %+v", st)
	}
	if err := s2.Unlock(pass); err != nil {
		t.Fatal(err)
	}
	if got, err := s2.Value("OLD"); err != nil || got != "old-secret" {
		t.Fatalf("converted value %q %v", got, err)
	}
	// Without its key a keychain vault cannot take a passphrase.
	b, _ = json.Marshal(f)
	os.WriteFile(path, b, 0o600)
	s3 := openTest(t, path, &MemKeyStore{})
	if st := s3.Status(); !st.Locked || st.Error != "key_missing" {
		t.Errorf("without the key %+v", st)
	}
	if err := s3.SetPassphrase(pass); !errors.Is(err, ErrKeyMissing) {
		t.Errorf("convert without the key: %v", err)
	}
	s4 := openTest(t, path, &MemKeyStore{Fail: true})
	if st := s4.Status(); !st.Locked || st.Error != "keychain_unavailable" {
		t.Errorf("without a keychain %+v", st)
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
	s2 := openTest(t, path, nil)
	if err := s2.Unlock(pass); !errors.Is(err, ErrPassphrase) {
		t.Errorf("old passphrase: %v", err)
	}
	if err := s2.Unlock("battery staple"); err != nil {
		t.Fatal(err)
	}
	if v, err := s2.Value("A"); err != nil || v != "alpha" {
		t.Errorf("value %q %v", v, err)
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
	os.WriteFile(path, []byte(`{"version":1,"future":{"x":1},"entries":[]}`), 0o600)
	s := openTest(t, path, &MemKeyStore{})
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
		b, _ := json.Marshal(map[string]any{"version": 1, "mode": ModePassphrase, "kdf": k, "check": Sealed{}, "entries": []any{}})
		os.WriteFile(path, b, 0o600)
		if _, err := Open(path, nil, "vault.json"); !errors.Is(err, ErrInvalid) {
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
// then it may read nothing without asking.
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
	s2 := openTest(t, path, nil)
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
	s3 := openTest(t, path, nil)
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
}

// A renamed variable keeps its value (sealed again under its new name, read
// back after reopening), description, machines and flag; taken names,
// invalid names and a locked vault are refused.
func TestRename(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	keys := &MemKeyStore{}
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
	s2 := openTest(t, path, keys)
	if err := s2.Unlock(pass); err != nil {
		t.Fatal(err)
	}
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

func boolp(b bool) *bool { return &b }
