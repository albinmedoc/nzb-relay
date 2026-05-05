import type { Context } from 'hono';

export function errorResponse(c: Context, status: number, code: string, error: string): Response {
  const requestId = c.get('requestId' as never) as string | undefined;
  return c.json({ error, code, ...(requestId ? { requestId } : {}) }, status as never);
}

export function isSqliteUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('code' in error ? (error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE' : false)
  );
}
