// Strict HTML sanitization pipeline for untrusted Markdown (files on machines
// and coding agents' messages). Parses HTML comments and safe GFM/VS Code HTML
// via rehype-raw, then sanitizes with an explicit allowlist schema via
// rehype-sanitize:
//  - HTML comments are parsed and dropped (never shown as literal text);
//  - active/dangerous elements (<script>, <style>, <iframe>, <object>, <embed>,
//    <svg>, <math>, <form>, raw <input>, <picture>, <source>, etc.) are
//    stripped together with their children;
//  - all event handlers (on*), inline style attributes, srcdoc, srcset, name
//    and non-allowlisted class names are removed;
//  - genuine GFM task-list checkboxes (<li class="task-list-item"><input ...>)
//    are preserved unforgeably across rehype-raw and rehype-sanitize so raw
//    HTML <input> elements can never become form controls;
//  - user IDs are prefixed with `user-content-` to prevent DOM clobbering.

import type { Options as ReactMarkdownOptions } from 'react-markdown';
import type rehypeRawFn from 'rehype-raw';
import type rehypeSanitizeFn from 'rehype-sanitize';
import { isSafeRasterDataUrl } from './links';

type Schema = NonNullable<Parameters<typeof rehypeSanitizeFn>[0]>;

/** Prefix added to sanitized IDs and ARIA references so rendered Markdown can
 * never collide with IDs used by the application DOM. */
export const ID_PREFIX = 'user-content-';

const ALIGN_BLOCK = /^(?:left|center|right|justify)$/i;
const ALIGN_IMAGE = /^(?:left|center|right)$/i;
const VALIGN = /^(?:top|middle|bottom|baseline)$/i;
const SCOPE = /^(?:row|col|rowgroup|colgroup)$/i;
const LANG_CLASS = /^language-[a-zA-Z0-9_+#.-]+$/;

/** Strict GitHub/VS Code-compatible HAST sanitization schema. */
export const MARKDOWN_SANITIZE_SCHEMA: Schema = {
  clobberPrefix: ID_PREFIX,
  clobber: ['id', 'ariaDescribedBy', 'ariaLabelledBy'],
  allowComments: false,
  allowDoctypes: false,
  required: {},
  strip: [
    'applet',
    'area',
    'audio',
    'base',
    'button',
    'canvas',
    'dialog',
    'embed',
    'fieldset',
    'form',
    'frame',
    'frameset',
    'head',
    'iframe',
    'input',
    'label',
    'legend',
    'link',
    'map',
    'math',
    'meta',
    'noembed',
    'noframes',
    'noscript',
    'object',
    'optgroup',
    'option',
    'picture',
    'plaintext',
    'portal',
    'script',
    'select',
    'source',
    'style',
    'svg',
    'template',
    'textarea',
    'title',
    'track',
    'video',
    'xmp',
  ],
  tagNames: [
    'a',
    'abbr',
    'b',
    'blockquote',
    'br',
    'caption',
    'cite',
    'code',
    'col',
    'colgroup',
    'dd',
    'del',
    'details',
    'dfn',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'ins',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    'q',
    'rp',
    'rt',
    'ruby',
    's',
    'samp',
    'section',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
    'var',
  ],
  ancestors: {
    caption: ['table'],
    col: ['table'],
    colgroup: ['table'],
    summary: ['details'],
    tbody: ['table'],
    td: ['table'],
    tfoot: ['table'],
    th: ['table'],
    thead: ['table'],
    tr: ['table'],
  },
  protocols: {
    href: ['http', 'https', 'mailto'],
    // data: and blob: are filtered again in post-sanitization (raster base64
    // only) and in the React <img> component (links.ts imageSource).
    src: ['http', 'https', 'data', 'blob'],
  },
  attributes: {
    '*': ['dir', 'lang', 'title', 'id'],
    a: [
      'href',
      'ariaDescribedBy',
      'ariaLabel',
      'ariaLabelledBy',
      'dataFootnoteBackref',
      'dataFootnoteRef',
      ['className', 'data-footnote-backref'],
    ],
    code: [['className', LANG_CLASS, 'math-inline', 'math-display']],
    col: ['span', ['align', ALIGN_BLOCK]],
    colgroup: ['span', ['align', ALIGN_BLOCK]],
    details: ['open'],
    div: [['align', ALIGN_BLOCK]],
    h1: [['align', ALIGN_BLOCK]],
    h2: [
      ['align', ALIGN_BLOCK],
      ['className', 'sr-only'],
    ],
    h3: [['align', ALIGN_BLOCK]],
    h4: [['align', ALIGN_BLOCK]],
    h5: [['align', ALIGN_BLOCK]],
    h6: [['align', ALIGN_BLOCK]],
    img: ['src', 'alt', 'width', 'height', ['align', ALIGN_IMAGE]],
    li: [['className', 'task-list-item']],
    ol: ['start', ['className', 'contains-task-list']],
    p: [['align', ALIGN_BLOCK]],
    section: ['dataFootnotes', ['className', 'footnotes']],
    td: ['colSpan', 'rowSpan', 'headers', ['align', ALIGN_BLOCK], ['vAlign', VALIGN]],
    th: ['colSpan', 'rowSpan', 'headers', ['scope', SCOPE], ['align', ALIGN_BLOCK], ['vAlign', VALIGN]],
    tr: [
      ['align', ALIGN_BLOCK],
      ['vAlign', VALIGN],
    ],
    ul: [['className', 'contains-task-list']],
  },
};

const MAX_SPAN = 100;
const GFM_CHECKBOX_NODE = 'gfmTaskCheckbox';

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  checked?: boolean;
}

