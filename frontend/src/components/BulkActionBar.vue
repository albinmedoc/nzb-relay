<script setup lang="ts">
defineProps<{
  selectedCount: number;
}>();

const emit = defineEmits<{
  clear: [];
}>();
</script>

<template>
  <div v-if="selectedCount > 0" class="bulk-bar">
    <strong>{{ selectedCount }} selected</strong>
    <div class="bulk-actions">
      <slot />
      <button class="secondary" type="button" @click="emit('clear')">Clear</button>
    </div>
  </div>
</template>
