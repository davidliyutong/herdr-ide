// Grammars Shiki does not ship.

import type { LanguageRegistration } from 'shiki/core';

/** Ignore files (`.gitignore` and its kin): a line starting with `#` is a
 * comment, a leading `!` negates a pattern. Patterns stay plain text. */
export const ignoreGrammar: LanguageRegistration = {
  name: 'ignore',
  scopeName: 'source.ignore',
  repository: {},
  patterns: [
    { name: 'comment.line.number-sign.ignore', match: '^\\s*#.*$' },
    { name: 'keyword.operator.negation.ignore', match: '^!' },
  ],
};
