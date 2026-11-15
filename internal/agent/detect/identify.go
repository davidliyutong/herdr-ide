package detect

import (
	"path/filepath"
	"strings"
)

// agentNames maps executable names (lowercase, without .exe, .cmd, .js and
// similar) to the agent they run, as herdr names them.
var agentNames = map[string]string{
	"pi": "pi", "claude": "claude", "claude-code": "claude", "codex": "codex", "gemini": "gemini",
	"cursor": "cursor", "cursor-agent": "cursor", "devin": "devin", "devin-cli": "devin",
	"agy": "agy", "antigravity": "agy", "antigravity-cli": "agy", "cline": "cline", ".cline": "cline",
	"omp": "omp", "mastracode": "mastracode", "mastra-code": "mastracode",
	"opencode": "opencode", "opencode2": "opencode", "open-code": "opencode",
	"copilot": "copilot", "github-copilot": "copilot", "ghcs": "copilot",
	"kimi": "kimi", "kimi-code": "kimi", "kiro": "kiro", "kiro-cli": "kiro", "droid": "droid",
	"amp": "amp", "amp-local": "amp", "grok": "grok", "grok-build": "grok", "hermes": "hermes",
	"hermes-agent": "hermes", "kilo": "kilo", "kilo-code": "kilo",
	"qodercli": "qodercli", "qoderclicn": "qodercli", "qoder": "qodercli", "qodercn": "qodercli",
	"qwen": "qwen", "qwen-code": "qwen", "letta": "letta", "letta-code": "letta", "maki": "maki",
	"muse": "muse", "muse-code": "muse", "muse-cli": "muse",
}

// knownPackagePaths are the entry points of agents installed as Node
// packages and run by node or bun, by their last path components.
var knownPackagePaths = []struct {
	suffix []string
	agent  string
}{
	{[]string{"node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli"}, "pi"},
	{[]string{"node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli"}, "pi"},
	{[]string{"node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli"}, "omp"},
	{[]string{"node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs"}, "kimi"},
	{[]string{"node_modules", "@qwen-code", "qwen-code", "dist", "index"}, "qwen"},
	{[]string{"node_modules", "mastracode", "dist", "cli"}, "mastracode"},
	{[]string{"node_modules", "@letta-ai", "letta-code", "letta"}, "letta"},
	{[]string{"node_modules", "@anthropic-ai", "claude-code", "cli"}, "claude"},
	{[]string{"node_modules", "@openai", "codex", "bin", "codex"}, "codex"},
	{[]string{"node_modules", "@google", "gemini-cli", "dist", "index"}, "gemini"},
}

// normalize is a name as herdr looks it up: the last path component,
// lowercase, without a Windows or script extension.
func normalize(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.TrimRight(name, "/\\")
	if i := strings.LastIndexAny(name, "/\\"); i >= 0 {
		name = name[i+1:]
	}
	for _, ext := range []string{".exe", ".cmd", ".bat", ".ps1", ".js"} {
		if strings.HasSuffix(name, ext) {
			return strings.TrimSuffix(name, ext)
		}
	}
	return name
}

func lookup(name string) string {
	n := normalize(name)
	if a := agentNames[n]; a != "" {
		return a
	}
	// Muse's launcher execs muse-bin-<version>.
	if rest, ok := strings.CutPrefix(n, "muse-bin-"); ok && rest != "" && rest[0] >= '0' && rest[0] <= '9' {
		return "muse"
	}
	return ""
}

func isPython(n string) bool {
	if n == "python" {
		return true
	}
	v, ok := strings.CutPrefix(n, "python")
	if !ok || v == "" {
		return false
	}
	for _, part := range strings.Split(v, ".") {
		if part == "" || strings.Trim(part, "0123456789") != "" {
			return false
		}
	}
	return true
}

// runtime reports whether n is a shell or a script runtime, whose own name
// says nothing about the agent it may run.
func runtime(n string) bool {
	switch n {
	case "sh", "bash", "zsh", "fish", "dash", "tmux", "node", "bun":
		return true
	}
	return isPython(n)
}

// Identify returns the agent a terminal's foreground program is (by its
// process name and argv, as herdr-core reports them), "" for anything
// else. A runtime or shell running a script counts as that script's agent,
// unless it runs code given inline (-c, -e, -m).
func Identify(name string, argv []string) string {
	effective := name
	if len(argv) > 0 && argv[0] != "" {
		// argv[0] carries the name an agent gave itself (node rewrites its
		// title, nix wrappers keep the original name there).
		if a := lookup(argv[0]); a != "" {
			return a
		}
	}
	if a := lookup(effective); a != "" {
		return a
	}
	run := normalize(effective)
	if len(argv) > 0 && runtime(normalize(argv[0])) {
		run = normalize(argv[0])
	}
	if runtime(run) {
		return scriptAgent(run, argv)
	}
	return ""
}

// scriptAgent is the agent of the script a runtime runs: its first
// argument that is not an option, unless code is given inline.
func scriptAgent(run string, argv []string) string {
	var inline []string
	switch {
	case run == "node" || run == "bun":
		inline = []string{"-e", "--eval", "-p", "--print"}
	case isPython(run):
		inline = []string{"-c", "-m"}
	case run == "tmux":
		return ""
	default:
		inline = []string{"-c"}
	}
	for i := 1; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--" {
			if i+1 < len(argv) {
				return pathAgent(argv[i+1])
			}
			return ""
		}
		for _, f := range inline {
			if arg == f || (strings.HasPrefix(f, "--") && strings.HasPrefix(arg, f+"=")) || (!strings.HasPrefix(f, "--") && strings.HasPrefix(arg, f)) {
				return ""
			}
		}
		if strings.HasPrefix(arg, "-") {
			switch arg {
			case "-r", "--require", "--loader", "--import", "--experimental-loader", "--inspect-port", "-W", "-X", "-S", "-L", "-o":
				i++
			}
			continue
		}
		return pathAgent(arg)
	}
	return ""
}

// pathAgent is the agent a script path names: by its file name, or by the
// entry point of a known package.
func pathAgent(p string) string {
	p = strings.Trim(p, `"'`)
	if p == "" || strings.HasPrefix(p, "-") {
		return ""
	}
	if a := lookup(p); a != "" {
		return a
	}
	parts := strings.FieldsFunc(filepath.ToSlash(p), func(r rune) bool { return r == '/' || r == '\\' })
	for i := range parts {
		parts[i] = strings.ToLower(parts[i])
	}
	for _, k := range knownPackagePaths {
		if len(parts) < len(k.suffix) {
			continue
		}
		tail := parts[len(parts)-len(k.suffix):]
		match := true
		for i, want := range k.suffix {
			got := tail[i]
			if i == len(k.suffix)-1 {
				got = strings.TrimSuffix(strings.TrimSuffix(got, ".js"), ".mjs")
				want = strings.TrimSuffix(want, ".mjs")
			}
			if got != want {
				match = false
				break
			}
		}
		if match {
			return k.agent
		}
	}
	return ""
}
