// Shared client-side snapshot of vault presets and their workspace links.
// Lives under state/ with zero plugin imports so workspaces, dialogs,
// terminals and chats can read linked presets without circular imports.
// Secret values never enter this store (or the browser at all).
import { create } from 'zustand';

export interface WorkspacePresetSummary {
  id: string;
  name: string;
  description?: string;
  variables: string[];
  groups: string[];
  /** Existing vault variable names resolved from variables + groups. */
  resolved: string[];
  /** Referenced variable names that no longer exist in the vault. */
  missing: string[];
}

export interface VaultPresetSyncInput {
  variables: ReadonlyArray<{ name: string; group?: string }>;
  presets: ReadonlyArray<{ id: string; name: string; description?: string; variables: string[]; groups: string[] }>;
  workspaceLinks: ReadonlyArray<{ machine: string; workspace: string; presets: string[] }>;
  locked: boolean;
  session: boolean;
  verifyEachAllow: boolean;
}

interface WorkspacePresetsState {
  presets: Record<string, WorkspacePresetSummary>;
  order: string[];
  /** Linked preset ids by workspaceKey(machine, workspace). */
  links: Record<string, string[]>;
  locked: boolean;
  session: boolean;
  verifyEachAllow: boolean;
  loaded: boolean;
}

const initial = (): WorkspacePresetsState => ({
  presets: {},
  order: [],
  links: {},
  locked: false,
  session: false,
  verifyEachAllow: false,
  loaded: false,
});

export const useWorkspacePresets = create<WorkspacePresetsState>(initial);

/** Key indexing a workspace's linked presets. */
export const workspaceKey = (machine: string, workspace: string): string => `${machine}\n${workspace}`;

/** Preset ids linked to (machine, workspace). */
export function workspacePresetIds(
  machine: string,
  workspace: string,
  links: Record<string, string[]> = useWorkspacePresets.getState().links,
): string[] {
  return links[workspaceKey(machine, workspace)] ?? [];
}

/** Human-readable names of the presets linked to (machine, workspace). */
export function workspacePresetNames(
  machine: string,
  workspace: string,
  state: Pick<WorkspacePresetsState, 'links' | 'presets'> = useWorkspacePresets.getState(),
): string[] {
  return workspacePresetIds(machine, workspace, state.links).map((id) => state.presets[id]?.name ?? id);
}

/** Resolves a preset's variables and groups against the known vault variables. */
export function resolvePresetSummary(
  preset: { id: string; name: string; description?: string; variables: string[]; groups: string[] },
  variables: ReadonlyArray<{ name: string; group?: string }>,
): WorkspacePresetSummary {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const byGroup = new Map<string, string[]>();
  for (const v of variables) {
    if (!v.group) continue;
    const list = byGroup.get(v.group) ?? [];
    list.push(v.name);
    byGroup.set(v.group, list);
  }
  const resolved: string[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  const seenMissing = new Set<string>();
  for (const gid of preset.groups) {
    for (const name of byGroup.get(gid) ?? []) {
      if (!seen.has(name)) {
        seen.add(name);
        resolved.push(name);
      }
    }
  }
  for (const name of preset.variables) {
    if (byName.has(name)) {
      if (!seen.has(name)) {
        seen.add(name);
        resolved.push(name);
      }
    } else if (!seenMissing.has(name)) {
      seenMissing.add(name);
      missing.push(name);
    }
  }
  return {
    id: preset.id,
    name: preset.name,
    ...(preset.description ? { description: preset.description } : {}),
    variables: preset.variables,
    groups: preset.groups,
    resolved,
    missing,
  };
}

/** Updates the shared snapshot from a vault list response. */
export function syncVaultWorkspacePresets(input: VaultPresetSyncInput): void {
  const presets: Record<string, WorkspacePresetSummary> = {};
  const order: string[] = [];
  for (const p of input.presets) {
    presets[p.id] = resolvePresetSummary(p, input.variables);
    order.push(p.id);
  }
  const links: Record<string, string[]> = {};
  for (const l of input.workspaceLinks) {
    if (l.presets.length) links[workspaceKey(l.machine, l.workspace)] = l.presets;
  }
  useWorkspacePresets.setState({
    presets,
    order,
    links,
    locked: input.locked,
    session: input.session,
    verifyEachAllow: input.verifyEachAllow,
    loaded: true,
  });
}

/** Clears the shared snapshot (tests). */
export function resetWorkspacePresets(): void {
  useWorkspacePresets.setState(initial());
}

type WorkspacePresetSaver = (machine: string, workspace: string, presets: string[], passphrase?: string) => Promise<void>;
let saver: WorkspacePresetSaver | undefined;

/** Registers the Vault plugin's save implementation so workspace dialogs can
 * persist preset links without importing the Vault plugin. */
export function registerWorkspacePresetSaver(fn: WorkspacePresetSaver | undefined): void {
  saver = fn;
}

/** Persists the linked presets for (machine, workspace) via the Vault plugin. */
export async function saveWorkspacePresets(machine: string, workspace: string, presets: string[], passphrase?: string): Promise<void> {
  if (!saver) return;
  await saver(machine, workspace, presets, passphrase);
}
