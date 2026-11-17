// The name of the way this page proves it is the user, for button texts.
import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { verifyUser, type Ways } from './proof';

/** "Touch ID", "Windows Hello" or "fingerprint or security key", by the
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
