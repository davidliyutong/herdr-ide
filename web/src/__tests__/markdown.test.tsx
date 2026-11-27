// @vitest-environment jsdom
//
// Rendered Markdown: what links and images may point to (the text is not
// trusted), the elements it produces, code colors and formulas.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const renderMath = vi.fn(async (tex: string, display: boolean) => `<span class="katex-mock">${display ? 'D' : 'I'}:${tex}</span>`);
vi.mock('../terminal/mathRender', () => ({ renderMath: (tex: string, display: boolean) => renderMath(tex, display) }));

import { imageSource, isMarkdownPath, parseImageDimension, relativePath, safeLink } from '../markdown/links';
import { Markdown, type MarkdownProps } from '../markdown/Markdown';
import { parseFrontmatter } from '../markdown/MarkdownBody';
import { StreamMarkdown } from '../markdown/StreamMarkdown';
import { streamBlocks } from '../markdown/streaming';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('safeLink', () => {
  const cases: [string, string | undefined][] = [
    ['https://a.example/x?y=1#z', 'https://a.example/x?y=1#z'],
    // As the browser will resolve it.
    ['http://a.example', 'http://a.example/'],
    ['HTTPS://A.EXAMPLE', 'https://a.example/'],
    [' \thttps://a.example/a b', 'https://a.example/a%20b'],
    // Relative to the page in a browser, not absolute.
    ['http:/api/x', undefined],
    ['http:x', undefined],
    ['https:/x', undefined],
    ['https:x', undefined],
    ['http:\\\\evil.example', undefined],
    // The page's own origin (jsdom's), by any spelling.
    ['http://localhost:3000/api/m/x/hc/stop', undefined],
    ['HTTP://LOCALHOST:3000/', undefined],
    ['http://localhost:3000', undefined],
    ['http://localhost:3001/', 'http://localhost:3001/'],
    // The page's server under another name of the loopback, or the other
    // scheme: the same port is the same server.
    ['https://localhost:3000/', undefined],
    ['http://127.0.0.1:3000/api/m/x/hc/stop', undefined],
    ['http://[::1]:3000/', undefined],
    ['http://127.0.0.9:3000/', undefined],
    ['http://127.0.0.1:3001/', 'http://127.0.0.1:3001/'],
    ['http://192.168.1.5:3000/', 'http://192.168.1.5:3000/'],
    ['mailto:a@b.example', 'mailto:a@b.example'],
    ['javascript:alert(1)', undefined],
    ['JaVaScRiPt:alert(1)', undefined],
    [' \tjava\nscript:alert(1)', undefined],
    ['data:text/html,<script>alert(1)</script>', undefined],
    ['vbscript:msgbox(1)', undefined],
    ['file:///etc/passwd', undefined],
    ['//evil.example/x', undefined],
    ['/api/m/x/hc/stop', undefined],
    ['#top', undefined],
    ['img/a.png', undefined],
    ['foo://bar', undefined],
    ['', undefined],
  ];
  it.each(cases)('%j', (href, want) => expect(safeLink(href)).toBe(want));
});

describe('relativePath', () => {
  const cases: [string, string, string | undefined][] = [
    ['a.md', '/home/u', '/home/u/a.md'],
    ['./a.md', '/home/u', '/home/u/a.md'],
    ['../a.md', '/home/u', '/home/a.md'],
    ['sub/../b/c.md#sec', '/home/u', '/home/u/b/c.md'],
    ['a.md?x=1#y', '/', '/a.md'],
    ['my%20file.md', '/d', '/d/my file.md'],
    ['../../../../etc/passwd', '/home/u', '/etc/passwd'],
    ['a.md', '/', '/a.md'],
    ['#frag', '/d', undefined],
    ['/abs/path', '/d', undefined],
    ['//host/x', '/d', undefined],
    ['https://a.example/x', '/d', undefined],
    ['javascript:alert(1)', '/d', undefined],
    ['JaVaScRiPt:alert(1)', '/d', undefined],
    ['data:text/html,x', '/d', undefined],
    ['', '/d', undefined],
    ['?q=1', '/d', undefined],
  ];
  it.each(cases)('%j in %j', (href, dir, want) => expect(relativePath(href, dir)).toBe(want));
});

