// Package webauthn verifies WebAuthn registrations and assertions with the
// standard library only, so a page can prove the user's presence with a
// platform authenticator (Touch ID, Windows Hello, a security key) to a
// server that has no login.
//
// The public key of a credential does not come from the attestation object,
// which would need a CBOR parser: the page sends what
// AuthenticatorAttestationResponse.getPublicKey() returned (a
// SubjectPublicKeyInfo in DER) and getPublicKeyAlgorithm() (a COSE algorithm
// number), next to getAuthenticatorData(). This package therefore reads only
// the fixed layout of authenticator data, the client data JSON and standard
// public keys. No attestation statement is checked: the server learns that
// some authenticator holds the key, not which one.
//
// Every input is bounded and every check refuses on doubt. Nothing here
// panics on malformed input.
package webauthn

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"
)

// COSE algorithms accepted.
const (
	ES256 = -7   // ECDSA with P-256 and SHA-256, signature in ASN.1 DER
	EdDSA = -8   // Ed25519
	RS256 = -257 // RSASSA-PKCS1-v1_5 with SHA-256
)

// Bounds on what a page may send; they keep a hostile body cheap to refuse.
const (
	maxClientData = 4 << 10
	maxAuthData   = 8 << 10
	maxSignature  = 1 << 10
	maxSPKI       = 2 << 10
	minChallenge  = 16
	maxChallenge  = 128
	maxCredID     = 1023
	minRSABits    = 2048
)

// Flags of the authenticator data.
const (
	flagUP = 0x01 // user present
	flagUV = 0x04 // user verified
	flagAT = 0x40 // attested credential data follows
)

// Errors, wrapped with detail where useful; test them with errors.Is.
var (
	ErrMalformed        = errors.New("webauthn: malformed input")
	ErrType             = errors.New("webauthn: wrong ceremony type")
	ErrChallenge        = errors.New("webauthn: challenge mismatch")
	ErrOrigin           = errors.New("webauthn: origin mismatch")
	ErrRPID             = errors.New("webauthn: relying party id mismatch")
	ErrUserVerification = errors.New("webauthn: user presence or verification missing")
	ErrAlgorithm        = errors.New("webauthn: unsupported algorithm or key")
	ErrSignature        = errors.New("webauthn: signature invalid")
)

// Expect is what a ceremony must match.
type Expect struct {
	Challenge []byte // the bytes the server gave the page
	Origin    string // the page's origin, e.g. "http://localhost:7780"
	RPID      string // the relying party id, a host name
}

// PublicKey is a credential's public key with its COSE algorithm.
type PublicKey struct {
	alg int
	key crypto.PublicKey // *ecdsa.PublicKey, *rsa.PublicKey or ed25519.PublicKey
}

// ParsePublicKey takes a credential's algorithm and its key as
// SubjectPublicKeyInfo.
func ParsePublicKey(alg int, spki []byte) (*PublicKey, error) {
	switch alg {
	case ES256, EdDSA, RS256:
	default:
		return nil, fmt.Errorf("%w: COSE algorithm %d", ErrAlgorithm, alg)
	}
	if len(spki) > maxSPKI {
		return nil, fmt.Errorf("%w: public key over %d bytes", ErrMalformed, maxSPKI)
	}
	parsed, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		return nil, fmt.Errorf("%w: public key: %v", ErrMalformed, err)
	}
	switch k := parsed.(type) {
	case *ecdsa.PublicKey:
		if alg != ES256 || k.Curve != elliptic.P256() {
			return nil, fmt.Errorf("%w: ECDSA key does not fit algorithm %d on P-256", ErrAlgorithm, alg)
		}
	case *rsa.PublicKey:
		if alg != RS256 {
			return nil, fmt.Errorf("%w: RSA key with algorithm %d", ErrAlgorithm, alg)
		}
		if k.N.BitLen() < minRSABits {
			return nil, fmt.Errorf("%w: RSA key of %d bits, at least %d needed", ErrAlgorithm, k.N.BitLen(), minRSABits)
		}
	case ed25519.PublicKey:
		if alg != EdDSA || len(k) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("%w: Ed25519 key with algorithm %d", ErrAlgorithm, alg)
		}
	default:
		// X25519 and other kinds of key.
		return nil, fmt.Errorf("%w: key of type %T", ErrAlgorithm, parsed)
	}
	return &PublicKey{alg: alg, key: parsed}, nil
}

// VerifyRegistration checks the client data and authenticator data of a
// navigator.credentials.create() and returns the new credential's id.
func VerifyRegistration(clientDataJSON, authenticatorData []byte, e Expect) (credentialID []byte, err error) {
	if err := checkSizes(clientDataJSON, authenticatorData, e); err != nil {
		return nil, err
	}
	if err := checkClientData(clientDataJSON, "webauthn.create", e); err != nil {
		return nil, err
	}
	if _, err := checkAuthData(authenticatorData, e); err != nil {
		return nil, err
	}
	// The flags were checked above, so the attested data is the next thing
	// to read: AAGUID, id length, id.
	if authenticatorData[32]&flagAT == 0 {
		return nil, fmt.Errorf("%w: no attested credential data", ErrMalformed)
	}
	rest := authenticatorData[37:]
	if len(rest) < 16+2 {
		return nil, fmt.Errorf("%w: attested credential data cut short", ErrMalformed)
	}
	n := int(binary.BigEndian.Uint16(rest[16:18]))
	if n == 0 || n > maxCredID {
		return nil, fmt.Errorf("%w: credential id length %d", ErrMalformed, n)
	}
	rest = rest[18:]
	if len(rest) < n {
		return nil, fmt.Errorf("%w: credential id runs past the data", ErrMalformed)
	}
	// A copy, so the caller's id does not alias the request body.
	return append([]byte(nil), rest[:n]...), nil
}

