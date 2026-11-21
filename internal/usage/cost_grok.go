package usage

import (
	"bytes"
	"encoding/json"
	"net/url"
	"path"
	"sort"
	"strings"
)

type grokUsage struct {
	ModelCalls int64 `json:"modelCalls"`
	Input      int64 `json:"inputTokens"`
	CachedRead int64 `json:"cachedReadTokens"`
	CacheCreat int64 `json:"cacheCreationTokens"`
	Output     int64 `json:"outputTokens"`
	Reasoning  int64 `json:"reasoningTokens"`
}

// parseGrokUpdate reads a turn_completed update: the turn's usage, by
// model when modelUsage has them.
func parseGrokUpdate(file string, line []byte, ent *fileEntry) {
	if !bytes.Contains(line, []byte(`"turn_completed"`)) || !bytes.Contains(line, []byte(`"usage"`)) {
		return
	}
	var d struct {
		Timestamp any `json:"timestamp"`
		Params    struct {
			Meta struct {
				TS any `json:"agentTimestampMs"`
			} `json:"_meta"`
			Update struct {
				SessionUpdate string `json:"sessionUpdate"`
				Usage         struct {
					grokUsage
					ModelUsage map[string]grokUsage `json:"modelUsage"`
				} `json:"usage"`
			} `json:"update"`
		} `json:"params"`
	}
	if json.Unmarshal(line, &d) != nil || d.Params.Update.SessionUpdate != "turn_completed" {
		return
	}
	t := timeOf(d.Params.Meta.TS)
	if t == 0 {
		t = timeOf(d.Timestamp)
	}
	if t == 0 {
		return
	}
	proj := grokProject(file)
	models := d.Params.Update.Usage.ModelUsage
	if len(models) == 0 {
		models = map[string]grokUsage{"unknown": d.Params.Update.Usage.grokUsage}
	}
	names := make([]string, 0, len(models))
	for m := range models {
		names = append(names, m)
	}
	sort.Strings(names)
	for _, m := range names {
		u := models[m]
		if u.Input == 0 && u.Output == 0 {
			continue
		}
		calls := max(u.ModelCalls, 1)
		// inputTokens includes the cached reads; the tier goes by the
		// average prompt of the turn's calls.
		ent.Records = append(ent.Records, Record{
			T: t, M: firstNonEmpty(m, "unknown"), J: proj,
			I: max(u.Input-u.CachedRead, 0), C: u.CachedRead, W: u.CacheCreat, O: u.Output, R: u.Reasoning,
			N: calls, X: max((u.Input+u.CacheCreat)/calls, 1),
		})
	}
}

// grokProject names a session's project by its directory
// (sessions/<project>/<session>/).
func grokProject(file string) string {
	dir := path.Base(path.Dir(path.Dir(file)))
	if s, err := url.PathUnescape(dir); err == nil {
		dir = s
	}
	return projectName(dir)
}

// parseGrokEvent reads a turn_started event: the model of its session, the
// first one named, into ent.Models.
func parseGrokEvent(line []byte, ent *fileEntry) {
	if !bytes.Contains(line, []byte(`"turn_started"`)) || !bytes.Contains(line, []byte(`"model_id"`)) {
		return
	}
	var d struct {
		SessionID string `json:"session_id"`
		ModelID   string `json:"model_id"`
	}
	if json.Unmarshal(line, &d) == nil && d.SessionID != "" && d.ModelID != "" {
		if _, ok := ent.Models[d.SessionID]; !ok {
			ent.Models[d.SessionID] = d.ModelID
		}
	}
}

// parseGrokUnified reads a legacy shell.turn.inference_done event (the
// model comes from the session's events), and counts retries.
func parseGrokUnified(line []byte, ent *fileEntry) {
	done := bytes.Contains(line, []byte("inference_done"))
	retry := bytes.Contains(line, []byte("inference_retry"))
	if !done && !retry {
		return
	}
	var d struct {
		Msg string `json:"msg"`
		TS  string `json:"ts"`
		SID string `json:"sid"`
		Ctx struct {
			Prompt     int64 `json:"prompt_tokens"`
			Cached     int64 `json:"cached_prompt_tokens"`
			Completion int64 `json:"completion_tokens"`
			Reasoning  int64 `json:"reasoning_tokens"`
		} `json:"ctx"`
	}
	if json.Unmarshal(line, &d) != nil {
		return
	}
	t := isoTime(d.TS)
	if t == 0 {
		return
	}
	if strings.Contains(d.Msg, "inference_retry") {
		ent.Records = append(ent.Records, Record{T: t, E: true})
		return
	}
	if !strings.Contains(d.Msg, "inference_done") {
		return
	}
	ent.Records = append(ent.Records, Record{T: t, S: d.SID, I: max(d.Ctx.Prompt-d.Ctx.Cached, 0), C: d.Ctx.Cached, O: d.Ctx.Completion, R: d.Ctx.Reasoning, N: 1})
}
