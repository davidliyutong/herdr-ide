// Package vault is the variable vault's store on the core host: named
// values (API keys and the like) encrypted one by one with AES-256-GCM in
// vault[-<instance>].json beside the settings file, under a master key
// derived from the user's passphrase with Argon2id and kept only in the
// core's memory while unlocked. Names, descriptions and the machines
// allowed to read a variable are stored in the clear; values never are,
// and each value's encryption covers its name, its machines and its
// inject-only flag (adOf), so a file edited to let a machine read a
// variable no longer opens it. The core's plugin (internal/plugins/vault)
// serves it to the UI and to the MCP servers on machines
// (docs/features/30-variable-vault.md).
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"sync"
	"time"
	"unicode"

	"golang.org/x/crypto/argon2"

	"herdr-ide/internal/userfile"
)

// Limits of what the vault keeps.
const (
	MaxName        = 128
	MaxValue       = 64 << 10
	MaxDescription = 1 << 10
	MaxMachines    = 256
	MaxMachineID   = 256
	MaxEntries     = 1000
	// AllMachines in a variable's machines lets every machine read it.
	AllMachines = "*"
)

// Modes of the master key.
const (
	// ModeNone: no passphrase yet (a new vault).
	ModeNone = ""
	// ModePassphrase: a key derived from the user's passphrase (Argon2id).
	ModePassphrase = "passphrase"
)

// FileVersion is the version of the files this store reads and writes: a
// file of another version, holding a passphrase or variables, does not
// open (development versions sealed values differently).
const FileVersion = 3

// Errors, each with the code the UI and the MCP servers get (Code).
var (
	ErrLocked        = errors.New("the vault is locked")
	ErrNotFound      = errors.New("no such variable")
	ErrInvalidName   = errors.New("a name is a letter or _ followed by letters, digits and _, at most 128")
	ErrInvalid       = errors.New("invalid variable")
	ErrValueRequired = errors.New("a new variable needs a value")
	ErrPassphrase    = errors.New("wrong passphrase")
	ErrWeak          = errors.New("the passphrase must have at least 8 characters")
	ErrCorrupt       = errors.New("a value cannot be decrypted")
	ErrFull          = errors.New("too many variables")
	ErrExists        = errors.New("a variable of that name exists")
	ErrNoPassphrase  = errors.New("the vault has no passphrase yet")
	ErrHasPassphrase = errors.New("the vault has a passphrase; change it with the current one")
	ErrVersion       = errors.New("the vault's file is of another version")
)

// Code is the error's code for clients: vault_locked, not_found, …
func Code(err error) string {
	switch {
	case errors.Is(err, ErrLocked):
		return "vault_locked"
	case errors.Is(err, ErrNotFound):
		return "not_found"
	case errors.Is(err, ErrInvalidName):
		return "invalid_name"
	case errors.Is(err, ErrInvalid):
		return "invalid"
	case errors.Is(err, ErrValueRequired):
		return "value_required"
	case errors.Is(err, ErrPassphrase):
		return "wrong_passphrase"
	case errors.Is(err, ErrWeak):
		return "weak_passphrase"
	case errors.Is(err, ErrCorrupt):
		return "corrupt"
	case errors.Is(err, ErrFull):
		return "full"
	case errors.Is(err, ErrExists):
		return "exists"
	case errors.Is(err, ErrNoPassphrase):
		return "no_passphrase"
	case errors.Is(err, ErrHasPassphrase):
		return "has_passphrase"
	case errors.Is(err, ErrVersion):
		return "version"
	}
	return "failed"
}

