// The screenshot generator's loopback-only static server. It serves the
// fixed index.html of its working directory on 127.0.0.1:3000.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(readFileSync(join(process.cwd(), 'index.html')));
}).listen(3000, '127.0.0.1', () => console.log('ready'));
