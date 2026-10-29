package brand

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func readRepo(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func tsConst(t *testing.T, src, name string) string {
	t.Helper()
	m := regexp.MustCompile(`export const ` + name + ` = '([^']*)'`).FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("const %s not found", name)
	}
	return m[1]
}

// The web UI and the VS Code extension cannot import Go constants; make sure
// their copies agree.
func TestBrandMirrorsAgree(t *testing.T) {
	if EnvPrefix != strings.ToUpper(strings.ReplaceAll(Slug, "-", "_"))+"_" {
		t.Errorf("EnvPrefix %q does not match Slug %q", EnvPrefix, Slug)
	}
	web := readRepo(t, "web/src/brand.ts")
	if tsConst(t, web, "APP_NAME") != Name || tsConst(t, web, "APP_SLUG") != Slug {
		t.Errorf("web/src/brand.ts disagrees with internal/brand")
	}
	extDir := filepath.Join("extensions", BridgeExt)
	ext := readRepo(t, filepath.Join(extDir, "src", "brand.ts"))
	if tsConst(t, ext, "DATA_DIR") != DataDirName || tsConst(t, ext, "ENV_PREFIX") != EnvPrefix || tsConst(t, ext, "SLUG") != Slug {
		t.Errorf("%s/src/brand.ts disagrees with internal/brand", extDir)
	}
	var pkg struct {
		Name      string `json:"name"`
		Publisher string `json:"publisher"`
	}
	if err := json.Unmarshal([]byte(readRepo(t, filepath.Join(extDir, "package.json"))), &pkg); err != nil {
		t.Fatal(err)
	}
	if pkg.Name != BridgeExt || pkg.Publisher != Slug {
		t.Errorf("extension package.json name/publisher = %s/%s", pkg.Name, pkg.Publisher)
	}
}
