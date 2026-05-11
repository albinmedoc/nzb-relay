import { computed, ref, type Ref } from 'vue';

type RowWithId = {
  id: string;
};

export function useRowSelection<T extends RowWithId>(rows: Ref<T[]>) {
  const selectedIds = ref<string[]>([]);
  const selectedRows = computed(() => rows.value.filter((row) => selectedIds.value.includes(row.id)));

  function toggleRow(id: string) {
    selectedIds.value = selectedIds.value.includes(id)
      ? selectedIds.value.filter((selectedId) => selectedId !== id)
      : [...selectedIds.value, id];
  }

  function toggleVisible() {
    const visibleIds = rows.value.map((row) => row.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.value.includes(id));
    if (allVisibleSelected) {
      selectedIds.value = selectedIds.value.filter((id) => !visibleIds.includes(id));
      return;
    }
    selectedIds.value = Array.from(new Set([...selectedIds.value, ...visibleIds]));
  }

  function clearSelection() {
    selectedIds.value = [];
  }

  return {
    selectedIds,
    selectedRows,
    toggleRow,
    toggleVisible,
    clearSelection
  };
}
