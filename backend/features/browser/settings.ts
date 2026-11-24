// The browser pane's settings (its page in Settings › Plugins).
import { defineModule, enumOf, int } from '#kernel/config/settings/index.ts';

const section = 'browser';

/** browser.forwardIdle's default, in minutes. */
export const DEFAULT_IDLE = 30;

export const settings = defineModule({
  sections: [{ id: section, order: 65, plugin: 'browser' }],
  settings: {
    /** Where a web link clicked in a terminal or a document opens: loopback
     * (the default) opens a loopback address in a browser pane, a remote
     * machine's through a forward, and any other address in the browser
     * outside the app; all opens every address a pane can show in one (the
     * desktop app shows any), the rest outside; external opens every
     * address outside the app. The web UI reads it. */
    'browser.openLinks': enumOf(['loopback', 'all', 'external'], { default: 'loopback', section, order: 10 }),
    /** How many minutes a forward stays unused before it ends (0: until it
     * is stopped). A use is a connection accepted, bytes carried, or a
     * client asking for the forward; a connection that only stays open is
     * none. */
    'browser.forwardIdle': int({ default: DEFAULT_IDLE, min: 0, max: 1440, section, order: 20 }),
  },
});
