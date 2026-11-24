package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"

	"veldr/internal/chatproto"
)

// The pinned protocol: design/codex-app-server/summary.json is what the
// adapter relies on of Codex's app-server schema, generated from
// `codex app-server generate-json-schema --experimental --out DIR` by
//
//	CODEX_SCHEMA_DIR=DIR go test ./internal/chatadapter/codex -run TestSchemaSummary -update
//
// (design/codex-app-server/README.md). TestSchemaPinned checks the
// adapter's requests, answers, notifications and item types against it.
const summaryPath = "../../../design/codex-app-server/summary.json"

// summary is the pinned part of the schema.
type summary struct {
	Version string `json:"version"`
	// Requests, ServerRequests and Notifications are the methods' params'
	// members (required ones marked with a trailing "!").
	Requests       map[string][]string `json:"requests"`
	ServerRequests map[string][]string `json:"serverRequests"`
	Notifications  map[string][]string `json:"notifications"`
	// Types are the values of the enumerations, and the members of each
	// variant of the tagged unions, the adapter sends or reads.
	Types map[string]map[string][]string `json:"types"`
}

// The methods and types of the summary.
var (
	summaryRequests = []string{mInitialize, mModelList, mAccountRead, mThreadStart, mThreadResume, mThreadList,
		mThreadTurnsList, mThreadCompactStart, mTurnStart, mTurnSteer, mTurnInterrupt}
	summaryNotifications = []string{"turn/started", "turn/completed", "item/started", "item/completed",
		"item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded",
		"item/commandExecution/outputDelta", "thread/tokenUsage/updated", "account/rateLimits/updated",
		"thread/name/updated", "error", "serverRequest/resolved"}
	summaryTypes = []string{"ThreadItem", "SandboxPolicy", "AskForApproval", "ApprovalsReviewer", "SandboxMode",
		"CommandExecutionApprovalDecision", "FileChangeApprovalDecision", "TurnStatus", "UserInput", "ModeKind",
		"CollaborationMode", "Settings", "McpServerElicitationAction", "PermissionGrantScope", "DynamicToolCallOutputContentItem",
		"PatchChangeKind", "SubAgentActivityKind", "CommandExecutionStatus", "PatchApplyStatus", "TurnItemsView", "SortDirection"}
)

type schemaDoc struct {
	Definitions map[string]json.RawMessage `json:"definitions"`
	OneOf       []json.RawMessage          `json:"oneOf"`
}

type schemaNode struct {
	Ref        string                     `json:"$ref"`
	Enum       []any                      `json:"enum"`
	Properties map[string]json.RawMessage `json:"properties"`
	Required   []string                   `json:"required"`
	OneOf      []json.RawMessage          `json:"oneOf"`
	AnyOf      []json.RawMessage          `json:"anyOf"`
	AllOf      []json.RawMessage          `json:"allOf"`
}

