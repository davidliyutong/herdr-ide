// The deployment failures a machine's state carries (MachineState.failure,
// the hub's transport/errors.ts DeployCode) are explained in every
// locale; a code the UI does not know shows as it is. What a connecting
// machine's dial is doing (MachineState.deploy) says its step, and an
// upload its share.
import { beforeAll, describe, expect, test } from 'vitest';
import { setLocale } from '../i18n';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';
import { deployPercent, deployText, failureText } from '../lib/machine';

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

describe('deploy progress', () => {
  beforeAll(() => setLocale('en'));

  test('each step has its text in English and Chinese; an unknown one says nothing', () => {
    for (const step of ['probe', 'download', 'upload', 'install', 'start']) {
      expect(en[`machine.deploy.${step}` as keyof typeof en]).toBeTruthy();
      expect(zhCN[`machine.deploy.${step}` as keyof typeof zhCN]).toBeTruthy();
    }
    expect(deployText({ step: 'start' })).toBe('Starting the node…');
    expect(deployText({ step: 'later' as 'start' })).toBe('');
  });

  test('only an upload of known length has a share, bounded to 0-100', () => {
    expect(deployPercent({ step: 'upload', sent: 1, total: 3 })).toBe(33);
    expect(deployPercent({ step: 'upload', sent: 5, total: 3 })).toBe(100);
    expect(deployPercent({ step: 'upload', sent: 0 })).toBeUndefined();
    expect(deployPercent({ step: 'download' })).toBeUndefined();
  });
});
