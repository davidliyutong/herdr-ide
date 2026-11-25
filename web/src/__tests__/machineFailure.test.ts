// The deployment failures a machine's state carries (MachineState.failure,
// the core's transport/errors.ts DeployCode) are explained in every
// locale; a code the UI does not know shows as it is.
import { beforeAll, describe, expect, test } from 'vitest';
import { setLocale } from '../i18n';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';
import { failureText } from '../lib/machine';

const CODES = ['platform_unsupported', 'cpu_unsupported', 'libs_missing', 'build_unavailable'];

describe('deployment failures', () => {
  beforeAll(() => setLocale('en'));

  test('each code has its explanation in English and Chinese', () => {
    for (const c of CODES) {
      expect(en[`machine.failure.${c}` as keyof typeof en]).toBeTruthy();
      expect(zhCN[`machine.failure.${c}` as keyof typeof zhCN]).toBeTruthy();
      expect(failureText(c)).toBe(en[`machine.failure.${c}` as keyof typeof en]);
    }
  });

  test('an unknown code shows as it is', () => {
    expect(failureText('something_new')).toBe('something_new');
  });
});
