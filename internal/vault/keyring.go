package vault

import (
	"errors"

	"github.com/zalando/go-keyring"

	"herdr-ide/internal/brand"
)

// OSKeyStore is where vaults of earlier versions kept the master key, the
// operating system's keychain: macOS's Keychain, Windows's Credential
// Manager, the Secret Service on Linux, under the service brand.Slug +
// "-vault". It is read to convert such a vault to a passphrase and emptied
// then. Tests use a map instead and never reach it.
type OSKeyStore struct{}

// KeychainService is the keychain item's service.
const KeychainService = brand.Slug + "-vault"

func (OSKeyStore) Get(account string) (string, error) {
	s, err := keyring.Get(KeychainService, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrKeyMissing
	}
	return s, err
}

func (OSKeyStore) Set(account, secret string) error {
	return keyring.Set(KeychainService, account, secret)
}

func (OSKeyStore) Delete(account string) error {
	err := keyring.Delete(KeychainService, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// MemKeyStore keeps keys in memory (tests). Fail makes every call fail as
// an unavailable keychain does.
type MemKeyStore struct {
	Keys map[string]string
	Fail bool
}

func (m *MemKeyStore) Get(account string) (string, error) {
	if m.Fail {
		return "", errors.New("no keychain")
	}
	s, ok := m.Keys[account]
	if !ok {
		return "", ErrKeyMissing
	}
	return s, nil
}

func (m *MemKeyStore) Delete(account string) error {
	if m.Fail {
		return errors.New("no keychain")
	}
	delete(m.Keys, account)
	return nil
}

func (m *MemKeyStore) Set(account, secret string) error {
	if m.Fail {
		return errors.New("no keychain")
	}
	if m.Keys == nil {
		m.Keys = map[string]string{}
	}
	m.Keys[account] = secret
	return nil
}
