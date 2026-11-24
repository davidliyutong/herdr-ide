import { describe, expect, test } from 'bun:test';
import { archiveName, baseName, cleanPath, downloadPaths, keptName, uploadName, uploadTarget, MAX_DOWNLOAD_PATHS } from './names.ts';

describe('paths', () => {
  test('cleanPath and baseName as Go names them', () => {
    for (const [p, want] of Object.entries({
      '/a/b/../c': '/a/c',
      '/x/': '/x',
      '/': '/',
      '//a//b': '/a/b',
      '/../x': '/x',
      '': '.',
      'a/./b/': 'a/b',
    }))
      expect([p, cleanPath(p)]).toEqual([p, want]);
    for (const [p, want] of Object.entries({ '/a/b': 'b', '/a/b/': 'b', '/': '/', '': '.', x: 'x', '//': '/' }))
      expect([p, baseName(p)]).toEqual([p, want]);
  });

  test('downloadPaths', () => {
    expect(downloadPaths(['/a/b/../c', '/a/c', '/x/'])).toEqual(['/a/c', '/x']);
    for (const bad of [[], ['relative'], ['~/x'], ['/a\0b'], Array<string>(MAX_DOWNLOAD_PATHS + 1).fill('/a')])
      expect(() => downloadPaths(bad)).toThrow();
  });

  test('archiveName', () => {
    const cases: Array<[string[], string]> = [
      [['/home/u/proj'], 'proj.zip'],
      [['/home/u/proj/a', '/home/u/proj/b/c'], 'proj.zip'],
      [['/home/u/proj/a', '/home/u/projx/b'], 'u.zip'],
      [['/a', '/b'], 'download.zip'],
      [['/'], 'download.zip'],
    ];
    for (const [paths, want] of cases) expect([paths, archiveName(paths)]).toEqual([paths, want]);
  });
});

describe('uploads', () => {
  // Uploads are named with the local time, as the Go core's time.Now.
  const now = new Date(2026, 9, 30, 2, 15, 0);

  test('upload names are unique and safe', () => {
    const a = uploadName('image.png', now);
    const b = uploadName('image.png', now);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^20261030-021500-[0-9a-f]{8}-image\.png$/);
    expect(uploadName('../../etc/pa ss;wd', now)).not.toMatch(/[/ ;]/);
    expect(uploadName('', now)).toEndWith('-upload');
    expect(uploadName('..', now)).toEndWith('-upload');
    expect(
      uploadName('x'.repeat(100) + '.png', now)
        .split('-')
        .pop(),
    ).toHaveLength(80);
  });

  test('upload into a directory', () => {
    const t = uploadTarget({ name: 'shot.png', dir: '' }, '/home/u/.veldr/uploads', now);
    expect([t.mkdirs, t.unique, t.path.slice(0, t.path.lastIndexOf('/'))]).toEqual([true, undefined, '/home/u/.veldr/uploads']);
    // Into a pane's directory under the file's own name, without replacing.
    const cases: Record<string, string> = {
      'my shot.png': '/home/u/proj/my shot.png',
      '../../etc/passwd': '/home/u/proj/passwd',
      'a\0\nb.txt': '/home/u/proj/ab.txt',
      '..': '/home/u/proj/upload',
      '': '/home/u/proj/upload',
      '  \u00a0spaced\t ': '/home/u/proj/spaced',
      '截图 2026-11-03.png': '/home/u/proj/截图 2026-11-03.png',
    };
    for (const [name, want] of Object.entries(cases))
      expect([name, uploadTarget({ name, dir: '/home/u/proj' }, '/up', now)]).toEqual([name, { path: want, unique: true }]);
    expect(uploadTarget({ name: 'a', dir: '~/proj' }, '/up', now).path).toBe('~/proj/a');
    expect(uploadTarget({ name: 'a', dir: '~' }, '/up', now).path).toBe('~/a');
    for (const dir of ['proj', './proj', '~user/proj'])
      expect(() => uploadTarget({ name: 'a', dir }, '/up', now)).toThrow('dir must be absolute');
    const long = keptName('é'.repeat(150) + '.png');
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long).toEndWith('é.png');
    expect(long).not.toContain('�');
  });
});
