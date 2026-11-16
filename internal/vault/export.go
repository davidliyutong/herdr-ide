package vault

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"herdr-ide/internal/brand"
)

// Export files carry variables (their values included) from one vault to
// another, encrypted under a passphrase of their own: a JSON envelope that
// says in the clear only its format, version, the key's derivation
// (Argon2id's parameters and salt) and the cipher, all bound to the
// ciphertext as its additional data, and the content sealed with
// AES-256-GCM. Values are opened from the vault and sealed into the file
// on the core; they never reach a browser
// (docs/features/30-variable-vault.md).

// Limits and parameters of export files.
const (
	// ExportVersion is the version of the files written and read: a file
	// of another version does not import.
	ExportVersion = 1
	// MaxExportFile bounds an export file, written or read.
	MaxExportFile = 16 << 20
	// MinExportPassphrase is the least length of an export's passphrase,
	// in characters: the file can be attacked offline, without the
	// vault's waits.
	MinExportPassphrase = 12
	exportCipher        = "aes-256-gcm"
	exportKDFAlg        = "argon2id"
)

// Errors of export files.
var (
	ErrWeakExport     = errors.New("an export's passphrase needs at least 12 characters")
	ErrFileFormat     = errors.New("not an export file of the vault, or a damaged one")
	ErrFileVersion    = errors.New("an export file of another version")
	ErrFilePassphrase = errors.New("wrong passphrase, or the file was changed")
	ErrTooLarge       = errors.New("the export file is too large")
)

// ExportFormat is the format id of export files, after the product.
func ExportFormat() string { return brand.Slug + "-vault-export" }

// Export is an export file's content: the variables with their values,
// and the machines their lists name, with their labels, so an import on
// another core can tell them.
type Export struct {
	Exported  time.Time        `json:"exported"`
	Machines  []ExportMachine  `json:"machines"`
	Variables []ExportVariable `json:"variables"`
}

// ExportMachine is a machine a variable's list names.
type ExportMachine struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	// Local: the core's own computer (whose id is the same on every core).
	Local bool `json:"local,omitempty"`
	// Kind and Target are the machine's kind and, for an ssh machine, its
	// target on the exporting core: an import maps the id only to a
	// machine of the same kind and target, as an id need not name the same
	// machine on another core (an --ssh machine's id is its target).
	// Files written before they were recorded map no ssh machine.
	Kind   string `json:"kind,omitempty"`
	Target string `json:"target,omitempty"`
}

// ExportVariable is a variable of an export file.
type ExportVariable struct {
	Name        string    `json:"name"`
	Value       string    `json:"value"`
	Description string    `json:"description,omitempty"`
	Machines    []string  `json:"machines"`
	InjectOnly  bool      `json:"injectOnly,omitempty"`
	Created     time.Time `json:"created"`
	Updated     time.Time `json:"updated"`
}

// exportFile is the envelope.
type exportFile struct {
	Format     string    `json:"format"`
	Version    int       `json:"version"`
	KDF        exportKDF `json:"kdf"`
	Cipher     string    `json:"cipher"`
	Nonce      []byte    `json:"nonce"`
	Ciphertext []byte    `json:"ciphertext"`
}

type exportKDF struct {
	Alg     string `json:"alg"`
	Salt    []byte `json:"salt"`
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memory"` // KiB
	Threads uint8  `json:"threads"`
}

// ad is the envelope's additional data: everything it says in the clear
// but the nonce, so a file whose version or derivation was changed does
// not open.
func (f *exportFile) ad() []byte {
	b, _ := json.Marshal(struct {
		Format  string    `json:"format"`
		Version int       `json:"version"`
		KDF     exportKDF `json:"kdf"`
		Cipher  string    `json:"cipher"`
	}{f.Format, f.Version, f.KDF, f.Cipher})
	return b
}

// SealExport writes e into an export file under passphrase (at least
// MinExportPassphrase characters), its key derived with k's parameters
// and a new salt.
func SealExport(e *Export, passphrase string, k KDF) ([]byte, error) {
	if len([]rune(passphrase)) < MinExportPassphrase {
		return nil, ErrWeakExport
	}
	if len(e.Variables) > MaxEntries {
		return nil, ErrFull
	}
	k.Salt = make([]byte, saltLen)
	if _, err := rand.Read(k.Salt); err != nil {
		return nil, err
	}
	plain, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	defer clear(plain)
	if len(plain) > MaxExportFile {
		return nil, ErrTooLarge
	}
	f := exportFile{
		Format: ExportFormat(), Version: ExportVersion, Cipher: exportCipher,
		KDF: exportKDF{Alg: exportKDFAlg, Salt: k.Salt, Time: k.Time, Memory: k.Memory, Threads: k.Threads},
	}
	key := derive(passphrase, k)
	defer clear(key)
	sealed, err := seal(key, plain, string(f.ad()))
	if err != nil {
		return nil, err
	}
	f.Nonce, f.Ciphertext = sealed.Nonce, sealed.Ciphertext
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(b) > MaxExportFile {
		return nil, ErrTooLarge
	}
	return append(b, '\n'), nil
}

