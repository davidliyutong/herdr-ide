// The stream protocol between the core and a machine's agent.
export * from './proto.ts';
export * from './gui.ts';
export * from './hidden.ts';
export * from './history.ts';
export * from './transcript.ts';
export * from './vault.ts';
export { defaultConfig as yamuxConfig } from '#shared/proto/yamux.ts';