function walkChildren(node: HastNode, visit: (child: HastNode, parent: HastNode) => HastNode | undefined) {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (let i = 0; i < children.length; i++) {
    const next = visit(children[i], node);
    if (next !== undefined) children[i] = next;
    walkChildren(children[i], visit);
  }
}

function classList(props: Record<string, unknown> | undefined): string[] {
  const cls = props?.className;
  if (Array.isArray(cls)) return cls.map(String);
  if (typeof cls === 'string') return cls.split(/\s+/).filter(Boolean);
  return [];
}

function clampSpan(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(n, MAX_SPAN);
}

let nonceSeq = 0;
function makeNonce(): string {
  nonceSeq = (nonceSeq + 1) >>> 0;
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(3);
    crypto.getRandomValues(buf);
    return `gfmcb-${nonceSeq}-${buf[0].toString(36)}${buf[1].toString(36)}${buf[2].toString(36)}`;
  }
  return `gfmcb-${nonceSeq}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Pre-raw rehype plugin: isolates genuine GFM task-list checkboxes into a
 * non-HTML node type that raw HTML can never forge. */
function rehypePreserveGfmCheckboxes() {
  return (tree: HastNode) => {
    walkChildren(tree, (child, parent) => {
      if (
        child.type === 'element' &&
        child.tagName === 'input' &&
        parent.type === 'element' &&
        parent.tagName === 'li' &&
        classList(parent.properties).includes('task-list-item') &&
        child.properties?.type === 'checkbox' &&
        child.properties?.disabled === true
      ) {
        return { type: GFM_CHECKBOX_NODE, checked: Boolean(child.properties.checked) };
      }
      return undefined;
    });
  };
}

/** Post-sanitization hardening and GFM checkbox restoration. */
function hardenSanitizedTree(tree: HastNode, checkboxes: ReadonlyMap<string, boolean>) {
  walkChildren(tree, (child) => {
    if (child.type !== 'element') return undefined;
    const props = child.properties;
    if (!props) return undefined;

    // Restore unforgeable GFM task-list checkboxes.
    if (
      child.tagName === 'span' &&
      typeof props.id === 'string' &&
      checkboxes.has(props.id) &&
      (!child.children || child.children.length === 0)
    ) {
      return {
        type: 'element',
        tagName: 'input',
        properties: { type: 'checkbox', disabled: true, checked: checkboxes.get(props.id) === true },
        children: [],
      };
    }

    // Defense-in-depth: never let non-raster data: URLs survive on <img>.
    if (child.tagName === 'img' && typeof props.src === 'string') {
      const cleaned = props.src.replace(/[\p{Cc}\p{Cf}\s]/gu, '');
      if (/^data:/i.test(cleaned) && !isSafeRasterDataUrl(props.src)) {
        delete props.src;
      }
    }

    // Clamp table spans to prevent layout DoS.
    if (child.tagName === 'td' || child.tagName === 'th') {
      for (const k of ['colSpan', 'rowSpan'] as const) {
        if (k in props) {
          const clamped = clampSpan(props[k]);
          if (clamped === undefined) delete props[k];
          else props[k] = clamped;
        }
      }
    } else if (child.tagName === 'col' || child.tagName === 'colgroup') {
      if ('span' in props) {
        const clamped = clampSpan(props.span);
        if (clamped === undefined) delete props.span;
        else props.span = clamped;
      }
    }

    // Normalize case-insensitive enum attributes.
    for (const k of ['align', 'vAlign', 'scope'] as const) {
      if (typeof props[k] === 'string') props[k] = props[k].toLowerCase();
    }

    // Defense-in-depth: strip any inline style or event handler if ever present.
    for (const key of Object.keys(props)) {
      if (key === 'style' || /^on[a-z]/i.test(key)) delete props[key];
    }

    return undefined;
  });
}

const SAFE_SCHEME_PREFIX = /^[ \t]*(https?|mailto|data|blob):/i;

/** Normalizes uppercase/leading-space allowlisted schemes (e.g. `HTTPS://…`)
 * before hast-util-sanitize, whose protocol check is case-sensitive. */
