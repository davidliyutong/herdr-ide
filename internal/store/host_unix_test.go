//go:build unix

package store

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// holdEnv makes the test binary a process that holds the database it
// names open (its pool idle between transactions) until its stdin closes.
const holdEnv = "STORE_TEST_HOLD"

func TestMain(m *testing.M) {
	if p := os.Getenv(holdEnv); p != "" {
		db, err := OpenShared(p)
		if err != nil {
			os.Exit(2)
		}
		if _, err := db.Migrate("held", []string{"CREATE TABLE held_t (n INTEGER)"}); err != nil {
			os.Exit(3)
		}
		if _, err := db.Exec("INSERT INTO held_t VALUES (1)"); err != nil {
			os.Exit(4)
		}
		os.Stdout.WriteString("ready\n")
		io.Copy(io.Discard, os.Stdin)
		db.Close()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// hold starts a process that holds the database at p open; the returned
// function ends it.
func hold(t *testing.T, p string) func() {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), holdEnv+"="+p)
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil || line != "ready\n" {
		in.Close()
		cmd.Wait()
		t.Fatalf("holder: %q %v", line, err)
	}
	done := false
	stop := func() {
		if !done {
			done = true
			in.Close()
			cmd.Wait()
		}
	}
	t.Cleanup(stop)
	return stop
}

