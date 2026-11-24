package codex

import "encoding/json"

// The members of Codex's app-server protocol (v2, with experimentalApi)
// the adapter reads, as codex-cli 0.171.0 sends them
// (spec/codex-app-server/README.md). What is not read is not declared.

// The methods the adapter calls.
const (
	mInitialize          = "initialize"
	mInitialized         = "initialized"
	mModelList           = "model/list"
	mAccountRead         = "account/read"
	mThreadStart         = "thread/start"
	mThreadResume        = "thread/resume"
	mThreadList          = "thread/list"
	mThreadTurnsList     = "thread/turns/list"
	mThreadCompactStart  = "thread/compact/start"
	mTurnStart           = "turn/start"
	mTurnSteer           = "turn/steer"
	mTurnInterrupt       = "turn/interrupt"
	mCommandApproval     = "item/commandExecution/requestApproval"
	mFileChangeApproval  = "item/fileChange/requestApproval"
	mRequestUserInput    = "item/tool/requestUserInput"
	mMCPElicitation      = "mcpServer/elicitation/request"
	mPermissionsApproval = "item/permissions/requestApproval"
	mDynamicToolCall     = "item/tool/call"
	mAuthTokensRefresh   = "account/chatgptAuthTokens/refresh"
	mAttestation         = "attestation/generate"
)

type initializeResult struct {
	UserAgent string `json:"userAgent"`
}

type effortOption struct {
	ReasoningEffort string `json:"reasoningEffort"`
	Description     string `json:"description"`
}

type modelInfo struct {
	ID                        string         `json:"id"`
	Model                     string         `json:"model"`
	DisplayName               string         `json:"displayName"`
	Description               string         `json:"description"`
	Hidden                    bool           `json:"hidden"`
	SupportedReasoningEfforts []effortOption `json:"supportedReasoningEfforts"`
	DefaultReasoningEffort    string         `json:"defaultReasoningEffort"`
	InputModalities           []string       `json:"inputModalities"`
	IsDefault                 bool           `json:"isDefault"`
}

// slug is the model's name for turn/start.
func (m *modelInfo) slug() string {
	if m.Model != "" {
		return m.Model
	}
	return m.ID
}

type modelListResult struct {
	Data       []modelInfo `json:"data"`
	NextCursor *string     `json:"nextCursor"`
}

type accountReadResult struct {
	Account            json.RawMessage `json:"account"`
	RequiresOpenaiAuth bool            `json:"requiresOpenaiAuth"`
}

type threadInfo struct {
	ID             string  `json:"id"`
	Preview        string  `json:"preview"`
	Name           *string `json:"name"`
	Cwd            string  `json:"cwd"`
	CreatedAt      int64   `json:"createdAt"`
	UpdatedAt      int64   `json:"updatedAt"`
	ParentThreadID *string `json:"parentThreadId"`
	Ephemeral      bool    `json:"ephemeral"`
}

// threadResult is what thread/start and thread/resume answer.
type threadResult struct {
	Thread          threadInfo `json:"thread"`
	Model           string     `json:"model"`
	ReasoningEffort *string    `json:"reasoningEffort"`
}

type threadListResult struct {
	Data       []threadInfo `json:"data"`
	NextCursor *string      `json:"nextCursor"`
}

type turnError struct {
	Message        string          `json:"message"`
	CodexErrorInfo json.RawMessage `json:"codexErrorInfo"`
}

type turnInfo struct {
	ID          string            `json:"id"`
	Items       []json.RawMessage `json:"items"`
	Status      string            `json:"status"`
	Error       *turnError        `json:"error"`
	StartedAt   *int64            `json:"startedAt"`
	CompletedAt *int64            `json:"completedAt"`
}

// The statuses of a turn.
const (
	turnCompleted   = "completed"
	turnInterrupted = "interrupted"
	turnFailed      = "failed"
	turnInProgress  = "inProgress"
)

type turnResult struct {
	Turn turnInfo `json:"turn"`
}

type turnsListResult struct {
	Data       []turnInfo `json:"data"`
	NextCursor *string    `json:"nextCursor"`
}

// turnNotification is turn/started's and turn/completed's.
type turnNotification struct {
	ThreadID string   `json:"threadId"`
	Turn     turnInfo `json:"turn"`
}

// itemNotification is item/started's and item/completed's.
type itemNotification struct {
	Item     json.RawMessage `json:"item"`
	ThreadID string          `json:"threadId"`
	TurnID   string          `json:"turnId"`
}

// deltaNotification is the deltas' (agent message, plan, reasoning
// summary, command output).
type deltaNotification struct {
	ThreadID     string `json:"threadId"`
	TurnID       string `json:"turnId"`
	ItemID       string `json:"itemId"`
	Delta        string `json:"delta"`
	SummaryIndex int    `json:"summaryIndex"`
}

type tokenBreakdown struct {
	TotalTokens int64 `json:"totalTokens"`
}

type tokenUsageNotification struct {
	ThreadID   string `json:"threadId"`
	TokenUsage struct {
		Last               tokenBreakdown `json:"last"`
		ModelContextWindow *int64         `json:"modelContextWindow"`
	} `json:"tokenUsage"`
}

