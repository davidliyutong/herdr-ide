// The recordings of spec/vectors/chat/claude replayed through the SDK with a
// fake Claude Code (testdata/fakeclaude.ts): what the host gets equals what
// the golden files of the same recordings have (testdata/golden), and the adapter wrote what the
// recordings have (the fake checks each line it waits for).
import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { SLUG } from '#shared/lib/brand.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { SDK_VERSION } from './sdk.ts';
import { TEST_SESSION, VECTORS, golden, goldenOf, isolateHome, replay } from './testing.ts';

isolateHome();

const files = readdirSync(VECTORS)
  .filter((f) => /^claude-\d.*\.jsonl$/.test(f))
  .sort();

describe('replays', () => {
  test('every recording has a golden file', () => {
    expect(files.length).toBeGreaterThanOrEqual(17);
  });

  for (const name of files)
    test(
      name,
      async () => {
        const resumed = name.includes('resume') || name.includes('07b') || name.includes('13-');
        const { r } = await replay(
          name,
          resumed
            ? (p) => {
                p.resume = TEST_SESSION;
                p.sessionId = '';
              }
            : undefined,
        );
        try {
          expect(r.mismatches()).toEqual([]);
          const got = goldenOf(r);
          const want = golden(name);
          expect(got.events).toEqual(want.events);
          expect(got.permissions).toEqual(want.permissions);
          expect(got.questions).toEqual(want.questions);
          expect(got.chat).toEqual(want.chat as never);
          // The SDK's command line: its arguments after the program's.
          const argv = r.argvs()[0]!;
          expect(argv).toContain('--output-format stream-json --verbose --input-format stream-json');
          expect(argv).toContain('--permission-prompt-tool=stdio');
          expect(argv).toContain('--setting-sources=user,project,local');
          expect(argv).toContain('--include-partial-messages');
          expect(argv).toContain(resumed ? `--resume=${TEST_SESSION}` : `--session-id=${TEST_SESSION}`);
          expect(argv).toContain('--permission-mode=default');
          expect(argv).not.toContain('dangerously');
          const env = r.records()[0]!.env as Record<string, string>;
          expect(env).toEqual({
            CLAUDE_AGENT_SDK_VERSION: SDK_VERSION,
            CLAUDE_CODE_ENTRYPOINT: SLUG,
            CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
            KEEP_ME: '1',
          });
        } finally {
          r.close();
        }
      },
      60_000,
    );
});

test('the plan approval states each mode the program is in', async () => {
  const { r } = await replay('claude-05-plan-mode.jsonl');
  try {
    expect(r.host.modes).toEqual([chat.Mode.Default, chat.Mode.Plan, chat.Mode.Default, chat.Mode.AcceptEdits, chat.Mode.Default]);
  } finally {
    r.close();
  }
}, 60_000);
