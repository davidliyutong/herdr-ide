// Folders opened with the app: dropped on its Dock icon (the app declares
// folders in its Info.plist, electron-builder.cjs) or `open -a`. macOS reports
// them with open-file, also while the app launches, before the page can take
// them; the page creates a workspace for each on the local machine. They
// wait while no page takes them: the app is starting, or the page is
// reloading.

import type { OpenedFolders } from '../../web/src/shell';

export class FolderQueue {
  private waiting: OpenedFolders[] = [];
  private send?: (opened: OpenedFolders) => void;

  /** The folders of one request to open, and how many other items it had. */
  add(opened: OpenedFolders) {
    this.waiting.push(opened);
    this.deliver();
  }

  /** The page now takes folders through send; undefined: no page does. */
  takenBy(send: ((opened: OpenedFolders) => void) | undefined) {
    this.send = send;
    this.deliver();
  }

  private deliver() {
    if (!this.send) return;
    for (const opened of this.waiting.splice(0)) this.send(opened);
  }
}
