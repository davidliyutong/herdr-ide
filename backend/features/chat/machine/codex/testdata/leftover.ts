// A command an app-server left running, for the adapter's tests: it
// ignores SIGTERM, writes its pid to the file its argument names, and
// sleeps until it is killed.
import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
writeFileSync(process.argv[2]!, String(process.pid), { mode: 0o600 });
setInterval(() => {}, 1 << 30);
