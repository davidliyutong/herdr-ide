package vault

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"veldr/internal/machines"
	vaultstore "veldr/internal/vault"
)

const filePass = "a long export phrase"

// exportFile calls the export route and returns the status and the body.
func (c *client) export(body map[string]any) (int, []byte) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/p/vault/export", strings.NewReader(mustJSON(body)))
	if c.tok != "" {
		r.Header.Set(SessionHeader, c.tok)
	}
	c.mux.ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}

func errorOf(b []byte) string {
	var out map[string]any
	json.Unmarshal(b, &out)
	s, _ := out["error"].(string)
	return s
}

// withMachines gives the host machines: "local" (labelled label) and m1.
func withMachines(h *fakeHost, localLabel string) {
	h.mg = machines.NewManager([]machines.Spec{
		{ID: machines.LocalID, Label: localLabel, Kind: machines.KindLocal},
		{ID: "m1", Label: "gpu", Kind: machines.KindSSH, Target: "gpu"},
	}, nil, log.New(os.Stderr, "", 0))
}

// An export needs the page's session and the vault's passphrase again, a
// file passphrase of 12 characters; the file holds the values sealed, its
// machines with their labels, and is recorded as a release without values.
func TestExport(t *testing.T) {
	p, h, s := newTest(t)
	withMachines(h, "mac (local)")
	s.Set("A", vaultstore.Update{Value: str("s3cret-a"), Machines: &[]string{"m1", "local"}, Description: str("first")})
	s.Set("B", vaultstore.Update{Value: str("s3cret-b")})
	c := newClient(p, h)
	req := map[string]any{"passphrase": pass, "filePassphrase": filePass, "names": []string{"A"}}
	if code, b := c.export(req); code != 401 || errorOf(b) != "vault_session" {
		t.Fatalf("without a session %d %s", code, b)
	}
	c.session(t)
	for name, x := range map[string]struct {
		body map[string]any
		code int
		err  string
	}{
		"wrong passphrase":     {map[string]any{"passphrase": "wrong horse", "filePassphrase": filePass, "names": []string{"A"}}, 403, "wrong_passphrase"},
		"weak file passphrase": {map[string]any{"passphrase": pass, "filePassphrase": "too short", "names": []string{"A"}}, 400, "weak_export_passphrase"},
		"nothing chosen":       {map[string]any{"passphrase": pass, "filePassphrase": filePass}, 400, "bad_request"},
		"a variable not there": {map[string]any{"passphrase": pass, "filePassphrase": filePass, "names": []string{"A", "NOPE"}}, 404, "not_found"},
	} {
		if code, b := c.export(x.body); code != x.code || errorOf(b) != x.err {
			t.Errorf("%s: %d %s", name, code, b)
		}
	}
	p.mu.Lock()
	p.fails, p.waitUntil = 0, p.waitUntil.AddDate(-1, 0, 0)
	p.mu.Unlock()
	code, file := c.export(req)
	if code != 200 || strings.Contains(string(file), "s3cret") {
		t.Fatalf("export %d %s", code, file)
	}
	e, err := vaultstore.OpenExport(file, filePass)
	if err != nil || len(e.Variables) != 1 || e.Variables[0].Value != "s3cret-a" || e.Variables[0].Description != "first" {
		t.Fatalf("file %+v %v", e, err)
	}
	if mustJSON(e.Machines) != `[{"id":"m1","label":"gpu","kind":"ssh","target":"gpu"},{"id":"local","label":"mac (local)","local":true,"kind":"local"}]` {
		t.Errorf("machines %s", mustJSON(e.Machines))
	}
	// All: every variable.
	req["names"], req["all"] = nil, true
	if code, file := c.export(req); code != 200 {
		t.Fatalf("all %d", code)
	} else if e, _ := vaultstore.OpenExport(file, filePass); len(e.Variables) != 2 {
		t.Errorf("all %+v", e)
	}
	l := p.Log()
	if len(l) != 2 || l[0].Tool != "export" || l[0].Result != ResultExported || strings.Join(l[0].Names, ",") != "A,B" || l[1].Names[0] != "A" {
		t.Errorf("log %+v", l)
	}
	audit := h.auditLog()
	if !strings.Contains(audit, `vault.exported {"names":["A"],"result":"exported","tool":"export"}`) ||
		strings.Contains(audit, "s3cret") || strings.Contains(audit, filePass) || strings.Contains(audit, pass) {
		t.Errorf("audit %s", audit)
	}
	// Locked, the vault exports nothing.
	s.Lock()
	if code, b := c.export(req); code != 409 || errorOf(b) != "vault_locked" {
		t.Errorf("locked %d %s", code, b)
	}
}

