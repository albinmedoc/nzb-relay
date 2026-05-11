<script setup lang="ts">
type RowWithId = {
  id: string;
};

const props = withDefaults(
  defineProps<{
    rows: RowWithId[];
    loading?: boolean;
    emptyMessage: string;
    selectable?: boolean;
    selectedIds?: string[];
  }>(),
  {
    loading: false,
    selectable: false,
    selectedIds: () => []
  }
);

const emit = defineEmits<{
  'toggle-row': [id: string];
  'toggle-visible': [];
}>();

defineSlots<{
  header(): unknown;
  row(props: { row: any; selected: boolean }): unknown;
}>();

function isSelected(id: string): boolean {
  return props.selectedIds.includes(id);
}
</script>

<template>
  <div v-if="rows.length === 0" class="empty">{{ loading ? 'Loading.' : emptyMessage }}</div>
  <div v-else class="table-wrap">
    <table>
      <thead>
        <tr>
          <th v-if="selectable" class="select-col">
            <input
              type="checkbox"
              :checked="rows.length > 0 && rows.every((row) => isSelected(row.id))"
              :aria-label="rows.length > 0 && rows.every((row) => isSelected(row.id)) ? 'Clear visible rows' : 'Select visible rows'"
              @change="emit('toggle-visible')"
            />
          </th>
          <slot name="header" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :class="{ selected: isSelected(row.id) }">
          <td v-if="selectable" class="select-col">
            <input
              type="checkbox"
              :checked="isSelected(row.id)"
              :aria-label="isSelected(row.id) ? 'Deselect row' : 'Select row'"
              @change="emit('toggle-row', row.id)"
            />
          </td>
          <slot name="row" :row="row" :selected="isSelected(row.id)" />
        </tr>
      </tbody>
    </table>
  </div>
</template>
