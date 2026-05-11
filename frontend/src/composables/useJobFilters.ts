import { computed, ref } from 'vue';
import type { JobListParams, JobStatus } from '../types';

export function useJobFilters(onChange: () => void) {
  const status = ref<'all' | JobStatus>('all');
  const createdAfter = ref('');
  const createdBefore = ref('');

  const apiFilters = computed<Pick<JobListParams, 'status' | 'createdAfter' | 'createdBefore'>>(() => ({
    status: status.value === 'all' ? undefined : status.value,
    createdAfter: dateToIso(createdAfter.value, false),
    createdBefore: dateToIso(createdBefore.value, true)
  }));

  function applyFilters() {
    onChange();
  }

  function clearFilters() {
    status.value = 'all';
    createdAfter.value = '';
    createdBefore.value = '';
    onChange();
  }

  return {
    status,
    createdAfter,
    createdBefore,
    apiFilters,
    applyFilters,
    clearFilters
  };
}

function dateToIso(value: string, endOfDay: boolean): string | undefined {
  if (!value) {
    return undefined;
  }
  const suffix = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
  return new Date(`${value}${suffix}`).toISOString();
}
