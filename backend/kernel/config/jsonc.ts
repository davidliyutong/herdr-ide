// The hand-edited JSON files of the core host (settings, keybindings). They
// are read as JSONC, as VS Code reads its own (comments and trailing commas
// allowed), and changed by edits of their text, so a change made from the
// UI keeps the user's comments and layout: a member or element is added on
// a line of its own beside its neighbours, removed with its line, and a
// value replaced in place (jsonc-parser's modify); nothing else moves.
//
// Edits made by hand are noticed by polling the file's signature (its
// modification time and size) rather than with fs.watch or chokidar: the
// file is replaced by a rename on every save (ours, and most editors'),
// which fs.watch loses track of and chokidar re-arms with timers of its
// own; a stat of one file every two seconds is cheap, works the same in Bun
// and in Electron's Node and on any file system, and its end is an
// AbortSignal like every other service's.
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parseTree,
  printParseErrorCode,
  type JSONPath,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import * as userfile from '#shared/host/userfile.ts';

/** Two spaces to a level, as the files are written new. */
const INDENT = '  ';
const FORMAT = { insertSpaces: true, tabSize: INDENT.length, eol: '\n' } as const;

/** A file's text parsed: its tree (undefined when the text holds no value:
 * empty, or only comments), or why it is not JSON. */
export type Parsed = { tree: Node | undefined; error?: undefined } | { tree?: undefined; error: string };

export function parseText(text: string): Parsed {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  const e = errors[0];
  if (e) return { error: `${printParseErrorCode(e.error)} at ${position(text, e.offset)}` };
  return { tree };
}

function position(text: string, offset: number): string {
  const before = text.slice(0, offset);
  return `line ${before.split('\n').length}, column ${offset - before.lastIndexOf('\n')}`;
}

/** The members of an object node by name (the last of a name wins, as
 * JSON.parse keeps them); undefined for a node that is not an object. */
export function members(node: Node | undefined): Map<string, Node> | undefined {
  if (node?.type !== 'object') return undefined;
  const out = new Map<string, Node>();
  for (const p of node.children ?? []) {
    const [name, value] = p.children ?? [];
    if (name && value) out.set(name.value as string, value);
  }
  return out;
}

/** text with the value at path set: replaced where it is, or added to its
 * object at the index insertAt picks among the members' names (absent:
 * last). Objects on the way are created. */
export function setValue(text: string, path: JSONPath, value: unknown, insertAt?: (names: string[]) => number): string {
  const tree = parseTree(text);
  const parent = tree && findNodeAtLocation(tree, path.slice(0, -1));
  const name = path[path.length - 1];
  if (!tree || findNodeAtLocation(tree, path) || parent?.type !== 'object' || typeof name !== 'string') {
    return byModify(text, path, value, { getInsertionIndex: insertAt });
  }
  const names = (parent.children ?? []).map((p) => p.children![0]!.value as string);
  const at = insertAt ? insertAt(names) : names.length;
  return (
    insertChild(text, parent, at, (indent) => `${JSON.stringify(name)}: ${json(value, indent)}`) ??
    byModify(text, path, value, { getInsertionIndex: () => at })
  );
}

/** text with value inserted into the array at path, at index. */
export function insertValue(text: string, path: JSONPath, index: number, value: unknown): string {
  const tree = parseTree(text);
  const array = tree && findNodeAtLocation(tree, path);
  return (
    (array?.type === 'array' && insertChild(text, array, index, (indent) => json(value, indent))) ||
    byModify(text, [...path, index], value, { isArrayInsertion: true })
  );
}

/** text without the member or element at path. */
export function removeValue(text: string, path: JSONPath): string {
  const tree = parseTree(text);
  const node = tree && findNodeAtLocation(tree, path);
  if (!node?.parent) return text;
  return removeChild(text, node.parent.type === 'property' ? node.parent : node);
}

/** value as JSON on lines of its own, the first after indent. */
const json = (value: unknown, indent: string) => JSON.stringify(value, null, INDENT).replaceAll('\n', '\n' + indent);

/** jsonc-parser's edit: it lays out what it writes, and the lines it
 * starts or ends on. */