// OpenExport reads an export file with its passphrase. A file that is not
// one (or is damaged) is ErrFileFormat, one of another version
// ErrFileVersion, a wrong passphrase or a changed file ErrFilePassphrase;
// derivation parameters outside the vault's bounds are refused before
// any work. The variables are not checked here (Import does).
func OpenExport(b []byte, passphrase string) (*Export, error) {
	if len(b) > MaxExportFile {
		return nil, ErrTooLarge
	}
	var f exportFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrFileFormat, err)
	}
	if f.Format != ExportFormat() {
		return nil, fmt.Errorf("%w: format %q", ErrFileFormat, f.Format)
	}
	if f.Version != ExportVersion {
		return nil, fmt.Errorf("%w %d, not %d", ErrFileVersion, f.Version, ExportVersion)
	}
	if f.Cipher != exportCipher || f.KDF.Alg != exportKDFAlg {
		return nil, fmt.Errorf("%w: cipher %q, kdf %q", ErrFileFormat, f.Cipher, f.KDF.Alg)
	}
	k := KDF{Salt: f.KDF.Salt, Time: f.KDF.Time, Memory: f.KDF.Memory, Threads: f.KDF.Threads}
	if err := validKDF(&k); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrFileFormat, err)
	}
	key := derive(passphrase, k)
	defer clear(key)
	plain, err := open(key, &Sealed{Nonce: f.Nonce, Ciphertext: f.Ciphertext}, string(f.ad()))
	if err != nil {
		return nil, ErrFilePassphrase
	}
	defer clear(plain)
	var e Export
	if err := json.Unmarshal(plain, &e); err != nil {
		return nil, fmt.Errorf("%w: content: %w", ErrFileFormat, err)
	}
	if len(e.Variables) > MaxEntries {
		return nil, ErrFull
	}
	return &e, nil
}

// NameError is a failure about one variable of several.
type NameError struct {
	Name string
	Err  error
}

func (e *NameError) Error() string { return e.Name + ": " + e.Err.Error() }
func (e *NameError) Unwrap() error { return e.Err }

// Export returns the variables of names with their values, and their
// machines without those forgotten; the vault must be unlocked. A name
// that is not there, or a value that does not open, fails it all.
func (s *Store) Export(names []string) ([]ExportVariable, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key == nil {
		return nil, s.noKey()
	}
	out := make([]ExportVariable, 0, len(names))
	for _, n := range names {
		e := s.find(n)
		if e == nil {
			return nil, &NameError{n, ErrNotFound}
		}
		b, err := open(s.key, e.Value, adOf(e))
		if err != nil {
			return nil, &NameError{n, err}
		}
		i := info(e, s.f.Forgotten)
		out = append(out, ExportVariable{
			Name: i.Name, Value: string(b), Description: i.Description, Machines: i.Machines,
			InjectOnly: i.InjectOnly, Created: i.Created, Updated: i.Updated,
		})
		clear(b)
	}
	return out, nil
}

// Import is a variable to import.
type Import struct {
	Name        string
	Value       string
	Description string
	Machines    []string
	InjectOnly  bool
	// Created is kept for a new variable (when it is not in the future).
	Created time.Time
	// Overwrite replaces the variable of that name; without it the name
	// must be free.
	Overwrite bool
}

// CheckImport reports why im cannot be imported as it is (a NameError),
// nil when it can as far as the vault's rules go.
func CheckImport(im Import) error {
	switch {
	case !ValidName(im.Name):
		return &NameError{im.Name, ErrInvalidName}
	case len(im.Value) > MaxValue:
		return &NameError{im.Name, fmt.Errorf("%w: value longer than %d bytes", ErrInvalid, MaxValue)}
	case len(im.Description) > MaxDescription:
		return &NameError{im.Name, fmt.Errorf("%w: description longer than %d bytes", ErrInvalid, MaxDescription)}
	case !validMachines(im.Machines):
		return &NameError{im.Name, fmt.Errorf("%w: machines", ErrInvalid)}
	}
	return nil
}

// Import adds or replaces the variables of list in one write: every value
// sealed under the vault's key with its name, machines and flag, so a
// failure (a name taken without Overwrite, an invalid variable, too many
// variables, a write) changes nothing. The vault must be unlocked.
func (s *Store) Import(list []Import) error {
	seen := map[string]bool{}
	for _, im := range list {
		if err := CheckImport(im); err != nil {
			return err
		}
		if seen[im.Name] {
			return &NameError{im.Name, ErrExists}
		}
		seen[im.Name] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key == nil {
		return s.noKey()
	}
	if err := s.applyForgotten(); err != nil {
		return err
	}
	prev := slices.Clone(s.f.Entries)
	restore := func(err error) error {
		s.f.Entries = prev
		return err
	}
	now := s.now().UTC()
	for _, im := range list {
		e := s.find(im.Name)
		if e != nil && !im.Overwrite {
			return restore(&NameError{im.Name, ErrExists})
		}
		if e == nil {
			if len(s.f.Entries) >= MaxEntries {
				return restore(ErrFull)
			}
			created := im.Created.UTC()
			if created.IsZero() || created.After(now) {
				created = now
			}
			s.f.Entries = append(s.f.Entries, Entry{Name: im.Name, Created: created})
			e = &s.f.Entries[len(s.f.Entries)-1]
		}
		e.Description, e.Machines, e.InjectOnly, e.Updated = im.Description, dedupe(im.Machines), im.InjectOnly, now
		if err := s.reseal(e, []byte(im.Value)); err != nil {
			return restore(err)
		}
	}
	if err := s.save(); err != nil {
		return restore(err)
	}
	return nil
}