// age sets the modification time of the database at p and of its journal
// files to d before now.
func age(t *testing.T, p string, d time.Duration) {
	t.Helper()
	old := time.Now().Add(-d)
	for _, s := range append([]string{""}, journals...) {
		if err := os.Chtimes(p+s, old, old); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
}

func makeDB(t *testing.T, p string) {
	t.Helper()
	db, err := Open(p, Options{Migrations: []string{"CREATE TABLE t (n INTEGER)"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO t VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	db.Close()
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

// Other hosts' databases (and the name of no host's) unopened for the
// retention and held by no process go with their journal files; this
// host's, recent ones, held ones, ones this process has open and names of
// no database stay.
func TestPruneHostFiles(t *testing.T) {
	dir := t.TempDir()
	month := HostFileRetention + time.Hour
	mine := HostFile(dir, MachineDB)
	other := filepath.Join(dir, "machine-other_host.db")
	// Another host's of this version: its whole name and its id's hash.
	named := filepath.Join(dir, "machine-node01.cluster.example.org-0a1b2c3d.db")
	recent := filepath.Join(dir, "machine-recent.db")
	legacy := filepath.Join(dir, MachineDB)
	held := filepath.Join(dir, "machine-held.db")
	openHereP := filepath.Join(dir, "machine-here.db")
	for _, p := range []string{mine, other, named, recent, legacy} {
		makeDB(t, p)
	}
	// A journal file left beside other's database goes with it.
	if err := os.WriteFile(other+"-wal", []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Names of no host's database, and a link.
	upper := filepath.Join(dir, "machine-Upper.db")
	dotted := filepath.Join(dir, "machine-.b.db")
	chat := filepath.Join(dir, "chat-other.db")
	link := filepath.Join(dir, "machine-link.db")
	for _, p := range []string{upper, dotted, chat} {
		makeDB(t, p)
	}
	if err := os.Symlink(other, link); err != nil {
		t.Fatal(err)
	}
	stop := hold(t, held) // creates it
	here := openShared(t, openHereP)
	for _, p := range []string{mine, other, named, legacy, held, openHereP, upper, dotted, chat} {
		age(t, p, month)
	}
	removed, err := PruneHostFiles(dir, MachineDB, HostFileRetention, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(removed)
	if want := []string{"machine-node01.cluster.example.org-0a1b2c3d.db", "machine-other_host.db", "machine.db"}; !slices.Equal(removed, want) {
		t.Fatalf("removed %v, want %v", removed, want)
	}
	for _, p := range []string{other, other + "-wal", other + "-shm", named, legacy} {
		if exists(p) {
			t.Errorf("%s stayed", filepath.Base(p))
		}
	}
	for _, p := range []string{mine, recent, held, openHereP, upper, dotted, chat} {
		if !exists(p) {
			t.Errorf("%s went", filepath.Base(p))
		}
	}
	// The holder's database is whole and still its own.
	stop()
	here.Close()
	age(t, held, month)
	age(t, openHereP, month)
	removed, err = PruneHostFiles(dir, MachineDB, HostFileRetention, time.Now())
	slices.Sort(removed)
	if want := []string{"machine-held.db", "machine-here.db"}; err != nil || !slices.Equal(removed, want) {
		t.Fatalf("once released: removed %v (%v), want %v", removed, err, want)
	}
	if exists(held+"-wal") || exists(held+"-shm") || !exists(mine) {
		t.Error("journal files left, or this host's database went")
	}
	if removed, err := PruneHostFiles(filepath.Join(dir, "missing"), MachineDB, HostFileRetention, time.Now()); err != nil || removed != nil {
		t.Errorf("a missing directory: %v %v", removed, err)
	}
}

// A database whose journal file was written within the retention is in
// use: it stays.
func TestPruneHostFilesRecentJournal(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "chat-b.db")
	makeDB(t, p)
	if err := os.WriteFile(p+"-wal", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	age(t, p, HostFileRetention+time.Hour)
	now := time.Now()
	os.Chtimes(p+"-wal", now, now)
	if removed, _ := PruneHostFiles(dir, "chat.db", HostFileRetention, now); len(removed) != 0 || !exists(p) {
		t.Fatalf("removed %v", removed)
	}
}

// Open marks a database used: its modification time is when it was last
// opened (at most an hour off), from which PruneHostFiles counts.
func TestOpenMarksUsed(t *testing.T) {
	p := filepath.Join(t.TempDir(), "machine-b.db")
	makeDB(t, p)
	age(t, p, 48*time.Hour)
	db, err := Open(p, Options{Migrations: []string{"CREATE TABLE t (n INTEGER)"}})
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	st, err := os.Stat(p)
	if err != nil || time.Since(st.ModTime()) > time.Minute {
		t.Fatalf("modified %v ago (%v)", time.Since(st.ModTime()), err)
	}
	if removed, _ := PruneHostFiles(filepath.Dir(p), MachineDB, HostFileRetention, time.Now()); len(removed) != 0 {
		t.Fatalf("a database opened now went: %v", removed)
	}
}

// A database stays marked used while it is open, also for longer than the
// retention without a write: a process that holds this host's database
// open keeps it from another host's PruneHostFiles. Once closed it is
// marked no more, and forgotten.
func TestOpenKeepsMarked(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "machine-b.db")
	db, err := Open(p, Options{Migrations: []string{"CREATE TABLE t (n INTEGER)"}})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	marked.Lock()
	_, kept := marked.paths[p]
	marked.Unlock()
	if !kept {
		t.Fatal("an open database is not kept marked")
	}
	modified := func() time.Duration {
		t.Helper()
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		return time.Since(st.ModTime())
	}
	// Open longer than the retention, without a write: an hourly pass
	// marks it.
	age(t, p, HostFileRetention+time.Hour)
	refreshMarked(time.Now().Add(markGrace))
	if d := modified(); d > time.Minute || d < -2*time.Minute {
		t.Fatalf("an open database modified %v ago", d)
	}
	if removed, _ := PruneHostFiles(dir, MachineDB, HostFileRetention, time.Now()); len(removed) != 0 {
		t.Fatalf("removed %v", removed)
	}
	// Closed: no longer marked, and forgotten.
	db.Close()
	age(t, p, HostFileRetention+time.Hour)
	refreshMarked(time.Now().Add(markGrace))
	if d := modified(); d < HostFileRetention {
		t.Fatalf("a closed database was marked: modified %v ago", d)
	}
	marked.Lock()
	_, kept = marked.paths[p]
	marked.Unlock()
	if kept {
		t.Fatal("a closed database is kept")
	}
	// One Open just took (it has no log yet) stays kept.
	q := filepath.Join(dir, "machine-c.db")
	keepMarked(q)
	refreshMarked(time.Now())
	marked.Lock()
	_, kept = marked.paths[q]
	delete(marked.paths, q)
	marked.Unlock()
	if !kept {
		t.Fatal("a database being opened was forgotten")
	}
}

// The machine id is the system's own: macOS's platform UUID as ioreg
// shows it, elsewhere the first machine-id file that has one.
func TestMachineID(t *testing.T) {
	out := []byte(`+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000256, registered>
    {
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
      "IOPlatformUUID" = "AB77F40E-2F67-5607-B4F1-6D5E54732E35"
      "serial-number" = <0000>
    }
`)
	if got := ioregUUID(out); got != "AB77F40E-2F67-5607-B4F1-6D5E54732E35" {
		t.Errorf("ioregUUID = %q", got)
	}
	if got := ioregUUID([]byte("nothing")); got != "" {
		t.Errorf("ioregUUID of nothing = %q", got)
	}
	id := machineID()
	if runtime.GOOS == "darwin" {
		if id == "" {
			t.Error("no platform UUID")
		}
		return
	}
	want := ""
	for _, p := range machineIDFiles {
		if b, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(b)) != "" {
			want = strings.TrimSpace(string(b))
			break
		}
	}
	if id != want {
		t.Errorf("machineID = %q, want %q", id, want)
	}
}
