// In-app dialogs replacing the browser's confirm() and prompt(): callers
// await a result, Dialogs.tsx renders the request. One dialog is shown at a
// time; a new request cancels the previous one.

import { create } from 'zustand';

export interface NewWorkspace {
  cwd: string;
  label: string;
}

export type DialogRequest =
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; resolve(ok: boolean): void }
  | { kind: 'newWorkspace'; m: string; cwd: string; resolve(v: NewWorkspace | undefined): void };

export const useDialog = create<{ current?: DialogRequest }>(() => ({}));

function show(req: DialogRequest) {
  const prev = useDialog.getState().current;
  if (prev?.kind === 'confirm') prev.resolve(false);
  else if (prev) prev.resolve(undefined);
  useDialog.setState({ current: req });
}

/** Closes the dialog shown for req (if it still is). */
export function closeDialog(req: DialogRequest) {
  if (useDialog.getState().current === req) useDialog.setState({ current: undefined });
}

export function confirmDialog(opts: { title: string; message: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => show({ kind: 'confirm', ...opts, resolve }));
}

/** Asks for the working directory and name of a new workspace on machine m. */
export function newWorkspaceDialog(m: string, cwd: string): Promise<NewWorkspace | undefined> {
  return new Promise((resolve) => show({ kind: 'newWorkspace', m, cwd, resolve }));
}

/** Splits a typed path into the directory to list and the name prefix to
 * match: "~/src/we" → ["~/src", "we"], "/opt/" → ["/opt", ""]. */
export function completionParts(value: string): [dir: string, prefix: string] {
  const i = value.lastIndexOf('/');
  if (i < 0) return [value === '~' ? '~' : '', value === '~' ? '' : value];
  return [value.slice(0, i) || '/', value.slice(i + 1)];
}
