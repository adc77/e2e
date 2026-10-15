/** Model identities reported while producing a recording, independent of its replay key. */
export interface ModelProvenance {
  readonly models: readonly RecordedModel[];
  readonly complete: boolean;
}

/** One reported model identity; missing identities are represented by incomplete provenance. */
interface RecordedModel {
  readonly provider: string;
  readonly model: string;
}

const MAX_RECORDED_MODELS = 16;
const MAX_RECORDED_MODEL_CHARS = 300;

/** Reads bounded, nonempty model identifiers without inventing an identity. */
export function readRecordedModel(value: unknown): RecordedModel | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const provider = raw['provider'];
  const model = raw['model'];
  if (typeof provider !== 'string' || provider.trim() === '' || provider.length > MAX_RECORDED_MODEL_CHARS) return undefined;
  if (typeof model !== 'string' || model.trim() === '' || model.length > MAX_RECORDED_MODEL_CHARS) return undefined;
  return { provider, model };
}

/** Validates optional recording metadata without changing which actions can replay. */
export function readModelProvenance(value: unknown): ModelProvenance | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['complete'] !== 'boolean' || !Array.isArray(raw['models']) || raw['models'].length > MAX_RECORDED_MODELS) return undefined;
  const models: RecordedModel[] = [];
  for (const item of raw['models']) {
    const model = readRecordedModel(item);
    if (model === undefined) return undefined;
    models.push(model);
  }
  return { models, complete: raw['complete'] };
}

/** Unions known identities and marks any missing or over-limit contribution as incomplete. */
export function mergeModelProvenance(...sources: readonly (ModelProvenance | undefined)[]): ModelProvenance {
  const models: RecordedModel[] = [];
  let complete = true;
  for (const source of sources) {
    if (source === undefined) {
      complete = false;
      continue;
    }
    complete &&= source.complete;
    for (const item of source.models) {
      const model = readRecordedModel(item);
      if (model === undefined) {
        complete = false;
      } else if (!models.some((known) => known.provider === model.provider && known.model === model.model)) {
        if (models.length === MAX_RECORDED_MODELS) complete = false;
        else models.push(model);
      }
    }
  }
  return { models, complete };
}

/** Reapplies the current secret ledger before metadata reaches a report or recording. */
export function redactModelProvenance(source: ModelProvenance, redact: (text: string) => string): ModelProvenance {
  return mergeModelProvenance({
    complete: source.complete,
    models: source.models.map((model) => ({ provider: redact(model.provider), model: redact(model.model) })),
  });
}
