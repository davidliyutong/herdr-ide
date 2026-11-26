// The conversation view's Chinese messages.
import type { en } from './en';
import { composerZhCN } from './composer.zh-CN';
import { timelineZhCN } from './timeline.zh-CN';

export const zhCN: Record<keyof typeof en, string> = {
  ...timelineZhCN,
  ...composerZhCN,
};
