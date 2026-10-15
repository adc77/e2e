import { expect, it } from 'vitest';
import { mergeModelProvenance, readModelProvenance, redactModelProvenance } from '../../src/cache/models.ts';
import { buildTraceEntry, readTraceEntry } from '../../src/cache/trace.ts';

const A = { provider: 'provider', model: 'model-A' };
const B = { provider: 'provider', model: 'model-B' };

it('merges distinct models and retains explicit incompleteness without inventing legacy identities', () => {
  expect(mergeModelProvenance({ models: [A], complete: true }, { models: [A, B], complete: true }))
    .toEqual({ models: [A, B], complete: true });
  expect(mergeModelProvenance(undefined, { models: [B], complete: true }))
    .toEqual({ models: [B], complete: false });
  expect(mergeModelProvenance({ models: [], complete: false }, { models: [B], complete: true }))
    .toEqual({ models: [B], complete: false });
  expect(mergeModelProvenance({ models: [], complete: true })).toEqual({ models: [], complete: true });
});

it('bounds model lists and marks omitted identities as incomplete', () => {
  const models = Array.from({ length: 17 }, (_, index) => ({ provider: 'provider', model: `model-${index}` }));
  expect(mergeModelProvenance({ models, complete: true })).toEqual({ models: models.slice(0, 16), complete: false });
  expect(mergeModelProvenance({ models: [{ provider: ' ', model: 'bad' }], complete: true })).toEqual({ models: [], complete: false });
});

it('redacts both identity components using the current ledger and deduplicates masked identities', () => {
  const source = { models: [{ provider: 'secret', model: 'secret' }, { provider: 'masked', model: 'masked' }], complete: true };
  expect(redactModelProvenance(source, (text) => text.replaceAll('secret', 'masked'))).toEqual({
    models: [{ provider: 'masked', model: 'masked' }], complete: true,
  });
  expect(source.models[0]!.provider).toBe('secret');
});

it.each([
  null,
  [],
  {},
  { models: [], complete: 'yes' },
  { models: 'model-A', complete: true },
  { models: [null], complete: true },
  { models: [{ provider: 'provider', model: 1 }], complete: true },
  { models: [{ provider: 'provider', model: ' ' }], complete: true },
  { models: [{ provider: 'x'.repeat(301), model: 'model' }], complete: true },
  { models: Array.from({ length: 17 }, () => A), complete: true },
])('rejects malformed recording metadata: %j', (value) => {
  expect(readModelProvenance(value)).toBeUndefined();
});

it('reads old entries and round-trips new metadata while rejecting invalid metadata', () => {
  const legacy = buildTraceEntry({ actions: [{ name: 'back', summary: 'back' }], executor: { name: 'test' }, summary: 'done' });
  expect(readTraceEntry(legacy)).toEqual(legacy);
  const recordedBy = { models: [A], complete: true };
  const current = { ...legacy, payload: { ...legacy.payload, recordedBy } };
  expect(readTraceEntry(current)).toEqual(current);
  expect(readTraceEntry({ ...legacy, payload: { ...legacy.payload, recordedBy: { models: [A], complete: 1 } } })).toBeUndefined();
});
