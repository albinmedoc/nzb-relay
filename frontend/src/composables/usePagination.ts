import { ref } from 'vue';

export function usePagination(initialLimit = 20) {
  const limit = ref(initialLimit);
  const offset = ref(0);

  function reset() {
    offset.value = 0;
  }

  function setLimit(value: number) {
    limit.value = value;
    reset();
  }

  function setOffset(value: number) {
    offset.value = value;
  }

  return {
    limit,
    offset,
    reset,
    setLimit,
    setOffset
  };
}
