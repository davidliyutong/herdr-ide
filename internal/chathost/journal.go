//go:build unix

package chathost

import (
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"veldr/internal/brand"
	"veldr/internal/chatproto"
	"veldr/internal/store"
)

// DBName is the name of the chat host's database in the instance's data
// directory, which the file of each host has with the host's name
// (store.HostFile: chat-<host>.db): the data directory may be on a home
// several hosts share, and a database in write-ahead logging is one
// host's.
const DBName = "chat.db"

// maxTrusted is the most directories the trusted list keeps: one more
// drops the one trusted the longest ago.
const maxTrusted = 1000

// migrations are the schema of the database (store.Options.Migrations).
//
// chats holds every member of a chatproto.Chat but its status (computed),
// with the JSON of its configuration options, slash commands, usage and
// capabilities, and what the host keeps beside: the sequence number of the
// last turn's end, the options the agent is started with again, the item
// a later History of the session starts after, and the bytes of its
// events. events holds the stored events, each as the line a client gets
// (json), with its type, item and time. Times are milliseconds since the
// epoch, 0 for none. A chat is fresh while its agent's session never had
// a turn: the agent may not keep it, and the chat's next start makes a
// new one instead of resuming it; renamed when the user named it
// (chatproto.OpRename), whose title its agent's no longer replaces;
// untrusted_told when its log tells that its agent started without the
// project's own settings (agentproto.NoticeUntrustedFolder), which is told
// again only after a start in a trusted folder. trusted lists the
// directories the user trusted (chatproto.OpTrust), with when, and the
// device and inode the directory had then: one that is another directory
// now is no longer trusted.
var migrations = []string{
	`CREATE TABLE settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE chats (
		id            TEXT PRIMARY KEY,
		kind          TEXT NOT NULL,
		title         TEXT NOT NULL DEFAULT '',
		cwd           TEXT NOT NULL,
		session_id    TEXT NOT NULL DEFAULT '',
		state         TEXT NOT NULL,
		error         TEXT NOT NULL DEFAULT '',
		created       INTEGER NOT NULL,
		updated       INTEGER NOT NULL,
		seq           INTEGER NOT NULL DEFAULT 0,
		seen          INTEGER NOT NULL DEFAULT 0,
		closed        INTEGER NOT NULL DEFAULT 0,
		handed_off    INTEGER NOT NULL DEFAULT 0,
		agent_version TEXT NOT NULL DEFAULT '',
		config        TEXT NOT NULL DEFAULT '',
		commands      TEXT NOT NULL DEFAULT '',
		usage         TEXT NOT NULL DEFAULT '',
		capabilities  TEXT NOT NULL DEFAULT '',
		turn_end      INTEGER NOT NULL DEFAULT 0,
		options       TEXT NOT NULL DEFAULT '',
		history_after TEXT NOT NULL DEFAULT '',
		bytes         INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE events (
		id   INTEGER PRIMARY KEY,
		chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
		seq  INTEGER NOT NULL,
		t    TEXT NOT NULL,
		item TEXT NOT NULL DEFAULT '',
		at   INTEGER NOT NULL,
		json BLOB NOT NULL
	);
	CREATE UNIQUE INDEX events_chat_seq ON events (chat, seq);`,
	`ALTER TABLE chats ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0;
	CREATE TABLE trusted (
		path TEXT PRIMARY KEY,
		at   INTEGER NOT NULL
	);`,
	// The directories trusted before their device and inode were kept are
	// trusted no longer.
	`ALTER TABLE chats ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE chats ADD COLUMN untrusted_told INTEGER NOT NULL DEFAULT 0;
	DELETE FROM trusted;
	ALTER TABLE trusted ADD COLUMN dev INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE trusted ADD COLUMN ino INTEGER NOT NULL DEFAULT 0;`,
	// archived: when the chat was archived (chatproto.OpArchive), 0 while
	// it is not.
	`ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`,
}

