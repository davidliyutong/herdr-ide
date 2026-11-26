// A fixed Claude Code stand-in for the documentation screenshot generator.
// It writes the process and transcript records the detector reads, shows a
// working screen until ./block exists, then waits at a permission prompt.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const id = '00000000-0000-4000-8000-000000000042';
const cwd = process.cwd();
const home = process.env.HOME!;
const escaped = cwd.replaceAll(/[^A-Za-z0-9]/g, '-');
const sessions = join(home, '.claude', 'sessions');
const project = join(home, '.claude', 'projects', escaped);
mkdirSync(sessions, { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(
  join(project, `${id}.jsonl`),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Review training stability' },
    cwd,
    sessionId: id,
    timestamp: '2026-11-26T11:42:00.000Z',
  }) + '\n',
);
writeFileSync(
  join(sessions, `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, sessionId: id, cwd, startedAt: Date.now() }) + '\n',
);

console.log('\x1b[2J\x1b[H Claude Code v2.1.316\n');
console.log(' Review training stability\n');
console.log(' ⏺ Analyzed train.py and configs/base.toml');
console.log(' ✻ Thinking… (3s · esc to interrupt)');

while (!existsSync('block')) await new Promise((resolve) => setTimeout(resolve, 100));
console.log('\x1b[2J\x1b[HDo you want to update train.py?\n');
console.log(' 324  if log_interval(step):');
console.log(' 325 -    print(f"step={step} loss={loss:.4f}")');
console.log(' 325 +    print(f"step={step} loss={loss:.4f} lr={lr:.1e}")\n');
console.log(' ❯ 1. Yes\n   2. Yes, and remember this choice\n   3. No');
setInterval(() => {}, 1000);
