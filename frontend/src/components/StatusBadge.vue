<script setup lang="ts">
defineProps<{
  status: string;
  failed?: boolean;
  running?: boolean;
}>();
</script>

<template>
  <span class="status" :class="[status, { failed, running }]">{{ status }}</span>
</template>
