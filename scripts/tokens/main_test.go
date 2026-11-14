package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sample = `{
  "color": {
    "background": { "light": "#ffffff", "dark": "#0a0a0a" },
    "borderStrong": { "light": "#d4d4d4", "dark": { "hex": "#ffffff", "alpha": 0.14 } }
  },
  "status": { "working": { "light": "#eab308", "dark": "#eab308" } },
  "terminal": {
    "light": { "background": "#ffffff", "foreground": "#0a0a0a", "cursor": "#0a0a0a", "selection": "#b6d4fe", "palette": [
      "#000001", "#000002", "#000003", "#000004", "#000005", "#000006", "#000007", "#000008",
      "#000009", "#00000a", "#00000b", "#00000c", "#00000d", "#00000e", "#00000f", "#000010"] },
    "dark": { "background": "#0a0a0a", "foreground": "#f0f0f0", "cursor": "#f0f0f0", "selection": "#3b4a6b", "palette": [
      "#100001", "#100002", "#100003", "#100004", "#100005", "#100006", "#100007", "#100008",
      "#100009", "#10000a", "#10000b", "#10000c", "#10000d", "#10000e", "#10000f", "#100010"] }
  },
  "metric": { "rowHeight": 26, "radius": 6 },
  "font": { "size": { "base": 12.5 } }
}`

func TestParse(t *testing.T) {
	tok, err := parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if c := tok.Color["background"]; c.Light != (Color{0xffffff, 1}) || c.Dark != (Color{0x0a0a0a, 1}) {
		t.Errorf("background = %+v", c)
	}
	if c := tok.Color["borderStrong"].Dark; c != (Color{0xffffff, 0.14}) {
		t.Errorf("borderStrong dark = %+v", c)
	}
	if tok.Metric["rowHeight"] != 26 || tok.Font.Size["base"] != 12.5 {
		t.Errorf("metric %v, font sizes %v", tok.Metric, tok.Font.Size)
	}
	if got := tok.Terminal.Dark.Palette[15].hex(); got != "#100010" {
		t.Errorf("dark palette ends with %s", got)
	}
}

func TestGenerate(t *testing.T) {
	files, err := generate([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		again, err := generate([]byte(sample))
		if err != nil {
			t.Fatal(err)
		}
		for name := range files {
			if !bytes.Equal(files[name], again[name]) {
				t.Fatalf("%s differs between runs", name)
			}
		}
	}
	for name, want := range map[string][]string{
		swiftOut: {
			"// " + header + "\n",
			"enum Tokens {",
			"static let colorBackground = Color(light: 0xffffff, dark: 0x0a0a0a, lightAlpha: 1, darkAlpha: 1)",
			"static let colorBorderStrong = Color(light: 0xd4d4d4, dark: 0xffffff, lightAlpha: 1, darkAlpha: 0.14)",
			"static let statusWorking = Color(",
			`background: "#0a0a0a", foreground: "#f0f0f0", cursor: "#f0f0f0", selection: "#3b4a6b",`,
			"static let metricRowHeight: CGFloat = 26\n",
			"static let fontSizeBase: CGFloat = 12.5\n",
		},
		cssOut: {
			"/* " + header + " */\n:root {\n",
			"  --ds-color-background: #0a0a0a;\n",
			"  --ds-color-border-strong: rgba(255, 255, 255, 0.14);\n",
			"  --ds-status-working: #eab308;\n",
			"  --ds-terminal-ansi-15: #100010;\n",
			"  --ds-metric-row-height: 26px;\n",
			"  --ds-font-size-base: 12.5px;\n",
			":root[data-theme='light'] {\n  --ds-color-background: #ffffff;\n  --ds-color-border-strong: #d4d4d4;\n",
		},
	} {
		for _, s := range want {
			if !strings.Contains(string(files[name]), s) {
				t.Errorf("%s lacks %q:\n%s", name, s, files[name])
			}
		}
	}
	// Lengths are written once: the light theme changes only colors.
	if n := strings.Count(string(files[cssOut]), "--ds-metric-radius"); n != 1 {
		t.Errorf("--ds-metric-radius written %d times", n)
	}
}

func TestRejects(t *testing.T) {
	for name, edit := range map[string][2]string{
		"short color":        {`"#ffffff", "dark": "#0a0a0a" }`, `"#fff", "dark": "#0a0a0a" }`},
		"upper case color":   {`"#eab308", "dark"`, `"#EAB308", "dark"`},
		"not a color":        {`"#eab308", "dark"`, `"yellow", "dark"`},
		"alpha out of range": {`"alpha": 0.14`, `"alpha": 1.4`},
		"missing alpha":      {`, "alpha": 0.14`, ``},
		"missing theme":      {`{ "light": "#eab308", "dark": "#eab308" }`, `{ "light": "#eab308" }`},
		"unknown field":      {`"metric":`, `"shadow": {}, "metric":`},
		"short palette":      {`"#00000f", "#000010"]`, `"#00000f"]`},
		"token name":         {`"rowHeight"`, `"row-height"`},
		"negative metric":    {`"radius": 6`, `"radius": -6`},
		"no terminal":        {`"light": { "background": "#ffffff", "foreground"`, `"other": { "background": "#ffffff", "foreground"`},
	} {
		data := strings.Replace(sample, edit[0], edit[1], 1)
		if data == sample {
			t.Fatalf("%s: the sample has no %q", name, edit[0])
		}
		if _, err := generate([]byte(data)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestCheck(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{source, swiftOut, cssOut} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, source), []byte(sample), 0o644); err != nil {
		t.Fatal(err)
	}
	// Nothing generated yet: stale, and the check writes nothing.
	if err := run(root, true); err == nil || !strings.Contains(err.Error(), swiftOut) || !strings.Contains(err.Error(), cssOut) {
		t.Fatalf("check without generated files: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, cssOut)); !os.IsNotExist(err) {
		t.Fatalf("check wrote %s: %v", cssOut, err)
	}
	if err := run(root, false); err != nil {
		t.Fatal(err)
	}
	if err := run(root, true); err != nil {
		t.Fatalf("check after generating: %v", err)
	}
	// An edited generated file is stale, and so is one behind the tokens.
	css := filepath.Join(root, cssOut)
	fresh, err := os.ReadFile(css)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(css, append(fresh, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run(root, true); err == nil || !strings.Contains(err.Error(), cssOut) || strings.Contains(err.Error(), swiftOut) {
		t.Fatalf("check with an edited file: %v", err)
	}
	if got, _ := os.ReadFile(css); !bytes.Equal(got, append(fresh, '\n')) {
		t.Fatal("check rewrote the edited file")
	}
	if err := run(root, false); err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(sample, `"radius": 6`, `"radius": 8`, 1)
	if err := os.WriteFile(filepath.Join(root, source), []byte(changed), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run(root, true); err == nil {
		t.Fatal("check passed after the tokens changed")
	}
}

// The repository's tokens parse and its generated files are current.
func TestRepository(t *testing.T) {
	if err := run(filepath.Join("..", ".."), true); err != nil {
		t.Fatal(err)
	}
}
