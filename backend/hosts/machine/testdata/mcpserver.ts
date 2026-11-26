// The mcp command on stdin and stdout, as a coding agent's CLI starts it
// (signals included), with a hub that gives every variable it is asked
// for: the tests that end a server with a signal run it (mcp.test.ts).
import { mcpCommand } from '../mcp.ts';
import { fakeHub } from '#features/vault/machine/testdata/fakehub.ts';

const hub = await fakeHub((req) => ({
  ok: true,
  values: Object.fromEntries((req.names ?? []).map((n) => [n, `secret-${n}`])),
}));
const code = await mcpCommand('mcp', ['--socket', hub.path]);
hub.close();
process.exit(code);
