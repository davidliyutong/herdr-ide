// Package vault is the variable vault's store on the core host: named
// values (API keys and the like) encrypted one by one with AES-256-GCM in
// vault[-<instance>].json beside the settings file, under a master key kept
// in the operating system's keychain or, where there is none, derived from
// a passphrase with Argon2id. Names, descriptions and the machines allowed
// to read a variable are stored in the clear; values never are. The core's
// plugin (internal/plugins/vault) serves it to the UI and to the MCP servers
// on machines (docs/features/30-variable-vault.md).
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
	// ModeNone: no key yet (no variable was ever stored).
	ModeNone = ""
	// ModeKeychain: a random key in the operating system's keychain.
	ModeKeychain = "keychain"
	// ModePassphrase: a key derived from the user's passphrase (Argon2id).
	ModePassphrase = "passphrase"
)

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
	// rest keeps the fields this version does not know.
	rest map[string]json.RawMessage
}

const checkText = "vault-check"

// checkAD is the check's additional data; no variable can have this name.
const checkAD = "#check"

// KeyStore keeps the master key: the operating system's keychain
// (OSKeyStore) or, in tests, a map.
type KeyStore interface {
	// Get returns the secret, ErrKeyMissing when there is none, or another
	// error when the keychain cannot be used.
	Get(account string) (string, error)
	Set(account, secret string) error
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

// Status is the vault's state.
type Status struct {
	Mode   string `json:"mode"`
	Locked bool   `json:"locked"`
	// Setup: passphrase mode without a passphrase yet; Unlock sets it.
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
		s.f = file{Version: 1}
		return s, nil
	}
	if err := json.Unmarshal(b, &s.f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	_ = json.Unmarshal(b, &s.f.rest)
	for _, k := range []string{"version", "mode", "kdf", "check", "entries"} {
		delete(s.f.rest, k)
	}
	switch s.f.Mode {
	case ModeKeychain:
		s.keyErr = s.unlockKeychain()
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
	st := Status{Mode: s.f.Mode, Locked: s.f.Mode != ModeNone && s.key == nil, Setup: s.setup}
	if s.f.Mode == ModeKeychain && s.key == nil && s.keyErr != nil {
		st.Error = Code(s.keyErr)
	}
	return st
}

func info(e *Entry) Info {
	m := e.Machines
	if m == nil {
		m = []string{}
	}
	return Info{Name: e.Name, Description: e.Description, Machines: slices.Clone(m), InjectOnly: e.InjectOnly, Created: e.Created, Updated: e.Updated}
}

// List returns the variables by name, without their values.
func (s *Store) List() []Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Info, 0, len(s.f.Entries))
	for i := range s.f.Entries {
		out = append(out, info(&s.f.Entries[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns a variable without its value.
func (s *Store) Get(name string) (Info, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.find(name); e != nil {
		return info(e), true
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
	b, err := open(s.key, e.Value, name)
	if err != nil {
		return "", err
	}
	return string(b), nil
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
	var sealed *Sealed
	if u.Value != nil {
		if err := s.ensureKey(); err != nil {
			return err
		}
		v, err := seal(s.key, []byte(*u.Value), name)
		if err != nil {
			return err
		}
		sealed = v
	}
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
	if sealed != nil {
		e.Value = sealed
	}
	e.Updated = now
	if err := s.save(); err != nil {
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
	prev := e.Machines
	e.Machines = append(slices.Clone(e.Machines), m)
	if err := s.save(); err != nil {
		e.Machines = prev
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
	prev := make([][]string, len(s.f.Entries))
	for i := range s.f.Entries {
		e := &s.f.Entries[i]
		prev[i] = e.Machines
		if slices.Contains(e.Machines, m) {
			e.Machines = slices.DeleteFunc(slices.Clone(e.Machines), func(x string) bool { return x == m })
			names = append(names, e.Name)
		}
	}
	if len(names) == 0 {
		return nil, nil
	}
	if err := s.save(); err != nil {
		for i := range s.f.Entries {
			s.f.Entries[i].Machines = prev[i]
		}
		return nil, err
	}
	return names, nil
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

// Lock forgets the key until Unlock.
func (s *Store) Lock() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.key)
	s.key = nil
	s.keyErr = nil
}

// Unlock takes the key: from the keychain (passphrase is ignored), or
// derived from the passphrase, which a passphrase vault without one yet
// takes as its new passphrase.
func (s *Store) Unlock(passphrase string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch s.f.Mode {
	case ModeNone:
		return nil
	case ModeKeychain:
		s.keyErr = s.unlockKeychain()
		return s.keyErr
	}
	if s.setup {
		if len([]rune(passphrase)) < 8 {
			return ErrWeak
		}
		kdf := s.KDF
		kdf.Salt = make([]byte, 16)
		if _, err := rand.Read(kdf.Salt); err != nil {
			return err
		}
		key := derive(passphrase, kdf)
		check, err := seal(key, []byte(checkText), checkAD)
		if err != nil {
			return err
		}
		s.f.KDF, s.f.Check = &kdf, check
		if err := s.save(); err != nil {
			s.f.KDF, s.f.Check = nil, nil
			return err
		}
		s.key, s.setup = key, false
		return nil
	}
	key := derive(passphrase, *s.f.KDF)
	if b, err := open(key, s.f.Check, checkAD); err != nil || string(b) != checkText {
		return ErrPassphrase
	}
	s.key = key
	return nil
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

// ensureKey makes sure the key is there to seal a value: a vault without a
// key gets one in the keychain, or turns to passphrase mode when the
// keychain cannot keep it (and is locked until the passphrase is set).
func (s *Store) ensureKey() error {
	if s.key != nil {
		return nil
	}
	if s.f.Mode != ModeNone {
		return ErrLocked
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	if s.keys != nil {
		if err := s.keys.Set(s.account, base64.StdEncoding.EncodeToString(key)); err == nil {
			check, err := seal(key, []byte(checkText), checkAD)
			if err != nil {
				return err
			}
			s.f.Mode, s.f.Check = ModeKeychain, check
			if err := s.save(); err != nil {
				s.f.Mode, s.f.Check = ModeNone, nil
				return err
			}
			s.key = key
			return nil
		}
	}
	s.f.Mode = ModePassphrase
	if err := s.save(); err != nil {
		s.f.Mode = ModeNone
		return err
	}
	s.setup = true
	return ErrLocked
}

func (s *Store) save() error {
	out := map[string]any{}
	for k, v := range s.f.rest {
		out[k] = v
	}
	out["version"] = 1
	if s.f.Mode != ModeNone {
		out["mode"] = s.f.Mode
	}
	if s.f.KDF != nil {
		out["kdf"] = s.f.KDF
	}
	if s.f.Check != nil {
		out["check"] = s.f.Check
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
