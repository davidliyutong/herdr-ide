//go:build unix

package transcript

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"herdr-ide/internal/agentproto"
)

// A line's Frame: its events as a read gives them, the block each was
// made of, the message and the index of its first block.
func TestClaudeFrame(t *testing.T) {
	line := jsonLine(t, obj{"type": "assistant", "apiBlockIndex": 2, "message": obj{"id": "msg_1", "stop_reason": "end_turn", "content": []any{
		obj{"type": "thinking", "thinking": ""},
		obj{"type": "text", "text": "done"},
	}}})
	f := ClaudeFrame([]byte(line), Limits{})
	if f.Message != "msg_1" || f.First != 2 || f.Count != 2 || len(f.Events) != 3 || len(f.Blocks) != 3 {
		t.Fatalf("frame %+v", f)
	}
	if f.Blocks[0] != 0 || f.Blocks[1] != 1 || f.Blocks[2] != -1 || f.Events[2].T != agentproto.TranscriptTurn || f.Events[2].StopReason != "end_turn" {
		t.Errorf("blocks %v events %+v", f.Blocks, f.Events)
	}
	// The SDK protocol's frames: no apiBlockIndex, the tool's result as
	// tool_use_result; a response still running ends no turn.
	sdk := ClaudeFrame([]byte(jsonLine(t, obj{"type": "assistant", "parent_tool_use_id": nil, "message": obj{"id": "msg_2", "stop_reason": nil, "content": []any{
		obj{"type": "tool_use", "id": "toolu_1", "name": "Edit", "input": obj{"file_path": "/p/a.go", "old_string": "a", "new_string": "b"}},
	}}})), Limits{})
	if sdk.First != -1 || len(sdk.Events) != 1 {
		t.Fatalf("sdk frame %+v", sdk)
	}
	u := updateOf(t, sdk.Events[0])
	content := asArr(u["content"])
	if u["sessionUpdate"] != "tool_call" || len(content) != 1 || asObj(content[0])["type"] != "diff" || asObj(content[0])["oldText"] != "a" {
		t.Errorf("tool call %v", u)
	}
	res := ClaudeFrame([]byte(jsonLine(t, obj{"type": "user", "message": obj{"role": "user", "content": []any{
		obj{"type": "tool_result", "tool_use_id": "toolu_2", "content": "[Subagent hand-back] preamble"},
	}}, "tool_use_result": obj{"agentId": "a1", "status": "completed", "content": []any{obj{"type": "text", "text": "the report"}}}})), Limits{})
	if len(res.Events) != 1 {
		t.Fatalf("result frame %+v", res)
	}
	if u := updateOf(t, res.Events[0]); !strings.Contains(string(res.Events[0].Update), "the report") || strings.Contains(string(res.Events[0].Update), "preamble") || u["status"] != "completed" {
		t.Errorf("a subagent's report %s", res.Events[0].Update)
	}

	long := ClaudeFrame(bytes.Repeat([]byte("x"), maxLine+1), Limits{})
	if len(long.Events) != 1 || long.Events[0].Method != agentproto.NoticeMethod(noticeSkipped) {
		t.Errorf("a long line %+v", long)
	}
	if bad := ClaudeFrame([]byte(`{"no":"type"}`), Limits{}); bad.Unknown != 1 || len(bad.Events) != 0 {
		t.Errorf("no type %+v", bad)
	}
}

// EachClaude reads every complete line from a line's start at or after
// from, until fn stops it or ctx ends.
func TestEachClaude(t *testing.T) {
	data := lines(userLine(t, "one"), textLine(t, "msg_1", "a"), userLine(t, "two"))
	data = append(data, []byte(`{"type":"user"`)...)
	var offs []int64
	var users int
	err := EachClaude(context.Background(), bytes.NewReader(data), 0, int64(len(data)), Limits{}, func(off int64, f Frame) bool {
		offs = append(offs, off)
		for _, ev := range f.Events {
			if ev.T == agentproto.TranscriptUser {
				users++
			}
		}
		return true
	})
	if err != nil || len(offs) != 3 || users != 2 {
		t.Errorf("offsets %v users %d: %v", offs, users, err)
	}
	// From inside the first line: the lines after it.
	var from []int64
	EachClaude(context.Background(), bytes.NewReader(data), 3, int64(len(data)), Limits{}, func(off int64, f Frame) bool {
		from = append(from, off)
		return true
	})
	if len(from) != 2 || from[0] != offs[1] {
		t.Errorf("from 3: %v", from)
	}
	n := 0
	EachClaude(context.Background(), bytes.NewReader(data), 0, int64(len(data)), Limits{}, func(int64, Frame) bool {
		n++
		return false
	})
	if n != 1 {
		t.Errorf("read on after false: %d", n)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := EachClaude(ctx, bytes.NewReader(data), 0, int64(len(data)), Limits{}, func(int64, Frame) bool { return true }); !errors.Is(err, context.Canceled) {
		t.Errorf("a cancelled read: %v", err)
	}
}