// deleteBatch is how many events one transaction deletes: a large log goes
// in steps, and the chats that write meanwhile wait for one step at most.
const deleteBatch = 2000

// journal is the host's database. Its writes take turns (mu); reads run
// beside them (write-ahead logging).
type journal struct {
	db *store.DB
	mu sync.Mutex
	// failAppend makes appendEvent fail (tests).
	failAppend func() error
}

// openJournal opens this host's database in base (store.HostFile), migrating
// any legacy un-hosted DBName into it first. Without one, this host's
// database of the namespace a previous product name left beside base
// (brand.LegacyDataDirs) is copied, so the chats moved tabs show come
// along; that namespace keeps its own. A database a newer host wrote is
// not used: its error is store.ErrNewer.
func openJournal(base string) (*journal, error) {
	target := store.HostFile(base, DBName)
	legacy := filepath.Join(base, DBName)
	if _, err := store.MigrateLegacy(legacy, target); err != nil {
		return nil, err
	}
	if !store.Exists(target) {
		for _, d := range brand.LegacyDataDirs(filepath.Base(base)) {
			if copied, _ := store.CopyDB(store.HostFile(filepath.Join(filepath.Dir(base), d), DBName), target); copied {
				break
			}
		}
	}
	db, err := store.Open(target, store.Options{Migrations: migrations})
	if errors.Is(err, store.ErrNewer) {
		db.Close()
		return nil, err
	}
	if err != nil {
		return nil, err
	}
	return &journal{db: db}, nil
}

func (j *journal) close() error { return j.db.Close() }

// row is what the journal keeps of a chat.
type row struct {
	chatproto.Chat
	TurnEnd      uint64
	Options      chatproto.Options
	HistoryAfter string
	Bytes        int64
	// Fresh: the session was made for the chat and never had a turn.
	Fresh bool
	// Renamed: the user named the chat; its agent's title does not replace
	// the name.
	Renamed bool
	// UntrustedTold: the log tells that the agent started without the
	// project's own settings, since its last start in a trusted folder.
	UntrustedTold bool
}

func ms(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func fromMS(v int64) time.Time {
	if v == 0 {
		return time.Time{}
	}
	return time.UnixMilli(v).UTC()
}

// jsonText is v's JSON, "" for nothing.
func jsonText(v any) string {
	b := line(v)
	if b == nil || string(b) == "null" {
		return ""
	}
	return string(b)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// insertChat stores a new chat.
func (j *journal) insertChat(r row) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	_, err := j.db.Exec(`INSERT INTO chats (id, kind, cwd, state, created, updated) VALUES (?, ?, ?, ?, ?, ?)`,
		r.ID, r.Kind, r.Cwd, r.State, ms(r.Created), ms(r.Updated))
	if err != nil {
		return err
	}
	return j.saveLocked(r)
}

// saveChat stores every member of a chat.
func (j *journal) saveChat(r row) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.saveLocked(r)
}

func (j *journal) saveLocked(r row) error {
	errText := ""
	if r.Error != nil {
		// The agent's standard error is never stored.
		errText = jsonText(r.Error.WithoutStderr())
	}
	_, err := j.db.Exec(`UPDATE chats SET kind = ?, title = ?, cwd = ?, session_id = ?, state = ?, error = ?,
		created = ?, updated = ?, seq = ?, seen = ?, closed = ?, handed_off = ?, agent_version = ?,
		config = ?, commands = ?, usage = ?, capabilities = ?, turn_end = ?, options = ?, history_after = ?, bytes = ?,
		fresh = ?, renamed = ?, untrusted_told = ?, archived = ? WHERE id = ?`,
		r.Kind, r.Title, r.Cwd, r.SessionID, r.State, errText,
		ms(r.Created), ms(r.Updated), int64(r.Seq), int64(r.Seen), ms(r.Closed), boolInt(r.HandedOff), r.AgentVersion,
		jsonText(r.Config), jsonText(r.Commands), jsonText(r.Usage), jsonText(r.Capabilities),
		int64(r.TurnEnd), jsonText(r.Options), r.HistoryAfter, r.Bytes, boolInt(r.Fresh), boolInt(r.Renamed), boolInt(r.UntrustedTold), ms(r.Archived), r.ID)
	return err
}

