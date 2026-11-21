// Package vault is the variable vault's store on the core host: named
// values (API keys and the like) encrypted one by one with AES-256-GCM in
// vault[-<instance>].json beside the settings file, under a master key
// derived from the user's passphrase with Argon2id and kept only in the
// core's memory while it holds the key (unlocked, or suspended: locked
// with the key kept for an authenticator's proof). Names, descriptions and
// the machines
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
	"strings"
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
	ErrAppTooLong    = errors.New("an app's name is at most 15 bytes, as the kernels keep a process's name")
	ErrAppGeneric    = errors.New("a shell or an interpreter runs any script, so it cannot be exempted")
)

// Code is the error's code for clients: vault_locked, not_found, …
func Code(err error) string {
	switch {
	// An export file's errors first: they may wrap the vault's (a
	// derivation out of bounds is ErrInvalid too).
	case errors.Is(err, ErrFileFormat):
		return "bad_file"
	case errors.Is(err, ErrFileVersion):
		return "file_version"
	case errors.Is(err, ErrFilePassphrase):
		return "file_passphrase"
	case errors.Is(err, ErrWeakExport):
		return "weak_export_passphrase"
	case errors.Is(err, ErrTooLarge):
		return "too_large"
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
	case errors.Is(err, ErrAppTooLong):
		return "app_too_long"
	case errors.Is(err, ErrAppGeneric):
		return "app_generic"
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
	// Guard is the sealed Guard (none: no authenticator, no rule).
	Guard *Sealed `json:"guard,omitempty"`
	// rest keeps the fields this version does not know.
	rest map[string]json.RawMessage
}

// Guard is what the user set to guard the vault beside its passphrase. It
// is sealed with the key, so a file edited without it cannot gain an
// authenticator or an exemption, and it is read only while the core holds
// the key: what it allows, proving the user without the passphrase, needs
// the key in memory.
type Guard struct {
	// Authenticators prove that the user is there in the passphrase's
	// stead: to open a session (which reopens a vault locked while the key
	// is held) and to allow a request.
	Authenticators []Authenticator `json:"authenticators,omitempty"`
	// VerifyEachAllow: allowing a request needs a proof made for it (an
	// authenticator's or the passphrase); a session is not enough.
	VerifyEachAllow bool `json:"verifyEachAllow,omitempty"`
	// Exempt are the apps whose requests on a machine are allowed without
	// asking while the vault is unlocked.
	Exempt []Exemption `json:"exempt,omitempty"`
}

// MaxExemptions bounds a vault's exemptions. MaxApp bounds the name of an
// app exempted: process names as the kernels keep them, 15 bytes on Linux
// (16 on macOS), so a longer one would never match, and one cut there
// would match every program whose name begins with it.
const (
	MaxExemptions = 64
	MaxApp        = 15
	// maxAppField bounds the names a guard holds (CheckApp checks new
	// ones), so a guard written with longer ones still opens and changes.
	maxAppField = 64
)

// Exemption lets the requests of one app on one machine read every
// variable without asking (inject-only ones only into commands) while the
// vault is unlocked. The app is the name of the process that started the
// one connected to the machine's vault.sock, as the machine's kernel names
// it: any program of the user there can take that name, so an exemption
// spares the user prompts, it does not tell programs apart.
type Exemption struct {
	ID      string    `json:"id"`
	Machine string    `json:"machine"`
	App     string    `json:"app"`
	Created time.Time `json:"created"`
}

// validAppField reports whether a guard may hold name as an app's: not
// empty, bounded, no control characters, no space at either end.
func validAppField(name string) bool {
	if name == "" || len(name) > maxAppField || strings.TrimSpace(name) != name {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// genericApps are shells, interpreters and launchers: they run any script
// or command, so exempting one would let every script read the variables.
// A version after the name (python3.12, node22) is the same program.
var genericApps = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "fish": true, "dash": true, "ksh": true, "mksh": true, "csh": true, "tcsh": true,
	"busybox": true, "env": true, "sudo": true, "doas": true, "nohup": true, "xargs": true, "script": true, "login": true,
	"node": true, "nodejs": true, "deno": true, "bun": true, "python": true, "pypy": true, "ruby": true, "perl": true,
	"php": true, "lua": true, "luajit": true, "tclsh": true, "wish": true, "osascript": true, "pwsh": true, "powershell": true,
	"java": true, "uv": true, "npx": true, "npm": true, "pnpm": true, "yarn": true, "make": true,
}

// CheckApp says why name cannot be exempted as an app (ErrAppTooLong,
// ErrAppGeneric, ErrInvalid), nil when it can.
func CheckApp(name string) error {
	switch {
	case !validAppField(name):
		return fmt.Errorf("%w: app %q", ErrInvalid, name)
	case len(name) > MaxApp:
		return ErrAppTooLong
	case genericApps[strings.TrimRight(strings.ToLower(name), "0123456789.")]:
		return ErrAppGeneric
	}
	return nil
}

// empty reports whether the guard holds nothing worth sealing.
func (g Guard) empty() bool {
	return len(g.Authenticators) == 0 && !g.VerifyEachAllow && len(g.Exempt) == 0
}

// Kinds of authenticator.
const (
	// KindWebAuthn is a credential of a browser's platform authenticator
	// or a security key, for one host name (RPID).
	KindWebAuthn = "webauthn"
	// KindDesktop is the desktop app's own prompt (Touch ID, Windows
	// Hello), which the app's shell vouches for; it has no key here.
	KindDesktop = "desktop"
)

// MaxAuthenticators bounds a vault's authenticators.
const MaxAuthenticators = 16

// Authenticator is one way to prove the user without the passphrase.
type Authenticator struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
	// Origin is the page a WebAuthn credential was added from and proves
	// for; RPID (its host name), Credential, Algorithm (COSE) and PublicKey
	// (SubjectPublicKeyInfo) are the credential's; SignCount the last
	// counter its authenticator signed.
	Origin     string    `json:"origin,omitempty"`
	RPID       string    `json:"rpId,omitempty"`
	Credential []byte    `json:"credential,omitempty"`
	Algorithm  int       `json:"alg,omitempty"`
	PublicKey  []byte    `json:"publicKey,omitempty"`
	SignCount  uint32    `json:"signCount,omitempty"`
	Created    time.Time `json:"created"`
	LastUsed   time.Time `json:"lastUsed,omitzero"`
}

// guardAD is the guard's additional data; no variable's nor the check's is
// the same.
const guardAD = "#guard"

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
	Mode string `json:"mode"`
	// Locked: no value can be read or sealed, whether the key is gone or
	// held while suspended.
	Locked bool `json:"locked"`
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
	// suspended: locked with the key held (Suspend), so that Resume opens
	// it again without the passphrase; the guard stays readable.
	suspended bool
	now       func() time.Time
}

