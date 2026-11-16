package vault

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const filePass = "a long export phrase"

func sample() *Export {
	t0 := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return &Export{
		Exported: t0,
		Machines: []ExportMachine{{ID: "m1", Label: "gpu"}},
		Variables: []ExportVariable{
			{Name: "A", Value: "s3cret-a", Description: "first", Machines: []string{"m1"}, InjectOnly: true, Created: t0, Updated: t0},
			{Name: "B", Value: "s3cret-b", Machines: []string{"*"}, Created: t0, Updated: t0},
		},
	}
}

// A file opens with its passphrase into what was sealed; it says in the
// clear only its format, version, derivation and cipher.
func TestExportRoundTrip(t *testing.T) {
	b, err := SealExport(sample(), filePass, testKDF)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte("s3cret")) || bytes.Contains(b, []byte("first")) || bytes.Contains(b, []byte(`"A"`)) {
		t.Fatalf("content in the clear: %s", b)
	}
	var clear map[string]any
	json.Unmarshal(b, &clear)
	keys := []string{}
	for k := range clear {
		keys = append(keys, k)
	}
	if len(keys) != 6 || clear["format"] != ExportFormat() || clear["version"] != float64(ExportVersion) || clear["cipher"] != "aes-256-gcm" {
		t.Errorf("envelope %v", clear)
	}
	e, err := OpenExport(b, filePass)
	if err != nil {
		t.Fatal(err)
	}
	if mustJSON(t, e) != mustJSON(t, sample()) {
		t.Errorf("opened\n%s\nwant\n%s", mustJSON(t, e), mustJSON(t, sample()))
	}
	// Each file has its own salt and nonce.
	b2, _ := SealExport(sample(), filePass, testKDF)
	if bytes.Equal(b, b2) {
		t.Error("two files alike")
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// A wrong passphrase, a changed file, another version or format and
// derivation parameters out of bounds fail with their codes.
func TestExportFailures(t *testing.T) {
	if _, err := SealExport(sample(), "short phras", testKDF); Code(err) != "weak_export_passphrase" {
		t.Errorf("11 characters: %v", err)
	}
	b, _ := SealExport(sample(), filePass, testKDF)
	if _, err := OpenExport(b, "another long phrase"); Code(err) != "file_passphrase" {
		t.Errorf("wrong passphrase: %v", err)
	}
	change := func(f func(m map[string]any)) []byte {
		var m map[string]any
		json.Unmarshal(b, &m)
		f(m)
		out, _ := json.Marshal(m)
		return out
	}
	for name, c := range map[string]struct {
		file []byte
		code string
	}{
		"ciphertext changed": {change(func(m map[string]any) {
			ct, _ := base64.StdEncoding.DecodeString(m["ciphertext"].(string))
			ct[10] ^= 1
			m["ciphertext"] = base64.StdEncoding.EncodeToString(ct)
		}), "file_passphrase"},
		"derivation changed within bounds": {change(func(m map[string]any) { m["kdf"].(map[string]any)["time"] = 2.0 }), "file_passphrase"},
		"nonce of another size":            {change(func(m map[string]any) { m["nonce"] = "AAAA" }), "file_passphrase"},
		"memory out of bounds":             {change(func(m map[string]any) { m["kdf"].(map[string]any)["memory"] = float64(4 << 20) }), "bad_file"},
		"no salt":                          {change(func(m map[string]any) { delete(m["kdf"].(map[string]any), "salt") }), "bad_file"},
		"another version":                  {change(func(m map[string]any) { m["version"] = 2.0 }), "file_version"},
		"another format":                   {change(func(m map[string]any) { m["format"] = "something-else" }), "bad_file"},
		"another cipher":                   {change(func(m map[string]any) { m["cipher"] = "chacha20" }), "bad_file"},
		"not JSON":                         {[]byte("PK\x03\x04"), "bad_file"},
		"too large":                        {bytes.Repeat([]byte(" "), MaxExportFile+1), "too_large"},
	} {
		if _, err := OpenExport(c.file, filePass); Code(err) != c.code {
			t.Errorf("%s: %v (%s), want %s", name, err, Code(err), c.code)
		}
	}
	many := &Export{}
	for i := 0; i <= MaxEntries; i++ {
		many.Variables = append(many.Variables, ExportVariable{Name: "V", Value: "x"})
	}
	if _, err := SealExport(many, filePass, testKDF); !errors.Is(err, ErrFull) {
		t.Errorf("too many: %v", err)
	}
}

// Export reads values of an unlocked vault; Import writes several in one
// write, and a refusal of any changes nothing.
func TestStoreExportImport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	s := newVault(t, path)
	s.Set("A", Update{Value: str("va"), Machines: &[]string{"m1"}, Description: str("d")})
	s.Set("TAKEN", Update{Value: str("old")})
	vars, err := s.Export([]string{"A", "TAKEN"})
	if err != nil || len(vars) != 2 || vars[0].Value != "va" || vars[0].Machines[0] != "m1" || vars[0].Description != "d" || vars[1].Value != "old" {
		t.Fatalf("export %+v %v", vars, err)
	}
	if _, err := s.Export([]string{"A", "NOPE"}); Code(err) != "not_found" {
		t.Errorf("missing %v", err)
	} else if ne := (*NameError)(nil); !errors.As(err, &ne) || ne.Name != "NOPE" {
		t.Errorf("missing name %v", err)
	}

	created := time.Date(2025, 5, 5, 0, 0, 0, 0, time.UTC)
	refused := map[string][]Import{
		"taken without overwrite": {{Name: "NEW", Value: "n"}, {Name: "TAKEN", Value: "x"}},
		"twice":                   {{Name: "NEW", Value: "n"}, {Name: "NEW", Value: "m"}},
		"invalid name":            {{Name: "NEW", Value: "n"}, {Name: "1BAD", Value: "x"}},
		"value too long":          {{Name: "NEW", Value: strings.Repeat("x", MaxValue+1)}},
		"control in a machine":    {{Name: "NEW", Value: "n", Machines: []string{"a\nb"}}},
	}
	for name, list := range refused {
		if err := s.Import(list); err == nil {
			t.Errorf("%s: imported", name)
		}
		if _, ok := s.Get("NEW"); ok {
			t.Errorf("%s: NEW written", name)
		}
	}
	if v, _ := s.Value("TAKEN"); v != "old" {
		t.Errorf("TAKEN %q", v)
	}
	err = s.Import([]Import{
		{Name: "NEW", Value: "n", Description: "nd", Machines: []string{"m2", "m2"}, InjectOnly: true, Created: created},
		{Name: "TAKEN", Value: "replaced", Overwrite: true, Created: created},
	})
	if err != nil {
		t.Fatal(err)
	}
	s2 := reopen(t, path)
	i, _ := s2.Get("NEW")
	if v, _ := s2.Value("NEW"); v != "n" || i.Description != "nd" || !i.InjectOnly || len(i.Machines) != 1 || !i.Created.Equal(created) {
		t.Errorf("NEW %+v %q", i, v)
	}
	i, _ = s2.Get("TAKEN")
	if v, _ := s2.Value("TAKEN"); v != "replaced" || i.Created.Equal(created) {
		t.Errorf("TAKEN %+v %q", i, v)
	}
	s2.Lock()
	if err := s2.Import([]Import{{Name: "X", Value: "x"}}); !errors.Is(err, ErrLocked) {
		t.Errorf("locked import %v", err)
	}
	if _, err := s2.Export([]string{"NEW"}); !errors.Is(err, ErrLocked) {
		t.Errorf("locked export %v", err)
	}
}

// An import that would pass the vault's bound of variables changes
// nothing.
func TestImportIsBounded(t *testing.T) {
	s := newVault(t, filepath.Join(t.TempDir(), "vault.json"))
	var list []Import
	for i := 0; i <= MaxEntries; i++ {
		list = append(list, Import{Name: "V" + strings.Repeat("_", i%3) + string(rune('A'+i%26)) + itoa(i), Value: "x"})
	}
	if err := s.Import(list); !errors.Is(err, ErrFull) {
		t.Fatalf("too many: %v", err)
	}
	if n := len(s.List()); n != 0 {
		t.Errorf("%d written", n)
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}
