export function nowIso(): string {
  return new Date().toISOString();
}

export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePhone(value: unknown): string | null {
  const text = normalizeText(value);

  if (!text) {
    return null;
  }

  return text.replace(/[^\d+]/g, '');
}

export function normalizeJid(value: unknown): string | null {
  const text = normalizeText(value);

  return text ? text.toLowerCase() : null;
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string | null): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = keyFn(item);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

export function maxIso(values: Array<string | null | undefined>): string | null {
  const filtered = values.filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (filtered.length === 0) {
    return null;
  }

  return filtered.sort().at(-1) ?? null;
}