describe('imageSource', () => {
  const base = { m: 'box', dir: '/home/u' };
  const cases: [string, typeof base | undefined, string | undefined][] = [
    ['data:image/png;base64,AAAA', undefined, 'data:image/png;base64,AAAA'],
    ['data:image/jpeg;base64,AAAA', base, 'data:image/jpeg;base64,AAAA'],
    ['data:image/svg+xml,<svg onload=alert(1)>', base, undefined],
    ['data:image/svg+xml;base64,AAAA', base, undefined],
    ['data:text/html;base64,AAAA', base, undefined],
    ['blob:https://a.example/1-2', undefined, 'blob:https://a.example/1-2'],
    ['img/a.png', undefined, undefined],
    ['img/a.png', base, '/api/m/box/file?path=%2Fhome%2Fu%2Fimg%2Fa.png'],
    ['../a.png', base, '/api/m/box/file?path=%2Fhome%2Fa.png'],
    ['https://x.example/y.png', base, undefined],
    ['//x.example/y.png', base, undefined],
    ['/api/m/x/hc/stop', base, undefined],
    ['javascript:alert(1)', base, undefined],
  ];
  it.each(cases)('%j with base %j', (src, b, want) => expect(imageSource(src, b)).toBe(want));
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  renderMath.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Renders and waits until the lazy renderer has produced its content. */
async function show(props: MarkdownProps) {
  await act(async () => {
    root.render(createElement(Markdown, props));
  });
  await vi.waitFor(() => expect(host.querySelector('.markdown-plain')).toBeNull(), { timeout: 5000 });
}
/** Waits for `fn` to hold, letting React flush each time. */
async function until(fn: () => unknown) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await sleep(20);
      });
      expect(fn()).toBeTruthy();
    },
    { timeout: 5000 },
  );
}
const q = (sel: string) => host.querySelector(sel);

