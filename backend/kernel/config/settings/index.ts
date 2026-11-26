// The settings of the hub and of its clients: definitions (define.ts) and
// the store of their values (store.ts).
export * from './define.ts';
export * from './store.ts';
// The name the composition roots know the store by (kernel/hub.ts,
// kernel/feature.ts, hosts/common/compose.ts).
export { Settings as Store } from './store.ts';
