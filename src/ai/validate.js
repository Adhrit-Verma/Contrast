// Minimal JSON-Schema check for the subset Gemini's responseSchema supports.
// One schema definition serves both jobs: it is sent to the model AND used to
// validate what comes back. ponytail: no zod — a second schema definition of
// the same shape is a bug farm, not safety.

export function validate(value, schema, path = '$') {
  const errs = [];
  if (!schema) return errs;
  const type = schema.type?.toLowerCase();

  if (value === null || value === undefined) {
    if (schema.nullable) return errs;
    return [`${path}: expected ${type ?? 'value'}, got ${value}`];
  }
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
    for (const key of schema.required ?? []) {
      if (!(key in value)) errs.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errs.push(...validate(value[key], sub, `${path}.${key}`));
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    value.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
  } else if (type === 'string') {
    if (typeof value !== 'string') errs.push(`${path}: expected string`);
    else if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: "${value}" not in ${schema.enum.join('|')}`);
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) errs.push(`${path}: expected number`);
    else if (type === 'integer' && !Number.isInteger(value)) errs.push(`${path}: expected integer`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') errs.push(`${path}: expected boolean`);
  }
  return errs;
}

/** Models sometimes wrap JSON in prose or fences even in JSON mode. */
export function parseJson(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
    if (start === -1 || end <= start) throw new Error(`response is not JSON: ${trimmed.slice(0, 120)}`);
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
