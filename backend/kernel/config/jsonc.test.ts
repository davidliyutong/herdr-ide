import { describe, expect, test } from 'bun:test';
import { parse } from 'jsonc-parser';
import { insertValue, members, parseText, removeValue, setValue } from './jsonc.ts';

const value = (text: string): unknown => parse(text, [], { allowTrailingComma: true });

describe('jsonc', () => {
  test('parse', () => {
    expect(parseText('').tree).toBeUndefined();
    expect(parseText('// only a comment\n').tree).toBeUndefined();
    expect(parseText('{"a": 1, /* c */ "b": [2,],}').error).toBeUndefined();
    expect(parseText('{"a": 1,\n  "b": }').error).toBe('ValueExpected at line 2, column 8');
    const m = members(parseText('{"a": 1, "a": 2, "__proto__": {"x": 1}}').tree!)!;
    expect([...m.keys()]).toEqual(['a', '__proto__']);
    expect(m.get('a')!.value).toBe(2);
    expect(members(parseText('[1]').tree)).toBeUndefined();
  });

  // A value is replaced in place; a new member goes on a line of its own
  // with its neighbours' indentation, after a comment of the line before.
  test('set', () => {
    const text = '{\n\t"a": 1, // one\n\t"b": [1, 2] // two\n}\n';
    expect(setValue(text, ['a'], 5)).toBe('{\n\t"a": 5, // one\n\t"b": [1, 2] // two\n}\n');
    expect(setValue(text, ['c'], { d: [true] })).toBe(
      '{\n\t"a": 1, // one\n\t"b": [1, 2], // two\n\t"c": {\n\t  "d": [\n\t    true\n\t  ]\n\t}\n}\n',
    );
    expect(setValue(text, ['0'], 0, () => 0)).toBe('{\n\t"0": 0,\n\t"a": 1, // one\n\t"b": [1, 2] // two\n}\n');
    // A trailing comma stays the file's style.
    expect(setValue('{\n  "a": 1,\n}', ['b'], 2)).toBe('{\n  "a": 1,\n  "b": 2,\n}');
    // Objects on one line, empty ones and missing ones are laid out anew.
    expect(value(setValue('{"a": {"x": 1}}', ['a', 'y'], 2))).toEqual({ a: { x: 1, y: 2 } });
    expect(setValue('{}', ['a'], 1)).toBe('{\n  "a": 1\n}\n');
    expect(setValue('', ['a', 'b'], 1)).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
    expect(value(setValue('{"a": null}', ['a'], { b: 1 }))).toEqual({ a: { b: 1 } });
  });

  // A member goes with its comma and its line, the comments on its line
  // with it; the comments of other lines stay.
  test('remove', () => {
    const text = '{\n  // first\n  "a": 1, // one\n  /* b */ "b": 2,\n  "c": 3 // three\n}\n';
    expect(removeValue(text, ['a'])).toBe('{\n  // first\n  /* b */ "b": 2,\n  "c": 3 // three\n}\n');
    expect(removeValue(text, ['b'])).toBe('{\n  // first\n  "a": 1, // one\n  "c": 3 // three\n}\n');
    expect(removeValue(text, ['c'])).toBe('{\n  // first\n  "a": 1, // one\n  /* b */ "b": 2\n}\n');
    expect(removeValue(text, ['nope'])).toBe(text);
    expect(removeValue('{"a": 1, "b": 2}', ['a'])).toBe('{"b": 2}');
    expect(removeValue('{"a": 1, "b": 2}', ['b'])).toBe('{"a": 1}');
    expect(removeValue('{\n  "a": {\n    "x": 1\n  }\n}\n', ['a', 'x'])).toBe('{\n  "a": {}\n}\n');
    expect(removeValue('[\n  1,\n  2\n]\n', [1])).toBe('[\n  1\n]\n');
    expect(removeValue('[\n  1\n]\n', [0])).toBe('[]\n');
  });

  test('insert into arrays', () => {
    const text = '[\n  1, // one\n  2\n]\n';
    expect(insertValue(text, [], 0, 0)).toBe('[\n  0,\n  1, // one\n  2\n]\n');
    expect(insertValue(text, [], 1, { a: 1 })).toBe('[\n  1, // one\n  {\n    "a": 1\n  },\n  2\n]\n');
    expect(insertValue(text, [], 2, 3)).toBe('[\n  1, // one\n  2,\n  3\n]\n');
    expect(value(insertValue('[1, 2]', [], 1, 9))).toEqual([1, 9, 2]);
    expect(value(insertValue('[]', [], 0, 'x'))).toEqual(['x']);
    // A comma on a line of its own is left to jsonc-parser's edit.
    expect(value(insertValue('[\n  1\n  ,\n]', [], 1, 2))).toEqual([1, 2]);
  });
});
