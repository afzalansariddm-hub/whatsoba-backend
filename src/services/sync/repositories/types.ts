export interface BulkUpsertStats {
  inputCount: number;
  validCount: number;
  duplicateCount: number;
  existingCount: number;
  persistedCount: number;
  invalidCount: number;
}

export interface BulkUpsertResult<TRecord> {
  stats: BulkUpsertStats;
  records: TRecord[];
  byKey: Map<string, TRecord>;
}
