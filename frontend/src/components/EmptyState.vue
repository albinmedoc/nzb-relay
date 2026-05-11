<script setup lang="ts">
defineProps<{
  message: string;
}>();
</script>

<template>
  <div class="empty">{{ message }}</div>
</template>
