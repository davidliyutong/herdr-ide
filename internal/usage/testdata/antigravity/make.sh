#!/bin/sh
# Makes the Antigravity conversation databases of TestAntigravity* with
# the sqlite3 shell (the tests read them without SQLite):
#
#   conv.db             512-byte pages so gen_metadata and steps span
#                       interior and overflow pages: generations across
#                       two days, Gemini (short and >200k long context),
#                       Claude, an unpriced model, a large last-turn row
#                       with embedded prompt bytes before the usage block,
#                       and a zero-token row.
#   wal.db, wal.db-wal  a database in WAL mode whose last generation is
#                       only in its WAL, followed by a frame of another
#                       WAL generation, which does not count.
#
# Run it here: sh make.sh
set -eu
cd "$(dirname "$0")"
rm -f conv.db wal.db wal.db-wal wal.db-shm tmp.db tmp.db-wal tmp.db-shm

python3 - <<'PY' | sqlite3 conv.db >/dev/null
def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7f
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)

def field(num, wt, val):
    tag = varint((num << 3) | wt)
    if wt == 0:
        return tag + varint(val)
    if wt == 2:
        return tag + varint(len(val)) + val
    raise ValueError(wt)

def ts_msg(sec):
    return field(1, 0, sec) + field(2, 0, 123000000)

def map_entry(k, v):
    return field(1, 2, k.encode()) + field(2, 2, v.encode())

def gen_blob(steps, prompt, cached, output, thinking, content, model, req_id, cascade_id, last_step=None, pad=0):
    f4 = b""
    if prompt: f4 += field(2, 0, prompt)
    if output: f4 += field(3, 0, output)
    if cached: f4 += field(5, 0, cached)
    if thinking: f4 += field(9, 0, thinking)
    if content: f4 += field(10, 0, content)
    f1 = b""
    if pad:
        f1 += field(1, 2, b"S" * pad)
        f1 += field(2, 2, b"M" * pad)
    f1 += field(4, 2, f4)
    if model:
        f1 += field(19, 2, model.encode())
    if req_id:
        f1 += field(20, 2, map_entry("request_id", req_id))
    if cascade_id:
        f1 += field(20, 2, map_entry("cascade_id", cascade_id))
    if last_step is not None:
        f1 += field(20, 2, map_entry("last_step_index", str(last_step)))
    packed = b"".join(varint(s) for s in steps)
    out = b""
    if packed:
        out += field(2, 2, packed)
    out += field(1, 2, f1)
    return out

def traj_blob(uri, sec):
    return field(1, 2, field(1, 2, uri.encode())) + field(2, 2, ts_msg(sec)) + field(7, 2, uri.encode())

def step_meta(sec):
    return field(1, 2, ts_msg(sec))

print("PRAGMA page_size = 512;")
print("PRAGMA journal_mode = WAL;")
print("CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT 'main', `data` blob, PRIMARY KEY (`id`));")
print("CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, `metadata` blob, `step_payload` blob, PRIMARY KEY (`idx`));")
print("CREATE TABLE `gen_metadata` (`idx` integer, `data` blob, `size` integer NOT NULL DEFAULT 0, PRIMARY KEY (`idx`));")
print("BEGIN;")

# Conversation starts 2026-11-14 10:00 UTC (1794650400) in project "my app"
day1 = 1794650400
day2 = 1794736800 # 2026-11-15 10:00 UTC
print(f"INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', X'{traj_blob('file:///Users/u/my%20app', day1).hex()}');")

# Steps on day 1 and day 2
steps = [
    (1, day1 + 60),
    (2, day1 + 120),
    (3, day2 + 60),
    (4, day2 + 120),
    (5, day2 + 180),
    (6, day2 + 240),
]
for idx, t in steps:
    print(f"INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES ({idx}, 15, X'{step_meta(t).hex()}', X'01');")

