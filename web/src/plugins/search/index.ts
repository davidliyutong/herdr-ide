// Project Search (docs/features/41-project-search.md): a panel of the
// right sidebar that searches the contents of the files below a folder of
// the shown machine, as VS Code's search view, and opens a match at its
// line. The core's side is backend/features/search, the machine's
// backend/features/search/machine.ts.
import { TextSearch } from 'lucide-react';
import type { PluginDef } from '../api';
import { SearchPanel } from './SearchPanel';

export const searchPlugin: PluginDef = {
  id: 'search',
  title: 'search.title',
  description: 'search.description',
  icon: TextSearch,
  panels: [{ id: 'search', title: 'search.title', icon: TextSearch, component: SearchPanel, command: 'view.panel.search' }],
};
