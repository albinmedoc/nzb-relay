import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep } from '../src/utils/time.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('time utilities', () => {
  it('removes abort listeners when sleep finishes normally', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const done = sleep(1000, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes abort listeners when sleep is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const done = sleep(1000, controller.signal);
    controller.abort();
    await done;

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
