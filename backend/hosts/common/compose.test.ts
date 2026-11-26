// What both hosts compose: which machines a run connects.
import { describe, expect, test } from 'bun:test';
import type { Spec } from '#kernel/machines/spec.ts';
import { selectSpecs } from '#hosts/common/compose.ts';

describe('selectSpecs', () => {
  const ssh = (id: string, label = id, target = id): Spec => ({ id, label, kind: 'ssh', target, enabled: true });
  const specs: Spec[] = [
    { id: 'local', label: 'Mac (local)', kind: 'local', enabled: true },
    ssh('a1', 'GPU', 'me@gpu'),
    ssh('b2', 'box', 'box'),
    ssh('x@y'),
  ];
  const ids = (l: Spec[]) => l.map((s) => s.id);

  test('every machine by default', () => {
    expect(ids(selectSpecs(specs, false, [], []))).toEqual(['local', 'a1', 'b2', 'x@y']);
  });

  test('--local-only keeps the local machine and the --ssh ones of this run', () => {
    expect(ids(selectSpecs(specs, true, [], []))).toEqual(['local']);
    expect(ids(selectSpecs(specs, true, ['x@y'], []))).toEqual(['local', 'x@y']);
  });

  test('--machine selects by id, label or target', () => {
    expect(ids(selectSpecs(specs, false, [], ['a1']))).toEqual(['a1']);
    expect(ids(selectSpecs(specs, false, [], ['box', 'me@gpu']))).toEqual(['a1', 'b2']);
    expect(ids(selectSpecs(specs, false, [], ['Mac (local)']))).toEqual(['local']);
  });
});
