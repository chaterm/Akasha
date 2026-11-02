import { createHash } from 'node:crypto';

/** Content must be schema-normalized before fingerprinting. Access scopes are not generation metadata. */
export function fingerprintTemplate(template: {
  id: string;
  title?: string | null;
  description?: string | null;
  icon?: string | null;
  content: unknown;
}): string {
  return createHash('sha256')
    .update(
      stableJson({
        id: template.id,
        title: template.title ?? null,
        description: template.description ?? null,
        icon: template.icon ?? null,
        content: template.content,
      }),
    )
    .digest('hex');
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
