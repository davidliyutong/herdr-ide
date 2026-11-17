// The roles of code's tokens. Shiki colors with one theme, whose colors
// are not colors but stand for roles: a token of a keyword gets the
// keyword's placeholder, and the page gives each role the color of the
// design tokens (--ds-syntax-*) in the theme in use. Text is therefore
// tokenized once, whichever theme shows it, and the editor, the previews
// and rendered Markdown share the grammars and the colors.

import type { ThemeRegistration } from 'shiki/core';

export const ROLES = [
  'comment',
  'keyword',
  'string',
  'number',
  'type',
  'function',
  'property',
  'tag',
  'attribute',
  'delimiter',
  'regexp',
  'heading',
  'strong',
  'emphasis',
  'link',
  'inserted',
  'deleted',
  'changed',
] as const;

export type Role = (typeof ROLES)[number];

/** The TextMate scopes of each role; the most specific selector wins, as in
 * any theme. */
const SCOPES: Record<Role, string[]> = {
  comment: ['comment', 'punctuation.definition.comment', 'string.comment'],
  keyword: [
    'keyword',
    'storage',
    'storage.type',
    'storage.modifier',
    'variable.language',
    'keyword.operator.new',
    'keyword.operator.expression',
    'keyword.operator.word',
    'keyword.operator.wordlike',
    'keyword.operator.logical.python',
    'keyword.other',
  ],
  string: ['string', 'punctuation.definition.string', 'markup.inline.raw'],
  number: [
    'constant.numeric',
    'constant.language',
    'constant.character',
    'constant.other',
    'support.constant',
    'variable.other.enummember',
    'keyword.other.unit',
  ],
  type: [
    'entity.name.type',
    'entity.name.class',
    'entity.name.namespace',
    'entity.name.struct',
    'entity.name.enum',
    'entity.name.interface',
    'entity.name.scope-resolution',
    'entity.other.inherited-class',
    'support.type',
    'support.class',
    // Grammars that call the names of types storage.
    'storage.type.java',
    'storage.type.generic.java',
    'storage.type.object.array.java',
    'storage.type.cs',
    'storage.type.groovy',
  ],
  function: ['entity.name.function', 'support.function', 'variable.function', 'meta.function-call.generic', 'entity.name.command'],
  property: [
    'variable.other.property',
    'variable.other.object.property',
    'support.type.property-name',
    'punctuation.support.type.property-name',
    'meta.object-literal.key',
    'entity.name.tag.yaml',
    'variable.other.key',
    'variable.key',
    'keyword.other.definition.ini',
    'entity.name.section.group-title.ini',
  ],
  tag: ['entity.name.tag', 'meta.tag.sgml', 'punctuation.definition.tag'],
  attribute: [
    'entity.other.attribute-name',
    'meta.decorator',
    'entity.name.function.decorator',
    'punctuation.decorator',
    'meta.preprocessor',
    'meta.attribute',
    'keyword.control.directive',
    'entity.name.function.preprocessor',
    'storage.type.annotation',
    'punctuation.definition.annotation',
  ],
  delimiter: ['keyword.operator', 'punctuation', 'meta.brace', 'meta.delimiter'],
  regexp: ['string.regexp', 'constant.character.escape', 'constant.other.placeholder', 'constant.character.format.placeholder'],
  heading: ['markup.heading', 'entity.name.section', 'meta.diff.header', 'meta.diff.index'],
  strong: ['markup.bold'],
  emphasis: ['markup.italic', 'markup.quote'],
  link: ['markup.underline.link', 'string.other.link', 'meta.link'],
  inserted: ['markup.inserted', 'punctuation.definition.inserted'],
  deleted: ['markup.deleted', 'punctuation.definition.deleted', 'invalid'],
  changed: ['markup.changed', 'punctuation.definition.changed', 'meta.diff.range'],
};

/** Scopes whose text has no role though it lies within text that has one:
 * a variable or an expression inside a string, code embedded in a
 * document, the names of an import. */
const PLAIN = [
  'variable',
  'meta.template.expression',
  'meta.embedded',
  'meta.interpolation',
  'storage.modifier.import',
  'storage.modifier.package',
];

/** The color of text without a role. */
const NONE = '#000000';

const placeholder = (i: number) => `#0000${(i + 1).toString(16).padStart(2, '0')}`;

export const ROLE_THEME = 'roles';

/** The theme Shiki tokenizes with: a placeholder per role, and text
 * without a role in its default color (which stands for none). */
export const roleTheme: ThemeRegistration = {
  name: ROLE_THEME,
  type: 'dark',
  colors: { 'editor.foreground': NONE, 'editor.background': '#ffffff' },
  tokenColors: [
    { scope: PLAIN, settings: { foreground: NONE } },
    ...ROLES.map((role, i) => ({ scope: SCOPES[role], settings: { foreground: placeholder(i) } })),
  ],
};

const byColor = new Map<string, Role>(ROLES.map((role, i) => [placeholder(i), role]));

/** The role a color of the role theme stands for; none for other text. */
export function roleOfColor(color: string | undefined): Role | undefined {
  return color ? byColor.get(color.toLowerCase()) : undefined;
}

/** The design token of each role's color. Markup's roles take the color of
 * a kindred role and a style of their own (highlight.css, the editor's
 * rules). */
export const ROLE_TOKEN: Record<Role, string> = {
  comment: '--ds-syntax-comment',
  keyword: '--ds-syntax-keyword',
  string: '--ds-syntax-string',
  number: '--ds-syntax-number',
  type: '--ds-syntax-type',
  function: '--ds-syntax-function',
  property: '--ds-syntax-property',
  tag: '--ds-syntax-tag',
  attribute: '--ds-syntax-attribute',
  delimiter: '--ds-syntax-delimiter',
  regexp: '--ds-syntax-regexp',
  heading: '--ds-syntax-function',
  strong: '--ds-color-foreground',
  emphasis: '--ds-color-foreground',
  link: '--ds-syntax-property',
  inserted: '--ds-git-added',
  deleted: '--ds-git-deleted',
  changed: '--ds-git-modified',
};

/** The font style of the roles that have one. */
export const ROLE_STYLE: Partial<Record<Role, 'bold' | 'italic' | 'underline'>> = {
  heading: 'bold',
  strong: 'bold',
  emphasis: 'italic',
  link: 'underline',
};
