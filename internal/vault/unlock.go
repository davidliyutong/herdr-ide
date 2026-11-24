package vault

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"time"
	"unicode"

	"veldr/internal/brand"
)

// An authenticator that can unlock the vault keeps the master key wrapped
// in an unlock entry of the file, outside the sealed guard (the guard needs
// the key to be read): AES-256-GCM under a key-encryption key (KEK) that
// only the authenticator can give again, derived with HKDF-SHA256 from
//
//   - enclave (the desktop app on macOS): the P-256 ECDH secret of an
//     ephemeral key the core made when the entry was added (only its public
//     half is kept) and the app's Secure Enclave key, which the enclave
//     gives only after Touch ID, with the desktop shell's own secret;
//   - hello (the desktop app on Windows): the Windows Hello key's signature
//     (RSA PKCS#1 v1.5, deterministic) of a challenge the core chose, with
//     the shell's secret;
//   - prf (a WebAuthn credential): the credential's PRF output for a salt
//     the core chose.
//
// The wrap's additional data binds the entry's id, authenticator, kind,
// every parameter and the hash of the file's check, so an edited entry
// does not open and a new passphrase (also one set by an older build,
// which keeps the entries it does not know) leaves the old entries
// unusable; Open drops them. An unlock unwraps the key, checks it against
// the check, finds the entry's authenticator in the guard it opens,
// verifies the authenticator's proof and the passphrase's window, and only
// then installs the key (UnlockWith).

// Kinds of unlock entry.
const (
	UnlockEnclave = "enclave"
	UnlockHello   = "hello"
	UnlockPRF     = "prf"
)

// Bounds of unlock entries.
const (
	// MaxDesktopUnlocks bounds the entries of the desktop app (enclave and
	// hello), one per install of it.
	MaxDesktopUnlocks = 4
	keyLen            = 32
	pointLen          = 65 // a P-256 point, X9.63 uncompressed
	maxBlob           = 4 << 10
	maxSignature      = 1 << 10
	maxPublicKey      = 2 << 10
	maxOrigin         = 512
	maxRPID           = 253
	maxCredential     = 1023
	maxAuthID         = 128
)

// Errors of unlocks without the passphrase.
var (
	ErrUnlockStale   = errors.New("the unlock entry or its authenticator is gone")
	ErrUnlockFailed  = errors.New("the authenticator's unlock did not open or verify")
	ErrPassphraseDue = errors.New("the passphrase is due: unlock with it")
	// ErrUnlockWrap is the KEK not opening the entry's wrap. UnlockWith
	// returns it wrapped in ErrUnlockFailed (its code stays vault_proof), so
	// that a caller that trusts where the KEK came from (the desktop shell's
	// relay) can tell a dead entry from a key that opened and did not verify.
	ErrUnlockWrap = errors.New("the unlock entry's wrap did not open")
	// ErrUnlockOrphan is an entry whose authenticator is no longer in the
	// guard, which UnlockWith removed; it is an ErrUnlockStale.
	ErrUnlockOrphan = fmt.Errorf("%w: its authenticator is no longer in the guard", ErrUnlockStale)
)

