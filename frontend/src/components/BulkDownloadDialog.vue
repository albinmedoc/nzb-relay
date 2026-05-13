<script setup lang="ts">
defineProps<{
  count: number;
  label: string;
}>();

const emit = defineEmits<{
  individual: [];
  zip: [];
  cancel: [];
}>();
</script>

<template>
  <div class="modal-backdrop" role="presentation" @click.self="emit('cancel')">
    <section class="modal bulk-download-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-download-title">
      <div class="section-head">
        <h2 id="bulk-download-title">Download {{ count }} {{ label }}{{ count === 1 ? '' : 's' }}</h2>
      </div>
      <p class="muted">Choose how the selected items should be downloaded.</p>
      <div class="detail-actions">
        <button class="secondary" type="button" @click="emit('individual')">Download individually</button>
        <button type="button" @click="emit('zip')">Download ZIP</button>
        <button class="secondary" type="button" @click="emit('cancel')">Cancel</button>
      </div>
    </section>
  </div>
</template>
