// The file explorer (docs/features/28-file-explorer.md): a panel of the
// right sidebar with the shown machine's files, and an editor pane for
// text files. The hub's side is backend/features/files, the machine's
// backend/features/files/machine.ts.
import { FilePen, Files } from 'lucide-react';
import type { PluginDef } from '../api';
import type { PluginView } from '../../term/layout';
import { t } from '../../i18n';
import { FilesPanel } from './FilesPanel';
import { EditorPane } from './EditorPane';
import { useFileGone } from './gone';
import { revealEntries } from './ops';
import { baseName, parentOf } from './tree';

export { registerFileDecorations, refreshDecorations } from './decorations';
export type { DecorationProvider, FileDecoration } from './decorations';

const pathOf = (v: PluginView) => (typeof v.path === 'string' ? v.path : '');

/** What a title says of a file gone from its machine (a hook, gone.ts). */
const goneNote = (m: string, path: string) => (useFileGone(m, path) ? t('files.gone') : undefined);

export const filesPlugin: PluginDef = {
  id: 'files',
  title: 'files.title',
  description: 'files.description',
  icon: Files,
  settings: { section: 'files' },
  // The previews' titles too, with the editors' checks (gone.ts).
  useFileGone: goneNote,
  panels: [{ id: 'files', title: 'files.title', icon: Files, component: FilesPanel, command: 'view.panel.files' }],
  paneViews: {
    editor: {
      icon: FilePen,
      title: (_m, v) => baseName(pathOf(v)) || 'editor',
      path: (_m, v) => pathOf(v) || undefined,
      directory: (_m, v) => (pathOf(v) ? parentOf(pathOf(v)) : undefined),
      preview: (_m, v) => v.preview === true,
      // A file deleted or moved away since: struck through, as in VS Code.
      useGone: (m, v) => goneNote(m, pathOf(v)),
      menu: (m, v) => (pathOf(v) ? revealEntries(m, pathOf(v)) : []),
      component: EditorPane,
    },
  },
};
