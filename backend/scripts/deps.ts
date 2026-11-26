// Pinned upstream releases of the four native submodules split out into
// independent repositories (davidliyutong/<slug>-<component>):
//   - encoder:    Linux FFmpeg/NVENC/VA-API/libvpx window video encoder
//   - vt:         Ghostty libghostty-vt WebAssembly terminal emulator
//   - gpupick:    Linux CUDA_VISIBLE_DEVICES GPU isolation LD_PRELOAD .so
//   - gui-helper: Static Linux X11/Wayland capture, compositor and keeper
//
// Downloads are verified against these SHA-256 digests at fetch time
// (fetch-deps.ts) before any member is extracted.
import type { Artifact } from './hcdist.ts';

export const OWNER = 'davidliyutong';
// Fixed upstream repository prefix on GitHub (stays unchanged if a fork
// renames the downstream product with scripts/rename.sh).
const UPSTREAM = ['vel', 'dr'].join('');

/** Bounds a release archive download (encoder archives are ~4 MB). */
export const MAX_DEP_ARCHIVE = 128 << 20;
/** Bounds an extracted binary or wasm module. */
export const MAX_DEP_BINARY = 64 << 20;
/** Bounds an extracted license or notice file. */
export const MAX_DEP_LICENSE = 4 << 20;

export interface SubmoduleRelease {
  repo: string;
  version: string;
  artifacts: Readonly<Record<string, Artifact>>;
}

export const ENCODER: SubmoduleRelease = {
  repo: `${UPSTREAM}-encoder`,
  version: '0.1.0',
  artifacts: {
    'linux-amd64': {
      name: `${UPSTREAM}-encoder-linux-amd64.tar.gz`,
      sha256: '0947b5b8e990001bc8e85c9b4c915a8875b58eab4fe5713901de7b0a0f237f6f',
    },
    'linux-arm64': {
      name: `${UPSTREAM}-encoder-linux-arm64.tar.gz`,
      sha256: 'c8b9afd6960e5a396696b8ef7c1ce46cde44915318938c409cd9eecd138bb274',
    },
  },
};

export const ENCODER_LICENSES = [
  'FFMPEG-LGPL-2.1.txt',
  'LIBDRM-LICENSE.txt',
  'LIBVA-LICENSE.txt',
  'LIBVPX-LICENSE.txt',
  'LIBVPX-PATENTS.txt',
  'NV-CODEC-HEADERS-LICENSE.txt',
  'README.md',
] as const;

export const VT: SubmoduleRelease = {
  repo: `${UPSTREAM}-vt`,
  version: '0.1.0',
  artifacts: {
    wasm: {
      name: `${UPSTREAM}-vt-wasm.tar.gz`,
      sha256: '668315a60392824867118e47c4d261d4302a7427ea24ac32cffe622b471d89bc',
    },
  },
};

export const GPUPICK: SubmoduleRelease = {
  repo: `${UPSTREAM}-gpupick`,
  version: '0.1.0',
  artifacts: {
    'linux-amd64': {
      name: `${UPSTREAM}-gpupick-linux-amd64.tar.gz`,
      sha256: '1551b27c5b5f071d9054d90438f1e963f7b4df4a092192eb6a6f9c412bbf2d55',
    },
    'linux-arm64': {
      name: `${UPSTREAM}-gpupick-linux-arm64.tar.gz`,
      sha256: '498ff8715348923cdf6f0d136ef3eb262e2b44b16bbda320b5725b87142b6828',
    },
  },
};

export const GUI_HELPER: SubmoduleRelease = {
  repo: `${UPSTREAM}-gui-helper`,
  version: '0.1.0',
  artifacts: {
    'linux-amd64': {
      name: `${UPSTREAM}-gui-helper-linux-amd64.tar.gz`,
      sha256: '254f912684dd636cf97321178254f0d12879748a7b727f9fd35c5e49b60fd810',
    },
    'linux-arm64': {
      name: `${UPSTREAM}-gui-helper-linux-arm64.tar.gz`,
      sha256: 'a326e81e8b067665be5ff14fb58954cf6e0cae4dd886ff050f489c6e797ffe77',
    },
  },
};

export const ALL_SUBMODULES = {
  encoder: ENCODER,
  vt: VT,
  gpupick: GPUPICK,
  'gui-helper': GUI_HELPER,
} as const;

export type SubmoduleKind = keyof typeof ALL_SUBMODULES;

/** GitHub release asset URL for a submodule artifact. */
export function depUrlOf(rel: SubmoduleRelease, a: Artifact): string {
  return `https://github.com/${OWNER}/${rel.repo}/releases/download/v${rel.version}/${a.name}`;
}