describe('Markdown', () => {
  it('shows the text plainly while the renderer loads', () => {
    act(() => root.render(createElement(Markdown, { text: '# Title' })));
    expect(q('.markdown-plain')?.textContent).toBe('# Title');
  });

  it('renders headings, lists, tables and task lists', async () => {
    await show({
      text: [
        '# One',
        '',
        '## Two',
        '',
        '- a',
        '- b',
        '',
        '| h1 | h2 |',
        '| -- | -- |',
        '| c1 | c2 |',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '~~gone~~',
      ].join('\n'),
    });
    expect(q('h1')?.textContent).toBe('One');
    expect(q('h2')?.textContent).toBe('Two');
    expect(host.querySelectorAll('li').length).toBe(4);
    expect(q('table th')?.textContent).toBe('h1');
    expect(q('table td')?.textContent).toBe('c1');
    const boxes = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect(boxes.length).toBe(2);
    expect([...boxes].map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(q('del')?.textContent).toBe('gone');
  });

  it('hides single-line, inline and multi-line HTML comments while keeping comments inside code visible', async () => {
    await show({
      text: [
        '<!-- single-line secret comment -->',
        '',
        'Before <!-- inline hidden --> after',
        '',
        '<!--',
        'multi-line hidden comment',
        '',
        'still inside comment',
        '-->',
        '',
        'Visible paragraph',
        '',
        '```html',
        '<!-- visible in code block -->',
        '```',
        '',
        'Inline `<!-- visible in code span -->` text',
      ].join('\n'),
    });
    expect(host.textContent).not.toContain('single-line secret comment');
    expect(host.textContent).not.toContain('inline hidden');
    expect(host.textContent).not.toContain('multi-line hidden comment');
    expect(host.textContent).not.toContain('still inside comment');
    expect(host.textContent).toContain('Before');
    expect(host.textContent).toContain('after');
    expect(host.textContent).toContain('Visible paragraph');
    expect(q('.md-code pre')?.textContent).toContain('<!-- visible in code block -->');
    expect(q('p code')?.textContent).toBe('<!-- visible in code span -->');
  });

  it('renders safe GFM/VS Code HTML elements cleanly', async () => {
    const onOpenPath = vi.fn();
    await show({
      text: [
        '<div align="center">Centered block</div>',
        '',
        '<p align="right">Right paragraph</p>',
        '',
        '<h2 align="center">Centered Heading</h2>',
        '',
        'Line 1<br>Line 2',
        '',
        '<hr>',
        '',
        '<details open>',
        '<summary>More info</summary>',
        '',
        'Inside **details** with <kbd>Cmd</kbd>+<kbd>K</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <mark>hi</mark>, <del>old</del>, <ins>new</ins>, <b>bold</b>.',
        '',
        '</details>',
        '',
        '<table><thead><tr><th colspan="2" align="center">Header</th></tr></thead><tbody><tr><td rowspan="2">A</td><td align="right">B</td></tr><tr><td colspan="9999">C</td></tr></tbody></table>',
        '',
        '<a href="https://example.com/docs" title="Docs">External</a> and <a href="./guide.md" title="Guide">Local</a>',
      ].join('\n'),
      base: { m: 'box', dir: '/home/u' },
      onOpenPath,
    });
    expect(q('div[align="center"]')?.textContent).toBe('Centered block');
    expect(q('p[align="right"]')?.textContent).toBe('Right paragraph');
    expect(q('h2[align="center"]')?.textContent).toBe('Centered Heading');
    expect(q('br')).not.toBeNull();
    expect(q('hr')).not.toBeNull();
    const details = q('details') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(true);
    expect(details.querySelector('summary')?.textContent).toBe('More info');
    expect(details.querySelector('strong')?.textContent).toBe('details');
    expect([...details.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Cmd', 'K']);
    expect(details.querySelector('sub')?.textContent).toBe('2');
    expect(details.querySelector('sup')?.textContent).toBe('2');
    expect(details.querySelector('mark')?.textContent).toBe('hi');
    expect(details.querySelector('del')?.textContent).toBe('old');
    expect(details.querySelector('ins')?.textContent).toBe('new');
    expect(details.querySelector('b')?.textContent).toBe('bold');

    const th = q('.md-table table thead th') as HTMLTableCellElement;
    expect(th.textContent).toBe('Header');
    expect(th.colSpan).toBe(2);
    const tds = [...host.querySelectorAll<HTMLTableCellElement>('.md-table table tbody td')];
    expect(tds[0].rowSpan).toBe(2);
    expect(tds[2].colSpan).toBe(100); // clamped from 9999

    const ext = [...host.querySelectorAll('a')].find((a) => a.textContent === 'External')!;
    expect(ext.getAttribute('href')).toBe('https://example.com/docs');
    expect(ext.getAttribute('title')).toBe('Docs — https://example.com/docs');
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer');

    const local = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Local')!;
    expect(local.getAttribute('title')).toBe('Guide — /home/u/guide.md');
    act(() => void local.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(onOpenPath).toHaveBeenCalledWith('/home/u/guide.md');
  });

  it('resolves HTML <img> relative URLs, raster data URLs and safe dimensions while degrading remote images to links', async () => {
    expect(parseImageDimension('200')).toEqual({ attr: 200 });
    expect(parseImageDimension('200px')).toEqual({ attr: 200 });
    expect(parseImageDimension('50%')).toEqual({ pct: '50%' });
    expect(parseImageDimension('999999')).toEqual({});
    expect(parseImageDimension('expression(alert(1))')).toEqual({});

    await show({
      text: [
        '<img src="./rel.png" alt="Rel" title="Preview" width="200" height="100" align="center">',
        '',
        '<img src="../pct.png" alt="Pct" width="50%" align="right">',
        '',
        '<img src="data:image/png;base64,AAAA" alt="Inline" width="64">',
        '',
        '<img src="https://evil.example/tracker.png" alt="Remote" width="200">',
        '',
        '<img src="/api/m/x/hc/stop" alt="Root">',
        '',
        '<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="Svg">',
      ].join('\n'),
      base: { m: 'box', dir: '/home/u/docs' },
    });
    const imgs = [...host.querySelectorAll('img')];
    expect(imgs).toHaveLength(3);
    expect(imgs[0].getAttribute('src')).toBe('/api/m/box/file?path=%2Fhome%2Fu%2Fdocs%2Frel.png');
    expect(imgs[0].getAttribute('alt')).toBe('Rel');
    expect(imgs[0].getAttribute('title')).toBe('Preview');
    expect(imgs[0].getAttribute('width')).toBe('200');
    expect(imgs[0].getAttribute('height')).toBe('100');
    expect(imgs[0].getAttribute('data-align')).toBe('center');
    expect(imgs[1].getAttribute('src')).toBe('/api/m/box/file?path=%2Fhome%2Fu%2Fpct.png');
    expect(imgs[1].style.width).toBe('50%');
    expect(imgs[1].getAttribute('data-align')).toBe('right');
    expect(imgs[2].getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(imgs[2].getAttribute('width')).toBe('64');

    const remote = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Remote')!;
    expect(remote.getAttribute('href')).toBe('https://evil.example/tracker.png');
    expect(remote.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.textContent).toContain('Root');
    expect(host.textContent).toContain('Svg');
  });

  it('strictly strips XSS payloads, event handlers, style attributes, active elements and raw inputs', async () => {
    await show({
      text: [
        '<script>alert("xss1")</script>',
        '<SCRIPT>alert("xss2")</SCRIPT>',
        '<img src=x onerror=alert(1)>',
        '<img src="./rel.png" onerror="alert(1)" srcset="https://evil.example/a.png 2x" style="position:fixed" width="120">',
        '<picture><source srcset="https://evil.example/track.png"><img src="./rel.png" alt="inside-pic"></picture>',
        '<a href="javascript:alert(1)" onclick="alert(1)" style="color:red" id="root" name="location">bad-js</a>',
        '<a href="&#106;avascript:alert(1)">bad-entity</a>',
        '<a href="java&#x09;script:alert(1)">bad-tab</a>',
        '<a href="vbscript:msgbox(1)">bad-vbs</a>',
        '<a href="data:text/html,<script>alert(1)</script>">bad-data</a>',
        '<iframe src="javascript:alert(1)" srcdoc="<script>alert(1)</script>">iframe-fallback</iframe>',
        '<svg onload="alert(1)"><script>alert(1)</script><text>svg-text</text></svg>',
        '<math><mtext>math-text</mtext></math>',
        '<style>body { display: none; }</style>',
        '<object data="javascript:alert(1)">obj-text</object>',
        '<embed src="javascript:alert(1)">',
        '<form action="https://evil.example"><input type="text" onfocus="alert(1)" value="v"><button>Send</button></form>',
        '<input type="checkbox" checked>',
        '<div style="position:fixed;inset:0" onmouseover="alert(1)" class="sidebar">Styled</div>',
        '<details ontoggle="alert(1)"><summary onclick="alert(1)">Safe summary</summary>Body</details>',
      ].join('\n\n'),
      base: { m: 'box', dir: '/home/u' },
    });
    for (const tag of ['script', 'iframe', 'svg', 'math', 'style', 'object', 'embed', 'form', 'input', 'button', 'picture', 'source']) {
      expect(q(tag), `tag <${tag}> must be stripped`).toBeNull();
    }
    expect(host.textContent).not.toContain('xss1');
    expect(host.textContent).not.toContain('xss2');
    expect(host.textContent).not.toContain('display: none');
    expect(host.textContent).not.toContain('iframe-fallback');
    expect(host.textContent).not.toContain('svg-text');
    expect(host.textContent).not.toContain('math-text');
    expect(host.querySelectorAll('a')).toHaveLength(0);
    // Relative <img> elements have no onerror, srcset or style attributes.
    const imgs = [...host.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    for (const img of imgs) {
      expect(img.getAttribute('onerror')).toBeNull();
      expect(img.getAttribute('srcset')).toBeNull();
      expect(img.getAttribute('style')).toBeNull();
    }
    // No element anywhere carries an on* handler, inline style, or clobbered id/name/class.
    for (const el of host.querySelectorAll('.markdown *')) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name).not.toMatch(/^on/i);
        expect(attr.name).not.toBe('style');
        expect(attr.name).not.toBe('name');
        expect(attr.name).not.toBe('srcdoc');
        expect(attr.name).not.toBe('srcset');
      }
    }
    expect(host.querySelector('#root')).toBeNull();
    expect(host.querySelector('#user-content-root')).not.toBeNull();
    expect(host.querySelector('.sidebar')).toBeNull();
    expect(host.textContent).toContain('Styled');
    expect(q('details summary')?.textContent).toBe('Safe summary');
  });

  it('keeps the href only of safe links', async () => {
    await show({
      text: [
        '[bad](javascript:alert(1))',
        '',
        '[ok](https://a.example)',
        '',
        '[mail](mailto:a@b.example)',
        '',
        '[data](data:text/html,x)',
        '',
        '[proto](//evil.example/x)',
        '',
        '[one](http:/api/x)',
        '',
        '[two](http:x)',
        '',
        '[three](https:/x)',
        '',
        '[own](http://localhost:3000/api/x)',
        '',
        '[other-name](http://127.0.0.1:3000/api/x)',
      ].join('\n'),
    });
    const link = (text: string) => [...host.querySelectorAll('a')].find((a) => a.textContent === text);
    expect(link('bad')).toBeUndefined();
    expect(host.textContent).toContain('bad');
    const ok = link('ok')!;
    expect(ok.getAttribute('href')).toBe('https://a.example/');
    expect(ok.getAttribute('target')).toBe('_blank');
    expect(ok.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link('mail')?.getAttribute('href')).toBe('mailto:a@b.example');
    expect(link('data')).toBeUndefined();
    expect(link('proto')).toBeUndefined();
    for (const n of ['one', 'two', 'three', 'own', 'other-name']) {
      expect(link(n)).toBeUndefined();
      expect(host.textContent).toContain(n);
    }
    expect(host.querySelectorAll('[href^="javascript" i]').length).toBe(0);
  });

  it('opens relative links through the caller, and shows them as text without one', async () => {
    const onOpenPath = vi.fn();
    await show({ text: '[doc](../other/b.md#x)', base: { m: 'box', dir: '/home/u' }, onOpenPath });
    const a = [...host.querySelectorAll('a')].find((e) => e.textContent === 'doc')!;
    act(() => void a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(onOpenPath).toHaveBeenCalledWith('/home/other/b.md');

    act(() => root.render(createElement(Markdown, { text: '[doc](b.md)', base: { m: 'box', dir: '/' } })));
    await until(() => q('.markdown span')?.textContent === 'doc');
    expect(host.querySelectorAll('a').length).toBe(0);
  });

  it('jumps to headings with fragment links', async () => {
    await show({ text: '[go](#second-part)\n\n# First\n\n## Second part' });
    const target = q('h2')!;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const a = q('a')!;
    expect(a.getAttribute('href')).toBe('#second-part');
    act(() => void a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(scroll).toHaveBeenCalled();
  });

  it('loads only images that are the document’s own', async () => {
    await show({
      text: ['![a](https://x.example/y.png)', '', '![b](/api/m/x/hc/stop)', '', '![c](pic.png)', '', '![d](data:image/svg+xml,x)'].join(
        '\n',
      ),
      base: { m: 'box', dir: '/home/u' },
    });
    const imgs = host.querySelectorAll('img');
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute('src')).toBe('/api/m/box/file?path=%2Fhome%2Fu%2Fpic.png');
    const remote = [...host.querySelectorAll('a')].find((a) => a.getAttribute('href') === 'https://x.example/y.png')!;
    expect(remote.textContent).toBe('a');
    expect(remote.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.textContent).toContain('b');
  });

  it('turns a remote image into a link only by the link rule', async () => {
    await show({
      text: ['![one](http:/api/x.png)', '', '![two](http://localhost:3000/api/x.png)', '', '![three](HTTPS://X.EXAMPLE/p.png)'].join('\n'),
      base: { m: 'box', dir: '/home/u' },
    });
    expect(host.querySelectorAll('img').length).toBe(0);
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://x.example/p.png']);
    expect(host.textContent).toContain('one');
    expect(host.textContent).toContain('two');
  });

  it('loads no relative image without a base', async () => {
    await show({ text: '![c](pic.png)' });
    expect(q('img')).toBeNull();
  });

  it('colors fenced code and offers a copy button', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await show({ text: '```ts\nconst x = 1;\n```\n\nand `inline`' });
    await until(() => q('.syn-keyword'));
    expect(q('.md-code-lang')?.textContent).toBe('ts');
    expect(q('.md-code pre')?.textContent).toBe('const x = 1;');
    expect(q('p code')?.textContent).toBe('inline');
    expect(q('p pre')).toBeNull();
    await act(async () => {
      (q('.md-code-copy') as HTMLButtonElement).click();
    });
    expect(writeText).toHaveBeenCalledWith('const x = 1;');
  });

  it('renders formulas with renderMath, and the source until then', async () => {
    await show({ text: 'inline $a^2$ and\n\n$$\nb^2\n$$' });
    await until(() => host.querySelectorAll('.katex-mock').length === 2);
    expect(renderMath).toHaveBeenCalledWith('a^2', false);
    expect(renderMath).toHaveBeenCalledWith('b^2', true);
    expect(q('.md-math-display .katex-mock')?.textContent).toBe('D:b^2');
  });

  it('shows the TeX source when it cannot be rendered', async () => {
    renderMath.mockImplementationOnce(async () => null as unknown as string);
    await show({ text: '$\\bad$' });
    await act(async () => {
      await sleep(20);
    });
    expect(q('.md-math-source code')?.textContent).toBe('\\bad');
  });

  it('recognizes .md, .mdx and .markdown paths', () => {
    for (const p of ['README.md', '/docs/a.mdx', 'notes.markdown', 'GUIDE.MD', 'doc.mkd']) expect(isMarkdownPath(p)).toBe(true);
    for (const p of ['main.ts', 'mvtrack.yaml', 'README.txt', 'md']) expect(isMarkdownPath(p)).toBe(false);
  });

  it('renders GitHub-style alert callouts safely and leaves regular blockquotes alone', async () => {
    await show({
      text: [
        '> [!NOTE]',
        '> Important detail here.',
        '',
        '> [!WARNING]',
        '> Watch out for `<script>alert(1)</script>`.',
        '',
        '> Plain quote.',
      ].join('\n'),
    });
    expect(q('.md-alert-note .md-alert-title')?.textContent).toBe('Note');
    expect(q('.md-alert-note .md-alert-body')?.textContent).toContain('Important detail here.');
    expect(q('.md-alert-warning .md-alert-title')?.textContent).toBe('Warning');
    expect(q('script')).toBeNull();
    expect(q('blockquote')?.textContent?.trim()).toBe('Plain quote.');
  });

  it('renders YAML frontmatter as escaped metadata without corrupting headings or horizontal rules', async () => {
    expect(parseFrontmatter('---\nnot valid yaml line\n---\nbody')).toBeUndefined();
    await show({
      text: ['---', 'title: "<script>alert(1)</script>"', 'tags:', '  - docs', '  - preview', '---', '', '# Real Title'].join('\n'),
    });
    expect(q('script')).toBeNull();
    expect(q('.md-frontmatter dt')?.textContent).toBe('title');
    expect(q('.md-frontmatter dd')?.textContent).toBe('<script>alert(1)</script>');
    expect(q('h1')?.textContent).toBe('Real Title');
  });

  it('deduplicates repeated heading anchor ids cleanly', async () => {
    await show({ text: '# Setup\n\n## Setup\n\n### Setup' });
    expect([...host.querySelectorAll('h1, h2, h3')].map((h) => h.id)).toEqual([
      'user-content-setup',
      'user-content-setup-1',
      'user-content-setup-2',
    ]);
  });

  it('neutralizes SVG/iframe/MDX XSS payloads', async () => {
    await show({
      text: [
        '<svg onload="alert(1)"></svg>',
        '',
        '<iframe src="javascript:alert(1)"></iframe>',
        '',
        '<CustomComponent onClick={() => alert(1)} />',
      ].join('\n'),
    });
    expect(q('svg')).toBeNull();
    expect(q('iframe')).toBeNull();
    expect(q('script')).toBeNull();
    expect(q('customcomponent')).toBeNull();
  });

  it('prefixes GFM footnote IDs once so footnote links jump cleanly', async () => {
    await show({ text: 'Text[^1]\n\n[^1]: Footnote body' });
    const fnLi = q('section[data-footnotes] li')!;
    expect(fnLi.id).toBe('user-content-fn-1');
    const scroll = vi.fn();
    fnLi.scrollIntoView = scroll;
    const refLink = q('sup a')!;
    expect(refLink.getAttribute('href')).toBe('#fn-1');
    act(() => void refLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(scroll).toHaveBeenCalled();
  });

  it('supports compact variant, option toggles, custom resolver hooks and streaming blocks', async () => {
    // Compact mode disables frontmatter by default and enables LaTeX math delimiters.
    await show({
      variant: 'compact',
      text: ['---', 'key: val', '---', '', String.raw`Inline \(a+b\) and`].join('\n'),
    });
    expect(q('.markdown')?.classList.contains('markdown-compact')).toBe(true);
    expect(q('.md-frontmatter')).toBeNull();
    await until(() => q('.katex-mock')?.textContent === 'I:a+b');

    // headingAnchors=false and codeCopy=false options work cleanly.
    await show({
      text: '# Plain Heading\n\n```ts\nconst y = 2;\n```',
      headingAnchors: false,
      codeCopy: false,
    });
    expect(q('h1')?.getAttribute('id')).toBeNull();
    expect(q('.md-code-copy')).toBeNull();

    // Custom resolveLink / resolveImage hooks work and unsafe resolved images are rejected.
    const onOpenPath = vi.fn();
    await show({
      text: '[doc](custom) ![good](a.png) ![bad](evil.png)',
      onOpenPath,
      resolveLink: (href) => (href === 'custom' ? '/resolved/custom.md' : undefined),
      resolveImage: (src) => (src === 'a.png' ? '/api/m/box/file?path=%2Fa.png' : 'javascript:alert(1)'),
    });
    const link = q('a')!;
    act(() => void link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(onOpenPath).toHaveBeenCalledWith('/resolved/custom.md');
    const imgs = host.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('/api/m/box/file?path=%2Fa.png');

    // streamBlocks keeps multi-line HTML comments and <details> blocks intact across blank lines.
    expect(streamBlocks('Intro\n\n<!--\nline 1\n\nline 2\n-->\n\nOutro')).toEqual(['Intro', '<!--\nline 1\n\nline 2\n-->', 'Outro']);
    expect(streamBlocks('<details>\n<summary>T</summary>\n\nBody\n\n</details>\n\nNext')).toEqual([
      '<details>\n<summary>T</summary>\n\nBody\n\n</details>',
      'Next',
    ]);

    // StreamMarkdown renders live blocks and collapses to a single document when done.
    await act(async () => {
      root.render(createElement(StreamMarkdown, { text: 'First\n\n<!-- hidden\n\ncomment -->\n\nSecond', live: true, variant: 'compact' }));
    });
    await vi.waitFor(() => expect(host.querySelector('.markdown-plain')).toBeNull(), { timeout: 5000 });
    expect(q('.md-stream')).not.toBeNull();
    expect(host.textContent).toContain('First');
    expect(host.textContent).toContain('Second');
    expect(host.textContent).not.toContain('hidden');
  });

  it('preserves single newlines as hard breaks in compact mode without changing document mode', async () => {
    // Document mode keeps CommonMark soft breaks (no <br>).
    await show({ text: 'line one\nline two' });
    expect(host.querySelectorAll('p br')).toHaveLength(0);

    // Compact mode (Agent Native View) converts single newlines into <br> while preserving formatting and code blocks.
    await show({
      variant: 'compact',
      text: 'line one\n**line two**\nline three\n\n```ts\nconst a = 1;\nconst b = 2;\n```',
    });
    expect(host.querySelectorAll('p br')).toHaveLength(2);
    expect(q('p strong')?.textContent).toBe('line two');
    expect(host.querySelectorAll('pre br')).toHaveLength(0);

    // Explicit hardBreaks=false overrides compact default.
    await show({ variant: 'compact', hardBreaks: false, text: 'line one\nline two' });
    expect(host.querySelectorAll('p br')).toHaveLength(0);
  });
});
