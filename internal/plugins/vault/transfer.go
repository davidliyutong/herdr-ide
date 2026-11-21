package vault

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"time"

	"herdr-ide/internal/brand"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	vaultstore "herdr-ide/internal/vault"
)

// Export and import: variables leave in an encrypted file
// (vaultstore.SealExport) the core builds, so their values never reach a
// browser, and come back from one in a single write. An export is a bulk
// release: it needs the page's session and the vault's passphrase again,
// and is recorded in the access log before the file is sent. An import
// sends the file and its passphrase twice, for the preview and for the
// changes: the core keeps nothing of a file between the two.

// Actions of an import's choices.
const (
	ImportNew       = "import"
	ImportOverwrite = "overwrite"
	ImportRename    = "rename"
	ImportSkip      = "skip"
)

// maxImportBody bounds an import's request: the file as a JSON string,
// with room for its escapes, and the choices.
const maxImportBody = 2*vaultstore.MaxExportFile + 1<<20

// fileWork is held while a file's key is derived (Argon2id): one at a
// time, as passphrases are checked.
func (p *Plugin) beginFileWork(w http.ResponseWriter) bool {
	if p.fileWork.TryLock() {
		return true
	}
	w.Header().Set("Retry-After", "1")
	plugin.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "busy", "message": "another file is being encrypted or read; try again in a moment"})
	return false
}

// failNamed answers a store's error, with the variable it is about.
func failNamed(w http.ResponseWriter, err error) {
	var ne *vaultstore.NameError
	if !errors.As(err, &ne) {
		fail(w, err)
		return
	}
	code := vaultstore.Code(err)
	status := http.StatusBadRequest
	switch code {
	case "not_found":
		status = http.StatusNotFound
	case "exists":
		status = http.StatusConflict
	}
	plugin.WriteJSON(w, status, map[string]string{"error": code, "message": err.Error(), "name": ne.Name})
}

// handleExport writes the variables named ({names}, or {all: true}) into
// an export file under {filePassphrase}, once the vault's {passphrase}
// is given again: the file is the response.
func (p *Plugin) handleExport(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	var body struct {
		Passphrase     string   `json:"passphrase"`
		FilePassphrase string   `json:"filePassphrase"`
		Names          []string `json:"names"`
		All            bool     `json:"all"`
	}
	if err := plugin.ReadJSON(r, 1<<20, &body); err != nil {
		plugin.WriteError(w, err)
		return
	}
	if len([]rune(body.FilePassphrase)) < vaultstore.MinExportPassphrase {
		fail(w, vaultstore.ErrWeakExport)
		return
	}
	names := body.Names
	if body.All {
		names = nil
		for _, i := range s.List() {
			names = append(names, i.Name)
		}
	}
	names = dedupeNames(names)
	if len(names) == 0 || len(names) > vaultstore.MaxEntries {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "names to export, or all"})
		return
	}
	// A bulk release: the vault's passphrase again, checked as any other.
	if st := s.Status(); st.Mode != vaultstore.ModePassphrase {
		fail(w, vaultstore.ErrNoPassphrase)
		return
	}
	if p.slowDown(w) {
		return
	}
	err = s.Verify(body.Passphrase)
	p.tried(err == nil, errors.Is(err, vaultstore.ErrPassphrase))
	if err != nil {
		fail(w, err)
		return
	}
	if !p.beginFileWork(w) {
		return
	}
	defer p.fileWork.Unlock()
	vars, err := s.Export(names)
	if err != nil {
		failNamed(w, err)
		return
	}
	e := &vaultstore.Export{Exported: time.Now().UTC(), Machines: exportMachines(c.Host, vars), Variables: vars}
	file, err := vaultstore.SealExport(e, body.FilePassphrase, s.KDF)
	for i := range vars {
		vars[i].Value = ""
	}
	if err != nil {
		fail(w, err)
		return
	}
	c.AuditField("count", len(names))
	// The file leaves only once its record is written.
	if err := p.record(c.Host, r, "vault.exported", pageAccess(r, "export", names, ResultExported)); err != nil {
		failLog(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="`+brand.Slug+"-vault-"+time.Now().Format("2006-01-02")+`.json"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(file)))
	w.WriteHeader(http.StatusOK)
	w.Write(file)
}

