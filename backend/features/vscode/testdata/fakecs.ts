// A stand-in for code-server's executable in the machine side's tests, run
// by Bun through a wrapper script (bin/code-server of a test release):
// argv[2] is a directory where it records what it was given.
//
//   --socket P …          serves HTTP on the unix socket P: GET / answers
//                         200 (404 with --broken: a code-server whose
//                         installation was moved away still listens and
//                         answers /healthz), until SIGTERM; records its
//                         argv and environment as serve.json.
//   --install-extension T records each T (and the content of a file T) in
//                         extensions.json, then exits; "fail" as T exits 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

const [record, ...args] = process.argv.slice(2);
const at = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const exts: Array<{ target: string; content?: string }> = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--install-extension') continue;
  const t = args[++i];
  let content: string | undefined;
  try {
    content = readFileSync(t, 'utf8');
  } catch {
    // an id
  }
  exts.push({ target: t, ...(content !== undefined ? { content } : {}) });
}
if (exts.length > 0) {
  writeFileSync(posix.join(record, 'extensions.json'), JSON.stringify({ args, exts }));
  console.log(`installed ${exts.map((e) => e.target).join(', ')}`);
  process.exit(exts.some((e) => e.target === 'fail') ? 1 : 0);
}

const socket = at('--socket');
if (!socket) {
  console.error('no --socket');
  process.exit(2);
}
const broken = args.includes('--broken');
const server = Bun.serve({
  unix: socket,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/healthz') return new Response('{"status":"alive"}');
    return broken ? new Response('not found', { status: 404 }) : new Response('workbench');
  },
});
writeFileSync(posix.join(record, broken ? 'broken.json' : 'serve.json'), JSON.stringify({ pid: process.pid, args, env: process.env }));
process.on('SIGTERM', () => {
  void server.stop(true);
  process.exit(0);
});