// loadChats reads every chat.
func (j *journal) loadChats() ([]row, error) {
	rows, err := j.db.Query(`SELECT id, kind, title, cwd, session_id, state, error, created, updated, seq, seen,
		closed, handed_off, agent_version, config, commands, usage, capabilities, turn_end, options, history_after, bytes,
		fresh, renamed, untrusted_told, archived FROM chats`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []row
	for rows.Next() {
		var r row
		var errText, config, commands, usage, caps, options string
		var created, updated, seq, seen, closed, turnEnd, archived int64
		var handedOff, fresh, renamed, untrustedTold int
		if err := rows.Scan(&r.ID, &r.Kind, &r.Title, &r.Cwd, &r.SessionID, &r.State, &errText, &created, &updated,
			&seq, &seen, &closed, &handedOff, &r.AgentVersion, &config, &commands, &usage, &caps, &turnEnd,
			&options, &r.HistoryAfter, &r.Bytes, &fresh, &renamed, &untrustedTold, &archived); err != nil {
			return nil, err
		}
		r.Created, r.Updated, r.Closed, r.Archived = fromMS(created), fromMS(updated), fromMS(closed), fromMS(archived)
		r.Seq, r.Seen, r.TurnEnd, r.HandedOff, r.Fresh = uint64(seq), uint64(seen), uint64(turnEnd), handedOff != 0, fresh != 0
		r.Renamed, r.UntrustedTold = renamed != 0, untrustedTold != 0
		if errText != "" {
			r.Error = &chatproto.Error{}
			json.Unmarshal([]byte(errText), r.Error)
		}
		unmarshal(config, &r.Config)
		unmarshal(commands, &r.Commands)
		unmarshal(usage, &r.Usage)
		unmarshal(caps, &r.Capabilities)
		unmarshal(options, &r.Options)
		out = append(out, r)
	}
	return out, rows.Err()
}

func unmarshal(s string, v any) {
	if s != "" {
		json.Unmarshal([]byte(s), v)
	}
}

// first is the lowest sequence number of a chat's stored events; 0 when
// it has none.
func (j *journal) first(chat string) (uint64, error) {
	var first sql.NullInt64
	err := j.db.QueryRow(`SELECT MIN(seq) FROM events WHERE chat = ?`, chat).Scan(&first)
	if err != nil || !first.Valid {
		return 0, err
	}
	return uint64(first.Int64), nil
}

// stored is an event as the journal keeps it.
type stored struct {
	seq  uint64
	t    string
	item string
	at   time.Time
	line []byte // without the newline
}

// appendEvent stores an event of a chat, and the chat's members that
// change with every event (r's).
func (j *journal) appendEvent(r row, e stored) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.failAppend != nil {
		if err := j.failAppend(); err != nil {
			return err
		}
	}
	tx, err := j.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO events (chat, seq, t, item, at, json) VALUES (?, ?, ?, ?, ?, ?)`,
		r.ID, int64(e.seq), e.t, e.item, ms(e.at), e.line); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE chats SET seq = ?, updated = ?, turn_end = ?, history_after = ?, bytes = ?, fresh = ? WHERE id = ?`,
		int64(r.Seq), ms(r.Updated), int64(r.TurnEnd), r.HistoryAfter, r.Bytes, boolInt(r.Fresh), r.ID); err != nil {
		return err
	}
	return tx.Commit()
}

