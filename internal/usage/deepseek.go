package usage

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path"
	"strings"
	"unicode"
)

// DeepSeekKeyFile is the key file the UI writes on a machine, below the
// agent's data directory.
const DeepSeekKeyFile = "usage/deepseek.key"

// deepseekKey finds a DeepSeek API key: the key file the panel writes
// (the user's choice, so it wins), DEEPSEEK_API_KEY of the agent's
// environment, or Claude Code's settings when their base URL is DeepSeek's.
func deepseekKey(e *Env) string {
	if e.Base != "" {
		if b, err := readFile(path.Join(e.Base, DeepSeekKeyFile)); err == nil {
			if k := strings.TrimSpace(string(b)); k != "" {
				return k
			}
		}
	}
	if k := strings.TrimSpace(e.getenv("DEEPSEEK_API_KEY")); k != "" {
		return k
	}
	if b, err := readFile(path.Join(claudeDir(e), "settings.json")); err == nil {
		var s struct {
			Env map[string]string `json:"env"`
		}
		if json.Unmarshal(b, &s) == nil && isDeepSeekURL(s.Env["ANTHROPIC_BASE_URL"]) {
			if k := strings.TrimSpace(s.Env["ANTHROPIC_AUTH_TOKEN"]); k != "" {
				return k
			}
		}
	}
	return ""
}

// isDeepSeekURL tells whether Claude Code's base URL is DeepSeek's own
// (https on api.deepseek.com or below deepseek.com): only then is its token
// a DeepSeek key, not one of a gateway that merely has deepseek in its name.
func isDeepSeekURL(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	h := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	return h == "api.deepseek.com" || strings.HasSuffix(h, ".deepseek.com")
}

// deepseekAccounts reads the DeepSeek balance: GET /user/balance.
func deepseekAccounts(ctx context.Context, e *Env, o *Options) []Account {
	key := deepseekKey(e)
	if key == "" {
		return []Account{{Provider: DeepSeek, Status: StatusMissing}}
	}
	a := Account{Provider: DeepSeek, ID: HashID(key), Source: "api"}
	if o.skips(DeepSeek, a.ID, "") {
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