// importReq is an import's request.
func importReq(file []byte, passphrase string, choices []map[string]any) string {
	return mustJSON(map[string]any{"file": string(file), "passphrase": passphrase, "choices": choices})
}

// An import previews a file without values: which names exist, which
// machines are unknown here; then imports, skips, overwrites or renames as
// chosen in one write, mapping machines by id (the local machine only with
// the same label), the others asking every time.
func TestImport(t *testing.T) {
	_, sh, ss := newTest(t)
	withMachines(sh, "old-mac (local)")
	ss.Set("NEW", vaultstore.Update{Value: str("v-new"), Machines: &[]string{"m1", "local", "gone"}, Description: str("d")})
	ss.Set("SAME", vaultstore.Update{Value: str("v-same"), Machines: &[]string{"*"}})
	ss.Set("OTHER", vaultstore.Update{Value: str("v-other")})
	ss.Set("RENAMED", vaultstore.Update{Value: str("v-renamed"), InjectOnly: boolp(true)})
	// "gone" is a machine neither core has a record of.
	vars, _ := ss.Export([]string{"NEW", "SAME", "OTHER", "RENAMED"})
	file, err := vaultstore.SealExport(&vaultstore.Export{Machines: exportMachines(sh, vars), Variables: vars}, filePass, ss.KDF)
	if err != nil {
		t.Fatal(err)
	}

	p, h, s := newTest(t)
	withMachines(h, "new-mac (local)")
	s.Set("SAME", vaultstore.Update{Value: str("mine")})
	s.Set("OTHER", vaultstore.Update{Value: str("mine too")})
	c := newClient(p, h)
	if code, out := c.do("POST", "/api/p/vault/import/preview", importReq(file, filePass, nil)); code != 401 || out["error"] != "vault_session" {
		t.Fatalf("without a session %d %v", code, out)
	}
	c.session(t)
	code, out := c.do("POST", "/api/p/vault/import/preview", importReq(file, filePass, nil))
	if code != 200 || strings.Contains(mustJSON(out), "v-") {
		t.Fatalf("preview %d %v", code, out)
	}
	var preview struct {
		Variables []previewVariable `json:"variables"`
		Machines  []map[string]any  `json:"machines"`
	}
	json.Unmarshal([]byte(mustJSON(out)), &preview)
	if len(preview.Variables) != 4 {
		t.Fatalf("preview %+v", preview)
	}
	nv := preview.Variables[0]
	if nv.Name != "NEW" || nv.Exists || nv.Description != "d" || strings.Join(nv.Machines, ",") != "m1" || strings.Join(nv.Unknown, ",") != "local,gone" {
		t.Errorf("NEW %+v", nv)
	}
	if sv := preview.Variables[1]; sv.Name != "SAME" || !sv.Exists || sv.Machines[0] != "*" {
		t.Errorf("SAME %+v", sv)
	}
	if mustJSON(preview.Machines) != `[{"id":"m1","known":true,"label":"gpu","local":false},{"id":"local","known":false,"label":"old-mac (local)","local":true},{"id":"gone","known":false,"label":"","local":false}]` {
		t.Errorf("machines %s", mustJSON(preview.Machines))
	}

	// A conflict refuses it all.
	choices := []map[string]any{{"i": 0, "action": "import"}, {"i": 1, "action": "import"}}
	if code, out := c.do("POST", "/api/p/vault/import", importReq(file, filePass, choices)); code != 409 || out["error"] != "exists" || out["name"] != "SAME" {
		t.Errorf("conflict %d %v", code, out)
	}
	if _, ok := s.Get("NEW"); ok {
		t.Error("a refused import wrote NEW")
	}
	for name, x := range map[string]struct {
		choices []map[string]any
		err     string
	}{
		"no choice":        {nil, "bad_request"},
		"out of the file":  {[]map[string]any{{"i": 9, "action": "import"}}, "bad_request"},
		"twice":            {[]map[string]any{{"i": 0, "action": "import"}, {"i": 0, "action": "skip"}}, "bad_request"},
		"unknown action":   {[]map[string]any{{"i": 0, "action": "merge"}}, "bad_request"},
		"invalid new name": {[]map[string]any{{"i": 3, "action": "rename", "as": "1BAD"}}, "invalid_name"},
		"new name taken":   {[]map[string]any{{"i": 3, "action": "rename", "as": "OTHER"}}, "exists"},
	} {
		if code, out := c.do("POST", "/api/p/vault/import", importReq(file, filePass, x.choices)); out["error"] != x.err {
			t.Errorf("%s: %d %v", name, code, out)
		}
	}
	choices = []map[string]any{
		{"i": 0, "action": "import"},
		{"i": 1, "action": "overwrite"},
		{"i": 2, "action": "skip"},
		{"i": 3, "action": "rename", "as": "MOVED"},
	}
	code, out = c.do("POST", "/api/p/vault/import", importReq(file, filePass, choices))
	if code != 200 || mustJSON(out["imported"]) != `["NEW","SAME","MOVED"]` {
		t.Fatalf("import %d %v", code, out)
	}
	for name, want := range map[string]string{"NEW": "v-new", "SAME": "v-same", "OTHER": "mine too", "MOVED": "v-renamed"} {
		if v, err := s.Value(name); v != want || err != nil {
			t.Errorf("%s = %q %v", name, v, err)
		}
	}
	if i, _ := s.Get("NEW"); strings.Join(i.Machines, ",") != "m1" || i.Description != "d" {
		t.Errorf("NEW %+v", i)
	}
	if i, _ := s.Get("MOVED"); !i.InjectOnly {
		t.Errorf("MOVED %+v", i)
	}
	audit := h.auditLog()
	if !strings.Contains(audit, `vault.imported {"names":["NEW","SAME","MOVED"],"overwritten":["SAME"],"renamed":{"MOVED":"RENAMED"}}`) ||
		strings.Contains(audit, "v-new") || strings.Contains(audit, filePass) {
		t.Errorf("audit %s", audit)
	}
	// An import is no release: the access log has none of it.
	if l := p.Log(); len(l) != 0 {
		t.Errorf("log %+v", l)
	}
}