var (
	validInstall  = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	validUnlockID = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
	validCheck    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ValidInstall reports whether install can name an install of the desktop
// app.
func ValidInstall(install string) bool { return validInstall.MatchString(install) }

// HelloKeyName is the name of the Windows Hello key of an install.
func HelloKeyName(install string) string { return brand.Slug + "-vault-" + install }

// UnlockEntry is an authenticator's wrap of the master key. Binary members
// are base64 (standard, padded) in the file, as its other binary members.
type UnlockEntry struct {
	ID string `json:"id"`
	// Authenticator is the id of the guard's authenticator the entry
	// belongs to: the desktop one for enclave and hello, the webauthn
	// credential for prf.
	Authenticator string    `json:"authenticator"`
	Kind          string    `json:"kind"`
	Created       time.Time `json:"created"`
	// Check is the hex SHA-256 of the file's check when the entry was made.
	Check   string         `json:"check"`
	Enclave *EnclaveParams `json:"enclave,omitempty"`
	Hello   *HelloParams   `json:"hello,omitempty"`
	PRF     *PRFParams     `json:"prf,omitempty"`
	Wrapped *Sealed        `json:"wrapped"`
}

// EnclaveParams are an enclave entry's: the desktop install, its Secure
// Enclave key's blob and public key, and the public half of the ephemeral
// key the core made (X9.63 uncompressed).
type EnclaveParams struct {
	Install string `json:"install"`
	Blob    []byte `json:"blob"`
	SEPub   []byte `json:"sePub"`
	EphPub  []byte `json:"ephPub"`
}

// HelloParams are a hello entry's: the desktop install, its Windows Hello
// key's name and public key, and the challenge the key signs.
type HelloParams struct {
	Install   string `json:"install"`
	KeyName   string `json:"keyName"`
	Challenge []byte `json:"challenge"`
	PublicKey []byte `json:"publicKey"`
}

// PRFParams are a prf entry's: the credential's origin, RP id and id, and
// the PRF salt (also the PRF's evaluation input).
type PRFParams struct {
	Origin     string `json:"origin"`
	RPID       string `json:"rpId"`
	Credential []byte `json:"credential"`
	Salt       []byte `json:"salt"`
}

func (e UnlockEntry) clone() UnlockEntry {
	if e.Enclave != nil {
		p := *e.Enclave
		p.Blob, p.SEPub, p.EphPub = slices.Clone(p.Blob), slices.Clone(p.SEPub), slices.Clone(p.EphPub)
		e.Enclave = &p
	}
	if e.Hello != nil {
		p := *e.Hello
		p.Challenge, p.PublicKey = slices.Clone(p.Challenge), slices.Clone(p.PublicKey)
		e.Hello = &p
	}
	if e.PRF != nil {
		p := *e.PRF
		p.Credential, p.Salt = slices.Clone(p.Credential), slices.Clone(p.Salt)
		e.PRF = &p
	}
	if e.Wrapped != nil {
		w := Sealed{Nonce: slices.Clone(e.Wrapped.Nonce), Ciphertext: slices.Clone(e.Wrapped.Ciphertext)}
		e.Wrapped = &w
	}
	return e
}

// desktop reports whether e is the desktop app's.
func (e *UnlockEntry) desktop() bool { return e.Kind == UnlockEnclave || e.Kind == UnlockHello }

// install is the desktop install of a desktop entry.
func (e *UnlockEntry) install() string {
	switch {
	case e.Enclave != nil:
		return e.Enclave.Install
	case e.Hello != nil:
		return e.Hello.Install
	}
	return ""
}

// entryAD is the wrap's additional data: the canonical JSON (keys sorted,
// binary members base64url) of the file's version, the entry's id,
// authenticator, kind, check and every parameter of its kind.
func entryAD(e *UnlockEntry) string {
	b64 := base64.RawURLEncoding.EncodeToString
	m := map[string]any{"v": FileVersion, "t": "unlock", "id": e.ID, "authenticator": e.Authenticator, "kind": e.Kind, "check": e.Check}
	switch {
	case e.Kind == UnlockEnclave && e.Enclave != nil:
		m["install"], m["blob"], m["sePub"], m["ephPub"] = e.Enclave.Install, b64(e.Enclave.Blob), b64(e.Enclave.SEPub), b64(e.Enclave.EphPub)
	case e.Kind == UnlockHello && e.Hello != nil:
		m["install"], m["keyName"], m["challenge"], m["publicKey"] = e.Hello.Install, e.Hello.KeyName, b64(e.Hello.Challenge), b64(e.Hello.PublicKey)
	case e.Kind == UnlockPRF && e.PRF != nil:
		m["origin"], m["rpId"], m["credential"], m["salt"] = e.PRF.Origin, e.PRF.RPID, b64(e.PRF.Credential), b64(e.PRF.Salt)
	}
	b, _ := json.Marshal(m)
	return string(b)
}

// checkHash is the hex SHA-256 of the check's ciphertext ("" for none).
func checkHash(c *Sealed) string {
	if c == nil {
		return ""
	}
	h := sha256.Sum256(c.Ciphertext)
	return hex.EncodeToString(h[:])
}

func validPoint(b []byte) bool {
	if len(b) != pointLen {
		return false
	}
	_, err := ecdh.P256().NewPublicKey(b)
	return err == nil
}

// validText reports whether s is not empty, at most max bytes and without
// control characters.
func validText(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func between(b []byte, lo, hi int) bool { return len(b) >= lo && len(b) <= hi }

func validEnclaveParams(p *EnclaveParams) bool {
	return p != nil && validInstall.MatchString(p.Install) && between(p.Blob, 1, maxBlob) && validPoint(p.SEPub) && validPoint(p.EphPub)
}

func validHelloParams(p *HelloParams) bool {
	return p != nil && validInstall.MatchString(p.Install) && p.KeyName == HelloKeyName(p.Install) &&
		len(p.Challenge) == keyLen && between(p.PublicKey, 1, maxPublicKey)
}

func validPRFParams(p *PRFParams) bool {
	return p != nil && validText(p.Origin, maxOrigin) && validText(p.RPID, maxRPID) &&
		between(p.Credential, 1, maxCredential) && len(p.Salt) == keyLen
}

// validEntry reports whether e is well formed: a known kind with its
// parameters only, and a wrap of a 32-byte key.
func validEntry(e *UnlockEntry) bool {
	if !validUnlockID.MatchString(e.ID) || !validText(e.Authenticator, maxAuthID) || !validCheck.MatchString(e.Check) ||
		e.Wrapped == nil || len(e.Wrapped.Nonce) != 12 || len(e.Wrapped.Ciphertext) != keyLen+16 {
		return false
	}
	switch e.Kind {
	case UnlockEnclave:
		return e.Hello == nil && e.PRF == nil && validEnclaveParams(e.Enclave)
	case UnlockHello:
		return e.Enclave == nil && e.PRF == nil && validHelloParams(e.Hello)
	case UnlockPRF:
		return e.Enclave == nil && e.Hello == nil && validPRFParams(e.PRF)
	}
	return false
}

// keptEntries are the entries of a file that Open keeps: well formed, made
// for its check (a passphrase changed since, also by an older build, ends
// them), with distinct ids, within the bounds, one per desktop install and
// one per credential.
func keptEntries(list []UnlockEntry, check *Sealed) []UnlockEntry {
	sum := checkHash(check)
	var out []UnlockEntry
	desktop, prf := 0, 0
	for _, e := range list {
		if !validEntry(&e) || e.Check != sum || slices.ContainsFunc(out, func(o UnlockEntry) bool {
			return o.ID == e.ID || (e.desktop() && o.desktop() && o.install() == e.install()) ||
				(e.PRF != nil && o.PRF != nil && bytes.Equal(o.PRF.Credential, e.PRF.Credential))
		}) {
			continue
		}
		if e.desktop() {
			if desktop >= MaxDesktopUnlocks {
				continue
			}
			desktop++
		} else {
			if prf >= MaxAuthenticators {
				continue
			}
			prf++
		}
		out = append(out, e)
	}
	return out
}

// ownerOf is the index in g of e's authenticator, -1 when it has none: the
// desktop authenticator for a desktop entry, the webauthn credential of
// the same id, origin and RP id for a prf entry.
func ownerOf(g Guard, e *UnlockEntry) int {
	return slices.IndexFunc(g.Authenticators, func(a Authenticator) bool {
		if a.ID != e.Authenticator {
			return false
		}
		switch {
		case e.desktop():
			return a.Kind == KindDesktop
		case e.Kind == UnlockPRF && e.PRF != nil:
			return a.Kind == KindWebAuthn && bytes.Equal(a.Credential, e.PRF.Credential) && a.Origin == e.PRF.Origin && a.RPID == e.PRF.RPID
		}
		return false
	})
}

// kek derives a key-encryption key: HKDF-SHA256, 32 bytes. nil when HKDF
// refuses its input (it does not for these lengths), which no wrap opens.
func kek(ikm, salt []byte, info string) []byte {
	k, err := hkdf.Key(sha256.New, ikm, salt, info, keyLen)
	if err != nil {
		return nil
	}
	return k
}

// EnclaveKEK is an enclave entry's KEK: ikm Z ‖ shellSecret, salt ephPub ‖
// sePub, info "vault-unlock enclave".
func EnclaveKEK(z, shellSecret, ephPub, sePub []byte) []byte {
	ikm := slices.Concat(z, shellSecret)
	defer clear(ikm)
	return kek(ikm, slices.Concat(ephPub, sePub), "vault-unlock enclave")
}

// HelloKEK is a hello entry's KEK: ikm signature ‖ shellSecret, salt the
// challenge, info "vault-unlock hello".
func HelloKEK(signature, shellSecret, challenge []byte) []byte {
	ikm := slices.Concat(signature, shellSecret)
	defer clear(ikm)
	return kek(ikm, challenge, "vault-unlock hello")
}

// PRFKEK is a prf entry's KEK: ikm the PRF output, salt the entry's PRF
// salt, info "vault-unlock prf".
func PRFKEK(output, salt []byte) []byte {
	return kek(output, salt, "vault-unlock prf")
}

// UnlockEntries returns copies of the unlock entries; it needs no key.
func (s *Store) UnlockEntries() []UnlockEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]UnlockEntry, 0, len(s.f.Unlock))
	for _, e := range s.f.Unlock {
		out = append(out, e.clone())
	}
	return out
}

