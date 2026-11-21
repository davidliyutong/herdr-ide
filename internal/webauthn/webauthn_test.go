package webauthn

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	mrand "math/rand"
	"strings"
	"sync"
	"testing"
)

const (
	testOrigin = "http://localhost:7780"
	testRPID   = "localhost"
)

var testChallenge = []byte("0123456789abcdef0123456789abcdef")

func testExpect() Expect {
	return Expect{Challenge: testChallenge, Origin: testOrigin, RPID: testRPID}
}

var (
	rsaOnce sync.Once
	rsaKey  *rsa.PrivateKey
)

// sharedRSA generates the RSA key once per test binary: it is the slow one.
func sharedRSA(t testing.TB) *rsa.PrivateKey {
	t.Helper()
	rsaOnce.Do(func() {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(err)
		}
		rsaKey = k
	})
	return rsaKey
}

type signer struct {
	alg  int
	spki []byte
	sign func(msg []byte) []byte
}

func spkiOf(t testing.TB, pub crypto.PublicKey) []byte {
	t.Helper()
	b, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func newES256(t testing.TB) signer {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{ES256, spkiOf(t, &k.PublicKey), func(msg []byte) []byte {
		d := sha256.Sum256(msg)
		sig, err := ecdsa.SignASN1(rand.Reader, k, d[:])
		if err != nil {
			t.Fatal(err)
		}
		return sig
	}}
}

func newEdDSA(t testing.TB) signer {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{EdDSA, spkiOf(t, pub), func(msg []byte) []byte { return ed25519.Sign(priv, msg) }}
}

func newRS256(t testing.TB) signer {
	k := sharedRSA(t)
	return signer{RS256, spkiOf(t, &k.PublicKey), func(msg []byte) []byte {
		d := sha256.Sum256(msg)
		sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, d[:])
		if err != nil {
			t.Fatal(err)
		}
		return sig
	}}
}

func clientData(typ string, challenge []byte, origin string, extra string) []byte {
	return []byte(`{"type":"` + typ + `","challenge":"` + base64.RawURLEncoding.EncodeToString(challenge) +
		`","origin":"` + origin + `"` + extra + `}`)
}

func authData(rpid string, flags byte, count uint32) []byte {
	h := sha256.Sum256([]byte(rpid))
	b := append([]byte(nil), h[:]...)
	b = append(b, flags)
	return binary.BigEndian.AppendUint32(b, count)
}

func regAuthData(rpid string, flags byte, id []byte, declaredLen int) []byte {
	b := authData(rpid, flags, 0)
	b = append(b, make([]byte, 16)...) // AAGUID
	b = binary.BigEndian.AppendUint16(b, uint16(declaredLen))
	b = append(b, id...)
	return append(b, 0xa5, 0x01, 0x02) // the start of a COSE key, never read
}

func sign(s signer, cd, ad []byte) []byte {
	h := sha256.Sum256(cd)
	return s.sign(append(append([]byte(nil), ad...), h[:]...))
}

