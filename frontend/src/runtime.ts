import { computed } from 'vue';

const config = window.NZB_RELAY_CONFIG ?? {};

export const backendUrl = config.backendUrl?.trim() ?? '';
export const backendToken = config.token?.trim() ?? '';
export const apiBase = computed(() => normalizeApiBase(backendUrl));
export const backendLabel = computed(() => apiBase.value === '/v1' ? 'same origin' : apiBase.value);

function normalizeApiBase(value: string): string {
  const trimmed = value?.trim().replace(/\/+$/, '') ?? '';
  if (!trimmed) {
    return '/v1';
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}