// usable reports whether values can be read and sealed: the key is held
// and the vault not suspended. Called with s.mu held.
func (s *Store) usable() bool { return s.key != nil && !s.suspended }

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
	for _, k := range []string{"version", "mode", "kdf", "check", "passphraseSet", "entries", "forgotten", "guard"} {
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
		Locked:        s.f.Mode != ModeNone && !s.usable(),
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
	if !s.usable() {
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
	if !s.usable() {
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
	if !s.usable() {
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

// ForgetMachine removes machine m from every variable's machines and the
// guard's exemptions (a removed machine: an id that comes back is not
// allowed again) and returns the names it was removed from.
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
	// Without the key the guard cannot be read: it may exempt an app there.
	exempt := s.key == nil && s.f.Guard != nil
	if g, err := s.guard(); err == nil {
		exempt = slices.ContainsFunc(g.Exempt, func(e Exemption) bool { return e.Machine == m })
	}
	if len(names) == 0 && !exempt {
		return nil, nil
	}
	// Taking it out of the machines seals the values (and the guard) again,
	// which needs the key: until then, the machine is forgotten.
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
// machines and the guard's exemptions, and empties the list. A value that
// opens is sealed again for its new machines; one that does not (the file
// was edited) loses them too and stays unreadable, or opens again when they
// were what the edit added: taking machines out never lets more read. A
// guard that does not open stays as it is (it exempts nothing: exempt
// reads it). Called with s.mu held and the key there; on failure nothing
// changed and the list is still enforced by info and Exempt.
func (s *Store) applyForgotten() error {
	if len(s.f.Forgotten) == 0 {
		return nil
	}
	forgotten := s.f.Forgotten
	gone := func(x string) bool { return slices.Contains(forgotten, x) }
	prevGuard := s.f.Guard
	if g, err := s.guard(); err == nil && slices.ContainsFunc(g.Exempt, func(e Exemption) bool { return gone(e.Machine) }) {
		g.Exempt = slices.DeleteFunc(g.Exempt, func(e Exemption) bool { return gone(e.Machine) })
		if err := s.setGuard(g); err != nil {
			return err
		}
	}
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
			s.f.Entries, s.f.Guard = prev, prevGuard
			return err
		}
	}
	s.f.Forgotten = nil
	if err := s.save(); err != nil {
		s.f.Entries, s.f.Forgotten, s.f.Guard = prev, forgotten, prevGuard
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

func openGuard(key []byte, v *Sealed) (Guard, error) {
	var g Guard
	b, err := open(key, v, guardAD)
	if err != nil {
		return g, err
	}
	if err := json.Unmarshal(b, &g); err != nil {
		return Guard{}, ErrCorrupt
	}
	return g, nil
}

func sealGuard(key []byte, g Guard) (*Sealed, error) {
	b, err := json.Marshal(g)
	if err != nil {
		return nil, err
	}
	return seal(key, b, guardAD)
}

// Guard returns what guards the vault beside its passphrase; ErrLocked
// while the key is not held (a suspended vault's guard is read: a proof is
// checked with it).
func (s *Store) Guard() (Guard, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.guard()
}

func (s *Store) guard() (Guard, error) {
	if s.key == nil {
		return Guard{}, s.noKey()
	}
	if s.f.Guard == nil {
		return Guard{}, nil
	}
	return openGuard(s.key, s.f.Guard)
}

// UpdateGuard is the user's change of the guard: fn changes it, and it is
// written; an error of fn leaves it as it was. The vault must be unlocked
// (ErrLocked while suspended too: a lock that came after the request's
// gate ends its say). Exemptions of machines forgotten while the key was
// not held are taken out first. RecordProof is what a proof writes.
func (s *Store) UpdateGuard(fn func(*Guard) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.usable() {
		return s.noKey()
	}
	if _, err := s.guard(); err != nil {
		return err
	}
	if err := s.applyForgotten(); err != nil {
		return err
	}
	g, err := s.guard()
	if err != nil {
		return err
	}
	if err := fn(&g); err != nil {
		return err
	}
	if len(g.Authenticators) > MaxAuthenticators {
		return fmt.Errorf("%w: at most %d authenticators", ErrInvalid, MaxAuthenticators)
	}
	if len(g.Exempt) > MaxExemptions {
		return fmt.Errorf("%w: at most %d exemptions", ErrInvalid, MaxExemptions)
	}
	for _, e := range g.Exempt {
		if !validAppField(e.App) || !validMachineID(e.Machine) || e.Machine == AllMachines {
			return fmt.Errorf("%w: exemption %q on %q", ErrInvalid, e.App, e.Machine)
		}
	}
	prev := s.f.Guard
	if err := s.setGuard(g); err != nil {
		return err
	}
	if err := s.save(); err != nil {
		s.f.Guard = prev
		return err
	}
	return nil
}

// RecordProof notes that authenticator id made a proof at at, with the
// signature counter it signed (count, for WebAuthn), and writes the guard.
// It changes nothing else, and works while the vault is suspended: a proof
// is how a suspended vault is unlocked. ErrNotFound for no such
// authenticator.
func (s *Store) RecordProof(id string, at time.Time, count *uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, err := s.guard()
	if err != nil {
		return err
	}
	i := slices.IndexFunc(g.Authenticators, func(a Authenticator) bool { return a.ID == id })
	if i < 0 {
		return ErrNotFound
	}
	g.Authenticators[i].LastUsed = at
	if count != nil {
		g.Authenticators[i].SignCount = *count
	}
	prev := s.f.Guard
	if err := s.setGuard(g); err != nil {
		return err
	}
	if err := s.save(); err != nil {
		s.f.Guard = prev
		return err
	}
	return nil
}

// setGuard seals g as the file's guard (none when it holds nothing),
// without writing the file. Called with s.mu held and the key there.
func (s *Store) setGuard(g Guard) error {
	if g.empty() {
		s.f.Guard = nil
		return nil
	}
	v, err := sealGuard(s.key, g)
	if err != nil {
		return err
	}
	s.f.Guard = v
	return nil
}

// Exempt reports whether app's requests on machine m are allowed without
// asking: the guard names them, the machine was not forgotten, and the
// vault is unlocked. A guard that does not open exempts nothing.
func (s *Store) Exempt(m, app string) bool {
	if m == "" || app == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.usable() || slices.Contains(s.f.Forgotten, m) {
		return false
	}
	g, err := s.guard()
	if err != nil {
		return false
	}
	return slices.ContainsFunc(g.Exempt, func(e Exemption) bool { return e.Machine == m && e.App == app })
}

// Lock forgets the key until Unlock.
func (s *Store) Lock() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.key)
	s.key = nil
	s.suspended = false
}

// Suspend locks the vault but keeps the key in memory: no value is read or
// sealed until Resume (or Unlock with the passphrase), and the guard stays
// readable, so an authenticator's proof can be checked. A vault whose key
// is not held stays as it is.
func (s *Store) Suspend() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key != nil {
		s.suspended = true
	}
}

// Resume unlocks a suspended vault with the key it holds; ErrLocked when it
// holds none.
func (s *Store) Resume() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key == nil {
		return s.noKey()
	}
	s.suspended = false
	return nil
}

