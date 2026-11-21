#!/bin/sh
# Makes the OpenCode databases of cost_test.go's TestOpenCode* with the
# sqlite3 shell (the tests read them without SQLite):
#
#   opencode.db         OpenCode's tables as its migrations leave them (a
#                       column added later), 512-byte pages so that its
#                       message table has interior pages and its records
#                       overflow pages: 37 answers of three models over two
#                       days, prompts, an answer with a long error, one
#                       without tokens, a prompt that names an assistant.
#   wal.db, wal.db-wal  a database in WAL mode whose last commits are only
#                       in its WAL (an answer added, another's tokens
#                       written when its step ended), then a frame of
#                       another WAL generation, which does not count.
#
# Run it here: sh make.sh
set -eu
cd "$(dirname "$0")"
rm -f opencode.db wal.db wal.db-wal wal.db-shm tmp.db tmp.db-wal tmp.db-shm

schema() {
	cat <<'EOF'
PRAGMA page_size = 512;
PRAGMA journal_mode = WAL;
CREATE TABLE `project` (`id` text PRIMARY KEY, `worktree` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL);
CREATE TABLE `session` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `directory` text NOT NULL, `title` text NOT NULL,
	`time_created` integer NOT NULL, `time_updated` integer NOT NULL);
CREATE TABLE `message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE TABLE `credential` (`id` text PRIMARY KEY, `value` text NOT NULL);
INSERT INTO credential VALUES ('c1', 'fixture-credential');
EOF
}

# answer ID SECONDS PROVIDER MODEL COST CWD [OUTPUT]: input 100, output
# OUTPUT (20) without the reasoning 5, cache reads 1000 and writes 10.
answer() {
	printf "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('%s', 'ses_1', %s000, %s000, json_object(
	'role', 'assistant', 'time', json_object('created', %s000, 'completed', %s500), 'parentID', 'msg_p', 'modelID', '%s', 'providerID', '%s',
	'mode', 'build', 'agent', 'build', 'path', json_object('cwd', '%s', 'root', '%s'), 'cost', %s,
	'tokens', json_object('total', 0, 'input', 100, 'output', %s, 'reasoning', 5, 'cache', json_object('read', 1000, 'write', 10)), 'finish', 'stop'));\n" \
		"$1" "$2" "$2" "$2" "$2" "$4" "$3" "$6" "$6" "$5" "${7:-20}"
}

# From 2026-11-14 10:00 UTC, an answer an hour: Claude through Anthropic's
# API (recorded free), DeepSeek (a recorded cost), a coding plan (free).
{
	schema
	echo "BEGIN;"
	i=1
	while [ $i -le 36 ]; do
		t=$((1794646800 + i * 3600))
		dir=/home/u/proj-a
		[ $((i % 2)) -eq 1 ] && dir=/home/u/proj-b
		case $((i % 3)) in
		0) answer "msg_a$i" $t anthropic claude-opus-4-5-20251101 0 $dir ;;
		1) answer "msg_a$i" $t deepseek deepseek-v4-flash 0.001 $dir ;;
		2) answer "msg_a$i" $t bailian-coding-plan glm-5 0 $dir ;;
		esac
		i=$((i + 1))
	done
	# Prompts, each longer than a page.
	i=1
	while [ $i -le 12 ]; do
		t=$((1794646800 + i * 3600 - 60))
		printf "INSERT INTO message VALUES ('msg_u%s', 'ses_1', %s000, %s000, json_object('role', 'user', 'time', json_object('created', %s000), 'text', replace(hex(zeroblob(900)), '00', 'ab')));\n" $i $t $t $t
		i=$((i + 1))
	done
	# A prompt that names an assistant, an answer without tokens, and one
	# whose long error spans several overflow pages.
	echo "INSERT INTO message VALUES ('msg_u99', 'ses_1', 1794700000000, 1794700000000, json_object('role', 'user', 'time', json_object('created', 1794700000000), 'text', 'you are an \"assistant\"', 'tokens', json_object('input', 9999)));"
	echo "INSERT INTO message VALUES ('msg_z', 'ses_1', 1794700000000, 1794700000000, json_object('role', 'assistant', 'time', json_object('created', 1794700000000), 'modelID', 'glm-5', 'providerID', 'bailian-coding-plan', 'cost', 0, 'tokens', json_object('input', 0, 'output', 0, 'reasoning', 0, 'cache', json_object('read', 0, 'write', 0))));"
	echo "INSERT INTO message VALUES ('msg_e', 'ses_1', 1794710000000, 1794710000000, json_object('role', 'assistant', 'time', json_object('created', 1794710000000), 'modelID', 'deepseek-v4-flash', 'providerID', 'deepseek', 'cost', 0.5, 'path', json_object('cwd', '/home/u/proj-a'), 'tokens', json_object('input', 7, 'output', 3, 'reasoning', 0, 'cache', json_object('read', 0, 'write', 0)), 'error', json_object('name', 'APIError', 'message', replace(hex(zeroblob(1500)), '00', 'e!'))));"
	# A column added by a later migration: the rows before have none.
	echo 'ALTER TABLE message ADD `extra` text;'
	answer msg_a37 1794780000 deepseek deepseek-v4-flash 0.001 /home/u/proj-a
	echo "COMMIT;"
} | sqlite3 opencode.db >/dev/null

# The WAL: two answers in the database, then commits left in the WAL.
{
	schema
	echo "PRAGMA wal_autocheckpoint = 0;"
	answer msg_w1 1794733200 deepseek deepseek-v4-flash 0.001 /home/u/proj-a
	answer msg_w2 1794736800 deepseek deepseek-v4-flash 0.001 /home/u/proj-a
	echo "PRAGMA wal_checkpoint(TRUNCATE);"
	answer msg_w3 1794740400 moonshotai kimi-k2.5 0.002 /home/u/proj-c
	echo "UPDATE message SET data = json_set(data, '\$.tokens.output', 500) WHERE id = 'msg_w2';"
	echo ".system cp tmp.db wal.db && cp tmp.db-wal wal.db-wal"
} | sqlite3 tmp.db >/dev/null
rm -f tmp.db tmp.db-wal tmp.db-shm
# A frame of another generation (other salts) after the last commit.
head -c 536 /dev/zero | tr '\0' '\1' >>wal.db-wal
# What the shell leaves of a closed database (macOS keeps an empty WAL).
rm -f opencode.db-wal opencode.db-shm wal.db-shm