func dedupeNames(names []string) []string {
	out := []string{}
	for _, n := range names {
		if !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	return out
}

// exportMachines are the machines the variables' lists name, with their
// labels, kinds and targets here.
func exportMachines(h plugin.Host, vars []vaultstore.ExportVariable) []vaultstore.ExportMachine {
	out := []vaultstore.ExportMachine{}
	var seen []string
	for _, v := range vars {
		for _, id := range v.Machines {
			if id == vaultstore.AllMachines || slices.Contains(seen, id) {
				continue
			}
			seen = append(seen, id)
			m := vaultstore.ExportMachine{ID: id, Local: id == machines.LocalID}
			if mc := machineOf(h, id); mc != nil {
				m.Label, m.Local = mc.Label(), mc.Local()
				m.Kind, m.Target = mc.Kind(), mc.Target()
			}
			out = append(out, m)
		}
	}
	return out
}

func machineOf(h plugin.Host, id string) *machines.Machine {
	if mg := h.Machines(); mg != nil {
		return mg.Get(id)
	}
	return nil
}

// mapMachines maps a variable's machines in a file to this core's: "*"
// stays; an ssh machine is kept by its id only when the file names it
// with the same kind and target as the machine of that id here (an id
// alone need not be the same machine: an --ssh machine's id is its target,
// and a record imported from herdr's catalog keeps herdr's id), and the
// local machine, whose id is the same on every core, only when its label
// (the host's name) is the same too; labels alone map nothing, as two
// machines may share one. The others leave the list, so they ask every
// time.
func mapMachines(h plugin.Host, file []vaultstore.ExportMachine, ms []string) (mapped, unknown []string) {
	mapped = []string{}
	for _, id := range ms {
		if id == vaultstore.AllMachines {
			mapped = append(mapped, id)
			continue
		}
		mc := machineOf(h, id)
		i := slices.IndexFunc(file, func(m vaultstore.ExportMachine) bool { return m.ID == id })
		ok := mc != nil && i >= 0
		switch {
		case !ok:
		case mc.Local():
			ok = file[i].Label != "" && file[i].Label == mc.Label()
		default:
			ok = file[i].Kind == mc.Kind() && file[i].Target != "" && file[i].Target == mc.Target()
		}
		if ok {
			mapped = append(mapped, id)
		} else {
			unknown = append(unknown, id)
		}
	}
	return mapped, unknown
}

// importBody is what an import's preview and its changes send: the file's
// text and its passphrase, and for the changes the choices.
type importBody struct {
	File       string `json:"file"`
	Passphrase string `json:"passphrase"`
	Choices    []struct {
		// I is the variable's index in the file.
		I      int    `json:"i"`
		Action string `json:"action"`
		As     string `json:"as,omitempty"`
	} `json:"choices"`
}

// readImport reads an import's request and opens its file; false when it
// answered.
func (p *Plugin) readImport(w http.ResponseWriter, r *http.Request) (*importBody, *vaultstore.Export, bool) {
	var body importBody
	if err := plugin.ReadJSON(r, maxImportBody, &body); err != nil {
		plugin.WriteError(w, err)
		return nil, nil, false
	}
	if len(body.File) > vaultstore.MaxExportFile {
		fail(w, vaultstore.ErrTooLarge)
		return nil, nil, false
	}
	if !p.beginFileWork(w) {
		return nil, nil, false
	}
	e, err := vaultstore.OpenExport([]byte(body.File), body.Passphrase)
	p.fileWork.Unlock()
	if err != nil {
		fail(w, err)
		return nil, nil, false
	}
	return &body, e, true
}

// previewVariable is a variable of a file as the preview shows it: never
// its value.
type previewVariable struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	InjectOnly  bool     `json:"injectOnly"`
	Machines    []string `json:"machines"`
	// Unknown are machines of its list this core does not know: they
	// will ask every time.
	Unknown []string `json:"unknown,omitempty"`
	// Exists: the vault has a variable of that name.
	Exists bool `json:"exists"`
	// Invalid is why it cannot be imported as it is (invalid_name: under
	// another name only; invalid: not at all).
	Invalid string `json:"invalid,omitempty"`
}

