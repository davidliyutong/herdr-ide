// Package vault is the variable vault's store on the core host: named
// values (API keys and the like) encrypted one by one with AES-256-GCM in
// vault[-<instance>].json beside the settings file, under a master key
// derived from the user's passphrase with Argon2id and kept only in the
// core's memory while unlocked. Names, descriptions and the machines
// allowed to read a variable are stored in the clear; values never are,
// and each value's encryption covers its name, its machines and its
// inject-only flag, so a file edited to let a machine read a variable no
// longer opens it. Vaults of earlier versions kept a random key in the
// operating system's keychain instead; they open with it and are converted
// to a passphrase (ConvertToPassphrase). The core's plugin
// (internal/plugins/vault) serves it to the UI and to the MCP servers on
// machines (docs/features/30-variable-vault.md).
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

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
	// ModeNone: no key yet (no passphrase was ever set).
	ModeNone = ""
	// ModeKeychain: a random key in the operating system's keychain, as
	// vaults of earlier versions kept it; converted to a passphrase.
	ModeKeychain = "keychain"
	// ModePassphrase: a key derived from the user's passphrase (Argon2id).
	ModePassphrase = "passphrase"
)

// fileVersion is the version of new files: 2 seals each value with its
// machines and inject-only flag besides its name (adOf); version 1 files
// are sealed again when unlocked.
const fileVersion = 2

// Errors, each with the code the UI and the MCP servers get (Code).
var (
	ErrLocked        = errors.New("the vault is locked")
	ErrNotFound      = errors.New("no such variable")
	ErrInvalidName   = errors.New("a name is a letter or _ followed by letters, digits and _, at most 128")
	ErrInvalid       = errors.New("invalid variable")
	ErrValueRequired = errors.New("a new variable needs a value")
	ErrPassphrase    = errors.New("wrong passphrase")
	ErrWeak          = errors.New("the passphrase must have at least 8 characters")
	ErrKeyMissing    = errors.New("the vault's key is not in the keychain")
	ErrKeychain      = errors.New("the keychain is unavailable")
	ErrCorrupt       = errors.New("a value cannot be decrypted")
	ErrFull          = errors.New("too many variables")
	ErrExists        = errors.New("a variable of that name exists")
	ErrNoPassphrase  = errors.New("the vault has no passphrase yet")
	ErrHasPassphrase = errors.New("the vault has a passphrase; change it with the current one")
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
	case errors.Is(err, ErrKeyMissing):
		return "key_missing"
	case errors.Is(err, ErrKeychain):
		return "keychain_unavailable"
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
	// Check is a known text sealed with the key: a wrong key or
	// passphrase fails to open it.
	Check   *Sealed `json:"check,omitempty"`
	Entries []Entry `json:"entries"`
	// Forgotten are machines removed while the vault was locked: no
	// variable lets them read without asking, and they are taken out of
	// the variables' machines (whose values are sealed again) at the next
	// unlock. The list only ever narrows who may read.
	Forgotten []string `json:"forgotten,omitempty"`
	// rest keeps the fields this version does not know.
	rest map[string]json.RawMessage
}

const checkText = "vault-check"

// checkAD is the check's additional data; no variable can have this name.
const checkAD = "#check"

// KeyStore is where vaults of earlier versions kept the master key: the
// operating system's keychain (OSKeyStore) or, in tests, a map. It is read
// to open such a vault and emptied once it has a passphrase.
type KeyStore interface {
	// Get returns the secret, ErrKeyMissing when there is none, or another
	// error when the keychain cannot be used.
	Get(account string) (string, error)
	Set(account, secret string) error
	Delete(account string) error
}

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

// adOf is the additional data a value is sealed with: its name, and in
// files of version 2 its machines and inject-only flag, so a value whose
// machines or flag were changed in the file (to let a machine read it
// without asking) no longer opens.
func adOf(e *Entry, version int) string {
	if version < 2 {
		return e.Name
	}
	ms := slices.Clone(e.Machines)
	slices.Sort(ms)
	flag := ""
	if e.InjectOnly {
		flag = "inject-only"
	}
	return e.Name + "\x00" + strings.Join(ms, "\x01") + "\x00" + flag
}

// Status is the vault's state.
type Status struct {
	Mode   string `json:"mode"`
	Locked bool   `json:"locked"`
	// Setup: no passphrase yet (a new vault, one of passphrase mode whose
	// passphrase was never set, or a keychain vault to convert):
	// SetPassphrase sets it.
	Setup bool `json:"setup,omitempty"`
	// Error is why a keychain key could not be read (key_missing,
	// keychain_unavailable).
	Error string `json:"error,omitempty"`
}

