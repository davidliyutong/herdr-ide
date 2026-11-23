// The tests' fixtures: an isolated instance per test, a page of it in
// English that reaches nothing but the instance, and a terminal protocol
// client for what the page draws on canvases.

import { test as base, expect, type Page } from '@playwright/test';
import { Instance } from './instance';
import { SSHMachine, sshUnavailable } from './sshd';
import { TermClient } from './term';

interface Fixtures {
  instance: Instance;
  term: TermClient;
  app: Page;
  /** An SSH machine in a container for the instance (harness/sshd.ts);
   * the test skips without Docker. */
  sshd: SSHMachine;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  instance: async ({}, use, info) => {
    const inst = await Instance.start();
    try {
      await use(inst);
    } finally {
      if (info.status !== info.expectedStatus) await info.attach('core.log', { body: inst.logs(), contentType: 'text/plain' });
      await inst.stop();
    }
  },
  sshd: async ({ instance }, use, info) => {
    const why = sshUnavailable();
    info.skip(!!why, why);
    const m = await SSHMachine.start(instance);
    try {
      await use(m);
    } finally {
      if (info.status !== info.expectedStatus) {
        const log = await m.root('cat /var/log/sshd.log').catch((e) => String(e));
        await info.attach('sshd.log', { body: log, contentType: 'text/plain' });
      }
      await m.remove();
    }
  },
  term: async ({ instance }, use) => {
    const t = new TermClient(instance.baseURL);
    await use(t);
    t.close();
  },
  app: async ({ instance, context, page }, use) => {
    // Offline: the page reaches its own core and nothing else.
    const origin = new URL(instance.baseURL).origin;
    await context.route(
      (url) => !url.href.startsWith(origin + '/') && /^https?:/.test(url.protocol),
      (route) => route.abort(),
    );
    await page.goto(instance.baseURL + '/');
    await expect(page.getByRole('treeitem', { name: /local/ }).first()).toBeVisible();
    await expect(page.locator('.statusbar .conn.on')).toBeVisible();
    await use(page);
  },
});

export { expect };