// handleImportPreview opens a file ({file, passphrase}) and says what it
// holds, without values: each variable's name, description, flag, the
// machines it maps to here and those unknown, whether its name is taken.
func (p *Plugin) handleImportPreview(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	_, e, ok := p.readImport(w, r)
	if !ok {
		return
	}
	vars := make([]previewVariable, 0, len(e.Variables))
	for _, v := range e.Variables {
		mapped, unknown := mapMachines(c.Host, e.Machines, v.Machines)
		pv := previewVariable{Name: v.Name, Description: v.Description, InjectOnly: v.InjectOnly, Machines: mapped, Unknown: unknown}
		if _, taken := s.Get(v.Name); taken {
			pv.Exists = true
		}
		if err := vaultstore.CheckImport(importOf(v, mapped, false)); err != nil {
			pv.Invalid = vaultstore.Code(err)
		}
		vars = append(vars, pv)
	}
	e.Variables = nil // the values go
	ms := make([]map[string]any, 0, len(e.Machines))
	for _, m := range e.Machines {
		_, unknown := mapMachines(c.Host, e.Machines, []string{m.ID})
		ms = append(ms, map[string]any{"id": m.ID, "label": m.Label, "local": m.Local, "known": len(unknown) == 0})
	}
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"exported": e.Exported, "variables": vars, "machines": ms})
}

func importOf(v vaultstore.ExportVariable, machines []string, overwrite bool) vaultstore.Import {
	return vaultstore.Import{
		Name: v.Name, Value: v.Value, Description: v.Description, Machines: machines,
		InjectOnly: v.InjectOnly, Created: v.Created, Overwrite: overwrite,
	}
}

// handleImport imports a file's variables as chosen ({file, passphrase,
// choices: [{i, action: import|overwrite|rename|skip, as}]}) in one write:
// a refusal of any changes nothing. Their machines are mapped as the
// preview showed. Audited with the names, never values.
func (p *Plugin) handleImport(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
	s, err := p.open(c.Host)
	if err != nil {
		fail(w, err)
		return
	}
	body, e, ok := p.readImport(w, r)
	if !ok {
		return
	}
	bad := func(msg string) {
		plugin.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": msg})
	}
	var list []vaultstore.Import
	var names, overwritten []string
	renamed := map[string]string{}
	done := map[int]bool{}
	for _, ch := range body.Choices {
		if ch.I < 0 || ch.I >= len(e.Variables) || done[ch.I] {
			bad("a choice names no variable of the file, or one twice")
			return
		}
		done[ch.I] = true
		v := e.Variables[ch.I]
		mapped, _ := mapMachines(c.Host, e.Machines, v.Machines)
		im := importOf(v, mapped, false)
		switch ch.Action {
		case ImportSkip:
			continue
		case ImportNew:
		case ImportOverwrite:
			im.Overwrite = true
			overwritten = append(overwritten, v.Name)
		case ImportRename:
			im.Name = ch.As
			renamed[ch.As] = v.Name
		default:
			bad("action is import, overwrite, rename or skip")
			return
		}
		list = append(list, im)
		names = append(names, im.Name)
	}
	if len(list) == 0 {
		bad("nothing to import")
		return
	}
	err = s.Import(list)
	for i := range list {
		list[i].Value = ""
	}
	e.Variables = nil
	if err != nil {
		if errors.Is(err, vaultstore.ErrLocked) {
			changed(c.Host)
		}
		failNamed(w, err)
		return
	}
	fields := map[string]any{"names": names}
	if len(overwritten) > 0 {
		fields["overwritten"] = overwritten
	}
	if len(renamed) > 0 {
		fields["renamed"] = renamed
	}
	c.Host.Audit(r, "vault.imported", fields)
	changed(c.Host)
	plugin.WriteJSON(w, http.StatusOK, map[string]any{"imported": names})
}
