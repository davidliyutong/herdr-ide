// The conversation view's English messages (web/src/conversation): the
// source of its message keys, gathered by web/src/i18n/en.ts.
// Split into timeline and composer modules for clean ownership.
import { composerEn } from './composer.en';
import { timelineEn } from './timeline.en';

export const en = {
  ...timelineEn,
  ...composerEn,
} as const;