// An id is the same machine only with the same kind and target: an export
// naming the --ssh machine devbox (its id is its target) does not let
// another core's machine of that id but another target read without
// asking, nor does a file that recorded no targets (an earlier version);
// the same target maps.
func TestImportMapsMachinesByTarget(t *testing.T) {
	_, sh, ss := newTest(t)
	sh.mg = machines.NewManager([]machines.Spec{
		{ID: "devbox", Label: "devbox", Kind: machines.KindSSH, Target: "devbox"},
		{ID: "m1", Label: "gpu", Kind: machines.KindSSH, Target: "me@gpu"},
	}, nil, log.New(os.Stderr, "", 0))
	ss.Set("A", vaultstore.Update{Value: str("v"), Machines: &[]string{"devbox", "m1"}})
	vars, _ := ss.Export([]string{"A"})
	ms := exportMachines(sh, vars)
	if mustJSON(ms) != `[{"id":"devbox","label":"devbox","kind":"ssh","target":"devbox"},{"id":"m1","label":"gpu","kind":"ssh","target":"me@gpu"}]` {
		t.Fatalf("exported machines %s", mustJSON(ms))
	}
	file, _ := vaultstore.SealExport(&vaultstore.Export{Machines: ms, Variables: vars}, filePass, ss.KDF)
	old := make([]vaultstore.ExportMachine, len(ms))
	for i, m := range ms {
		old[i] = vaultstore.ExportMachine{ID: m.ID, Label: m.Label}
	}
	oldFile, _ := vaultstore.SealExport(&vaultstore.Export{Machines: old, Variables: vars}, filePass, ss.KDF)

	p, h, s := newTest(t)
	h.mg = machines.NewManager([]machines.Spec{
		{ID: "devbox", Label: "devbox", Kind: machines.KindSSH, Target: "me@elsewhere"},
		{ID: "m1", Label: "gpu", Kind: machines.KindSSH, Target: "me@gpu"},
	}, nil, log.New(os.Stderr, "", 0))
	c := newClient(p, h)
	c.session(t)
	preview := func(f []byte) (string, string) {
		t.Helper()
		code, out := c.do("POST", "/api/p/vault/import/preview", importReq(f, filePass, nil))
		if code != 200 {
			t.Fatalf("preview %d %v", code, out)
		}
		v := out["variables"].([]any)[0].(map[string]any)
		return mustJSON(v["machines"]), mustJSON(v["unknown"])
	}
	if mapped, unknown := preview(file); mapped != `["m1"]` || unknown != `["devbox"]` {
		t.Errorf("mapped %s, unknown %s", mapped, unknown)
	}
	if mapped, unknown := preview(oldFile); mapped != `[]` || unknown != `["devbox","m1"]` {
		t.Errorf("a file without targets: mapped %s, unknown %s", mapped, unknown)
	}
	code, out := c.do("POST", "/api/p/vault/import", importReq(file, filePass, []map[string]any{{"i": 0, "action": "import"}}))
	if code != 200 {
		t.Fatalf("import %d %v", code, out)
	}
	if i, _ := s.Get("A"); strings.Join(i.Machines, ",") != "m1" {
		t.Errorf("imported machines %v", i.Machines)
	}
}