function normalizeAllowedScheme(value: string): string {
  const m = SAFE_SCHEME_PREFIX.exec(value);
  return m ? `${m[1].toLowerCase()}:${value.slice(m[0].length)}` : value;
}

/** Builds the rehype plugin chain that parses HTML comments + safe GFM HTML
 * and strictly sanitizes the resulting HAST tree. */
export function safeHtmlPlugins(
  rehypeRaw: typeof rehypeRawFn,
  rehypeSanitize: typeof rehypeSanitizeFn,
): NonNullable<ReactMarkdownOptions['rehypePlugins']> {
  const runSanitize = rehypeSanitize(MARKDOWN_SANITIZE_SCHEMA);
  function rehypeSanitizeMarkdown() {
    return (tree: HastNode) => {
      const nonce = makeNonce();
      const checkboxes = new Map<string, boolean>();
      let idx = 0;
      walkChildren(tree, (child) => {
        if (child.type === GFM_CHECKBOX_NODE) {
          const id = `${nonce}-${idx++}`;
          checkboxes.set(ID_PREFIX + id, Boolean(child.checked));
          return { type: 'element', tagName: 'span', properties: { id }, children: [] };
        }
        if (child.type === 'element' && child.properties) {
          if (typeof child.properties.href === 'string') child.properties.href = normalizeAllowedScheme(child.properties.href);
          if (typeof child.properties.src === 'string') child.properties.src = normalizeAllowedScheme(child.properties.src);
        }
        return undefined;
      });
      const sanitized = runSanitize(tree as unknown as Parameters<typeof runSanitize>[0]) as unknown as HastNode;
      hardenSanitizedTree(sanitized, checkboxes);
      return sanitized;
    };
  }
  return [rehypePreserveGfmCheckboxes, [rehypeRaw, { passThrough: [GFM_CHECKBOX_NODE] }], rehypeSanitizeMarkdown];
}
