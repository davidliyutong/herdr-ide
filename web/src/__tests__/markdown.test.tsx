// @vitest-environment jsdom
//
// Rendered Markdown: what links and images may point to (the text is not
// trusted), the elements it produces, code colors and formulas.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const renderMath = vi.fn(async (tex: string, display: boolean) => `<span class="katex-mock">${display ? 'D' : 'I'}:${tex}</span>`);
vi.mock('../terminal/mathRender', () => ({ renderMath: (tex: string, display: boolean) => renderMath(tex, display) }));

import { imageSource, relativePath, safeLink } from '../markdown/links';
import { Markdown, type MarkdownProps } from '../markdown/Markdown';

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

  it('shows raw HTML as text', async () => {
    await show({ text: ['<script>alert(1)</script>', '', '<img src=x onerror=alert(1)>', '', 'a <b>bold</b> b'].join('\n') });
    expect(q('script')).toBeNull();
    expect(q('img')).toBeNull();
    expect(q('b')).toBeNull();
    expect(host.textContent).toContain('<script>alert(1)</script>');
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
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
    renderMath.mockImplementation(async () => null as unknown as string);
    await show({ text: '$\\bad$' });
    await act(async () => {
      await sleep(20);
    });
    expect(q('.md-math-source code')?.textContent).toBe('\\bad');
  });
});
