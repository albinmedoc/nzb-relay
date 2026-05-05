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
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

