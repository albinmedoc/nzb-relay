export function nowIso(): string {
  return new Date().toISOString();
}

export function addMillisecondsIso(baseIso: string, milliseconds: number): string {
  return new Date(new Date(baseIso).getTime() + milliseconds).toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      finish();
    };
    const timeout = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
