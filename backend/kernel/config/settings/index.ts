// The settings of the core and of its clients: definitions (define.ts) and
// the store of their values (store.ts).
export * from './define.ts';
export * from './store.ts';
// The name the composition roots know the store by (kernel/core.ts,
// kernel/feature.ts, hosts/bun/serve.ts).
export { Settings as Store } from './store.ts';
