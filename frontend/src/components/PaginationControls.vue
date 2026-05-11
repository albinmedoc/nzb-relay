<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    total: number;
    limit: number;
    offset: number;
    pageSizes?: number[];
    disabled?: boolean;
  }>(),
  {
    pageSizes: () => [20, 50, 100],
    disabled: false
  }
);

const emit = defineEmits<{
  'update:limit': [value: number];
  'update:offset': [value: number];
}>();

const rangeText = computed(() => {
  if (props.total === 0) {
    return '0 of 0';
  }
  const start = props.offset + 1;
  const end = Math.min(props.offset + props.limit, props.total);
  return `${start}-${end} of ${props.total}`;
});

const canPrevious = computed(() => props.offset > 0);
const canNext = computed(() => props.offset + props.limit < props.total);

function setLimit(value: string) {
  emit('update:limit', Number(value));
  emit('update:offset', 0);
}

function previous() {
  emit('update:offset', Math.max(0, props.offset - props.limit));
}

function next() {
  emit('update:offset', props.offset + props.limit);
}
</script>

<template>
  <div class="pagination">
    <label>
      Rows
      <select :value="limit" :disabled="disabled" @change="setLimit(($event.target as HTMLSelectElement).value)">
        <option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
      </select>
    </label>
    <span class="muted">{{ rangeText }}</span>
    <button class="secondary" type="button" :disabled="disabled || !canPrevious" @click="previous">Previous</button>
    <button class="secondary" type="button" :disabled="disabled || !canNext" @click="next">Next</button>
  </div>
</template>
