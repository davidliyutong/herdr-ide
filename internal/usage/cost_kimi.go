package usage

import (
	"bytes"
	"encoding/json"
	"io"
	"path"
	"strings"
)

// Kimi Code CLI writes append-only JSONL wire logs per session and agent:
// ~/.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl
// (both main and sub-agents: each records its own usage.record events,
// covering both turn and session-scoped compaction calls). The session's
// state.json holds cwd (v2) or workDir (v1) for the project name.

// kimiStateMax bounds state.json read for a session's working directory.
const kimiStateMax = 64 << 10

// parseKimiLog reads usage.record lines from a Kimi Code wire.jsonl file.
func parseKimiLog(file string, r io.Reader, final bool, ent *fileEntry) (int64, error) {
	proj := ""
	if len(ent.Records) > 0 {
		proj = ent.Records[0].J
	}
	if proj == "" {
		proj = kimiProject(file)
	}
	return eachLine(r, final, func(line []byte) {
		parseKimiLine(proj, line, ent)
	})
}

func parseKimiLine(proj string, line []byte, ent *fileEntry) {
	if !bytes.Contains(line, []byte(`"usage.record"`)) {
		return
	}
	var d struct {
		Type  string `json:"type"`
		Model string `json:"model"`
		Time  any    `json:"time"`
		Usage struct {
			InputOther         int64 `json:"inputOther"`
			InputCacheRead     int64 `json:"inputCacheRead"`
			InputCacheCreation int64 `json:"inputCacheCreation"`
			Output             int64 `json:"output"`
		} `json:"usage"`
	}
	if json.Unmarshal(line, &d) != nil || d.Type != "usage.record" {
		return
	}
	t := timeOf(d.Time)
	if t == 0 {
		return
	}
	in := max(d.Usage.InputOther, 0)
	cr := max(d.Usage.InputCacheRead, 0)
	cw := max(d.Usage.InputCacheCreation, 0)
	out := max(d.Usage.Output, 0)
	if in+cr+cw+out == 0 {
		return
	}
	ent.Records = append(ent.Records, Record{
		T: t,
		M: kimiModelName(d.Model),
		J: proj,
		I: in,
		C: cr,
		W: cw,
		O: out,
		N: 1,
	})
}

// kimiModelName normalizes Kimi Code's logged model identifiers to canonical
// names matching pricing.json: "kimi-code/k3.1-pro" -> "kimi-k3.1-pro",
// "kimi-code/k3" -> "kimi-k3", "kimi-code/kimi-for-coding" -> "kimi-for-coding".
func kimiModelName(m string) string {
	m = strings.TrimSpace(m)
	if m == "" {
		return "unknown"
	}
	if rest, ok := strings.CutPrefix(m, "kimi-code/"); ok {
		m = rest
	} else if rest, ok := strings.CutPrefix(m, "moonshot/"); ok {
		m = rest
	}
	if len(m) >= 2 && m[0] == 'k' && m[1] >= '0' && m[1] <= '9' {
		m = "kimi-" + m
	}
	return m
}

// kimiProject resolves a wire.jsonl file's project name from its session's
// state.json (cwd or workDir), falling back to the workspace directory
// name (wd_<name>_<12hex>).
func kimiProject(file string) string {
	dir := path.Dir(file)
	if path.Base(path.Dir(dir)) == "agents" {
		dir = path.Dir(path.Dir(dir))
	}
	if p := kimiStateProject(path.Join(dir, "state.json")); p != "" {
		return p
	}
	ws := path.Base(path.Dir(dir))
	if rest, ok := strings.CutPrefix(ws, "wd_"); ok {
		if i := strings.LastIndexByte(rest, '_'); i > 0 && isHex12(rest[i+1:]) {
			return rest[:i]
		}
		if rest != "" {
			return rest
		}
	}
	return ""
}

func kimiStateProject(p string) string {
	f, err := openRegular(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, kimiStateMax))
	if err != nil {
		return ""
	}
	var st struct {
		CWD     string `json:"cwd"`
		WorkDir string `json:"workDir"`
	}
	if json.Unmarshal(b, &st) != nil {
		return ""
	}
	return projectName(firstNonEmpty(st.CWD, st.WorkDir))
}

func isHex12(s string) bool {
	if len(s) != 12 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}
