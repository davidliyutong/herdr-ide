import { describe, expect, it } from 'vitest';
import {
  continueMarkdownLine,
  handleMarkdownKey,
  indentMarkdownLines,
  insertMarkdownLink,
  wrapMarkdownSelection,
} from '../conversation/markdownEdit';

describe('continueMarkdownLine', () => {
  it('continues unordered lists and clears empty markers', () => {
    expect(continueMarkdownLine('- hello', 7, 7)).toEqual({
      text: '- hello\n- ',
      selectionStart: 10,
      selectionEnd: 10,
    });
    expect(continueMarkdownLine('  * nested', 10, 10)).toEqual({
      text: '  * nested\n  * ',
      selectionStart: 15,
      selectionEnd: 15,
    });
    expect(continueMarkdownLine('- ', 2, 2)).toEqual({
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
    expect(continueMarkdownLine('first\n  + ', 10, 10)).toEqual({
      text: 'first\n',
      selectionStart: 6,
      selectionEnd: 6,
    });
  });

  it('continues task lists unchecked and clears empty task items', () => {
    expect(continueMarkdownLine('- [x] done', 10, 10)).toEqual({
      text: '- [x] done\n- [ ] ',
      selectionStart: 17,
      selectionEnd: 17,
    });
    expect(continueMarkdownLine('  - [ ] ', 8, 8)).toEqual({
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
  });

  it('increments ordered lists and clears empty items', () => {
    expect(continueMarkdownLine('1. first', 8, 8)).toEqual({
      text: '1. first\n2. ',
      selectionStart: 12,
      selectionEnd: 12,
    });
    expect(continueMarkdownLine('  9) ninth', 10, 10)).toEqual({
      text: '  9) ninth\n  10) ',
      selectionStart: 17,
      selectionEnd: 17,
    });
    expect(continueMarkdownLine('2. ', 3, 3)).toEqual({
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
  });

  it('continues blockquotes and clears empty quotes', () => {
    expect(continueMarkdownLine('> note', 6, 6)).toEqual({
      text: '> note\n> ',
      selectionStart: 9,
      selectionEnd: 9,
    });
    expect(continueMarkdownLine('>> ', 3, 3)).toEqual({
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
  });

  it('auto-closes unclosed code fences without duplicating already-closed fences', () => {
    expect(continueMarkdownLine('```ts', 5, 5)).toEqual({
      text: '```ts\n\n```',
      selectionStart: 6,
      selectionEnd: 6,
    });
    expect(continueMarkdownLine('  ~~~', 5, 5)).toEqual({
      text: '  ~~~\n  \n  ~~~',
      selectionStart: 8,
      selectionEnd: 8,
    });
    // Already paired: do not insert another closing fence.
    expect(continueMarkdownLine('```ts\ncode\n```', 5, 5)).toBeUndefined();
  });

  it('returns undefined for ordinary lines and handles leading newline at pos 0', () => {
    expect(continueMarkdownLine('plain text', 10, 10)).toBeUndefined();
    // pos 0 on text starting with '\n': line 0 is empty, must not misread line 1.
    expect(continueMarkdownLine('\n- item', 0, 0)).toBeUndefined();
    expect(indentMarkdownLines('\n- item', 0, 7, false)).toEqual({
      text: '  \n  - item',
      selectionStart: 2,
      selectionEnd: 11,
    });
  });
});

describe('indentMarkdownLines', () => {
  it('indents and outdents single list lines while ignoring plain single lines', () => {
    expect(indentMarkdownLines('hello', 5, 5, false)).toBeUndefined();
    expect(indentMarkdownLines('- item', 6, 6, false)).toEqual({
      text: '  - item',
      selectionStart: 8,
      selectionEnd: 8,
    });
    expect(indentMarkdownLines('  - item', 8, 8, true)).toEqual({
      text: '- item',
      selectionStart: 6,
      selectionEnd: 6,
    });
    expect(indentMarkdownLines('- item', 6, 6, true)).toBeUndefined();
  });

  it('indents and outdents multi-line selections preserving range', () => {
    const src = 'one\ntwo\nthree';
    const indented = indentMarkdownLines(src, 0, src.length, false)!;
    expect(indented).toEqual({
      text: '  one\n  two\n  three',
      selectionStart: 2,
      selectionEnd: 19,
    });
    const outdented = indentMarkdownLines(indented.text, indented.selectionStart, indented.selectionEnd, true)!;
    expect(outdented).toEqual({
      text: 'one\ntwo\nthree',
      selectionStart: 0,
      selectionEnd: 13,
    });
  });
});

describe('wrapMarkdownSelection & insertMarkdownLink', () => {
  it('wraps selected text and toggles off when already wrapped', () => {
    const wrapped = wrapMarkdownSelection('hello world', 6, 11, '**', '**', true)!;
    expect(wrapped).toEqual({ text: 'hello **world**', selectionStart: 8, selectionEnd: 13 });
    const unwrapped = wrapMarkdownSelection(wrapped.text, wrapped.selectionStart, wrapped.selectionEnd, '**', '**', true)!;
    expect(unwrapped).toEqual({ text: 'hello world', selectionStart: 6, selectionEnd: 11 });
  });

  it('inserts empty paired delimiters only when allowEmpty is true', () => {
    expect(wrapMarkdownSelection('hi', 2, 2, '`', '`', false)).toBeUndefined();
    expect(wrapMarkdownSelection('hi', 2, 2, '`', '`', true)).toEqual({
      text: 'hi``',
      selectionStart: 3,
      selectionEnd: 3,
    });
  });

  it('creates links selecting url for non-empty text or label when empty', () => {
    expect(insertMarkdownLink('see docs', 4, 8)).toEqual({
      text: 'see [docs](url)',
      selectionStart: 11,
      selectionEnd: 14,
    });
    expect(insertMarkdownLink('see ', 4, 4)).toEqual({
      text: 'see [text](url)',
      selectionStart: 5,
      selectionEnd: 9,
    });
  });
});

describe('handleMarkdownKey', () => {
  it('handles formatting shortcuts, paired wraps, Tab indentation and Shift+Enter continuation', () => {
    expect(handleMarkdownKey('code', 0, 4, { key: 'b', ctrlKey: true })).toEqual({
      text: '**code**',
      selectionStart: 2,
      selectionEnd: 6,
    });
    expect(handleMarkdownKey('code', 0, 4, { key: 'i', metaKey: true })).toEqual({
      text: '*code*',
      selectionStart: 1,
      selectionEnd: 5,
    });
    expect(handleMarkdownKey('code', 0, 4, { key: 'e', metaKey: true })).toEqual({
      text: '`code`',
      selectionStart: 1,
      selectionEnd: 5,
    });
    expect(handleMarkdownKey('code', 0, 4, { key: 'k', ctrlKey: true })).toEqual({
      text: '[code](url)',
      selectionStart: 7,
      selectionEnd: 10,
    });
    expect(handleMarkdownKey('foo', 0, 3, { key: '`' })).toEqual({
      text: '`foo`',
      selectionStart: 1,
      selectionEnd: 4,
    });
    expect(handleMarkdownKey('foo', 0, 3, { key: '(' })).toEqual({
      text: '(foo)',
      selectionStart: 1,
      selectionEnd: 4,
    });
    expect(handleMarkdownKey('- item', 6, 6, { key: 'Enter', shiftKey: true })).toEqual({
      text: '- item\n- ',
      selectionStart: 9,
      selectionEnd: 9,
    });
    expect(handleMarkdownKey('- item', 6, 6, { key: 'Tab' })).toEqual({
      text: '  - item',
      selectionStart: 8,
      selectionEnd: 8,
    });
  });
});