var validName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ValidName reports whether name can name a variable (an environment
// variable's name).
func ValidName(name string) bool { return len(name) <= MaxName && validName.MatchString(name) }

// Sealed is a value encrypted with AES-256-GCM.
type Sealed struct {
	Nonce      []byte `json:"nonce"`
	Ciphertext []byte `json:"ciphertext"`
}

// KDF are the Argon2id parameters of a passphrase's key.
type KDF struct {
	Salt    []byte `json:"salt"`
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memory"` // KiB
	Threads uint8  `json:"threads"`
}

// DefaultKDF are the parameters of new passphrases (RFC 9106's second
// recommended option).
var DefaultKDF = KDF{Time: 3, Memory: 64 << 10, Threads: 4}

// Bounds of the Argon2id parameters a vault's file may hold: a file
// edited to weaker ones, or to ones that would exhaust the core's memory
// or panic (no threads), is refused at Open.
const (
	saltLen    = 16
	maxKDFTime = 10
	maxKDFMem  = 1 << 20 // KiB: 1 GiB
	maxThreads = 16
)

// minKDFMemory is the least memory (KiB) a file's parameters may ask for:
// 8 MiB (tests lower it).
var minKDFMemory uint32 = 8 << 10

// validKDF reports why k cannot derive a key, nil when it can.
func validKDF(k *KDF) error {
	switch {
	case len(k.Salt) != saltLen:
		return fmt.Errorf("%w: kdf salt of %d bytes", ErrInvalid, len(k.Salt))
	case k.Time < 1 || k.Time > maxKDFTime:
		return fmt.Errorf("%w: kdf time %d", ErrInvalid, k.Time)
	case k.Memory < minKDFMemory || k.Memory > maxKDFMem:
		return fmt.Errorf("%w: kdf memory %d KiB", ErrInvalid, k.Memory)
	case k.Threads < 1 || k.Threads > maxThreads:
		return fmt.Errorf("%w: kdf threads %d", ErrInvalid, k.Threads)
	}
	return nil
}

// Entry is a stored variable.
type Entry struct {
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Machines    []string  `json:"machines"`
	InjectOnly  bool      `json:"injectOnly,omitempty"`
	Value       *Sealed   `json:"value"`
	Created     time.Time `json:"created"`
	Updated     time.Time `json:"updated"`
}

// file is vault.json.
type file struct {
	Version int    `json:"version"`
	Mode    string `json:"mode,omitempty"`
	KDF     *KDF   `json:"kdf,omitempty"`
	// Check is a known text sealed with the key: a wrong passphrase fails
	// to open it.
	Check *Sealed `json:"check,omitempty"`
	// PassphraseSet is when the passphrase was set or last changed: the
	// panel shows it, so a passphrase the user did not choose shows.
	PassphraseSet time.Time `json:"passphraseSet,omitzero"`
	Entries       []Entry   `json:"entries"`
	// Forgotten are machines removed while the vault was locked: no
	// variable lets them read without asking, and they are taken out of
	// the variables' machines (whose values are sealed again) at the next
	// unlock. The list only ever narrows who may read.
	Forgotten []string `json:"forgotten,omitempty"`
	// rest keeps the fields this version does not know.
	rest map[string]json.RawMessage
}

const checkText = "vault-check"

// checkAD is the check's additional data; no variable's is the same
// (adOf's are JSON objects).
const checkAD = "#check"

// Info is a variable as clients see it: everything but the value.
type Info struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Machines    []string  `json:"machines"`
	InjectOnly  bool      `json:"injectOnly"`
	Created     time.Time `json:"created"`
	Updated     time.Time `json:"updated"`
}

// Allows reports whether machine m may read the variable without asking.
func (i Info) Allows(m string) bool {
	return slices.Contains(i.Machines, AllMachines) || slices.Contains(i.Machines, m)
}

// adOf is the additional data a value is sealed with: the file's version,
// the variable's name, machines (sorted) and inject-only flag as JSON (an
// encoding with one text per content), so a value moved to another entry,
// or an entry whose machines were widened or flag dropped in the file,
// does not open.
func adOf(e *Entry) string {
	ms := slices.Clone(e.Machines)
	slices.Sort(ms)
	b, _ := json.Marshal(struct {
		V          int      `json:"v"`
		Name       string   `json:"name"`
		Machines   []string `json:"machines"`
		InjectOnly bool     `json:"injectOnly"`
	}{FileVersion, e.Name, ms, e.InjectOnly})
	return string(b)
}

// Status is the vault's state.
type Status struct {
	Mode   string `json:"mode"`
	Locked bool   `json:"locked"`
	// Setup: no passphrase yet; SetPassphrase sets it.
	Setup bool `json:"setup,omitempty"`
	// PassphraseSet is when the passphrase was set or last changed.
	PassphraseSet time.Time `json:"passphraseSet,omitzero"`
}

