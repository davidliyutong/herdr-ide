// The name of the way this page proves it is the user, for button texts,
// and whether the desktop app can keep a key that unlocks the vault.
import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { verifyUser, type UnlockWays, type Ways } from './proof';

/** "Touch ID", "Windows Hello" or "biometrics or security key", by the
 * way offered (the app's prompt first). */
export function useWayName(ways: Ways): string {
  const [prompt, setPrompt] = useState<'touchid' | 'hello' | null>(null);
  useEffect(() => {
    let live = true;
    if (ways.desktop)
      void verifyUser()
        ?.available()
        .then(
          (a) => live && setPrompt(a),
          () => {},
        );
    return () => {
      live = false;
    };
  }, [ways.desktop]);
  return wayName(ways.desktop ? prompt : null);
}

export function wayName(prompt: 'touchid' | 'hello' | null): string {
  return prompt === 'touchid' ? t('vault.way.touchid') : prompt === 'hello' ? t('vault.way.hello') : t('vault.way.webauthn');
}

/** Whether the desktop app can keep this install's unlock key (the Secure
 * Enclave with Touch ID, a Windows Hello key); false outside the app and
 * until it answered. */
export function useCanUnlock(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    let live = true;
    void verifyUser()
      // An app of an older build has no unlock keys.
      ?.canUnlock?.()
      .then(
        (c) => live && setCan(c === true),
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);
  return can;
}

/** The name of the way a locked vault unlocks here (the app's key first). */
export function unlockWayName(w: UnlockWays): string {
  return wayName(w.desktop === 'enclave' ? 'touchid' : w.desktop === 'hello' ? 'hello' : null);
}
