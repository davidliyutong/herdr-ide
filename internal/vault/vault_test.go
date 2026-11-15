package vault

import (
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

func TestRoundTripWithTheKeychain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	keys := &MemKeyStore{}
	s := openTest(t, path, keys)
	if st := s.Status(); st.Mode != ModeNone || st.Locked {
		t.Fatalf("empty vault %+v", st)
	}
	if err := s.Set("API_KEY", Update{Value: str("s3cr3t-value"), Description: str("the key")}); err != nil {
		t.Fatal(err)
	}
	if len(keys.Keys) != 1 {
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
	// Opened again, the key comes from the keychain.
	s2 := openTest(t, path, keys)
	if st := s2.Status(); st.Mode != ModeKeychain || st.Locked {
		t.Fatalf("reopened %+v", st)
	}
	if v, err := s2.Value("API_KEY"); err != nil || v != "s3cr3t-value" {
		t.Fatalf("value %q, %v", v, err)
	}
	if i, _ := s2.Get("API_KEY"); i.Description != "the key" {
		t.Errorf("info %+v", i)
	}
	// Locked, no value; unlocked again from the keychain.
	s2.Lock()
	if _, err := s2.Value("API_KEY"); !errors.Is(err, ErrLocked) {
		t.Errorf("locked: %v", err)
	}
	if err := s2.Unlock(""); err != nil {
		t.Fatal(err)
	}
	// Without the key in the keychain the vault stays locked.
	s3 := openTest(t, path, &MemKeyStore{})
	if st := s3.Status(); !st.Locked || st.Error != "key_missing" {
		t.Errorf("without the key %+v", st)
	}
	s4 := openTest(t, path, &MemKeyStore{Fail: true})
	if st := s4.Status(); !st.Locked || st.Error != "keychain_unavailable" {
		t.Errorf("without a keychain %+v", st)
	}
}

// A ciphertext moved to another variable does not open: the name is the
// additional data.
func TestNamesBindTheirValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	keys := &MemKeyStore{}
	s := openTest(t, path, keys)
	s.Set("A", Update{Value: str("alpha")})
	s.Set("B", Update{Value: str("bravo")})
	var raw map[string]any
	b, _ := os.ReadFile(path)
	json.Unmarshal(b, &raw)
	entries := raw["entries"].([]any)
	a, bb := entries[0].(map[string]any), entries[1].(map[string]any)
	a["value"], bb["value"] = bb["value"], a["value"]
	b, _ = json.Marshal(raw)
	os.WriteFile(path, b, 0o600)
	s2 := openTest(t, path, keys)
	if _, err := s2.Value("A"); !errors.Is(err, ErrCorrupt) {
		t.Errorf("swapped value opened: %v", err)
	}
}

func TestPassphraseMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := openTest(t, path, &MemKeyStore{Fail: true})
	// Without a keychain the first value asks for a passphrase.
	if err := s.Set("TOKEN", Update{Value: str("v1")}); !errors.Is(err, ErrLocked) {
		t.Fatalf("first set: %v", err)
	}
	if st := s.Status(); st.Mode != ModePassphrase || !st.Locked || !st.Setup {
		t.Fatalf("status %+v", st)
	}
	if err := s.Unlock("short"); !errors.Is(err, ErrWeak) {
		t.Errorf("weak: %v", err)
	}
	if err := s.Unlock("correct horse"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("TOKEN", Update{Value: str("v1")}); err != nil {
		t.Fatal(err)
	}
	s2 := openTest(t, path, nil)
	if st := s2.Status(); st.Mode != ModePassphrase || !st.Locked || st.Setup {
		t.Fatalf("reopened %+v", st)
	}
	if _, err := s2.Value("TOKEN"); !errors.Is(err, ErrLocked) {
		t.Errorf("locked value: %v", err)
	}
	if err := s2.Unlock("wrong horse"); !errors.Is(err, ErrPassphrase) {
		t.Errorf("wrong passphrase: %v", err)
	}
	if err := s2.Unlock("correct horse"); err != nil {
		t.Fatal(err)
	}
	if v, err := s2.Value("TOKEN"); err != nil || v != "v1" {
		t.Errorf("value %q %v", v, err)
	}
	// Names and descriptions are readable while locked; deleting needs no key.
	s2.Lock()
	if len(s2.List()) != 1 {
		t.Error("list while locked")
	}
	if err := s2.Delete("TOKEN"); err != nil {
		t.Error(err)
	}
}

func TestValidation(t *testing.T) {
	s := openTest(t, filepath.Join(t.TempDir(), "vault.json"), &MemKeyStore{})
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

// A removed machine leaves every variable's list.
func TestForgetMachine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := openTest(t, path, &MemKeyStore{})
	ms := []string{"m1", "m2"}
	s.Set("A", Update{Value: str("a"), Machines: &ms})
	all := []string{"*"}
	s.Set("B", Update{Value: str("b"), Machines: &all})
	names, err := s.ForgetMachine("m1")
	if err != nil || strings.Join(names, ",") != "A" {
		t.Fatalf("forget %v %v", names, err)
	}
	s2 := openTest(t, path, nil)
	if i, _ := s2.Get("A"); strings.Join(i.Machines, ",") != "m2" {
		t.Errorf("A %v", i.Machines)
	}
	if i, _ := s2.Get("B"); strings.Join(i.Machines, ",") != "*" {
		t.Errorf("B %v", i.Machines)
	}
	if names, _ := s.ForgetMachine("m1"); names != nil {
		t.Errorf("again %v", names)
	}
}
