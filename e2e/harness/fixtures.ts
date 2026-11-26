// The tests' fixtures: an isolated instance per test, a page of it in
// English that reaches nothing but the instance, a terminal protocol
// client for what the page draws on canvases, and the desktop app on an
// instance of its own.

import { test as base, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { Desktop, desktopUnavailable, type DesktopOptions } from './desktop';
import { Instance } from './instance';
import { SSHMachine, sshUnavailable } from './sshd';
import { TermClient } from './term';

interface Fixtures {
  instance: Instance;
  /** What the instance fixture launches with (test.use). */
  instanceOptions: { settings?: Record<string, unknown>; codeServerSeed?: string };
  term: TermClient;
  app: Page;
  /** An SSH machine in a container for the instance (harness/sshd.ts);
   * the test skips without Docker. */
  sshd: SSHMachine;
  /** What the SSH fixture launches (test.use). */
  sshdOptions: { image?: string };
  /** What the desktop fixture launches the app with (test.use). */
  desktopOptions: DesktopOptions;
  /** The desktop app on an instance of its own (harness/desktop.ts); the
   * test skips where it is not built or has no display. */
  desktop: Desktop;
}

export const test = base.extend<Fixtures>({
  instanceOptions: [{}, { option: true }],
  instance: async ({ instanceOptions }, use, info) => {
    const inst = await Instance.start(instanceOptions);
    try {
      await use(inst);
    } finally {
      if (info.status !== info.expectedStatus) {
        await info.attach('hub.log', { body: inst.logs(), contentType: 'text/plain' });
        writeFileSync(info.outputPath('hub.log'), inst.logs());
      }
      await inst.stop();
    }
  },
  sshdOptions: [{}, { option: true }],
  sshd: async ({ instance, sshdOptions }, use, info) => {
    const why = sshUnavailable();
    info.skip(!!why, why);
    const m = await SSHMachine.start(instance, sshdOptions);
    try {
      await use(m);
    } finally {
      if (info.status !== info.expectedStatus) {
        const log = await m.root('cat /var/log/sshd.log').catch((e) => String(e));
        await info.attach('sshd.log', { body: log, contentType: 'text/plain' });
        // The machine's nodes' logs (in its host directories) and processes.
        const nodes = await m.root('cat /home/*/.*/hosts/*/node.log 2>&1; ps -o pid,args').catch((e) => String(e));
        await info.attach('machine.log', { body: nodes, contentType: 'text/plain' });
        writeFileSync(info.outputPath('machine.log'), nodes);
      }
      await m.remove();
    }
  },
  desktopOptions: [{}, { option: true }],
  desktop: async ({ desktopOptions }, use, info) => {
    const why = desktopUnavailable();
    info.skip(!!why, why);
    const d = await Desktop.launch(desktopOptions);
    try {
      await use(d);
    } finally {
      if (info.status !== info.expectedStatus) {
        await info.attach('app.log', { body: d.logs(), contentType: 'text/plain' });
        writeFileSync(info.outputPath('app.log'), d.logs());
      }
      await d.close();
    }
  },
  term: async ({ instance }, use) => {
    const t = new TermClient(instance.baseURL);
    await use(t);
    t.close();
  },
  app: async ({ instance, context, page }, use) => {
    // Offline: the page reaches its own hub and nothing else.
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
