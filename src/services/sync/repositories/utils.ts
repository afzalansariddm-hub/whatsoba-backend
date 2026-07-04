export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeJid(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  return normalized.length > 0 ? normalized : null;
}

export function normalizeKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();

  return normalized.length > 0 ? normalized : null;
}

export function dedupeByKey<T>(items: T[], keyFn: (item: T) => string | null): {
  records: T[];
  duplicateCount: number;
} {
  const records = new Map<string, T>();
  let duplicateCount = 0;

  for (const item of items) {
    const key = keyFn(item);

    if (!key) {
      continue;
    }

    if (records.has(key)) {
      duplicateCount += 1;
    }

    records.set(key, item);
  }

  return {
    records: Array.from(records.values()),
    duplicateCount
  };
}