// Update changes a variable; nil fields stay as they are.
type Update struct {
	// To renames the variable, in the same write as the other changes.
	To          *string   `json:"to"`
	Description *string   `json:"description"`
	Machines    *[]string `json:"machines"`
	InjectOnly  *bool     `json:"injectOnly"`
	Value       *string   `json:"value"`
}

// Store is the vault.
type Store struct {
	path string
	// KDF are the parameters of a new passphrase (tests lower them).
	KDF KDF

	mu  sync.Mutex
	f   file
	key []byte // nil while locked
	now func() time.Time
}

// Open reads the vault at path (none yet: an empty vault, without a
// passphrase). A vault with a passphrase stays locked until Unlock.
func Open(path string) (*Store, error) {
	s := &Store{path: path, KDF: DefaultKDF, now: time.Now}
	b, sig, err := userfile.Read(path)
	if err != nil {
		return nil, err
	}
	if !sig.Exists {
		s.f = file{Version: FileVersion}
		return s, nil
	}
	if err := json.Unmarshal(b, &s.f); err != nil {
		return nil, fmt.Errorf("%s: %w: %w", path, ErrInvalid, err)
	}
	_ = json.Unmarshal(b, &s.f.rest)
	for _, k := range []string{"version", "mode", "kdf", "check", "passphraseSet", "entries", "forgotten"} {
		delete(s.f.rest, k)
	}
	switch s.f.Mode {
	case ModePassphrase:
		if s.f.KDF == nil || s.f.Check == nil {
			return nil, fmt.Errorf("%s: %w: a passphrase vault without its key's parameters", path, ErrInvalid)
		}
		if err := validKDF(s.f.KDF); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	case ModeNone:
		if len(s.f.Entries) > 0 {
			return nil, fmt.Errorf("%s: %w: variables without a passphrase", path, ErrInvalid)
		}
	default:
		return nil, fmt.Errorf("%s: %w: mode %q", path, ErrVersion, s.f.Mode)
	}
	if s.f.Version != FileVersion {
		if s.f.Mode != ModeNone {
			return nil, fmt.Errorf("%s: %w %d, not %d", path, ErrVersion, s.f.Version, FileVersion)
		}
		s.f.Version = FileVersion
	}
	return s, nil
}

// Status tells the mode and whether the vault is locked.
func (s *Store) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Status{
		Mode:          s.f.Mode,
		Locked:        s.f.Mode != ModeNone && s.key == nil,
		Setup:         s.f.Mode == ModeNone,
		PassphraseSet: s.f.PassphraseSet,
	}
}

// info is what clients see of e: its machines without those forgotten.
func info(e *Entry, forgotten []string) Info {
	m := slices.DeleteFunc(slices.Clone(e.Machines), func(x string) bool { return slices.Contains(forgotten, x) })
	if m == nil {
		m = []string{}
	}
	return Info{Name: e.Name, Description: e.Description, Machines: m, InjectOnly: e.InjectOnly, Created: e.Created, Updated: e.Updated}
}

