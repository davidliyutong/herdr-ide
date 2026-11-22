package vault

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"github.com/awnumar/memguard"
	"github.com/awnumar/memguard/core"
)

// The master key, while the vault is unlocked, is kept in a memguard
// Enclave: encrypted in memory under a session key that memguard holds in
// locked (mlock), guarded pages. It is opened into a LockedBuffer (locked,
// read-only pages between guard pages) for one operation of the store
// (a value opened or sealed, a guard read and written, every value of a
// passphrase change), which is destroyed (wiped and released) right after.
// What memguard does not cover: AES's expanded key that each operation
// builds on Go's heap, the passphrase and the strings of a request that
// carried key material (Go strings cannot be wiped), and the session key
// itself, which is in the process's memory too.
//
// memguard reports most failures of the system (an mlock limit too small,
// a mapping refused) by purging its session and panicking; the helpers
// below turn those panics into ErrMemory, so an unlock fails with that
// error instead of crashing the core or keeping the key in an ordinary
// slice.

// ErrMemory is a failure to keep key material in locked memory.
var ErrMemory = errors.New("the vault's key cannot be kept in locked memory")

// newEnclave is memguard.NewEnclave (tests replace it to fail).
var newEnclave = memguard.NewEnclave

// purging is held for reading while key material is sealed or opened, and
// for writing by Purge: memguard's purge unmaps the buffers it finds, so
// one in use would fault. It is never taken twice by one caller.
var purging sync.RWMutex

// guarded runs fn, a call into memguard, turning its panic into ErrMemory.
func guarded(fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: %v", ErrMemory, r)
		}
	}()
	return fn()
}

// sealKey moves b (32 bytes of key material) into a new Enclave and wipes
// b, also when it fails.
func sealKey(b []byte) (*memguard.Enclave, error) {
	defer clear(b)
	purging.RLock()
	defer purging.RUnlock()
	var e *memguard.Enclave
	err := guarded(func() error {
		e = newEnclave(b)
		return nil
	})
	if err == nil && e == nil {
		err = fmt.Errorf("%w: no key", ErrMemory)
	}
	if err != nil {
		return nil, err
	}
	return e, nil
}

// withKey opens e into a LockedBuffer, calls fn with its bytes and
// destroys the buffer. The bytes are read-only (writing them faults) and
// must not be kept after fn returns. No Enclave is ErrLocked; one that does
// not open (memguard's session was purged, which a failure of the system
// does) is ErrMemory.
func withKey(e *memguard.Enclave, fn func(k []byte) error) error {
	return withKeys([]*memguard.Enclave{e}, func(ks [][]byte) error { return fn(ks[0]) })
}

// withKeys is withKey for several Enclaves at once (a passphrase change
// opens the current key and the new one).
func withKeys(es []*memguard.Enclave, fn func(ks [][]byte) error) error {
	for _, e := range es {
		if e == nil {
			return ErrLocked
		}
	}
	purging.RLock()
	defer purging.RUnlock()
	bufs := make([]*memguard.LockedBuffer, 0, len(es))
	defer func() {
		for _, b := range bufs {
			destroyBuffer(b)
		}
	}()
	ks := make([][]byte, 0, len(es))
	for _, e := range es {
		var b *memguard.LockedBuffer
		err := guarded(func() error {
			var err error
			b, err = e.Open()
			return err
		})
		if err != nil {
			if !errors.Is(err, ErrMemory) {
				err = fmt.Errorf("%w: %w", ErrMemory, err)
			}
			return err
		}
		bufs = append(bufs, b)
		ks = append(ks, b.Bytes())
	}
	return fn(ks)
}

// destroyBuffer destroys b; a failure of memguard's checks (it panics
// after wiping what it can) is not passed on, since the operation's own
// result stands.
func destroyBuffer(b *memguard.LockedBuffer) {
	_ = guarded(func() error {
		b.Destroy()
		return nil
	})
}

// destroyKey makes e unreadable: memguard's Enclaves have no Destroy, so
// its ciphertext is overwritten in place (an Enclave is a pointer to
// core.Enclave, whose only field is the ciphertext's slice; the layout is
// checked first, and a layout that differs is left to the garbage
// collector), and the reference dropped by the caller. Called with the
// store's lock held, so no operation of the store is reading it.
func destroyKey(e *memguard.Enclave) {
	if e == nil || e.Enclave == nil {
		return
	}
	if unsafe.Sizeof(core.Enclave{}) != unsafe.Sizeof([]byte(nil)) {
		return
	}
	ct := (*[]byte)(unsafe.Pointer(e.Enclave))
	if len(*ct)-core.Overhead != core.EnclaveSize(e.Enclave) {
		return
	}
	clear(*ct)
}

// Purge wipes every key memguard holds (the vault's, and its own session
// key), for the end of the process: Enclaves made before it no longer open.
// The core calls it as it shuts down; nothing of the vault works after it
// until a new unlock.
func Purge() {
	purging.Lock()
	defer purging.Unlock()
	_ = guarded(func() error {
		memguard.Purge()
		return nil
	})
}