func mustKey(t testing.TB, s signer) *PublicKey {
	t.Helper()
	k, err := ParsePublicKey(s.alg, s.spki)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func flip(b []byte, i int) []byte {
	c := append([]byte(nil), b...)
	c[i] ^= 0x01
	return c
}

func TestAssertionValid(t *testing.T) {
	for name, s := range map[string]signer{"ES256": newES256(t), "EdDSA": newEdDSA(t), "RS256": newRS256(t)} {
		t.Run(name, func(t *testing.T) {
			cd := clientData("webauthn.get", testChallenge, testOrigin, `,"crossOrigin":false,"extra":{"a":1}`)
			ad := authData(testRPID, flagUP|flagUV, 4242)
			n, err := VerifyAssertion(mustKey(t, s), cd, ad, sign(s, cd, ad), testExpect())
			if err != nil {
				t.Fatal(err)
			}
			if n != 4242 {
				t.Fatalf("counter %d", n)
			}
		})
	}
}

func TestAssertionRefusals(t *testing.T) {
	es := newES256(t)
	other := newES256(t)
	key := mustKey(t, es)
	// An unknown member to change a byte in, which no check but the signature sees.
	goodCD := clientData("webauthn.get", testChallenge, testOrigin, `,"x":"abc"`)
	goodAD := authData(testRPID, flagUP|flagUV, 1)
	goodSig := sign(es, goodCD, goodAD)

	otherChallenge := bytes.Repeat([]byte{7}, 32)
	cases := []struct {
		name string
		cd   []byte
		ad   []byte
		sig  []byte
		want error
	}{
		{"wrong challenge", clientData("webauthn.get", otherChallenge, testOrigin, ""), goodAD, nil, ErrChallenge},
		{"wrong origin", clientData("webauthn.get", testChallenge, "http://evil.example", ""), goodAD, nil, ErrOrigin},
		{"origin with path", clientData("webauthn.get", testChallenge, testOrigin+"/", ""), goodAD, nil, ErrOrigin},
		{"no origin", []byte(`{"type":"webauthn.get","challenge":"` + base64.RawURLEncoding.EncodeToString(testChallenge) + `"}`), goodAD, nil, ErrOrigin},
		{"cross origin", clientData("webauthn.get", testChallenge, testOrigin, `,"crossOrigin":true`), goodAD, nil, ErrOrigin},
		{"cross origin not a bool", clientData("webauthn.get", testChallenge, testOrigin, `,"crossOrigin":"no"`), goodAD, nil, ErrOrigin},
		{"registration type", clientData("webauthn.create", testChallenge, testOrigin, ""), goodAD, nil, ErrType},
		{"no type", []byte(`{"challenge":"x","origin":"y"}`), goodAD, nil, ErrType},
		{"type in other case", []byte(`{"TYPE":"webauthn.get","challenge":"x","origin":"y"}`), goodAD, nil, ErrType},
		{"wrong rp id", goodCD, authData("example.com", flagUP|flagUV, 1), nil, ErrRPID},
		{"user not verified", goodCD, authData(testRPID, flagUP, 1), nil, ErrUserVerification},
		{"user not present", goodCD, authData(testRPID, flagUV, 1), nil, ErrUserVerification},
		{"no flags", goodCD, authData(testRPID, 0, 1), nil, ErrUserVerification},
		{"authenticator data changed", goodCD, flip(goodAD, 36), goodSig, ErrSignature},
		{"client data changed", flip(goodCD, len(goodCD)-4), goodAD, goodSig, ErrSignature},
		{"signature changed", goodCD, goodAD, flip(goodSig, len(goodSig)-1), ErrSignature},
		{"signature of another key", goodCD, goodAD, sign(other, goodCD, goodAD), ErrSignature},
		{"empty signature", goodCD, goodAD, nil, ErrSignature},
		{"short authenticator data", goodCD, goodAD[:36], goodSig, ErrMalformed},
		{"empty authenticator data", goodCD, nil, goodSig, ErrMalformed},
		{"challenge not base64url", []byte(`{"type":"webauthn.get","challenge":"a+b/c=","origin":"` + testOrigin + `"}`), goodAD, nil, ErrChallenge},
		{"challenge not a string", []byte(`{"type":"webauthn.get","challenge":5,"origin":"` + testOrigin + `"}`), goodAD, nil, ErrChallenge},
		{"not JSON", []byte("not json"), goodAD, nil, ErrMalformed},
		{"JSON array", []byte(`[]`), goodAD, nil, ErrMalformed},
		{"JSON null", []byte(`null`), goodAD, nil, ErrMalformed},
		{"trailing data", append(append([]byte(nil), goodCD...), []byte(` {}`)...), goodAD, nil, ErrMalformed},
		{"invalid UTF-8", append(append([]byte(nil), goodCD[:len(goodCD)-1]...), []byte(`,"x":"\xff"}`)...), goodAD, nil, ErrMalformed},
		{"client data over bound", append(append([]byte(nil), goodCD[:len(goodCD)-1]...), []byte(`,"x":"`+strings.Repeat("a", 4096)+`"}`)...), goodAD, nil, ErrMalformed},
		{"authenticator data over bound", goodCD, append(append([]byte(nil), goodAD...), make([]byte, 8*1024)...), goodSig, ErrMalformed},
		{"signature over bound", goodCD, goodAD, make([]byte, 1025), ErrMalformed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sig := c.sig
			if sig == nil && c.want != ErrSignature {
				sig = goodSig
			}
			_, err := VerifyAssertion(key, c.cd, c.ad, sig, testExpect())
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}

	t.Run("signature at the bound is judged, not refused", func(t *testing.T) {
		_, err := VerifyAssertion(key, goodCD, goodAD, make([]byte, 1024), testExpect())
		if !errors.Is(err, ErrSignature) {
			t.Fatal(err)
		}
	})
	t.Run("client data at the bound is accepted", func(t *testing.T) {
		pad := 4096 - len(goodCD) - len(`,"x":""`)
		cd := append(append([]byte(nil), goodCD[:len(goodCD)-1]...), []byte(`,"x":"`+strings.Repeat("a", pad)+`"}`)...)
		if len(cd) != 4096 {
			t.Fatalf("test data of %d bytes", len(cd))
		}
		if _, err := VerifyAssertion(key, cd, goodAD, sign(es, cd, goodAD), testExpect()); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("nil key", func(t *testing.T) {
		if _, err := VerifyAssertion(nil, goodCD, goodAD, goodSig, testExpect()); !errors.Is(err, ErrAlgorithm) {
			t.Fatal(err)
		}
	})
	t.Run("zero key", func(t *testing.T) {
		if _, err := VerifyAssertion(&PublicKey{}, goodCD, goodAD, goodSig, testExpect()); !errors.Is(err, ErrAlgorithm) {
			t.Fatal(err)
		}
	})
	t.Run("key of another algorithm", func(t *testing.T) {
		ed := mustKey(t, newEdDSA(t))
		if _, err := VerifyAssertion(ed, goodCD, goodAD, goodSig, testExpect()); !errors.Is(err, ErrSignature) {
			t.Fatal(err)
		}
	})
}

func TestExpectBounds(t *testing.T) {
	es := newES256(t)
	key := mustKey(t, es)
	for name, c := range map[string][]byte{
		"empty":     nil,
		"short":     make([]byte, 15),
		"too long":  make([]byte, 129),
		"far above": make([]byte, 4096),
	} {
		t.Run(name, func(t *testing.T) {
			e := testExpect()
			e.Challenge = c
			cd := clientData("webauthn.get", c, testOrigin, "")
			ad := authData(testRPID, flagUP|flagUV, 1)
			if _, err := VerifyAssertion(key, cd, ad, sign(es, cd, ad), e); !errors.Is(err, ErrMalformed) {
				t.Fatal(err)
			}
			if _, err := VerifyRegistration(cd, regAuthData(testRPID, flagUP|flagUV|flagAT, []byte{1}, 1), e); !errors.Is(err, ErrMalformed) {
				t.Fatal(err)
			}
		})
	}
	for _, n := range []int{16, 128} {
		c := bytes.Repeat([]byte{9}, n)
		e := testExpect()
		e.Challenge = c
		cd := clientData("webauthn.get", c, testOrigin, "")
		ad := authData(testRPID, flagUP|flagUV, 1)
		if _, err := VerifyAssertion(key, cd, ad, sign(es, cd, ad), e); err != nil {
			t.Fatalf("challenge of %d bytes: %v", n, err)
		}
	}
	t.Run("empty origin and rp id", func(t *testing.T) {
		cd := clientData("webauthn.get", testChallenge, "", "")
		ad := authData("", flagUP|flagUV, 1)
		e := Expect{Challenge: testChallenge}
		if _, err := VerifyAssertion(key, cd, ad, sign(es, cd, ad), e); !errors.Is(err, ErrOrigin) {
			t.Fatal(err)
		}
		e.Origin = testOrigin
		cd = clientData("webauthn.get", testChallenge, testOrigin, "")
		if _, err := VerifyAssertion(key, cd, ad, sign(es, cd, ad), e); !errors.Is(err, ErrRPID) {
			t.Fatal(err)
		}
	})
}

func TestParsePublicKey(t *testing.T) {
	p384, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	small, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	es, ed, rs := newES256(t), newEdDSA(t), newRS256(t)

	cases := []struct {
		name string
		alg  int
		spki []byte
		want error
	}{
		{"ES256", ES256, es.spki, nil},
		{"EdDSA", EdDSA, ed.spki, nil},
		{"RS256", RS256, rs.spki, nil},
		{"P-256 key with RS256", RS256, es.spki, ErrAlgorithm},
		{"P-256 key with EdDSA", EdDSA, es.spki, ErrAlgorithm},
		{"RSA key with ES256", ES256, rs.spki, ErrAlgorithm},
		{"Ed25519 key with ES256", ES256, ed.spki, ErrAlgorithm},
		{"P-384 key", ES256, spkiOf(t, &p384.PublicKey), ErrAlgorithm},
		{"1024-bit RSA key", RS256, spkiOf(t, &small.PublicKey), ErrAlgorithm},
		{"unknown algorithm", -35, es.spki, ErrAlgorithm},
		{"algorithm zero", 0, es.spki, ErrAlgorithm},
		{"unknown algorithm and garbage", 99, []byte{1, 2, 3}, ErrAlgorithm},
		{"garbage DER", ES256, []byte{1, 2, 3, 4}, ErrMalformed},
		{"empty", ES256, nil, ErrMalformed},
		{"trailing bytes", ES256, append(append([]byte(nil), es.spki...), 0), ErrMalformed},
		{"truncated", ES256, es.spki[:len(es.spki)-1], ErrMalformed},
		{"over bound", ES256, make([]byte, 2049), ErrMalformed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			k, err := ParsePublicKey(c.alg, c.spki)
			if c.want == nil {
				if err != nil || k == nil {
					t.Fatal(err)
				}
				return
			}
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
			if k != nil {
				t.Fatal("key returned with an error")
			}
		})
	}
}

func TestRegistration(t *testing.T) {
	id := []byte("credential-id-0123456789")
	cd := clientData("webauthn.create", testChallenge, testOrigin, "")
	flags := byte(flagUP | flagUV | flagAT)

	t.Run("valid", func(t *testing.T) {
		ad := regAuthData(testRPID, flags, id, len(id))
		got, err := VerifyRegistration(cd, ad, testExpect())
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, id) {
			t.Fatalf("id %x", got)
		}
		got[0] ^= 0xff
		if !bytes.Equal(ad[55:55+len(id)], id) {
			t.Fatal("id aliases the authenticator data")
		}
	})
	t.Run("longest id", func(t *testing.T) {
		long := bytes.Repeat([]byte{3}, 1023)
		got, err := VerifyRegistration(cd, regAuthData(testRPID, flags, long, 1023), testExpect())
		if err != nil || !bytes.Equal(got, long) {
			t.Fatal(err)
		}
	})
	cases := []struct {
		name string
		cd   []byte
		ad   []byte
		want error
	}{
		{"attested data flag missing", cd, regAuthData(testRPID, flagUP|flagUV, id, len(id)), ErrMalformed},
		{"id length past the data", cd, regAuthData(testRPID, flags, id, 200), ErrMalformed},
		{"id length over the maximum", cd, regAuthData(testRPID, flags, bytes.Repeat([]byte{1}, 1024), 1024), ErrMalformed},
		{"id length zero", cd, regAuthData(testRPID, flags, nil, 0), ErrMalformed},
		{"cut after the counter", cd, authData(testRPID, flags, 0), ErrMalformed},
		{"cut inside the AAGUID", cd, append(authData(testRPID, flags, 0), make([]byte, 10)...), ErrMalformed},
		{"cut inside the id length", cd, append(authData(testRPID, flags, 0), make([]byte, 17)...), ErrMalformed},
		{"wrong challenge", clientData("webauthn.create", bytes.Repeat([]byte{1}, 32), testOrigin, ""), regAuthData(testRPID, flags, id, len(id)), ErrChallenge},
		{"wrong origin", clientData("webauthn.create", testChallenge, "https://evil.example", ""), regAuthData(testRPID, flags, id, len(id)), ErrOrigin},
		{"assertion type", clientData("webauthn.get", testChallenge, testOrigin, ""), regAuthData(testRPID, flags, id, len(id)), ErrType},
		{"wrong rp id", cd, regAuthData("example.com", flags, id, len(id)), ErrRPID},
		{"user not verified", cd, regAuthData(testRPID, flagUP|flagAT, id, len(id)), ErrUserVerification},
		{"cross origin", clientData("webauthn.create", testChallenge, testOrigin, `,"crossOrigin":true`), regAuthData(testRPID, flags, id, len(id)), ErrOrigin},
		{"authenticator data over bound", cd, append(regAuthData(testRPID, flags, id, len(id)), make([]byte, 8192)...), ErrMalformed},
		{"client data over bound", make([]byte, 4097), regAuthData(testRPID, flags, id, len(id)), ErrMalformed},
		{"short authenticator data", cd, make([]byte, 36), ErrMalformed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := VerifyRegistration(c.cd, c.ad, testExpect())
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
			if got != nil {
				t.Fatal("id returned with an error")
			}
		})
	}
}

// TestRandomInputs feeds noise to both functions: they must refuse, never panic.
func TestRandomInputs(t *testing.T) {
	r := mrand.New(mrand.NewSource(1))
	rnd := func(max int) []byte {
		b := make([]byte, r.Intn(max+1))
		r.Read(b)
		return b
	}
	keys := []*PublicKey{mustKey(t, newES256(t)), mustKey(t, newEdDSA(t)), mustKey(t, newRS256(t))}
	e := testExpect()
	for i := 0; i < 400; i++ {
		cd, ad, sig := rnd(300), rnd(300), rnd(300)
		if i%4 == 0 {
			// Past the early checks, so the later code sees noise too.
			cd = clientData("webauthn.get", testChallenge, testOrigin, "")
			ad = append(authData(testRPID, flagUP|flagUV|flagAT, r.Uint32()), rnd(100)...)
		}
		for _, k := range keys {
			if _, err := VerifyAssertion(k, cd, ad, sig, e); err == nil {
				t.Fatalf("noise verified: %x %x %x", cd, ad, sig)
			}
		}
		if i%4 == 0 {
			// Noise after valid headers may be a well-formed id: only no panic is asked.
			cd = clientData("webauthn.create", testChallenge, testOrigin, "")
			_, _ = VerifyRegistration(cd, ad, e)
			continue
		}
		if id, err := VerifyRegistration(cd, ad, e); err == nil {
			t.Fatalf("noise registered: %x %x %x", cd, ad, id)
		}
		if _, err := ParsePublicKey(r.Intn(600)-300, rnd(300)); err == nil {
			t.Fatal("noise parsed as a key")
		}
	}
}
