package sshconfig

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// write puts files under home, creating directories.
func write(t *testing.T, home string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(home, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadAliases(t *testing.T) {
	home := t.TempDir()
	write(t, home, map[string]string{
		".ssh/config": `# Comments, keywords in any case, = and quotes.
Include conf.d/*.conf ~/.ssh/extra "` + filepath.ToSlash(filepath.Join(home, "abs.conf")) + `"
Include missing.conf

HOST gpu gpu-b *.corp !bastion web?
  hostname 10.0.0.5
  USER yutong
  IdentityFile ~/.ssh/id_secret
  ProxyCommand ssh -W %h:%p jump
Host=gpu
  HostName other.example
  User other

Match host gpu exec "true"
  User matched
Host nus-ws-1   # the lab's
  HostName=%h.lab.example
  User "li yu"
Host *
  User everyone
	Host	tabbed
	  User	tab
`,
		".ssh/conf.d/a.conf": "Host from-a\n  HostName a.example\n",
		".ssh/conf.d/b.conf": "Host from-b GPU\n  User b\n",
		".ssh/conf.d/c.txt":  "Host not-included\n",
		".ssh/extra":         "Host extra\n",
		"abs.conf":           "Host absolute\n",
	})
	got := Read(home)
	want := []Host{
		{Alias: "from-a", HostName: "a.example"},
		// GPU is the config's gpu, spelled as it was first named; its User
		// comes from here, the first one given to it, its HostName from the
		// config's first Host block.
		{Alias: "from-b", User: "b"},
		{Alias: "GPU", User: "b", HostName: "10.0.0.5"},
		{Alias: "extra"},
		{Alias: "absolute"},
		{Alias: "gpu-b", HostName: "10.0.0.5", User: "yutong"},
		{Alias: "nus-ws-1", HostName: "nus-ws-1.lab.example"},
		{Alias: "tabbed", User: "tab"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Read =\n%+v\nwant\n%+v", got, want)
	}
	// A user name with a space is not one this reader passes on; key paths
	// and proxy commands are never read.
	for _, h := range got {
		for _, v := range []string{h.Alias, h.HostName, h.User} {
			if strings.Contains(v, "id_secret") || strings.Contains(v, "ssh -W") || strings.Contains(v, " ") {
				t.Errorf("leaked %q", v)
			}
		}
	}
}

func TestReadMissingAndBounded(t *testing.T) {
	if got := Read(t.TempDir()); got != nil {
		t.Errorf("no config: %v", got)
	}
	home := t.TempDir()
	// An Include of itself, a file too large, a directory.
	write(t, home, map[string]string{
		".ssh/config": "Include config big dir\nHost ok\n",
		".ssh/big":    "Host big\n" + strings.Repeat("# padding\n", MaxFileSize/10+1),
	})
	os.MkdirAll(filepath.Join(home, ".ssh", "dir"), 0o700)
	if got := Read(home); !reflect.DeepEqual(got, []Host{{Alias: "ok"}}) {
		t.Errorf("Read = %+v", got)
	}
	// Includes nest at most MaxDepth deep.
	files := map[string]string{".ssh/config": "Include n1\nHost top\n"}
	for i := 1; i <= MaxDepth+3; i++ {
		files[".ssh/n"+strconv.Itoa(i)] = "Include n" + strconv.Itoa(i+1) + "\nHost h" + strconv.Itoa(i) + "\n"
	}
	home = t.TempDir()
	write(t, home, files)
	got := Read(home)
	if len(got) != MaxDepth+1 || got[len(got)-1].Alias != "top" {
		t.Errorf("nested includes: %+v", got)
	}
}

func TestParseLine(t *testing.T) {
	for _, c := range []struct {
		line, keyword string
		args          []string
	}{
		{"  # comment", "", nil},
		{"", "", nil},
		{"Host a b\tc", "host", []string{"a", "b", "c"}},
		{"HostName=x.example", "hostname", []string{"x.example"}},
		{"User = me", "user", []string{"me"}},
		{`Include "a b" c\ d`, "include", []string{"a b", "c d"}},
		{"Host a # trailing", "host", []string{"a"}},
		{"Host a#b", "host", []string{"a#b"}},
		{"Compression", "compression", nil},
	} {
		k, a := parseLine(c.line)
		if k != c.keyword || !reflect.DeepEqual(a, c.args) {
			t.Errorf("parseLine(%q) = %q %q", c.line, k, a)
		}
	}
}
