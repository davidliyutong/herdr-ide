// Folders opened with the app: dropped on its Dock icon (the app declares
// folders in its Info.plist, electron-builder.cjs) or `open -a`. macOS reports
// them with open-file, also while the app launches, before the page can take
// them; the page creates a workspace for each on the local machine. They wait
// while no page takes them: the app is starting, or the page is reloading.

export class OpenedFolders {
  private waiting: string[] = [];
  private send?: (path: string) => void;

  /** A folder opened with the app. */
  add(path: string) {
    this.waiting.push(path);
    this.deliver();
  }

  /** The page now takes folders through send; undefined: no page does. */
  takenBy(send: ((path: string) => void) | undefined) {
    this.send = send;
    this.deliver();
  }

  private deliver() {
    if (!this.send) return;
    for (const path of this.waiting.splice(0)) this.send(path);
  }
}