// List returns the variables by name, without their values.
func (s *Store) List() []Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Info, 0, len(s.f.Entries))
	for i := range s.f.Entries {
		out = append(out, info(&s.f.Entries[i], s.f.Forgotten))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns a variable without its value.
func (s *Store) Get(name string) (Info, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.find(name); e != nil {
		return info(e, s.f.Forgotten), true
	}
	return Info{}, false
}

func (s *Store) find(name string) *Entry {
	for i := range s.f.Entries {
		if s.f.Entries[i].Name == name {
			return &s.f.Entries[i]
		}
	}
	return nil
}

// Value decrypts a variable's value.
func (s *Store) Value(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.find(name)
	if e == nil {
		return "", ErrNotFound
	}
	if s.key == nil {
		return "", ErrLocked
	}
	b, err := open(s.key, e.Value, adOf(e))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// reseal seals e's value again for what adOf says now (its machines or
// flag changed), from plain, the value's text; called with s.mu held and
// the key there.
func (s *Store) reseal(e *Entry, plain []byte) error {
	v, err := seal(s.key, plain, adOf(e))
	if err != nil {
		return err
	}
	e.Value = v
	return nil
}

// validMachineID reports whether m can be a machine in a variable's list:
// not empty, not too long, no control characters.
func validMachineID(m string) bool {
	if m == "" || len(m) > MaxMachineID {
		return false
	}
	for _, r := range m {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validMachines(ms []string) bool {
	if len(ms) > MaxMachines {
		return false
	}
	for _, m := range ms {
		if !validMachineID(m) {
			return false
		}
	}
	return true
}

// Set creates or changes a variable: a new one needs a value, and To
// renames one that exists (taken names are refused), all in one write, so
// a failure changes nothing. Every change needs the vault unlocked: the
// value is sealed with the name, the machines and the flag. Machines
// forgotten while the vault was locked leave every list first, so the
// machines a change names are the user's choice, a forgotten one too.
func (s *Store) Set(name string, u Update) error {
	if !ValidName(name) {
		return ErrInvalidName
	}
	to := name
	if u.To != nil {
		if !ValidName(*u.To) {
			return ErrInvalidName
		}
		to = *u.To
	}
	if u.Description != nil && len(*u.Description) > MaxDescription {
		return fmt.Errorf("%w: description longer than %d bytes", ErrInvalid, MaxDescription)
	}
	if u.Value != nil && len(*u.Value) > MaxValue {
		return fmt.Errorf("%w: value longer than %d bytes", ErrInvalid, MaxValue)
	}
	if u.Machines != nil && !validMachines(*u.Machines) {
		return fmt.Errorf("%w: machines", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.find(name)
	if e == nil && to != name {
		return ErrNotFound
	}
	if e == nil && u.Value == nil {
		return ErrValueRequired
	}
	if e == nil && len(s.f.Entries) >= MaxEntries {
		return ErrFull
	}
	if to != name && s.find(to) != nil {
		return ErrExists
	}
	if s.key == nil {
		return s.noKey()
	}
	if err := s.applyForgotten(); err != nil {
		return err
	}
	e = s.find(name) // the entries were written again
	var plain []byte
	if u.Value != nil {
		plain = []byte(*u.Value)
	} else {
		b, err := open(s.key, e.Value, adOf(e))
		if err != nil {
			return err
		}
		plain = b
	}
	defer clear(plain)
	prev := slices.Clone(s.f.Entries)
	now := s.now().UTC()
	if e == nil {
		s.f.Entries = append(s.f.Entries, Entry{Name: name, Machines: []string{}, Created: now})
		e = &s.f.Entries[len(s.f.Entries)-1]
	}
	if u.Description != nil {
		e.Description = *u.Description
	}
	if u.Machines != nil {
		e.Machines = dedupe(*u.Machines)
	}
	if u.InjectOnly != nil {
		e.InjectOnly = *u.InjectOnly
	}
	e.Name, e.Updated = to, now
	err := s.reseal(e, plain)
	if err == nil {
		err = s.save()
	}
	if err != nil {
		s.f.Entries = prev
		return err
	}
	return nil
}

func dedupe(ms []string) []string {
	out := []string{}
	for _, m := range ms {
		if !slices.Contains(out, m) {
			out = append(out, m)
		}
	}
	return out
}

// Allow adds machine m to the machines allowed to read name; a forgotten
// machine (removed, and added again under the same id) is allowed again.
func (s *Store) Allow(name, m string) error {
	if !validMachineID(m) {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.find(name)
	if e == nil {
		return ErrNotFound
	}
	if info(e, s.f.Forgotten).Allows(m) {
		return nil
	}
	if s.key == nil {
		return ErrLocked
	}
	if err := s.applyForgotten(); err != nil {
		return err
	}
	e = s.find(name) // the entries were written again
	if len(e.Machines) >= MaxMachines {
		return ErrInvalid
	}
	plain, err := open(s.key, e.Value, adOf(e))
	if err != nil {
		return err
	}
	defer clear(plain)
	prev := *e
	e.Machines = append(slices.Clone(e.Machines), m)
	err = s.reseal(e, plain)
	if err == nil {
		err = s.save()
	}
	if err != nil {
		*e = prev
		return err
	}
	return nil
}

// ForgetMachine removes machine m from every variable's machines (a
// removed machine: an id that comes back is not allowed again) and returns
// the names it was removed from.
func (s *Store) ForgetMachine(m string) ([]string, error) {
	if m == "" || m == AllMachines {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var names []string
	for i := range s.f.Entries {
		if slices.Contains(s.f.Entries[i].Machines, m) {
			names = append(names, s.f.Entries[i].Name)
		}
	}
	if len(names) == 0 {
		return nil, nil
	}
	// Taking it out of the machines seals the values again, which needs
	// the key: until then, the machine is forgotten.
	if !slices.Contains(s.f.Forgotten, m) {
		prev := s.f.Forgotten
		s.f.Forgotten = append(slices.Clone(s.f.Forgotten), m)
		if err := s.save(); err != nil {
			s.f.Forgotten = prev
			return nil, err
		}
	}
	if s.key != nil {
		_ = s.applyForgotten() // else still enforced by info, applied at the next change
	}
	return names, nil
}

// applyForgotten takes the forgotten machines out of every variable's
// machines and empties the list. A value that opens is sealed again for its
// new machines; one that does not (the file was edited) loses them too and
// stays unreadable, or opens again when they were what the edit added:
// taking machines out never lets more read. Called with s.mu held and the
// key there; on failure nothing changed and the list is still enforced by
// info.
func (s *Store) applyForgotten() error {
	if len(s.f.Forgotten) == 0 {
		return nil
	}
	forgotten := s.f.Forgotten
	gone := func(x string) bool { return slices.Contains(forgotten, x) }
	prev := slices.Clone(s.f.Entries)
	for i := range s.f.Entries {
		e := &s.f.Entries[i]
		if !slices.ContainsFunc(e.Machines, gone) {
			continue
		}
		plain, err := open(s.key, e.Value, adOf(e))
		e.Machines = slices.DeleteFunc(slices.Clone(e.Machines), gone)
		if err != nil {
			continue
		}
		err = s.reseal(e, plain)
		clear(plain)
		if err != nil {
			s.f.Entries = prev
			return err
		}
	}
	s.f.Forgotten = nil
	if err := s.save(); err != nil {
		s.f.Entries, s.f.Forgotten = prev, forgotten
		return err
	}
	return nil
}

// Delete removes a variable; it needs no key.
func (s *Store) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.f.Entries, func(e Entry) bool { return e.Name == name })
	if i < 0 {
		return ErrNotFound
	}
	prev := slices.Clone(s.f.Entries)
	s.f.Entries = slices.Delete(s.f.Entries, i, i+1)
	if err := s.save(); err != nil {
		s.f.Entries = prev
		return err
	}
	if s.key != nil {
		_ = s.applyForgotten()
	}
	return nil
}

// Lock forgets the key until Unlock.
func (s *Store) Lock() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.key)
	s.key = nil
}

// Unlock takes the key derived from the passphrase; an unlocked vault only
// checks it. Forgotten machines are then taken out of the lists.
func (s *Store) Unlock(passphrase string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Mode != ModePassphrase {
		return ErrNoPassphrase
	}
	if s.key != nil {
		return s.verify(passphrase)
	}
	key := derive(passphrase, *s.f.KDF)
	if b, err := open(key, s.f.Check, checkAD); err != nil || string(b) != checkText {
		clear(key)
		return ErrPassphrase
	}
	s.key = key
	_ = s.applyForgotten() // else still enforced by info, applied at the next change
	return nil
}

// Verify checks a passphrase without changing anything.
func (s *Store) Verify(passphrase string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Mode != ModePassphrase {
		return ErrNoPassphrase
	}
	return s.verify(passphrase)
}

func (s *Store) verify(passphrase string) error {
	key := derive(passphrase, *s.f.KDF)
	defer clear(key)
	if b, err := open(key, s.f.Check, checkAD); err != nil || string(b) != checkText {
		return ErrPassphrase
	}
	return nil
}

// SetPassphrase gives a new vault its passphrase (at least 8 characters)
// and unlocks it; a vault with a passphrase changes it with
// ChangePassphrase.
func (s *Store) SetPassphrase(passphrase string) error {
	if len([]rune(passphrase)) < 8 {
		return ErrWeak
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Mode != ModeNone {
		return ErrHasPassphrase
	}
	return s.rekey(nil, passphrase)
}

// ChangePassphrase replaces the passphrase after checking the current one;
// every value is sealed again under the new key, which then unlocks the
// vault. A failure (a value that does not open) leaves the vault as it was,
// locked if it was.
func (s *Store) ChangePassphrase(old, passphrase string) error {
	if len([]rune(passphrase)) < 8 {
		return ErrWeak
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Mode != ModePassphrase {
		return ErrNoPassphrase
	}
	cur := derive(old, *s.f.KDF)
	defer clear(cur)
	if b, err := open(cur, s.f.Check, checkAD); err != nil || string(b) != checkText {
		return ErrPassphrase
	}
	return s.rekey(cur, passphrase)
}

// rekey derives a new key from passphrase with a new salt and seals every
// value and the check under it, from cur, the current key (none for a new
// vault); only once all is written is the new key installed. Called with
// s.mu held.
func (s *Store) rekey(cur []byte, passphrase string) error {
	kdf := s.KDF
	kdf.Salt = make([]byte, saltLen)
	if _, err := rand.Read(kdf.Salt); err != nil {
		return err
	}
	key := derive(passphrase, kdf)
	entries := slices.Clone(s.f.Entries)
	for i := range entries {
		e := &entries[i]
		plain, err := open(cur, e.Value, adOf(e))
		if err != nil {
			clear(key)
			return err
		}
		v, err := seal(key, plain, adOf(e))
		clear(plain)
		if err != nil {
			clear(key)
			return err
		}
		e.Value = v
	}
	check, err := seal(key, []byte(checkText), checkAD)
	if err != nil {
		clear(key)
		return err
	}
	prev := s.f
	s.f.Entries, s.f.Version, s.f.Mode, s.f.KDF, s.f.Check, s.f.PassphraseSet = entries, FileVersion, ModePassphrase, &kdf, check, s.now().UTC()
	if err := s.save(); err != nil {
		s.f = prev
		clear(key)
		return err
	}
	clear(s.key)
	s.key = key
	_ = s.applyForgotten() // else still enforced by info, applied at the next change
	return nil
}

func derive(passphrase string, k KDF) []byte {
	return argon2.IDKey([]byte(passphrase), k.Salt, k.Time, k.Memory, k.Threads, 32)
}

// noKey says why there is no key to seal a value: a new vault needs its
// passphrase first, any other is locked.
func (s *Store) noKey() error {
	if s.f.Mode == ModeNone {
		return ErrNoPassphrase
	}
	return ErrLocked
}

func (s *Store) save() error {
	out := map[string]any{}
	for k, v := range s.f.rest {
		out[k] = v
	}
	out["version"] = s.f.Version
	if s.f.Mode != ModeNone {
		out["mode"] = s.f.Mode
	}
	if s.f.KDF != nil {
		out["kdf"] = s.f.KDF
	}
	if s.f.Check != nil {
		out["check"] = s.f.Check
	}
	if !s.f.PassphraseSet.IsZero() {
		out["passphraseSet"] = s.f.PassphraseSet
	}
	entries := s.f.Entries
	if entries == nil {
		entries = []Entry{}
	}
	out["entries"] = entries
	if len(s.f.Forgotten) > 0 {
		out["forgotten"] = s.f.Forgotten
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	_, err = userfile.Write(s.path, append(b, '\n'))
	return err
}

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// seal encrypts plain with ad as additional data (adOf), so a value moved
// to another variable in the file, or whose variable's machines or flag
// changed in it, no longer opens.
func seal(key, plain []byte, ad string) (*Sealed, error) {
	g, err := gcm(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return &Sealed{Nonce: nonce, Ciphertext: g.Seal(nil, nonce, plain, []byte(ad))}, nil
}

func open(key []byte, v *Sealed, ad string) ([]byte, error) {
	if v == nil {
		return nil, ErrCorrupt
	}
	g, err := gcm(key)
	if err != nil {
		return nil, err
	}
	if len(v.Nonce) != g.NonceSize() {
		return nil, ErrCorrupt
	}
	b, err := g.Open(nil, v.Nonce, v.Ciphertext, []byte(ad))
	if err != nil {
		return nil, ErrCorrupt
	}
	return b, nil
}
