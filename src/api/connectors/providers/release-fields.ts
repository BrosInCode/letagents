import { asRecord, asString } from './http.js';

/** Small, credential-free signals. Never copy rich text, users or arbitrary custom-field objects. */
export interface ReleaseField { id: string; name: string; values: string[] | null }
export function releaseLabels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.flatMap(item => {
    const name = typeof item === 'string' ? item : asString(asRecord(item).name);
    return name && name.length <= 240 ? [name] : [];
  }))];
}
export function releaseOptions(value: unknown): string[] | null {
  if (value === null) return [];
  if (typeof value === 'boolean') return [String(value)];
  const values = Array.isArray(value) ? value : [value];
  if (values.some(item => !asString(asRecord(item).value))) return null;
  return [...new Set(values.flatMap(item => {
    const text = asString(asRecord(item).value);
    return text && text.length <= 240 ? [text] : [];
  }))];
}
export function readReleaseFields(value: unknown): ReleaseField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<ReleaseField>(item => {
    const field = asRecord(item), id = asString(field.id), name = asString(field.name);
    if (!id || !/^[A-Za-z0-9_.:-]{1,240}$/.test(id) || !name || name.length > 240) return [];
    if (field.values === null) return [{ id, name, values: null }];
    if (!Array.isArray(field.values) || field.values.some(v => typeof v !== 'string' || v.length > 240)) return [];
    return [{ id, name, values: [...new Set(field.values as string[])] }];
  });
}

/** A denied/partial read is not evidence that a known release flag was cleared. */
export function preserveReleaseFields(previous: Record<string, unknown>, incoming: Record<string, unknown>) {
  const old = readReleaseFields(previous.releaseFields), fields = readReleaseFields(incoming.releaseFields);
  let unavailable = incoming.releaseMetadataAvailable === false;
  for (const prior of old) {
    const field = fields.find(value => value.id === prior.id);
    if (field?.values === null && prior.values !== null) { field.values = prior.values; unavailable = true; }
    else if (!field && (incoming.releaseMetadataAvailable === false || !Array.isArray(incoming.releaseFields))) {
      fields.push(prior); unavailable = true;
    }
  }
  return { releaseFields: fields, releaseRefreshFailed: unavailable };
}
