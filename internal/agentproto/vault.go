package agentproto

// The variable vault's requests (OpVault): an MCP server on a machine asks
// the core for variables through the agent, which only relays the stream.
// The core decides from the machine the stream came from, never from what
// the request says about itself.

// Vault tools (VaultRequest.Tool).
const (
	// VaultList lists the variables (names, descriptions, flags).
	VaultList = "list"
	// VaultGet returns one variable's value (refused for inject-only ones).
	VaultGet = "get"
	// VaultEnv returns values to put into a command's environment.
	VaultEnv = "env"
)

// VaultRequest is what an MCP server asks for.
type VaultRequest struct {
	Tool  string   `json:"tool"`
	Names []string `json:"names,omitempty"`
	// Client is the program that started the MCP server (claude, codex…),
	// Terminal the terminal it runs in (HC_TERMINAL_ID), Cwd its directory:
	// shown to the user who approves, not trusted.
	Client   string `json:"client,omitempty"`
	Terminal string `json:"terminal,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
}

// VaultVariable is a variable as list shows it.
type VaultVariable struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	InjectOnly  bool   `json:"inject_only,omitempty"`
	// Approval: reading it from this machine asks the user first.
	Approval bool `json:"approval,omitempty"`
}

// VaultResponse answers a VaultRequest. Code is one of vault_locked,
// not_found, inject_only, denied, plugin_disabled, unavailable,
// bad_request.
type VaultResponse struct {
	OK        bool              `json:"ok"`
	Code      string            `json:"code,omitempty"`
	Error     string            `json:"error,omitempty"`
	Variables []VaultVariable   `json:"variables,omitempty"`
	Values    map[string]string `json:"values,omitempty"`
}