func TestSchemaSummary(t *testing.T) {
	dir := os.Getenv("CODEX_SCHEMA_DIR")
	if dir == "" || !*update {
		t.Skip("CODEX_SCHEMA_DIR and -update regenerate the summary")
	}
	defs := map[string]json.RawMessage{}
	load := func(p string) schemaDoc {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		var d schemaDoc
		if err := json.Unmarshal(b, &d); err != nil {
			t.Fatal(err)
		}
		for k, v := range d.Definitions {
			if _, ok := defs[k]; !ok {
				defs[k] = v
			}
		}
		return d
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	more, _ := filepath.Glob(filepath.Join(dir, "v2", "*.json"))
	for _, f := range append(files, more...) {
		load(f)
	}
	node := func(raw json.RawMessage) schemaNode {
		var n schemaNode
		json.Unmarshal(raw, &n)
		for n.Ref != "" {
			r := defs[filepath.Base(n.Ref)]
			n = schemaNode{}
			json.Unmarshal(r, &n)
		}
		return n
	}
	members := func(n schemaNode) []string {
		var out []string
		for k := range n.Properties {
			if slices.Contains(n.Required, k) {
				k += "!"
			}
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	methods := func(file string, keep []string) map[string][]string {
		out := map[string][]string{}
		for _, raw := range load(filepath.Join(dir, file)).OneOf {
			n := node(raw)
			m := node(n.Properties["method"])
			if len(m.Enum) != 1 {
				continue
			}
			name, _ := m.Enum[0].(string)
			if keep != nil && !slices.Contains(keep, name) {
				continue
			}
			out[name] = members(node(n.Properties["params"]))
		}
		return out
	}
	// variants are an enumeration's values (under "") and the members of
	// a union's variants, by their tag (type) or their one member.
	var variants func(n schemaNode, into map[string][]string)
	variants = func(n schemaNode, into map[string][]string) {
		for _, v := range n.Enum {
			if s, ok := v.(string); ok {
				into[""] = append(into[""], s)
			}
		}
		for _, list := range [][]json.RawMessage{n.OneOf, n.AnyOf, n.AllOf} {
			for _, raw := range list {
				v := node(raw)
				switch tag := node(v.Properties["type"]); {
				case len(tag.Enum) == 1:
					s, _ := tag.Enum[0].(string)
					into[s] = append(into[s], members(v)...)
				case len(v.Properties) == 1 && len(v.Enum) == 0:
					for k := range v.Properties {
						into[k] = members(node(v.Properties[k]))
					}
				default:
					variants(v, into)
				}
			}
		}
		if len(n.Properties) > 0 && len(n.OneOf) == 0 && len(n.AnyOf) == 0 {
			if _, tagged := n.Properties["type"]; !tagged {
				into["{}"] = members(n)
			}
		}
	}
	s := summary{
		Version:        "codex-cli 0.171.0",
		Requests:       methods("ClientRequest.json", summaryRequests),
		ServerRequests: methods("ServerRequest.json", nil),
		Notifications:  methods("ServerNotification.json", summaryNotifications),
		Types:          map[string]map[string][]string{},
	}
	for _, name := range summaryTypes {
		raw, ok := defs[name]
		if !ok {
			t.Errorf("no type %s in the schema", name)
			continue
		}
		m := map[string][]string{}
		variants(node(raw), m)
		for k := range m {
			sort.Strings(m[k])
			m[k] = slices.Compact(m[k])
		}
		s.Types[name] = m
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(summaryPath, append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func loadSummary(t *testing.T) summary {
	t.Helper()
	b, err := os.ReadFile(summaryPath)
	if err != nil {
		t.Fatal(err)
	}
	var s summary
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// has tells whether a member list has name (required or not).
func has(list []string, name string) bool {
	return slices.Contains(list, name) || slices.Contains(list, name+"!")
}

// TestSchemaPinned checks what the adapter sends and reads against the
// pinned schema: a Codex that renamed a method, a member or a value fails
// here once its summary is generated again.
func TestSchemaPinned(t *testing.T) {
	s := loadSummary(t)
	checkParams := func(method string, params map[string]any) {
		t.Helper()
		members, ok := s.Requests[method]
		if !ok {
			t.Errorf("no request %s", method)
			return
		}
		for k := range params {
			if !has(members, k) {
				t.Errorf("%s has no member %s (%v)", method, k, members)
			}
		}
		for _, m := range members {
			if req, ok := requiredName(m); ok {
				if _, sent := params[req]; !sent {
					t.Errorf("%s: the required %s is not sent", method, req)
				}
			}
		}
	}
	for _, mode := range chatproto.Modes {
		p := turnParams("t", "/w", "m", []userInput{{Type: "text", Text: "x", TextElements: []string{}}}, settings{model: "m", effort: "low", mode: mode})
		checkParams(mTurnStart, p)
		approval, sandbox, _ := policy(mode, "/w")
		if !slices.Contains(s.Types["AskForApproval"][""], approval) {
			t.Errorf("approval policy %s", approval)
		}
		variant, ok := s.Types["SandboxPolicy"][sandbox["type"].(string)]
		if !ok {
			t.Errorf("sandbox policy %v", sandbox)
		}
		for k := range sandbox {
			if !has(variant, k) {
				t.Errorf("sandbox policy %s has no %s", sandbox["type"], k)
			}
		}
		cm := p["collaborationMode"].(map[string]any)
		if !slices.Contains(s.Types["ModeKind"][""], cm["mode"].(string)) {
			t.Errorf("collaboration mode %v", cm["mode"])
		}
		for k := range cm["settings"].(map[string]any) {
			if !has(s.Types["Settings"]["{}"], k) {
				t.Errorf("collaboration settings have no %s", k)
			}
		}
	}
	checkParams(mThreadStart, threadParams("", "/w", "m"))
	checkParams(mThreadResume, threadParams("t", "/w", "m"))
	for _, sb := range []string{"read-only"} {
		if !slices.Contains(s.Types["SandboxMode"][""], sb) {
			t.Errorf("sandbox mode %s", sb)
		}
	}
	if !slices.Contains(s.Types["ApprovalsReviewer"][""], "user") {
		t.Error("approvals reviewer user")
	}
	checkParams(mTurnSteer, map[string]any{"threadId": "", "expectedTurnId": "", "clientUserMessageId": "", "input": nil})
	checkParams(mTurnInterrupt, map[string]any{"threadId": "", "turnId": ""})
	checkParams(mThreadCompactStart, map[string]any{"threadId": ""})
	checkParams(mThreadList, map[string]any{"cwd": "", "limit": 0, "cursor": ""})
	checkParams(mThreadList, map[string]any{"includedThreadIds": nil, "limit": 0})
	checkParams(mThreadTurnsList, map[string]any{"threadId": "", "limit": 0, "sortDirection": "", "itemsView": "", "cursor": ""})
	checkParams(mModelList, map[string]any{"limit": 0, "includeHidden": false, "cursor": ""})
	checkParams(mAccountRead, map[string]any{"refreshToken": false})
	checkParams(mInitialize, map[string]any{"clientInfo": nil, "capabilities": nil})
	for _, v := range []string{"asc", "desc"} {
		if !slices.Contains(s.Types["SortDirection"][""], v) {
			t.Errorf("sort direction %s", v)
		}
	}
	if !slices.Contains(s.Types["TurnItemsView"][""], "full") {
		t.Error("items view full")
	}
	for _, d := range []string{"accept", "acceptForSession", "decline", "cancel"} {
		if !slices.Contains(s.Types["CommandExecutionApprovalDecision"][""], d) || !slices.Contains(s.Types["FileChangeApprovalDecision"][""], d) {
			t.Errorf("decision %s", d)
		}
	}
	for _, m := range []string{mCommandApproval, mFileChangeApproval, mRequestUserInput, mMCPElicitation, mPermissionsApproval, mDynamicToolCall, mAuthTokensRefresh, mAttestation} {
		if _, ok := s.ServerRequests[m]; !ok {
			t.Errorf("no server request %s", m)
		}
	}
	if !slices.Contains(s.Types["McpServerElicitationAction"][""], "decline") || !slices.Contains(s.Types["PermissionGrantScope"][""], "turn") {
		t.Error("the refusals' values")
	}
	if _, ok := s.Types["DynamicToolCallOutputContentItem"]["inputText"]; !ok {
		t.Error("dynamic tool output inputText")
	}
	for _, n := range summaryNotifications {
		if _, ok := s.Notifications[n]; !ok {
			t.Errorf("no notification %s", n)
		}
	}
	for _, it := range []string{itemUserMessage, itemAgentMessage, itemPlan, itemReasoning, itemCommand, itemFileChange,
		itemMCPToolCall, itemDynamicTool, itemCollabTool, itemSubAgent, itemWebSearch, itemImageView, itemCompaction} {
		if _, ok := s.Types["ThreadItem"][it]; !ok {
			t.Errorf("no item type %s", it)
		}
	}
	for _, st := range []string{turnCompleted, turnInterrupted, turnFailed, turnInProgress} {
		if !slices.Contains(s.Types["TurnStatus"][""], st) {
			t.Errorf("turn status %s", st)
		}
	}
	for _, k := range []string{subAgentStarted, subAgentCompleted, subAgentStopped} {
		if !slices.Contains(s.Types["SubAgentActivityKind"][""], k) {
			t.Errorf("subagent activity %s", k)
		}
	}
	for _, it := range []string{"text", "image", "mention", "localImage", "skill"} {
		if _, ok := s.Types["UserInput"][it]; !ok {
			t.Errorf("no user input %s", it)
		}
	}
}

func requiredName(m string) (string, bool) {
	if n := len(m); n > 0 && m[n-1] == '!' {
		return m[:n-1], true
	}
	return "", false
}