// events reads the lines of a chat's stored events with a sequence number
// in (after, upTo], each with its newline, the oldest first: as many as
// fit max bytes, one at least. last is the sequence number of the last one
// read.
func (j *journal) events(chat string, after, upTo uint64, max int) (lines [][]byte, last uint64, err error) {
	if after >= upTo {
		return nil, after, nil
	}
	rows, err := j.db.Query(`SELECT seq, json FROM events WHERE chat = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 512`,
		chat, int64(after), int64(upTo))
	if err != nil {
		return nil, after, err
	}
	defer rows.Close()
	size := 0
	last = after
	for rows.Next() {
		var seq int64
		var b []byte
		if err := rows.Scan(&seq, &b); err != nil {
			return lines, last, err
		}
		if len(lines) > 0 && size+len(b)+1 > max {
			break
		}
		lines = append(lines, append(b, '\n'))
		size += len(b) + 1
		last = uint64(seq)
	}
	return lines, last, rows.Err()
}

// eventsOf reads the stored events of a chat of the given types, the
// oldest first.
func (j *journal) eventsOf(chat string, types ...string) ([]chatproto.Event, error) {
	var out []chatproto.Event
	for _, t := range types {
		rows, err := j.db.Query(`SELECT json FROM events WHERE chat = ? AND t = ? ORDER BY seq`, chat, t)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var b []byte
			if err := rows.Scan(&b); err != nil {
				rows.Close()
				return nil, err
			}
			var ev chatproto.Event
			if json.Unmarshal(b, &ev) == nil {
				out = append(out, ev)
			}
		}
		rows.Close()
	}
	return out, nil
}

// trim deletes a chat's oldest events until its events take at most keep
// bytes, and returns the bytes deleted and the lowest sequence number
// left (0 for none).
func (j *journal) trim(chat string, bytes, keep int64) (deleted int64, first uint64, err error) {
	for bytes-deleted > keep {
		n, done, err := j.trimStep(chat, bytes-deleted-keep)
		deleted += n
		if err != nil {
			return deleted, 0, err
		}
		if done {
			break
		}
	}
	first, err = j.first(chat)
	return deleted, first, err
}

// trimStep deletes at most deleteBatch of a chat's oldest events, as many
// as needed for over bytes; done when nothing is left to delete.
func (j *journal) trimStep(chat string, over int64) (int64, bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	tx, err := j.db.Begin()
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT seq, length(json) FROM events WHERE chat = ? ORDER BY seq LIMIT ?`, chat, deleteBatch)
	if err != nil {
		return 0, false, err
	}
	var upTo, n int64
	count := 0
	for rows.Next() && n < over {
		var seq, size int64
		if err := rows.Scan(&seq, &size); err != nil {
			rows.Close()
			return 0, false, err
		}
		upTo, n = seq, n+size
		count++
	}
	rows.Close()
	if count == 0 {
		return 0, true, nil
	}
	if _, err := tx.Exec(`DELETE FROM events WHERE chat = ? AND seq <= ?`, chat, upTo); err != nil {
		return 0, false, err
	}
	if _, err := tx.Exec(`UPDATE chats SET bytes = MAX(bytes - ?, 0) WHERE id = ?`, n, chat); err != nil {
		return 0, false, err
	}
	return n, false, tx.Commit()
}

// deleteChat forgets a chat and its events, the events a batch at a time.
func (j *journal) deleteChat(chat string) error {
	for {
		j.mu.Lock()
		res, err := j.db.Exec(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE chat = ? ORDER BY seq LIMIT ?)`, chat, deleteBatch)
		j.mu.Unlock()
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n < deleteBatch {
			break
		}
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	_, err := j.db.Exec(`DELETE FROM chats WHERE id = ?`, chat)
	return err
}

// settingsKey is the settings' key in the settings table.
const settingsKey = "host"

// settings are the settings the core gave last; the defaults when none.
func (j *journal) settings() chatproto.HostSettings {
	var v string
	var s chatproto.HostSettings
	if j.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, settingsKey).Scan(&v) == nil {
		json.Unmarshal([]byte(v), &s)
	}
	return s.Clamp()
}

// putSettings keeps the settings the core gave.
func (j *journal) putSettings(s chatproto.HostSettings) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	_, err := j.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		settingsKey, jsonText(s))
	return err
}

