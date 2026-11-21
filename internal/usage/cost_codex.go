package usage

import (
	"bytes"
	"encoding/json"
	"io"
)

// codexState is what parseCodexLog carries from line to line, kept to read
// a rollout on from where it ended.
type codexState struct {
	// Model and Turn are the last turn's.
	Model   string `json:"model,omitempty"`
	Turn    string `json:"turn,omitempty"`
	Project string `json:"project,omitempty"`
	// New: a token_usage_record was seen (legacy token_count events are
	// replays from then on).
	New bool `json:"new,omitempty"`
	// Total is the last token_count's total input (nil: none yet).
	Total *int64 `json:"total,omitempty"`
}

type codexUsage struct {
	Input     int64 `json:"input_tokens"`
	Cached    int64 `json:"cached_input_tokens"`
	CacheW    int64 `json:"cache_write_input_tokens"`
	Output    int64 `json:"output_tokens"`
	Reasoning int64 `json:"reasoning_output_tokens"`
}

func (u codexUsage) record(model, proj string, t int64) (Record, bool) {
	if u.Input == 0 && u.Output == 0 && u.CacheW == 0 {
		return Record{}, false
	}
	// input_tokens includes the cached tokens; the tier goes by the
	// whole prompt.
	return Record{T: t, M: model, J: proj, I: max(u.Input-u.Cached, 0), C: u.Cached, W: u.CacheW, O: u.Output, R: u.Reasoning, N: 1, X: u.Input}, true
}

// parseCodexLog reads a rollout: token_usage_record events (one per
// response, keyed by response_id, the model by turn_id), else the legacy
// token_count events (last_token_usage; an event whose total did not move
// is a replay), which after the first token_usage_record are replays too.
// It goes on from ent.Codex's state and leaves the state at its end there.
func parseCodexLog(file string, r io.Reader, ent *fileEntry) (int64, error) {
	turnModel := map[string]string{}
	lastModel, lastTurn, proj := "", "", ""
	seenNew := false
	var prevTotal int64 = -1
	if st := ent.Codex; st != nil {
		lastModel, lastTurn, proj, seenNew = st.Model, st.Turn, st.Project, st.New
		if st.Turn != "" {
			turnModel[st.Turn] = st.Model
		}
		if st.Total != nil {
			prevTotal = *st.Total
		}
	}
	end, err := eachLine(r, false, func(line []byte) {
		switch {
		case bytes.Contains(line, []byte(`"session_meta"`)):
			var d struct {
				Payload struct {
					CWD string `json:"cwd"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) == nil && d.Payload.CWD != "" {
				proj = projectName(d.Payload.CWD)
			}
		case bytes.Contains(line, []byte(`"turn_context"`)):
			var d struct {
				Payload struct {
					Model  string `json:"model"`
					TurnID string `json:"turn_id"`
					CWD    string `json:"cwd"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) == nil && d.Payload.Model != "" {
				lastModel, lastTurn = d.Payload.Model, d.Payload.TurnID
				if d.Payload.TurnID != "" {
					turnModel[d.Payload.TurnID] = d.Payload.Model
				}
				if proj == "" && d.Payload.CWD != "" {
					proj = projectName(d.Payload.CWD)
				}
			}
		case bytes.Contains(line, []byte(`"token_usage_record"`)):
			var d struct {
				Timestamp string `json:"timestamp"`
				Ordinal   any    `json:"ordinal"`
				Payload   struct {
					TurnID     string     `json:"turn_id"`
					ResponseID string     `json:"response_id"`
					Usage      codexUsage `json:"usage"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) != nil {
				return
			}
			seenNew = true
			model := firstNonEmpty(turnModel[d.Payload.TurnID], lastModel, "unknown")
			rec, ok := d.Payload.Usage.record(model, proj, isoTime(d.Timestamp))
			if !ok {
				return
			}
			if d.Payload.ResponseID != "" {
				rec.K = hashKey("codex", d.Payload.ResponseID)
			} else {
				b, _ := json.Marshal(d.Ordinal)
				rec.K = hashKey("codex-ord", file, string(b))
			}
			ent.Records = append(ent.Records, rec)
		case bytes.Contains(line, []byte(`"token_count"`)):
			if seenNew {
				return
			}
			var d struct {
				Timestamp string `json:"timestamp"`
				Payload   struct {
					Type string `json:"type"`
					Info struct {
						Total struct {
							Input int64 `json:"input_tokens"`
						} `json:"total_token_usage"`
						Last json.RawMessage `json:"last_token_usage"`
					} `json:"info"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) != nil || d.Payload.Type != "token_count" {
				return
			}
			total := d.Payload.Info.Total.Input
			if prevTotal >= 0 && total == prevTotal {
				return
			}
			prevTotal = total
			var u codexUsage
			if json.Unmarshal(d.Payload.Info.Last, &u) != nil {
				return
			}
			rec, ok := u.record(firstNonEmpty(lastModel, "unknown"), proj, isoTime(d.Timestamp))
			if !ok {
				return
			}
			rec.K = hashKey("codex-tc", file, d.Timestamp, string(d.Payload.Info.Last))
			ent.Records = append(ent.Records, rec)
		}
	})
	st := &codexState{Model: lastModel, Turn: lastTurn, Project: proj, New: seenNew}
	if prevTotal >= 0 {
		st.Total = &prevTotal
	}
	ent.Codex = st
	return end, err
}
