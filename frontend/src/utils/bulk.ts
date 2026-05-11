export async function runBulk<T>(
  rows: T[],
  action: (row: T) => Promise<void>
): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await action(row);
      completed += 1;
    } catch {
      failed += 1;
    }
  }

  return { completed, failed };
}

export function bulkSummary(action: string, result: { completed: number; failed: number }): string {
  if (result.failed === 0) {
    return `${action} completed for ${result.completed} item${result.completed === 1 ? '' : 's'}.`;
  }
  return `${action} completed for ${result.completed} item${result.completed === 1 ? '' : 's'}; ${result.failed} failed.`;
}