// trust adds a directory to the trusted list, with the device and inode it
// has (id); beyond maxTrusted the one trusted the longest ago goes.
func (j *journal) trust(path string, at time.Time, id fileID) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	tx, err := j.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO trusted (path, at, dev, ino) VALUES (?, ?, ?, ?)
		ON CONFLICT (path) DO UPDATE SET at = excluded.at, dev = excluded.dev, ino = excluded.ino`,
		path, ms(at), int64(id.dev), int64(id.ino)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM trusted WHERE path NOT IN (SELECT path FROM trusted ORDER BY at DESC, path LIMIT ?)`,
		maxTrusted); err != nil {
		return err
	}
	return tx.Commit()
}

// trustedDir is a directory of the trusted list, with the device and inode
// it had when it was trusted.
type trustedDir struct {
	path string
	at   time.Time
	id   fileID
}

// listTrusted returns all trusted directories, most recently trusted first.
func (j *journal) listTrusted() ([]trustedDir, error) {
	rows, err := j.db.Query(`SELECT path, at, dev, ino FROM trusted ORDER BY at DESC, path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []trustedDir
	for rows.Next() {
		var t trustedDir
		var at, dev, ino int64
		if err := rows.Scan(&t.path, &at, &dev, &ino); err != nil {
			return nil, err
		}
		t.at = fromMS(at)
		t.id = fileID{dev: uint64(dev), ino: uint64(ino)}
		out = append(out, t)
	}
	return out, rows.Err()
}

// trustedAbove are the directories of the trusted list among dir, an
// absolute clean path, and the directories above it, dir first.
func (j *journal) trustedAbove(dir string) ([]trustedDir, error) {
	var paths []any
	for p := dir; ; p = parentDir(p) {
		paths = append(paths, p)
		if p == "/" {
			break
		}
	}
	rows, err := j.db.Query(`SELECT path, dev, ino FROM trusted WHERE path IN (?`+strings.Repeat(", ?", len(paths)-1)+`)
		ORDER BY length(path) DESC`, paths...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []trustedDir
	for rows.Next() {
		var t trustedDir
		var dev, ino int64
		if err := rows.Scan(&t.path, &dev, &ino); err != nil {
			return nil, err
		}
		t.id = fileID{dev: uint64(dev), ino: uint64(ino)}
		out = append(out, t)
	}
	return out, rows.Err()
}

// untrust removes directories from the trusted list.
func (j *journal) untrust(paths ...string) error {
	if len(paths) == 0 {
		return nil
	}
	args := make([]any, len(paths))
	for i, p := range paths {
		args[i] = p
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	_, err := j.db.Exec(`DELETE FROM trusted WHERE path IN (?`+strings.Repeat(", ?", len(paths)-1)+`)`, args...)
	return err
}

// clientIDs are the page's ids (chatproto.Event.ClientID) of the last n
// prompts of a chat its log keeps (EventUser and EventQueued), the oldest
// first.
func (j *journal) clientIDs(chat string, n int) ([]string, error) {
	rows, err := j.db.Query(`SELECT json FROM events WHERE chat = ? AND t IN (?, ?) ORDER BY seq DESC LIMIT ?`,
		chat, chatproto.EventUser, chatproto.EventQueued, 2*n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	seen := map[string]bool{}
	for rows.Next() && len(ids) < n {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		var ev struct {
			ClientID string `json:"clientId"`
		}
		if json.Unmarshal(b, &ev) == nil && ev.ClientID != "" && !seen[ev.ClientID] {
			seen[ev.ClientID] = true
			ids = append(ids, ev.ClientID)
		}
	}
	slices.Reverse(ids)
	return ids, rows.Err()
}

// parentDir is the directory above an absolute, clean path; "/" for "/".
func parentDir(p string) string {
	i := strings.LastIndexByte(p, '/')
	if i <= 0 {
		return "/"
	}
	return p[:i]
}