cid = "conv-uuid-1"
gens = [
    # Day 1: gemini-4-neon (thinking + content)
    (0, gen_blob([1], 10000, 50000, 1000, 400, 600, "gemini-4-neon", "req-0", cid, 0)),
    # Day 1: gemini-3.1-pro-preview > 200k prompt -> long tier (input 4, cached 0.4, output 18)
    (1, gen_blob([2], 50000, 200000, 500, 100, 400, "gemini-3.1-pro-preview", "req-1", cid, 1)),
    # Day 2: claude-opus-4-6-thinking -> Claude table (input 5, cached 0.5, output 25)
    (2, gen_blob([3], 2000, 10000, 300, 50, 250, "claude-opus-4-6-thinking", "req-2", cid, 2)),
    # Day 2: gemini-3.8-flash-n (output omitted, reconciled from thinking + content)
    (3, gen_blob([4], 4000, 8000, 0, 120, 180, "gemini-3.8-flash-n", "req-3", cid, 3)),
    # Day 2: unpriced model
    (4, gen_blob([5], 1000, 2000, 100, 0, 100, "gpt-oss-120b", "req-4", cid, 4)),
    # Day 2: empty/failed generation (zero tokens, skipped)
    (5, gen_blob([6], 0, 0, 0, 0, 0, "", "req-empty", cid, 5)),
    # Day 2: last turn with large embedded prompt before f4/f19 (spans overflow pages)
    (6, gen_blob([6], 3000, 20000, 200, 80, 120, "gemini-4-hydrogen", "req-5", cid, 6, pad=1200)),
]
for idx, blob in gens:
    print(f"INSERT INTO gen_metadata (idx, data, size) VALUES ({idx}, X'{blob.hex()}', {len(blob)});")
print("COMMIT;")
PY

# WAL fixture: one generation checkpointed, second generation only in WAL.
python3 - <<'PY' | sqlite3 tmp.db >/dev/null
def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7f
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)

def field(num, wt, val):
    tag = varint((num << 3) | wt)
    if wt == 0: return tag + varint(val)
    return tag + varint(len(val)) + val

def ts_msg(sec):
    return field(1, 0, sec)

def map_entry(k, v):
    return field(1, 2, k.encode()) + field(2, 2, v.encode())

def gen_blob(prompt, cached, output, model, req_id):
    f4 = field(2, 0, prompt) + field(3, 0, output) + field(5, 0, cached)
    f1 = field(4, 2, f4) + field(19, 2, model.encode()) + field(20, 2, map_entry("request_id", req_id))
    return field(1, 2, f1)

day2 = 1794736800
traj = field(2, 2, ts_msg(day2)) + field(7, 2, b"file:///work/wal-proj")
g0 = gen_blob(1000, 0, 100, "gemini-4-neon", "wal-req-0")
g1 = gen_blob(2000, 5000, 400, "gemini-4-neon", "wal-req-1")

print("PRAGMA page_size = 512;")
print("PRAGMA journal_mode = WAL;")
print("PRAGMA wal_autocheckpoint = 0;")
print("CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT 'main', `data` blob, PRIMARY KEY (`id`));")
print("CREATE TABLE `gen_metadata` (`idx` integer, `data` blob, `size` integer NOT NULL DEFAULT 0, PRIMARY KEY (`idx`));")
print(f"INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', X'{traj.hex()}');")
print(f"INSERT INTO gen_metadata (idx, data, size) VALUES (0, X'{g0.hex()}', {len(g0)});")
print("PRAGMA wal_checkpoint(TRUNCATE);")
print(f"INSERT INTO gen_metadata (idx, data, size) VALUES (1, X'{g1.hex()}', {len(g1)});")
print(".system cp tmp.db wal.db && cp tmp.db-wal wal.db-wal")
PY

rm -f tmp.db tmp.db-wal tmp.db-shm conv.db-wal conv.db-shm wal.db-shm
# A frame of another generation (other salts) after the last commit.
head -c 536 /dev/zero | tr '\0' '\1' >>wal.db-wal
