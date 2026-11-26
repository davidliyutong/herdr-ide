// The Git feature's settings (its page in Settings › Plugins), which the
// web UI reads (web/src/plugins/git, web/src/eol.ts).
import { bool, defineModule, enumOf, int } from '#kernel/config/settings/index.ts';

const section = 'git';

export const settings = defineModule({
  sections: [{ id: section, order: 67, plugin: 'git' }],
  settings: {
    /** What editors and diffs do with a file whose lines end in more than
     * one way (LF and CRLF): keep each line's ending, unify them, or open
     * the file read-only. */
    'git.mixedLineEndings': enumOf(['keep', 'unify', 'readOnly'], { default: 'keep', section, order: 10 }),
    /** Source Control's changes as a list or a tree. */
    'git.changesView': enumOf(['list', 'tree'], { default: 'list', section, order: 20 }),
    /** Untracked files among the changes or in a group of their own. */
    'git.untrackedChanges': enumOf(['mixed', 'separate'], { default: 'mixed', section, order: 21 }),
    /** Minutes between fetches of every remote while the panel shows a
     * repository (0: never). */
    'git.autoFetch': int({ default: 0, min: 0, max: 240, section, order: 30 }),
    /** Ask before pulling, pushing or synchronizing. */
    'git.confirmSync': bool({ default: false, section, order: 31 }),
    /** The commits a page of the graph pane reads (the machine's pages are
     * at most 1000). */
    'git.graphPageSize': int({ default: 300, min: 50, max: 1000, step: 50, section, order: 40 }),
  },
});
