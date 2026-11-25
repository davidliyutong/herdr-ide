// The product's names. Every identifier that contains the product name at
// runtime (binaries, directories, protocol prefixes, storage keys) derives
// from these constants; web/src/brand.ts and the bridge extension's
// src/brand.ts copy them (brand.test.ts keeps them in sync), and
// scripts/rename.sh renames all three.

/** The display name. */
export const NAME = 'veldr';
/** The lowercase identifier of binaries, directories, protocol prefixes and storage keys. */
export const SLUG = 'veldr';
/** The product's domain; reversed, it begins the desktop app's id. */
export const DOMAIN = 'veldr.app';
/** Prefix of environment variables. */
export const ENV_PREFIX = 'VELDR_';

/** The binary: the core and, on machines, the agent it starts. */
export const CORE_BIN = SLUG;
/** The VS Code bridge extension's name; its publisher is SLUG. */
export const BRIDGE_EXT = `${SLUG}-bridge`;
/** The extension's identifier (publisher.name) in code-server. */
export const BRIDGE_EXT_ID = `${SLUG}.${BRIDGE_EXT}`;
/** The per-machine state directory below $HOME. */
export const DATA_DIR_NAME = `.${SLUG}`;
/** Uploaded agents (shared by instances; one directory per build), relative to $HOME. */
export const AGENT_DIR = `${DATA_DIR_NAME}/agent`;

/** The name of a product environment variable. */
export const env = (name: string): string => ENV_PREFIX + name;

/** The state directory name of an instance; several cores share machines without sharing state. */
export const dataDir = (instance: string): string => (instance === '' ? DATA_DIR_NAME : `${DATA_DIR_NAME}-${instance}`);

/** Whether s is usable as an instance name: empty, or up to 32 of a-z, 0-9 and '-'. */
export const validInstance = (s: string): boolean => s === '' || (s.length <= 32 && /^[a-z0-9-]+$/.test(s));
