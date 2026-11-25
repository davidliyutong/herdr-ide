// Who a request is to the command line's core: every client is a browser,
// whatever the request carries (the desktop app runs a core of its own in
// process; SECURITY.md, "Content on the UI's origin").

import { paths } from '../harness/paths';
import { expect, test } from '../harness/fixtures';

test("every client of the command line's core is a browser, also with the cookie that marked the desktop app's requests", async ({
  instance,
}) => {
  const client = async (headers: Record<string, string>) =>
    ((await (await fetch(instance.baseURL + '/api/config', { headers })).json()) as { client: string }).client;
  expect(await client({})).toBe('browser');
  expect(await client({ Cookie: `${paths.slug}-desktop=${'a'.repeat(43)}` })).toBe('browser');
});