// AddEnclave adds the enclave entry of the desktop authenticator for
// install, whose Secure Enclave key is blob and sePub, with the shell's
// secret: it makes an ephemeral P-256 key, the ECDH secret with sePub and
// from it the KEK, wraps the key, and forgets the ephemeral private key.
// An entry of the same install is replaced. The vault must be unlocked.
func (s *Store) AddEnclave(authenticator, install string, blob, sePub, shellSecret []byte) (UnlockEntry, error) {
	if !validInstall.MatchString(install) || !between(blob, 1, maxBlob) || !validPoint(sePub) || len(shellSecret) != keyLen {
		return UnlockEntry{}, fmt.Errorf("%w: enclave unlock", ErrInvalid)
	}
	se, err := ecdh.P256().NewPublicKey(sePub)
	if err != nil {
		return UnlockEntry{}, fmt.Errorf("%w: enclave key", ErrInvalid)
	}
	eph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return UnlockEntry{}, err
	}
	z, err := eph.ECDH(se)
	if err != nil {
		return UnlockEntry{}, fmt.Errorf("%w: enclave key", ErrInvalid)
	}
	ephPub := eph.PublicKey().Bytes()
	k := EnclaveKEK(z, shellSecret, ephPub, sePub)
	clear(z)
	e := UnlockEntry{Authenticator: authenticator, Kind: UnlockEnclave,
		Enclave: &EnclaveParams{Install: install, Blob: slices.Clone(blob), SEPub: slices.Clone(sePub), EphPub: ephPub}}
	return s.addUnlock(e, k)
}