// A file of the same core keeps its local machine; a wrong passphrase, a
// changed file, another version and a file too large fail with codes.
func TestImportFailures(t *testing.T) {
	p, h, s := newTest(t)
	withMachines(h, "mac (local)")
	s.Set("A", vaultstore.Update{Value: str("v"), Machines: &[]string{"local"}})
	vars, _ := s.Export([]string{"A"})
	file, _ := vaultstore.SealExport(&vaultstore.Export{Machines: exportMachines(h, vars), Variables: vars}, filePass, s.KDF)
	c := newClient(p, h)
	c.session(t)
	_, out := c.do("POST", "/api/p/vault/import/preview", importReq(file, filePass, nil))
	if v := out["variables"].([]any)[0].(map[string]any); mustJSON(v["machines"]) != `["local"]` || v["unknown"] != nil {
		t.Errorf("same local machine %v", v)
	}
	var env map[string]any
	json.Unmarshal(file, &env)
	ct, _ := base64.StdEncoding.DecodeString(env["ciphertext"].(string))
	ct[0] ^= 1
	env["ciphertext"] = base64.StdEncoding.EncodeToString(ct)
	tampered, _ := json.Marshal(env)
	env["version"] = 7
	future, _ := json.Marshal(env)
	for name, x := range map[string]struct {
		file       []byte
		passphrase string
		code       int
		err        string
	}{
		"wrong passphrase": {file, "another long phrase", 400, "file_passphrase"},
		"changed":          {tampered, filePass, 400, "file_passphrase"},
		"version":          {future, filePass, 400, "file_version"},
		"not a file":       {[]byte("hello"), filePass, 400, "bad_file"},
		"too large":        {[]byte(strings.Repeat("x", vaultstore.MaxExportFile+1)), filePass, 413, "too_large"},
	} {
		for _, route := range []string{"/api/p/vault/import/preview", "/api/p/vault/import"} {
			code, out := c.do("POST", route, importReq(x.file, x.passphrase, []map[string]any{{"i": 0, "action": "overwrite"}}))
			if code != x.code || out["error"] != x.err {
				t.Errorf("%s %s: %d %v", name, route, code, out)
			}
		}
	}
	if v, _ := s.Value("A"); v != "v" {
		t.Errorf("A changed: %q", v)
	}
}

func boolp(b bool) *bool { return &b }
