package usage

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"
	"strings"
	"unicode"
)

// DeepSeekKeyFile is the key file the UI writes on a machine, below the
// agent's data directory.
const DeepSeekKeyFile = "usage/deepseek.key"

// deepseekKey finds a DeepSeek API key: DEEPSEEK_API_KEY of the agent's
// environment, Claude Code's settings when their base URL is DeepSeek's, or
// the key file.
func deepseekKey(e *Env) string {
	if k := strings.TrimSpace(e.getenv("DEEPSEEK_API_KEY")); k != "" {
		return k
	}
	if b, err := readFile(path.Join(claudeDir(e), "settings.json")); err == nil {
		var s struct {
			Env map[string]string `json:"env"`
		}
		if json.Unmarshal(b, &s) == nil && strings.Contains(strings.ToLower(s.Env["ANTHROPIC_BASE_URL"]), "deepseek") {
			if k := strings.TrimSpace(s.Env["ANTHROPIC_AUTH_TOKEN"]); k != "" {
				return k
			}
		}
	}
	if e.Base != "" {
		if b, err := readFile(path.Join(e.Base, DeepSeekKeyFile)); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

// deepseekAccounts reads the DeepSeek balance: GET /user/balance.
func deepseekAccounts(ctx context.Context, e *Env, o *Options) []Account {
	key := deepseekKey(e)
	if key == "" {
		return []Account{{Provider: DeepSeek, Status: StatusMissing}}
	}
	a := Account{Provider: DeepSeek, ID: HashID(key), Source: "api"}
	if o.skips(DeepSeek, a.ID) {
		return []Account{skipped(a)}
	}
	m, err := getMap(ctx, e.Client, "GET", e.URLs.DeepSeekBalance, map[string]string{"Authorization": "Bearer " + key}, nil)
	if err != nil {
		return []Account{failed(a, err)}
	}
	parseDeepseekBalance(&a, m)
	a.Status, a.AsOf = StatusOK, e.now().Unix()
	return []Account{a}
}

func parseDeepseekBalance(a *Account, m map[string]any) {
	if v, ok := m["is_available"].(bool); ok {
		a.Available = boolPtr(v)
	}
	for _, x := range arr(m["balance_infos"]) {
		x := obj(x)
		total, ok := num(x["total_balance"])
		if !ok {
			continue
		}
		g, _ := num(x["granted_balance"])
		t, _ := num(x["topped_up_balance"])
		a.Balances = append(a.Balances, Balance{Currency: str(x["currency"]), Total: total, Granted: g, ToppedUp: t})
	}
}

// ErrBadKey: a key that cannot be an API key.
var ErrBadKey = errors.New("bad key")

// SetDeepSeekKey writes the key file below base (0600, its directory
// 0700); an empty key removes it.
func SetDeepSeekKey(base, key string) error {
	key = strings.TrimSpace(key)
	p := path.Join(base, DeepSeekKeyFile)
	if key == "" {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if len(key) > 256 {
		return ErrBadKey
	}
	for _, r := range key {
		if r > unicode.MaxASCII || !unicode.IsPrint(r) || unicode.IsSpace(r) {
			return ErrBadKey
		}
	}
	dir := path.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".deepseek-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(key + "\n"); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

// HasDeepSeekKeyFile reports whether the key file exists.
func HasDeepSeekKeyFile(base string) bool {
	_, err := os.Stat(path.Join(base, DeepSeekKeyFile))
	return err == nil
}
