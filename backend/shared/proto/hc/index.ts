// herdr-core's API (protocol generation 1): JSON-RPC 2.0 over a connection
// that the hello switches to framed mode.
export * from './types.ts';
export * from './conn.ts';
export { GENERATION, MAX_PAYLOAD, WINDOW } from './wire.ts';
