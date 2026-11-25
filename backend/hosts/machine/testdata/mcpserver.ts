// The mcp command on stdin and stdout, as a coding agent's CLI starts it
// (signals included), with a core that gives every variable it is asked
// for: the tests that end a server with a signal run it (mcp.test.ts).
import { mcpCommand } from '../mcp.ts';
import { fakeCore } from '#features/vault/machine/testdata/fakecore.ts';

const core = await fakeCore((req) => ({
  ok: true,
  values: Object.fromEntries((req.names ?? []).map((n) => [n, `secret-${n}`])),
}));
const code = await mcpCommand('mcp', ['--socket', core.path]);
core.close();
process.exit(code);