// Update changes a variable; nil fields stay as they are.
type Update struct {
	Description *string   `json:"description"`
	Machines    *[]string `json:"machines"`
	InjectOnly  *bool     `json:"injectOnly"`
	Value       *string   `json:"value"`
}

// Store is the vault.
type Store struct {
	path    string
	keys    KeyStore
	account string
	// KDF are the parameters of a new passphrase (tests lower them).
	KDF KDF

	mu     sync.Mutex
	f      file
	key    []byte // nil while locked
	keyErr error  // why the keychain's key could not be read
	setup  bool   // passphrase mode without a passphrase
	now    func() time.Time
}

// Open reads the vault at path (none yet: an empty vault). keys holds the
// master key under account. A keychain vault is unlocked at once when the
// key can be read; a passphrase vault stays locked until Unlock.
func Open(path string, keys KeyStore, account string) (*Store, error) {
	s := &Store{path: path, keys: keys, account: account, KDF: DefaultKDF, now: time.Now}
	b, sig, err := userfile.Read(path)
	if err != nil {
		return nil, err
	}
	if !sig.Exists {
		s.f = file{Version: fileVersion}
		return s, nil
	}
	if err := json.Unmarshal(b, &s.f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	_ = json.Unmarshal(b, &s.f.rest)
	for _, k := range []string{"version", "mode", "kdf", "check", "entries", "forgotten"} {
		delete(s.f.rest, k)
	}
	if s.f.Version < 1 {
		s.f.Version = 1
	}
	switch s.f.Mode {
	case ModeKeychain:
		s.keyErr = s.unlockKeychain()
		if s.keyErr == nil {
			s.keyErr = s.upgrade()
		}
	case ModePassphrase:
		if s.f.KDF != nil {
			if err := validKDF(s.f.KDF); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
		}
		s.setup = s.f.KDF == nil || s.f.Check == nil
	case ModeNone:
	default:
		return nil, fmt.Errorf("%s: unknown mode %q", path, s.f.Mode)
	}
	return s, nil
}

// Path is the vault's file.
func (s *Store) Path() string { return s.path }

// Status tells the mode and whether the vault is locked.
func (s *Store) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{Mode: s.f.Mode, Locked: s.f.Mode != ModeNone && s.key == nil, Setup: s.f.Mode != ModePassphrase || s.setup}
	if s.f.Mode == ModeKeychain && s.key == nil && s.keyErr != nil {
		st.Error = Code(s.keyErr)
	}
	return st
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
	b, err := open(s.key, e.Value, adOf(e, s.f.Version))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// reseal seals e's value again for what adOf says now (its machines or
// flag changed), from plain, the value's text; called with s.mu held and
// the key there.
func (s *Store) reseal(e *Entry, plain []byte) error {
	v, err := seal(s.key, plain, adOf(e, s.f.Version))
	if err != nil {
		return err
	}
	e.Value = v
	return nil
}

func validMachines(ms []string) bool {
	if len(ms) > MaxMachines {
		return false
	}
	for _, m := range ms {
		if m == "" || len(m) > MaxMachineID {
			return false
		}
	}
	return true
}

// Set creates or changes a variable: a new one needs a value; a value
// needs the vault unlocked (and creates the key of a vault without one).
func (s *Store) Set(name string, u Update) error {
	if !ValidName(name) {
		return ErrInvalidName
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
	if e == nil && u.Value == nil {
		return ErrValueRequired
	}
	if e == nil && len(s.f.Entries) >= MaxEntries {
		return ErrFull
	}
	// The value is sealed with the machines and the flag: changing any of
	// them needs the key.
	if s.key == nil {
		return s.ensureKey()
	}
	var plain []byte
	if u.Value != nil {
		plain = []byte(*u.Value)
	} else {
		b, err := open(s.key, e.Value, adOf(e, s.f.Version))
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
	e.Updated = now
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

// Allow adds machine m to the machines allowed to read name.
func (s *Store) Allow(name, m string) error {
	if m == "" || len(m) > MaxMachineID {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.find(name)
	if e == nil {
		return ErrNotFound
	}
	if slices.Contains(e.Machines, m) || slices.Contains(e.Machines, AllMachines) {
		return nil
	}
	if len(e.Machines) >= MaxMachines {
		return ErrInvalid
	}
	if s.key == nil {
		return ErrLocked
	}
	plain, err := open(s.key, e.Value, adOf(e, s.f.Version))
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
	// the key: while locked, the machine is forgotten until the unlock.
	if !slices.Contains(s.f.Forgotten, m) {
		prev := s.f.Forgotten
		s.f.Forgotten = append(slices.Clone(s.f.Forgotten), m)
		if err := s.save(); err != nil {
			s.f.Forgotten = prev
			return nil, err
		}
	}
	if s.key != nil {
		if err := s.applyForgotten(); err != nil {
			return nil, err
		}
	}
	return names, nil
}

// applyForgotten takes the forgotten machines out of the variables'
// machines, sealing their values again; called with s.mu held and the key
// there.
func (s *Store) applyForgotten() error {
	if len(s.f.Forgotten) == 0 {
		return nil
	}
	prev := slices.Clone(s.f.Entries)
	for i := range s.f.Entries {
		e := &s.f.Entries[i]
		if !slices.ContainsFunc(e.Machines, func(x string) bool { return slices.Contains(s.f.Forgotten, x) }) {
			continue
		}
		plain, err := open(s.key, e.Value, adOf(e, s.f.Version))
		if err != nil {
			s.f.Entries = prev
			return err
		}
		e.Machines = slices.DeleteFunc(slices.Clone(e.Machines), func(x string) bool { return slices.Contains(s.f.Forgotten, x) })
		err = s.reseal(e, plain)
		clear(plain)
		if err != nil {
			s.f.Entries = prev
			return err
		}
	}
	forgotten := s.f.Forgotten
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
	return nil
}

// Rename gives a variable another name, keeping its value, description,
// machines and flags. Its value is sealed again under the new name (the
// name is the ciphertext's additional data), so the vault must be unlocked;
// a name taken by another variable is refused.
func (s *Store) Rename(from, to string) error {
	if !ValidName(to) {
		return ErrInvalidName
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.find(from)
	if e == nil {
		return ErrNotFound
	}
	if from == to {
		return nil
	}
	if s.find(to) != nil {
		return ErrExists
	}
	if s.key == nil {
		return ErrLocked
	}
	plain, err := open(s.key, e.Value, adOf(e, s.f.Version))
	if err != nil {
		return err
	}
	defer clear(plain)
	prev := *e
	e.Name, e.Updated = to, time.Now().UTC()
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

// Lock forgets the key until Unlock.
func (s *Store) Lock() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.key)
	s.key = nil
	s.keyErr = nil
}

// Unlock takes the key derived from the passphrase (a keychain vault's
// from the keychain; the passphrase is ignored) and seals the values of an
// earlier version's file again, with their machines.
func (s *Store) Unlock(passphrase string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch s.f.Mode {
	case ModeNone:
		return ErrNoPassphrase
	case ModeKeychain:
		if s.keyErr = s.unlockKeychain(); s.keyErr == nil {
			s.keyErr = s.upgrade()
		}
		return s.keyErr
	}
	if s.setup {
		return ErrNoPassphrase
	}
	if s.key != nil {
		return s.verify(passphrase)
	}
	key := derive(passphrase, *s.f.KDF)
	if b, err := open(key, s.f.Check, checkAD); err != nil || string(b) != checkText {
		return ErrPassphrase
	}
	s.key = key
	return s.upgrade()
}

// Verify checks a passphrase without changing anything (an unlocked
// vault's, to prove the user is there).
func (s *Store) Verify(passphrase string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Mode != ModePassphrase || s.setup {
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

// SetPassphrase gives the vault a passphrase: a new vault's first, or a
// keychain vault's, whose values are sealed again under the passphrase's
// key and whose keychain item is then removed (an unlocked one; a keychain
// whose key cannot be read leaves values that cannot be opened). A vault
// with a passphrase changes it with ChangePassphrase. The vault is
// unlocked afterwards.
func (s *Store) SetPassphrase(passphrase string) error {
	if len([]rune(passphrase)) < 8 {
		return ErrWeak
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.f.Mode == ModePassphrase && !s.setup:
		return ErrHasPassphrase
	case s.f.Mode == ModeKeychain && s.key == nil:
		if s.keyErr != nil {
			return s.keyErr
		}
		return ErrLocked
	case s.f.Mode == ModePassphrase && s.setup && len(s.f.Entries) > 0:
		// Values sealed under a key never written down cannot be kept.
		return ErrLocked
	}
	keychain := s.f.Mode == ModeKeychain
	if err := s.rekey(passphrase); err != nil {
		return err
	}
	s.setup = false
	if keychain && s.keys != nil {
		// The old key opens nothing any more; remove it all the same.
		_ = s.keys.Delete(s.account)
	}
	return nil
}

// ChangePassphrase replaces the passphrase after checking the current one;
// every value is sealed again under the new key.
func (s *Store) ChangePassphrase(old, passphrase string) error {
	if len([]rune(passphrase)) < 8 {
		return ErrWeak
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Mode != ModePassphrase || s.setup {
		return ErrNoPassphrase
	}
	if err := s.verify(old); err != nil {
		return err
	}
	if s.key == nil {
		key := derive(old, *s.f.KDF)
		s.key = key
	}
	return s.rekey(passphrase)
}

// rekey derives a new key from passphrase with a new salt and seals every
// value and the check under it (version 2), from the key there; called
// with s.mu held.
func (s *Store) rekey(passphrase string) error {
	kdf := s.KDF
	kdf.Salt = make([]byte, saltLen)
	if _, err := rand.Read(kdf.Salt); err != nil {
		return err
	}
	key := derive(passphrase, kdf)
	prev := s.f
	prev.Entries = slices.Clone(s.f.Entries)
	entries := slices.Clone(s.f.Entries)
	for i := range entries {
		e := &entries[i]
		plain, err := open(s.key, e.Value, adOf(e, s.f.Version))
		if err != nil {
			return err
		}
		v, err := seal(key, plain, adOf(e, fileVersion))
		clear(plain)
		if err != nil {
			return err
		}
		e.Value = v
	}
	check, err := seal(key, []byte(checkText), checkAD)
	if err != nil {
		return err
	}
	s.f.Entries, s.f.Version, s.f.Mode, s.f.KDF, s.f.Check = entries, fileVersion, ModePassphrase, &kdf, check
	if err := s.save(); err != nil {
		s.f = prev
		return err
	}
	clear(s.key)
	s.key = key
	return s.applyForgotten()
}

// upgrade seals the values of a version 1 file again with their machines
// (version 2) and takes the forgotten machines out; called with s.mu held
// and the key there.
func (s *Store) upgrade() error {
	if s.f.Version < fileVersion {
		prev := slices.Clone(s.f.Entries)
		for i := range s.f.Entries {
			e := &s.f.Entries[i]
			plain, err := open(s.key, e.Value, adOf(e, s.f.Version))
			if err != nil {
				s.f.Entries = prev
				return err
			}
			v, err := seal(s.key, plain, adOf(e, fileVersion))
			clear(plain)
			if err != nil {
				s.f.Entries = prev
				return err
			}
			e.Value = v
		}
		version := s.f.Version
		s.f.Version = fileVersion
		if err := s.save(); err != nil {
			s.f.Entries, s.f.Version = prev, version
			return err
		}
	}
	return s.applyForgotten()
}

func derive(passphrase string, k KDF) []byte {
	return argon2.IDKey([]byte(passphrase), k.Salt, k.Time, k.Memory, k.Threads, 32)
}

// unlockKeychain reads the key from the keychain and checks it.
func (s *Store) unlockKeychain() error {
	if s.keys == nil {
		return ErrKeychain
	}
	secret, err := s.keys.Get(s.account)
	if err != nil {
		if errors.Is(err, ErrKeyMissing) {
			return ErrKeyMissing
		}
		return fmt.Errorf("%w: %v", ErrKeychain, err)
	}
	key, err := base64.StdEncoding.DecodeString(secret)
	if err != nil || len(key) != 32 {
		return ErrKeyMissing
	}
	if s.f.Check != nil {
		if b, err := open(key, s.f.Check, checkAD); err != nil || string(b) != checkText {
			return ErrKeyMissing
		}
	}
	s.key = key
	return nil
}

// ensureKey says why there is no key to seal a value: a vault without a
// passphrase needs one first (SetPassphrase), any other is locked.
func (s *Store) ensureKey() error {
	if s.key != nil {
		return nil
	}
	if s.f.Mode == ModeNone || s.setup {
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
	if len(s.f.Forgotten) > 0 {
		out["forgotten"] = s.f.Forgotten
	}
	entries := s.f.Entries
	if entries == nil {
		entries = []Entry{}
	}
	out["entries"] = entries
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

// seal encrypts plain with the name as additional data, so a value moved
// to another variable in the file no longer opens.
func seal(key, plain []byte, name string) (*Sealed, error) {
	g, err := gcm(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return &Sealed{Nonce: nonce, Ciphertext: g.Seal(nil, nonce, plain, []byte(name))}, nil
}

func open(key []byte, v *Sealed, name string) ([]byte, error) {
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
	b, err := g.Open(nil, v.Nonce, v.Ciphertext, []byte(name))
	if err != nil {
		return nil, ErrCorrupt
	}
	return b, nil
}