// VerifyAssertion checks a navigator.credentials.get() made with the key
// and returns the authenticator's signature counter.
func VerifyAssertion(key *PublicKey, clientDataJSON, authenticatorData, signature []byte, e Expect) (signCount uint32, err error) {
	if key == nil || key.key == nil {
		return 0, fmt.Errorf("%w: no public key", ErrAlgorithm)
	}
	if err := checkSizes(clientDataJSON, authenticatorData, e); err != nil {
		return 0, err
	}
	if len(signature) > maxSignature {
		return 0, fmt.Errorf("%w: signature over %d bytes", ErrMalformed, maxSignature)
	}
	if err := checkClientData(clientDataJSON, "webauthn.get", e); err != nil {
		return 0, err
	}
	count, err := checkAuthData(authenticatorData, e)
	if err != nil {
		return 0, err
	}

	hash := sha256.Sum256(clientDataJSON)
	msg := make([]byte, 0, len(authenticatorData)+len(hash))
	msg = append(msg, authenticatorData...)
	msg = append(msg, hash[:]...)

	ok := false
	switch k := key.key.(type) {
	case *ecdsa.PublicKey:
		if key.alg == ES256 {
			digest := sha256.Sum256(msg)
			ok = ecdsa.VerifyASN1(k, digest[:], signature)
		}
	case *rsa.PublicKey:
		if key.alg == RS256 {
			digest := sha256.Sum256(msg)
			ok = rsa.VerifyPKCS1v15(k, crypto.SHA256, digest[:], signature) == nil
		}
	case ed25519.PublicKey:
		if key.alg == EdDSA && len(k) == ed25519.PublicKeySize {
			ok = ed25519.Verify(k, msg, signature)
		}
	}
	if !ok {
		return 0, ErrSignature
	}
	return count, nil
}

func checkSizes(clientDataJSON, authenticatorData []byte, e Expect) error {
	if len(clientDataJSON) > maxClientData {
		return fmt.Errorf("%w: client data over %d bytes", ErrMalformed, maxClientData)
	}
	if len(authenticatorData) > maxAuthData {
		return fmt.Errorf("%w: authenticator data over %d bytes", ErrMalformed, maxAuthData)
	}
	if len(e.Challenge) < minChallenge || len(e.Challenge) > maxChallenge {
		return fmt.Errorf("%w: expected challenge must be %d to %d bytes", ErrMalformed, minChallenge, maxChallenge)
	}
	return nil
}

// checkClientData reads the JSON by exact member names: Go's struct decoding
// would also match "Type" or "TYPE", which a browser never sends.
func checkClientData(data []byte, wantType string, e Expect) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("%w: client data is not UTF-8", ErrMalformed)
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(data, &members); err != nil || members == nil {
		return fmt.Errorf("%w: client data is not a JSON object", ErrMalformed)
	}

	var typ string
	if json.Unmarshal(members["type"], &typ) != nil || typ != wantType {
		return fmt.Errorf("%w: want %q", ErrType, wantType)
	}

	var challenge string
	if json.Unmarshal(members["challenge"], &challenge) != nil {
		return fmt.Errorf("%w: challenge is not a string", ErrChallenge)
	}
	got, err := base64.RawURLEncoding.Strict().DecodeString(challenge)
	if err != nil {
		return fmt.Errorf("%w: challenge is not base64url", ErrChallenge)
	}
	if subtle.ConstantTimeCompare(got, e.Challenge) != 1 {
		return ErrChallenge
	}

	var origin string
	if e.Origin == "" || json.Unmarshal(members["origin"], &origin) != nil || origin != e.Origin {
		return ErrOrigin
	}
	if raw, ok := members["crossOrigin"]; ok {
		var cross bool
		// Absent or false passes; true, and anything that is not a boolean, does not.
		if json.Unmarshal(raw, &cross) != nil || cross {
			return fmt.Errorf("%w: cross-origin ceremony", ErrOrigin)
		}
	}
	return nil
}

// checkAuthData checks the RP id hash and flags and returns the counter.
func checkAuthData(ad []byte, e Expect) (uint32, error) {
	if len(ad) < 37 {
		return 0, fmt.Errorf("%w: authenticator data of %d bytes, at least 37 needed", ErrMalformed, len(ad))
	}
	want := sha256.Sum256([]byte(e.RPID))
	if e.RPID == "" || subtle.ConstantTimeCompare(ad[:32], want[:]) != 1 {
		return 0, ErrRPID
	}
	if ad[32]&(flagUP|flagUV) != flagUP|flagUV {
		return 0, ErrUserVerification
	}
	return binary.BigEndian.Uint32(ad[33:37]), nil
}
