// @vitest-environment jsdom
//
// File-type icons (fileIcons.tsx): special names before compound
// extensions before extensions, case ignored; folders by name, open and
// closed; links; the colors are design tokens legible on the interface's
// backgrounds in both themes.

import { describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { FileSymlink, FolderOpen, FolderSymlink } from 'lucide-react';
import tokens from '../../../spec/tokens.json';
import { FILE_ICON_COLORS, FileIcon, fileIcon } from '../fileIcons';
import { t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (name: string, kind: 'file' | 'dir' = 'file', open = false) => fileIcon(name, kind, open).id;

describe('file icons', () => {
  it('know special names, whatever their case', () => {
    expect(id('package.json')).toBe('npm');
    expect(id('Package.JSON')).toBe('npm');
    expect(id('go.mod')).toBe('go.package');
    expect(id('go.sum')).toBe('lock');
    expect(id('Cargo.toml')).toBe('rust.package');
    expect(id('Cargo.lock')).toBe('lock');
    expect(id('Dockerfile')).toBe('docker');
    expect(id('Dockerfile.dev')).toBe('docker');
    expect(id('docker-compose.yml')).toBe('docker');
    expect(id('docker-compose.override.yaml')).toBe('docker');
    expect(id('compose.yaml')).toBe('docker');
    expect(id('Makefile')).toBe('make');
    expect(id('GNUmakefile')).toBe('make');
    expect(id('CMakeLists.txt')).toBe('cmake');
    expect(id('README')).toBe('readme');
    expect(id('README.md')).toBe('readme');
    expect(id('readme.zh-CN.md')).toBe('readme');
    expect(id('LICENSE')).toBe('license');
    expect(id('LICENSE-MIT')).toBe('license');
    expect(id('licence.txt')).toBe('license');
    expect(id('COPYING')).toBe('license');
    expect(id('CHANGELOG.md')).toBe('changelog');
    expect(id('.gitignore')).toBe('git');
    expect(id('.gitattributes')).toBe('git');
    expect(id('.env')).toBe('env');
    expect(id('.env.local')).toBe('env');
    expect(id('.envrc')).toBe('env');
    expect(id('yarn.lock')).toBe('lock');
    expect(id('pnpm-lock.yaml')).toBe('lock');
    expect(id('package-lock.json')).toBe('lock');
    expect(id('tsconfig.json')).toBe('tsconfig');
    expect(id('tsconfig.node.json')).toBe('tsconfig');
    expect(id('vite.config.ts')).toBe('vite');
    expect(id('vitest.config.mts')).toBe('vitest');
    expect(id('.eslintrc.json')).toBe('eslint');
    expect(id('.bashrc')).toBe('shell');
    expect(id('requirements-dev.txt')).toBe('python.package');
    expect(id('pyproject.toml')).toBe('python.package');
  });

  it('take the longest extension that ends the name', () => {
    expect(id('index.d.ts')).toBe('typescript.declaration');
    expect(id('App.test.tsx')).toBe('test.react');
    expect(id('api.spec.ts')).toBe('test.typescript');
    expect(id('a.b.test.js')).toBe('test.javascript');
    expect(id('release.tar.gz')).toBe('archive');
    expect(id('vendor.min.js')).toBe('javascript.minified');
    expect(id('Button.stories.tsx')).toBe('stories');
  });

  it('know the common kinds of files by extension', () => {
    const cases: Record<string, string> = {
      'main.ts': 'typescript',
      'App.tsx': 'react',
      'index.js': 'javascript',
      'mod.mjs': 'javascript',
      'main.go': 'go',
      'lib.rs': 'rust',
      'app.py': 'python',
      'x.rb': 'ruby',
      'Main.java': 'java',
      'main.c': 'c',
      'main.cpp': 'cpp',
      'Prog.cs': 'csharp',
      'run.sh': 'shell',
      'Setup.ps1': 'powershell',
      'index.html': 'html',
      'style.css': 'css',
      'theme.scss': 'sass',
      'doc.md': 'markdown',
      'notes.txt': 'text',
      'data.json': 'json',
      'config.yaml': 'yaml',
      'ci.yml': 'yaml',
      'Cargo.config.toml': 'toml',
      'app.ini': 'ini',
      'pom.xml': 'java.package',
      'feed.xml': 'xml',
      'table.csv': 'spreadsheet',
      'q.sql': 'sql',
      'app.db': 'database',
      'photo.JPG': 'image',
      'logo.svg': 'svg',
      'clip.mp4': 'video',
      'song.mp3': 'audio',
      'a.zip': 'archive',
      'a.7z': 'archive',
      'pkg.deb': 'package',
      'paper.pdf': 'pdf',
      'report.docx': 'document',
      'sheet.xlsx': 'spreadsheet',
      'deck.pptx': 'presentation',
      'font.woff2': 'font',
      'cert.pem': 'certificate',
      'id_ed25519.pub': 'key',
      'server.key': 'key',
      'app.log': 'log',
      'nb.ipynb': 'notebook',
      'fix.patch': 'diff',
      'tool.exe': 'binary',
      'libx.so': 'binary',
      'mod.wasm': 'webassembly',
      'rules.mk': 'make',
    };
    for (const [name, want] of Object.entries(cases)) expect([name, id(name)]).toEqual([name, want]);
  });

  it('give other files the plain icon', () => {
    expect(id('notes')).toBe('file');
    expect(id('.hidden')).toBe('file');
    expect(id('a.unknownext')).toBe('file');
    expect(fileIcon('notes', 'file').color).toBeUndefined();
  });

  it('know special folders, open and closed', () => {
    expect(id('.git', 'dir')).toBe('folder.git');
    expect(id('.github', 'dir')).toBe('folder.github');
    expect(id('.vscode', 'dir')).toBe('folder.vscode');
    expect(id('node_modules', 'dir')).toBe('folder.dependencies');
    expect(id('src', 'dir')).toBe('folder.src');
    expect(id('Tests', 'dir')).toBe('folder.test');
    expect(id('__tests__', 'dir')).toBe('folder.test');
    expect(id('docs', 'dir')).toBe('folder.docs');
    expect(id('dist', 'dir')).toBe('folder.dist');
    expect(id('build', 'dir')).toBe('folder.dist');
    expect(id('scripts', 'dir')).toBe('folder.scripts');
    expect(id('public', 'dir')).toBe('folder.assets');
    expect(id('assets', 'dir')).toBe('folder.assets');
    expect(id('.cache', 'dir')).toBe('folder.cache');
    expect(id('.unknown', 'dir')).toBe('folder.hidden');
    expect(id('photos', 'dir')).toBe('folder');
    // A file named like a folder is a file (Bazel's BUILD).
    expect(id('build')).toBe('build');
    const open = fileIcon('src', 'dir', true);
    expect(open).toMatchObject({ id: 'folder.src', icon: FolderOpen, color: fileIcon('src', 'dir').color });
  });

  it('use the design tokens of the file icon hues', () => {
    expect(Object.keys(tokens.fileIcon).sort()).toEqual([...FILE_ICON_COLORS].sort());
  });

  // Icons are graphics: 3:1 against what they are drawn on, the
  // background, the sidebars and a selected row, in both themes.
  for (const kind of ['dark', 'light'] as const) {
    it(`are legible on the ${kind} theme's backgrounds`, () => {
      const backgrounds = (['background', 'sidebar', 'hover', 'accent'] as const).map((n) => tokens.color[n][kind]);
      for (const name of FILE_ICON_COLORS) {
        for (const bg of backgrounds) {
          expect([name, bg, contrast(tokens.fileIcon[name][kind], bg) >= 3]).toEqual([name, bg, true]);
        }
      }
    });
  }

  it('draw in their color, and links with the link icon of their kind', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement('div', null, [
          createElement(FileIcon, { key: 1, name: 'main.go', kind: 'file' }),
          createElement(FileIcon, { key: 2, name: 'notes', kind: 'file' }),
          createElement(FileIcon, { key: 3, name: 'main.go', kind: 'file', link: true }),
        ]),
      ),
    );
    const [go, plain, link] = [...host.querySelectorAll<SVGElement>('svg')];
    expect(go.dataset.icon).toBe('go');
    expect(go.getAttribute('style')).toContain('var(--ds-file-icon-sky)');
    expect(go.getAttribute('aria-hidden')).toBe('true');
    expect(plain.getAttribute('style')).toBeNull();
    expect(link.getAttribute('style')).toContain('var(--ds-file-icon-sky)');
    expect(link.getAttribute('aria-label')).toBe(t('fileIcon.link'));
    expect(link.classList.toString()).toContain('file-symlink');
    expect(FileSymlink).not.toBe(FolderSymlink);
    act(() => root.unmount());
  });
});

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