type rateLimitWindow struct {
	UsedPercent        float64 `json:"usedPercent"`
	WindowDurationMins *int    `json:"windowDurationMins"`
	ResetsAt           *int64  `json:"resetsAt"`
}

type rateLimitSnapshot struct {
	LimitID   *string          `json:"limitId"`
	LimitName *string          `json:"limitName"`
	Primary   *rateLimitWindow `json:"primary"`
	Secondary *rateLimitWindow `json:"secondary"`
}

type errorNotification struct {
	Error     turnError `json:"error"`
	WillRetry bool      `json:"willRetry"`
	ThreadID  string    `json:"threadId"`
	TurnID    string    `json:"turnId"`
}

// item is a ThreadItem: one struct for the members of every type the
// adapter maps (content is a userMessage's UserInput list, a reasoning's
// strings).
type item struct {
	Type string `json:"type"`
	ID   string `json:"id"`

	ClientID *string         `json:"clientId"`
	Content  json.RawMessage `json:"content"`

	Text    string   `json:"text"`
	Phase   *string  `json:"phase"`
	Summary []string `json:"summary"`

	Command          string          `json:"command"`
	Cwd              string          `json:"cwd"`
	Status           string          `json:"status"`
	CommandActions   []commandAction `json:"commandActions"`
	AggregatedOutput *string         `json:"aggregatedOutput"`
	ExitCode         *int            `json:"exitCode"`
	DurationMs       *int64          `json:"durationMs"`

	Changes []fileChange `json:"changes"`

	Server    string          `json:"server"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Result    *struct {
		Content []json.RawMessage `json:"content"`
	} `json:"result"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`

	Query  string `json:"query"`
	Action *struct {
		Type    string   `json:"type"`
		Query   *string  `json:"query"`
		Queries []string `json:"queries"`
		URL     *string  `json:"url"`
		Pattern *string  `json:"pattern"`
	} `json:"action"`

	Path string `json:"path"`

	Kind              string   `json:"kind"`
	AgentThreadID     string   `json:"agentThreadId"`
	AgentPath         string   `json:"agentPath"`
	Model             *string  `json:"model"`
	ReasoningEffort   *string  `json:"reasoningEffort"`
	SenderThreadID    string   `json:"senderThreadId"`
	ReceiverThreadIDs []string `json:"receiverThreadIds"`
	Prompt            *string  `json:"prompt"`

	StartedAtMs   *int64 `json:"startedAtMs"`
	CompletedAtMs *int64 `json:"completedAtMs"`
}

// The item types the adapter maps.
const (
	itemUserMessage   = "userMessage"
	itemAgentMessage  = "agentMessage"
	itemPlan          = "plan"
	itemReasoning     = "reasoning"
	itemCommand       = "commandExecution"
	itemFileChange    = "fileChange"
	itemMCPToolCall   = "mcpToolCall"
	itemDynamicTool   = "dynamicToolCall"
	itemCollabTool    = "collabAgentToolCall"
	itemSubAgent      = "subAgentActivity"
	itemWebSearch     = "webSearch"
	itemImageView     = "imageView"
	itemCompaction    = "contextCompaction"
	subAgentStarted   = "started"
	subAgentCompleted = "completed"
	subAgentStopped   = "interrupted"
)

type commandAction struct {
	Type    string `json:"type"`
	Command string `json:"command"`
}

type fileChange struct {
	Path string `json:"path"`
	Kind struct {
		Type     string  `json:"type"`
		MovePath *string `json:"move_path"`
	} `json:"kind"`
	Diff string `json:"diff"`
}

// userInput is a UserInput of the protocol: what a turn/start or a
// turn/steer sends, and a userMessage item holds.
type userInput struct {
	Type         string   `json:"type"`
	Text         string   `json:"text,omitempty"`
	TextElements []string `json:"text_elements,omitzero"`
	URL          string   `json:"url,omitempty"`
	Path         string   `json:"path,omitempty"`
	Name         string   `json:"name,omitempty"`
}

type commandApprovalParams struct {
	ThreadID       string          `json:"threadId"`
	ItemID         string          `json:"itemId"`
	Reason         *string         `json:"reason"`
	Command        *string         `json:"command"`
	Cwd            *string         `json:"cwd"`
	CommandActions []commandAction `json:"commandActions"`
	Network        json.RawMessage `json:"networkApprovalContext"`
}

type fileApprovalParams struct {
	ThreadID  string  `json:"threadId"`
	ItemID    string  `json:"itemId"`
	Reason    *string `json:"reason"`
	GrantRoot *string `json:"grantRoot"`
}

type userInputParams struct {
	ThreadID  string `json:"threadId"`
	ItemID    string `json:"itemId"`
	Questions []struct {
		ID       string `json:"id"`
		Header   string `json:"header"`
		Question string `json:"question"`
		IsOther  bool   `json:"isOther"`
		IsSecret bool   `json:"isSecret"`
		Options  []struct {
			Label       string `json:"label"`
			Description string `json:"description"`
		} `json:"options"`
	} `json:"questions"`
}
