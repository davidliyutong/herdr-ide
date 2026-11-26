// The vault's settings (its page in Settings, under the plugins): how long
// things wait and last, and what run_with_env's commands may take.
import { defineModule, int } from '#kernel/config/settings/index.ts';

const number = (def: number, min: number, max: number, order: number, group?: string) =>
  int({ default: def, min, max, section: 'vault', order, ...(group ? { group } : {}) });

export const settings = defineModule({
  sections: [{ id: 'vault', order: 69, plugin: 'vault' }],
  settings: {
    /** Seconds a request waits for the user's answer. */
    'vault.approvalTimeout': number(60, 10, 600, 10),
    /** Minutes without use after which the vault locks (0: never). */
    'vault.autoLock': number(60, 0, 1440, 20),
    /** Days after the passphrase that an authenticator may unlock. */
    'vault.passphraseDays': number(14, 1, 90, 25),
    /** A page's session ends unused for these minutes, or these hours
     * after it began. */
    'vault.sessionIdle': number(30, 1, 240, 30, 'vaultSessions'),
    'vault.sessionMax': number(12, 1, 24, 31, 'vaultSessions'),
    /** run_with_env's default and longest timeout (seconds), and the KiB
     * of output it returns. */
    'vault.runTimeout': number(120, 5, 3600, 40, 'vaultRun'),
    'vault.runMaxTimeout': number(600, 5, 3600, 41, 'vaultRun'),
    'vault.runOutput': number(64, 4, 1024, 42, 'vaultRun'),
  },
});