function byModify(
  text: string,
  path: JSONPath,
  value: unknown,
  o: { getInsertionIndex?: (names: string[]) => number; isArrayInsertion?: boolean },
): string {
  const out = applyEdits(text, modify(text, path, value, { formattingOptions: FORMAT, ...o }));
  return out.endsWith('\n') ? out : out + '\n';
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
function lineEnd(text: string, offset: number): number {
  const i = text.indexOf('\n', offset);
  return i < 0 ? text.length : i;
}
const blank = (s: string) => /^[ \t\r]*$/.test(s);

// jsonc-parser's SyntaxKind.CommaToken (a const enum, which this build
// cannot read).
const COMMA = 5;

/** The next token after offset, past white space and comments. */
function nextToken(text: string, offset: number): { kind: number; offset: number } {
  const s = createScanner(text, true);
  s.setPosition(offset);
  const kind = s.scan();
  return { kind, offset: s.getTokenOffset() };
}

/** text with the member (or element) content gives for its indentation
 * inserted among parent's children at index, on a line of its own beside
 * its neighbours; undefined where the parent is not laid out one child to
 * a line (jsonc-parser's edit lays it out then). */
function insertChild(text: string, parent: Node, index: number, content: (indent: string) => string): string | undefined {
  const children = parent.children ?? [];
  if (children.length === 0) return undefined;
  const indentOf = (offset: number) => /^[ \t]*/.exec(text.slice(lineStart(text, offset)))![0];
  const next = children[index];
  if (next) {
    const start = lineStart(text, next.offset);
    if (!blank(text.slice(start, next.offset))) return undefined;
    const indent = indentOf(next.offset);
    return text.slice(0, start) + indent + content(indent) + ',\n' + text.slice(start);
  }
  // After the last child: a comma after it (where it has none) and a line
  // after its own, ending with a comma as it does.
  const last = children[children.length - 1]!;
  const end = last.offset + last.length;
  const after = nextToken(text, end);
  const eol = lineEnd(text, end);
  const trailing = after.kind === COMMA;
  if (parent.offset + parent.length - 1 < eol || (trailing && after.offset > eol)) return undefined;
  const indent = indentOf(last.offset);
  const line = '\n' + indent + content(indent) + (trailing ? ',' : '');
  return text.slice(0, end) + (trailing ? '' : ',') + text.slice(end, eol) + line + text.slice(eol);
}

// What may be on a child's line besides it for the line to be its own:
// white space, comments on the line (before it, block comments).
const commentsBefore = /^[ \t]*(\/\*.*?\*\/[ \t]*)*$/;
const commentsAfter = /^[ \t]*(\/\*.*?\*\/[ \t]*)*(\/\/.*)?\r?$/;

/** text without child (a property or an element) and its comma, and
 * without its line when nothing but comments is on it; the comments of
 * other lines stay. */
function removeChild(text: string, child: Node): string {
  const parent = child.parent!;
  const siblings = parent.children ?? [];
  const i = siblings.indexOf(child);
  const end = child.offset + child.length;
  const after = nextToken(text, end);
  let from = child.offset;
  let to = end;
  // The comma that separated the last child (without one of its own) from
  // the one before it, which goes too.
  let comma: number | undefined;
  if (after.kind === COMMA) {
    to = after.offset + 1;
    while (text[to] === ' ' || text[to] === '\t') to++;
  } else if (i > 0) {
    const prev = siblings[i - 1]!;
    const c = nextToken(text, prev.offset + prev.length);
    if (c.kind === COMMA && /^[ \t]*$/.test(text.slice(c.offset + 1, from))) from = c.offset;
    else if (c.kind === COMMA) comma = c.offset;
  }
  const start = lineStart(text, from);
  const eol = lineEnd(text, to);
  if (commentsBefore.test(text.slice(start, from)) && commentsAfter.test(text.slice(to, eol))) {
    from = start;
    to = Math.min(eol + 1, text.length);
  }
  let out = text.slice(0, from) + text.slice(to);
  if (comma !== undefined && comma < from) out = out.slice(0, comma) + out.slice(comma + 1);
  if (siblings.length === 1) {
    // An object or array left with nothing but space in it is {} or [].
    const close = parent.offset + parent.length - 1 - (text.length - out.length);
    if (/^\s*$/.test(out.slice(parent.offset + 1, close))) out = out.slice(0, parent.offset + 1) + out.slice(close);
  }
  return out;
}

/** A file of the core host and the version of it last read or written
 * ("" keeps nothing on disk). */
export class UserFile {
  readonly path: string;
  #sig: userfile.Sig | undefined;

  constructor(path: string) {
    this.path = path;
  }

  /** Whether someone else changed the file since it was last read or
   * written. */
  changed(): boolean {
    if (!this.path) return false;
    const now = userfile.stat(this.path);
    return this.#sig ? !userfile.sameSig(now, this.#sig) : now.exists;
  }

  /** The file's text ("" when missing); throws when it cannot be read. */
  read(): string {
    if (!this.path) return '';
    const { data, sig } = userfile.read(this.path);
    this.#sig = sig;
    return data ? data.toString('utf8') : '';
  }

  /** Replaces the file (atomically, mode 0600). */
  write(text: string): void {
    if (this.path) this.#sig = userfile.write(this.path, text);
  }
}
