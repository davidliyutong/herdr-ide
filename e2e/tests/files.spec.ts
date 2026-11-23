import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../harness/fixtures';
import { cdInTerminal, explorer, mod, newTerminalTab, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';

test.beforeEach(async ({ instance }) => {
  mkdirSync(join(instance.work, 'docs', 'deep'), { recursive: true });
  writeFileSync(join(instance.work, 'notes.txt'), 'first line\n');
  writeFileSync(join(instance.work, 'docs', 'deep', 'inner.md'), '# Inner\n');
});

test('the explorer follows the terminal, opens files and copies with the keyboard', async ({ app, instance, term, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await newTerminalTab(app);
  await cdInTerminal(app, term, await terminalOfPane(term, 1), instance.work);
  const tree = await explorer(app);
  await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toBeVisible();
  await expect(app.getByRole('navigation', { name: 'Folder shown' })).toHaveAttribute('title', instance.work);

  // A click shows the file in the preview editor and keeps the keyboard in the tree.
  await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
  await expect(app.getByRole('tab', { name: /notes\.txt/ })).toBeVisible();
  await expect(tree).toBeFocused();

  // Copy and paste on the tree: a copy beside it, named as Finder names it.
  await app.keyboard.press(`${mod}+c`);
  await app.keyboard.press(`${mod}+v`);
  await expect(tree.getByRole('treeitem', { name: 'notes copy.txt' })).toBeVisible();
  expect(readFileSync(join(instance.work, 'notes copy.txt'), 'utf8')).toBe('first line\n');

  // A file made outside the page shows with the next poll.
  writeFileSync(join(instance.work, 'later.txt'), '');
  await expect(tree.getByRole('treeitem', { name: 'later.txt' })).toBeVisible();
});

test('the explorer reveals the file of the editor shown again', async ({ app, instance, term }) => {
  await newTerminalTab(app);
  await cdInTerminal(app, term, await terminalOfPane(term, 1), instance.work);
  const tree = await explorer(app);
  await tree.getByRole('treeitem', { name: 'docs' }).click();
  await tree.getByRole('treeitem', { name: 'deep' }).click();
  await tree.getByRole('treeitem', { name: 'inner.md' }).dblclick();
  const editorTab = app.getByRole('tab', { name: /inner\.md/ });
  await expect(editorTab).toHaveAttribute('aria-selected', 'true');

  // Folded away, then the editor's tab shown again: the tree opens the
  // folders that lead to its file and selects it.
  await app.getByRole('button', { name: 'Collapse Folders' }).click();
  await expect(tree.getByRole('treeitem', { name: 'inner.md' })).toHaveCount(0);
  await app.getByRole('tab', { name: /^Tab 1/ }).click();
  await editorTab.click();
  const row = tree.getByRole('treeitem', { name: 'inner.md' });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByRole('navigation', { name: 'Folder shown' })).toHaveAttribute('title', instance.work);
});

test('New File creates the file on the machine and the tree selects it', async ({ app, instance, term }) => {
  await newTerminalTab(app);
  await cdInTerminal(app, term, await terminalOfPane(term, 1), instance.work);
  const tree = await explorer(app);
  await expect(tree.getByRole('treeitem', { name: 'notes.txt' })).toBeVisible();
  await app.getByRole('button', { name: 'New File…' }).click();
  await app.keyboard.type('fresh.ts');
  await app.keyboard.press('Enter');
  await waitFor(() => existsSync(join(instance.work, 'fresh.ts')), { what: 'fresh.ts on disk' });
  await expect(tree.getByRole('treeitem', { name: 'fresh.ts' })).toBeVisible();
});

test('the editor keeps its undo history while its tab is not shown', async ({ app, instance, term }) => {
  await newTerminalTab(app);
  await cdInTerminal(app, term, await terminalOfPane(term, 1), instance.work);
  const tree = await explorer(app);
  await tree.getByRole('treeitem', { name: 'notes.txt' }).dblclick();
  const editorTab = app.getByRole('tab', { name: /notes\.txt/ });
  await expect(editorTab).toHaveAttribute('aria-selected', 'true');
  const lines = app.locator('.files-editor .monaco-editor .view-lines');
  await expect(lines).toContainText('first line');

  // Typed and saved: the text is clean, and undo still takes the typing back.
  await lines.click();
  await app.keyboard.press(`${mod}+End`);
  await app.keyboard.type('typed');
  await app.keyboard.press(`${mod}+s`);
  await waitFor(() => readFileSync(join(instance.work, 'notes.txt'), 'utf8').includes('typed'), { what: 'the saved text' });
  await expect(app.locator('.files-dirty')).toHaveCount(0);

  // Another tab and back: the editor is mounted again.
  await app.getByRole('tab', { name: /^Tab 1/ }).click();
  await editorTab.click();
  await expect(lines).toContainText('typed');
  await lines.click();
  await app.keyboard.press(`${mod}+z`);
  await expect(lines).not.toContainText('typed');
  await expect(app.locator('.files-dirty')).toHaveCount(1);
  await app.keyboard.press(`${mod}+Shift+z`);
  await expect(lines).toContainText('typed');
});

test('a file opened again has the undo history it had when its editor closed', async ({ app, instance, term }) => {
  await newTerminalTab(app);
  await cdInTerminal(app, term, await terminalOfPane(term, 1), instance.work);
  const tree = await explorer(app);
  await tree.getByRole('treeitem', { name: 'notes.txt' }).dblclick();
  const editorTab = app.getByRole('tab', { name: /notes\.txt/ });
  const lines = app.locator('.files-editor .monaco-editor .view-lines');
  await expect(lines).toContainText('first line');
  await lines.click();
  await app.keyboard.press(`${mod}+End`);
  await app.keyboard.type('typed');
  await app.keyboard.press(`${mod}+s`);
  await waitFor(() => readFileSync(join(instance.work, 'notes.txt'), 'utf8').includes('typed'), { what: 'the saved text' });

  await editorTab.getByRole('button', { name: /close/i }).click();
  await expect(editorTab).toHaveCount(0);
  await tree.getByRole('treeitem', { name: 'notes.txt' }).dblclick();
  await expect(lines).toContainText('typed');
  await lines.click();
  await app.keyboard.press(`${mod}+z`);
  await expect(lines).not.toContainText('typed');
});
