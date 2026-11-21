// Uploads and downloads (docs/features/06-quick-look-and-files.md): their
// trays in the status bar. A part of the app that is always on.
import { ArrowDownUp } from 'lucide-react';
import { TransfersTray } from '../../components/Transfers';
import { DownloadsTray } from '../../components/Downloads';
import type { PluginDef } from '../api';

export const transfersPlugin: PluginDef = {
  id: 'transfers',
  title: 'plugins.transfers.title',
  description: 'plugins.transfers.description',
  icon: ArrowDownUp,
  enableSetting: null,
  statusItems: [
    { id: 'transfers.uploads', title: 'transfers.title', component: TransfersTray },
    { id: 'transfers.downloads', title: 'downloads.title', component: DownloadsTray },
  ],
};
