package transport

import (
	"errors"
	"testing"
)

func TestClassifySSHError(t *testing.T) {
	auth := []string{
		"user@host: Permission denied (publickey,password).",
		"Host key verification failed.",
		"The authenticity of host 'x' can't be established.",
	}
	for _, s := range auth {
		if err := classifySSHError(s, nil); !errors.Is(err, ErrAuthRequired) {
			t.Errorf("%q not classified as auth: %v", s, err)
		}
	}
	if err := classifySSHError("ssh: connect to host x port 22: Connection refused", nil); errors.Is(err, ErrAuthRequired) {
		t.Errorf("connection refused classified as auth")
	}
}

func TestNormArch(t *testing.T) {
	for in, want := range map[string]string{"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64", "amd64\n": "amd64"} {
		if got := normArch(in); got != want {
			t.Errorf("normArch(%q) = %q want %q", in, got, want)
		}
	}
}

func TestShQuote(t *testing.T) {
	if got := shQuote(`it's`); got != `'it'"'"'s'` {
		t.Fatalf("shQuote = %s", got)
	}
}
