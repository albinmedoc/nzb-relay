import { ref } from 'vue';

export const error = ref('');
export const notice = ref('');

export function clearMessages(): void {
  error.value = '';
  notice.value = '';
}

export function setNotice(message: string): void {
  error.value = '';
  notice.value = message;
}

export function setError(cause: unknown, fallback = 'request failed'): void {
  notice.value = '';
  error.value = cause instanceof Error ? cause.message : fallback;
}

export async function runAction(action: () => Promise<void>): Promise<void> {
  clearMessages();
  try {
    await action();
  } catch (cause) {
    setError(cause);
  }
}
