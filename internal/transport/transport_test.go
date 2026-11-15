package transport

import (
	"errors"
	"slices"
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

// Every ssh command ends its options with "--" right before the target, so
// ssh parses nothing after it as an option, whatever the target says.
func TestSSHTargetAfterDoubleDash(t *testing.T) {
	o := SSHOptions{Target: "-oProxyCommand=touch /tmp/x", ControlDir: "/tmp/c"}
	for name, args := range map[string][]string{
		"run":  o.runArgs("true"),
		"stop": o.stopArgs(),
		"auth": AuthCommand(o.ControlDir, o.Target)[1:],
	} {
		i := slices.Index(args, o.Target)
		if i < 1 || args[i-1] != "--" || slices.Index(args, "--") != i-1 {
			t.Errorf("%s: %q", name, args)
		}
		for _, a := range args[:i-1] {
			if a == o.Target {
				t.Errorf("%s: target among the options: %q", name, args)
			}
		}
		// The options are all before "--".
		if !slices.Contains(args[:i-1], "ControlPath=/tmp/c/%C") {
			t.Errorf("%s: options after the target: %q", name, args)
		}
	}
	if got := o.runArgs("uname"); got[len(got)-1] != remoteSh("uname") || got[len(got)-2] != o.Target {
		t.Errorf("run: the command follows the target: %q", got)
	}
}
