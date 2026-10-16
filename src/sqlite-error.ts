export function isUniqueConstraint(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    String((err as { code: unknown }).code).includes('SQLITE_CONSTRAINT') &&
    /unique/i.test(err.message)
  );
}

export function isBusy(err: unknown): boolean {
  return err instanceof Error && 'code' in err && String((err as { code: unknown }).code).includes('SQLITE_BUSY');
}