// AddHello adds the hello entry of the desktop authenticator for install:
// keyName is its Windows Hello key (HelloKeyName), publicKey that key's,
// signature its signature of challenge, with the shell's secret. An entry
// of the same install is replaced. The vault must be unlocked.
//
// No signature is verified with publicKey: the key is kept to tell the
// Hello key apart, and it is bound into the wrap's additional data with the
// key's name, so it cannot be swapped for another. The signature is checked
// by the wrap opening: it is part of the KEK, and the Hello key signs
// deterministically, so only that key's signature of the challenge opens
// the entry again.
func (s *Store) AddHello(authenticator, install, keyName string, challenge, publicKey, signature, shellSecret []byte) (UnlockEntry, error) {
	if !validInstall.MatchString(install) || keyName != HelloKeyName(install) || len(challenge) != keyLen ||
		!between(publicKey, 1, maxPublicKey) || !between(signature, 1, maxSignature) || len(shellSecret) != keyLen {
		return UnlockEntry{}, fmt.Errorf("%w: hello unlock", ErrInvalid)
	}
	e := UnlockEntry{Authenticator: authenticator, Kind: UnlockHello,
		Hello: &HelloParams{Install: install, KeyName: keyName, Challenge: slices.Clone(challenge), PublicKey: slices.Clone(publicKey)}}
	return s.addUnlock(e, HelloKEK(signature, shellSecret, challenge))
}

