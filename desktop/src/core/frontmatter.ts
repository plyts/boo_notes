/** Minimal YAML front matter (flat `key: value` pairs), as written by Boo Notes. */

export interface Parsed {
  data: Record<string, string>;
  body: string;
}

export function parseFrontMatter(text: string): Parsed {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: normalized };
  const after = normalized.indexOf('\n', end + 4);
  const data: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const m = /^([\w-]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"')) {
      try {
        value = String(JSON.parse(value));
      } catch {
        value = value.slice(1, value.endsWith('"') ? -1 : undefined);
      }
    }
    data[m[1]] = value;
  }
  const body = after === -1 ? '' : normalized.slice(after + 1).replace(/^\n/, '');
  return { data, body };
}

/** Strings are JSON-quoted (a valid YAML double-quoted scalar) unless they are plain words. */
export function serializeFrontMatter(data: Record<string, string | number | undefined>, body: string): string {
  const lines = ['---'];
  for (const [key, raw] of Object.entries(data)) {
    if (raw === undefined) continue;
    const value = String(raw);
    lines.push(`${key}: ${/^[\w.:+-]+$/.test(value) ? value : JSON.stringify(value)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${body}`;
}