// Held reports whether the key is in memory, the vault unlocked or
// suspended.
func (s *Store) Held() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.key != nil
}

// Unlock takes the key derived from the passphrase; a vault that holds the
// key only checks it, and a suspended one is then unlocked. Forgotten
// machines are then taken out of the lists.
func (s *Store) Unlock(passphrase string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Mode != ModePassphrase {
		return ErrNoPassphrase
	}
	if s.key != nil {
		if err := s.verify(passphrase); err != nil {
			return err
		}
		s.suspended = false
		return nil
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
	// A new passphrase ends every authenticator and exemption: whoever knew
	// the old one may have added theirs. The rule stays.
	var guard *Sealed
	if s.f.Guard != nil {
		g, err := openGuard(cur, s.f.Guard)
		if err != nil {
			clear(key)
			return err
		}
		if g.VerifyEachAllow {
			if guard, err = sealGuard(key, Guard{VerifyEachAllow: true}); err != nil {
				clear(key)
				return err
			}
		}
	}
	prev := s.f
	s.f.Entries, s.f.Version, s.f.Mode, s.f.KDF, s.f.Check, s.f.PassphraseSet = entries, FileVersion, ModePassphrase, &kdf, check, s.now().UTC()
	s.f.Guard = guard
	if err := s.save(); err != nil {
		s.f = prev
		clear(key)
		return err
	}
	clear(s.key)
	s.key, s.suspended = key, false
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
	if s.f.Guard != nil {
		out["guard"] = s.f.Guard
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
