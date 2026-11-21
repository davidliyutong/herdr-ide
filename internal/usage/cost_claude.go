package usage

import (
	"bytes"
	"encoding/json"
	"path"
)

// parseClaudeLine reads an assistant message's usage: one record per
// response, keyed by (requestId, message.id) as duplicates of forked and
// streamed sessions are; "<synthetic>" messages are errors.
func parseClaudeLine(file string, line []byte, ent *fileEntry) {
	// Quoted, the words are JSON's own, not text in a string (whose quotes
	// are escaped): a user's line (a tool's output) is not decoded.
	if !bytes.Contains(line, []byte(`"usage"`)) || !bytes.Contains(line, []byte(`"assistant"`)) {
		return
	}
	var d struct {
		Timestamp string `json:"timestamp"`
		RequestID string `json:"requestId"`
		UUID      string `json:"uuid"`
		CWD       string `json:"cwd"`
		Message   struct {
			Role  string `json:"role"`
			Model string `json:"model"`
			ID    string `json:"id"`
			Usage struct {
				Input         int64 `json:"input_tokens"`
				CacheRead     int64 `json:"cache_read_input_tokens"`
				CacheCreation int64 `json:"cache_creation_input_tokens"`
				Breakdown     struct {
					W5 int64 `json:"ephemeral_5m_input_tokens"`
					W1 int64 `json:"ephemeral_1h_input_tokens"`
				} `json:"cache_creation"`
				Output  int64 `json:"output_tokens"`
				Details struct {
					Thinking int64 `json:"thinking_tokens"`
				} `json:"output_tokens_details"`
			} `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &d) != nil || d.Message.Role != "assistant" || d.Message.Model == "<synthetic>" {
		return
	}
	u := d.Message.Usage
	w5, w1 := u.Breakdown.W5, u.Breakdown.W1
	if w5 == 0 && w1 == 0 {
		w5 = u.CacheCreation
	}
	if u.Input == 0 && u.CacheRead == 0 && w5 == 0 && w1 == 0 && u.Output == 0 {
		return
	}
	model := d.Message.Model
	if model == "" {
		model = "unknown"
	}
	id := d.Message.ID
	if id == "" {
		id = d.UUID
	}
	proj := projectName(d.CWD)
	if proj == "" {
		proj = path.Base(path.Dir(file))
	}
	ent.Records = append(ent.Records, Record{
		K: hashKey("claude", d.RequestID, id), T: isoTime(d.Timestamp), M: model, J: proj,
		I: u.Input, C: u.CacheRead, W: w5, H: w1, O: u.Output, R: u.Details.Thinking, N: 1,
	})
}
