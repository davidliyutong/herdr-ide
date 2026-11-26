// Compiled by installed.test.ts with `bun build --compile`: loads the Agent
// SDK installed in a data directory (argv: the directory, the pin as JSON)
// as the chat host does, and has its query() write initialize to a program
// that is two pipes (no process runs), printing what it wrote.
import { PassThrough } from 'node:stream';
import { installedSdk } from '../load.ts';

const [base, pin] = process.argv.slice(2);
const sdk = await installedSdk(base!, JSON.parse(pin!)).load();
const stdin = new PassThrough();
const stdout = new PassThrough();
const q = sdk.query({
  prompt: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
  options: {
    pathToClaudeCodeExecutable: '/nonexistent/claude',
    spawnClaudeCodeProcess: () => ({
      stdin,
      stdout,
      killed: false,
      exitCode: null,
      kill: () => true,
      on: () => {},
      once: () => {},
      off: () => {},
    }),
  },
});
for await (const b of stdin) {
  console.log(String(b).split('\n')[0]);
  break;
}
q.close();
process.exit(0);