// AddPRF adds the prf entry of webauthn authenticator, the credential of
// origin and rpID, from its PRF output for salt. An entry of the same
// credential is replaced. The vault must be unlocked.
func (s *Store) AddPRF(authenticator, origin, rpID string, credential, salt, output []byte) (UnlockEntry, error) {
	p := &PRFParams{Origin: origin, RPID: rpID, Credential: slices.Clone(credential), Salt: slices.Clone(salt)}
	if !validPRFParams(p) || len(output) != keyLen {
		return UnlockEntry{}, fmt.Errorf("%w: prf unlock", ErrInvalid)
	}
	return s.addUnlock(UnlockEntry{Authenticator: authenticator, Kind: UnlockPRF, PRF: p}, PRFKEK(output, salt))
}

// addUnlock wraps the key under kek (wiped after) as e, whose kind and
// parameters are set, and writes it: e's authenticator must be in the
// guard (ErrNotFound), an entry of the same install or credential is
// replaced, and the bounds kept.
func (s *Store) addUnlock(e UnlockEntry, kek []byte) (UnlockEntry, error) {
	defer clear(kek)
	if !validText(e.Authenticator, maxAuthID) {
		return UnlockEntry{}, fmt.Errorf("%w: authenticator", ErrInvalid)
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return UnlockEntry{}, err
	}
	e.ID = base64.RawURLEncoding.EncodeToString(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.usable() {
		return UnlockEntry{}, s.noKey()
	}
	e.Created, e.Check = s.now().UTC(), checkHash(s.f.Check)
	err := withKey(s.key, func(k []byte) error {
		g, err := s.guardWith(k)
		if err != nil {
			return err
		}
		if ownerOf(g, &e) < 0 {
			return fmt.Errorf("%w: authenticator %q", ErrNotFound, e.Authenticator)
		}
		if e.Wrapped, err = seal(kek, k, entryAD(&e)); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return UnlockEntry{}, err
	}
	list := slices.DeleteFunc(slices.Clone(s.f.Unlock), func(o UnlockEntry) bool {
		if e.desktop() {
			return o.desktop() && o.install() == e.install()
		}
		return o.PRF != nil && bytes.Equal(o.PRF.Credential, e.PRF.Credential)
	})
	n := 0
	for _, o := range list {
		if o.desktop() == e.desktop() {
			n++
		}
	}
	if (e.desktop() && n >= MaxDesktopUnlocks) || (!e.desktop() && n >= MaxAuthenticators) {
		return UnlockEntry{}, fmt.Errorf("%w: too many unlock entries", ErrInvalid)
	}
	prev := s.f.Unlock
	s.f.Unlock = append(list, e)
	if err := s.save(); err != nil {
		s.f.Unlock = prev
		return UnlockEntry{}, err
	}
	return e.clone(), nil
}

// RemoveUnlock removes an unlock entry; it needs no key. ErrNotFound for
// no such entry.
func (s *Store) RemoveUnlock(id string) error {
	if !validUnlockID.MatchString(id) {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.removeUnlock(id)
}

func (s *Store) removeUnlock(id string) error {
	i := slices.IndexFunc(s.f.Unlock, func(e UnlockEntry) bool { return e.ID == id })
	if i < 0 {
		return ErrNotFound
	}
	prev := s.f.Unlock
	s.f.Unlock = slices.Delete(slices.Clone(s.f.Unlock), i, i+1)
	if err := s.save(); err != nil {
		s.f.Unlock = prev
		return err
	}
	return nil
}

// VerifyUnlock checks an authenticator's proof for an unlock (a WebAuthn
// assertion's signature and counter; nil for the desktop's, whose relay
// is its proof) with the guard the candidate key opened and the entry's
// authenticator in it, and returns the counter to record (nil: none). It
// runs with the store's lock held: it must not call the store.
type VerifyUnlock func(g Guard, a Authenticator) (signCount *uint32, err error)

// UnlockWith unlocks the vault with unlock entry id's KEK (wiped after),
// in this order: the entry is found (else ErrUnlockStale); the key is
// unwrapped (ErrUnlockWrap wrapped in ErrUnlockFailed when it does not
// open) and opens the check (ErrUnlockFailed); the guard it opens holds the
// entry's authenticator (else the entry is removed: ErrUnlockOrphan, an
// ErrUnlockStale); verify, when given, accepts
// the authenticator's proof (its error wrapped in ErrUnlockFailed); the
// passphrase was checked with the key less than min(days, the days sealed
// then) days ago, and not in the future (else ErrPassphraseDue). Only then
// is the key installed and the authenticator's use recorded (LastUsed,
// and the counter verify returned). It returns the window sealed with the
// passphrase, whose auto-lock caps the session's. Any failure leaves the
// vault as it was and destroys the candidate key.
func (s *Store) UnlockWith(id string, kek []byte, days int, verify VerifyUnlock) (Window, error) {
	defer clear(kek)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.Mode != ModePassphrase {
		return Window{}, ErrNoPassphrase
	}
	i := slices.IndexFunc(s.f.Unlock, func(e UnlockEntry) bool { return e.ID == id })
	if !validUnlockID.MatchString(id) || i < 0 {
		return Window{}, ErrUnlockStale
	}
	e := s.f.Unlock[i].clone()
	if len(kek) != keyLen {
		return Window{}, ErrUnlockFailed
	}
	plain, err := open(kek, e.Wrapped, entryAD(&e))
	if err != nil || len(plain) != keyLen {
		clear(plain)
		return Window{}, fmt.Errorf("%w: %w", ErrUnlockFailed, ErrUnlockWrap)
	}
	cand, err := sealKey(plain)
	if err != nil {
		return Window{}, err
	}
	var w Window
	stale := false
	err = withKey(cand, func(k []byte) error {
		if s.checkKey(k) != nil {
			return ErrUnlockFailed
		}
		g, err := s.guardWith(k)
		if err != nil {
			return fmt.Errorf("%w: %w", ErrUnlockFailed, err)
		}
		ai := ownerOf(g, &e)
		if ai < 0 {
			stale = true
			return ErrUnlockOrphan
		}
		var count *uint32
		if verify != nil {
			if count, err = verify(g, g.Authenticators[ai]); err != nil {
				return fmt.Errorf("%w: %w", ErrUnlockFailed, err)
			}
		}
		if w, err = s.window(k, days); err != nil {
			return err
		}
		return s.recordProof(k, g, g.Authenticators[ai].ID, s.now().UTC(), count)
	})
	if stale {
		_ = s.removeUnlock(id)
	}
	if err != nil {
		destroyKey(cand)
		return Window{}, err
	}
	if s.key != nil {
		destroyKey(cand) // the same key
	} else {
		s.key = cand
	}
	_ = withKey(s.key, s.applyForgotten) // else still enforced by info, applied at the next change
	return w, nil
}

// The passphrase's window: an unlock by an authenticator is allowed only
// within some days of the last time the passphrase was checked with the
// key. When that was, and the window then (the days and the auto-lock of
// the settings), is sealed under the key (passphraseAt), so a program that
// can write the file cannot move it, lengthen it or lift the auto-lock: it
// can only put back an older one, which ends sooner. Its end is also in
// the clear (passphraseHint), for the UI only.

// Bounds of the window's days (the setting vault.passphraseDays).
const (
	MinPassphraseDays     = 1
	MaxPassphraseDays     = 90
	DefaultPassphraseDays = 14
)

// passphraseAtAD is the sealed window's additional data.
const passphraseAtAD = "#passphraseAt"

// Window is how long after the passphrase an authenticator may unlock the
// vault (Days), and the auto-lock then (AutoLock; 0: never).
type Window struct {
	Days     int
	AutoLock time.Duration
}

// clampDays keeps days within the setting's bounds.
func clampDays(days int) int { return min(max(days, MinPassphraseDays), MaxPassphraseDays) }

// passphraseAt is the sealed window.
type passphraseAt struct {
	At       time.Time `json:"at"`
	Days     int       `json:"days"`
	AutoLock int64     `json:"autoLock"` // seconds; 0: never
}

// sealWindow seals the window w starting now under k, and its end for the
// hint.
func (s *Store) sealWindow(k []byte, w Window) (*Sealed, string, error) {
	p := passphraseAt{At: s.now().UTC().Truncate(time.Second), Days: clampDays(w.Days), AutoLock: int64(max(w.AutoLock, 0) / time.Second)}
	b, err := json.Marshal(p)
	if err != nil {
		return nil, "", err
	}
	v, err := seal(k, b, passphraseAtAD)
	if err != nil {
		return nil, "", err
	}
	return v, p.At.AddDate(0, 0, p.Days).Format(time.RFC3339), nil
}

// passphraseChecked starts the window w: the passphrase was just checked
// with k, the key. A write that fails leaves the previous window. Called
// with s.mu held.
func (s *Store) passphraseChecked(k []byte, w Window) {
	v, hint, err := s.sealWindow(k, w)
	if err != nil {
		return
	}
	prevAt, prevHint := s.f.PassphraseAt, s.f.PassphraseHint
	s.f.PassphraseAt, s.f.PassphraseHint = v, hint
	if err := s.save(); err != nil {
		s.f.PassphraseAt, s.f.PassphraseHint = prevAt, prevHint
	}
}

// window opens the sealed window with k and returns it when an unlock by
// an authenticator is within it, the days the lesser of days (the setting
// now) and those sealed; ErrPassphraseDue when there is none, it does not
// open, it starts in the future or it has ended. Called with s.mu held.
func (s *Store) window(k []byte, days int) (Window, error) {
	if s.f.PassphraseAt == nil {
		return Window{}, ErrPassphraseDue
	}
	b, err := open(k, s.f.PassphraseAt, passphraseAtAD)
	if err != nil {
		return Window{}, ErrPassphraseDue
	}
	var p passphraseAt
	err = json.Unmarshal(b, &p)
	clear(b)
	if err != nil || p.Days < MinPassphraseDays || p.AutoLock < 0 {
		return Window{}, ErrPassphraseDue
	}
	now := s.now()
	limit := min(clampDays(days), p.Days)
	if p.At.IsZero() || now.Before(p.At) || !now.Before(p.At.AddDate(0, 0, limit)) {
		return Window{}, ErrPassphraseDue
	}
	return Window{Days: p.Days, AutoLock: time.Duration(p.AutoLock) * time.Second}, nil
}

// PassphraseDue is when the passphrase's window ends, from its hint in the
// clear (zero when there is none): for what the UI offers only, never for
// what is allowed. It needs no key.
func (s *Store) PassphraseDue() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := time.Parse(time.RFC3339, s.f.PassphraseHint)
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}

// ForgetPassphrase ends the passphrase's window: the next unlock needs the
// passphrase. It needs no key.
func (s *Store) ForgetPassphrase() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f.PassphraseAt == nil && s.f.PassphraseHint == "" {
		return nil
	}
	prevAt, prevHint := s.f.PassphraseAt, s.f.PassphraseHint
	s.f.PassphraseAt, s.f.PassphraseHint = nil, ""
	if err := s.save(); err != nil {
		s.f.PassphraseAt, s.f.PassphraseHint = prevAt, prevHint
		return err
	}
	return nil
}
