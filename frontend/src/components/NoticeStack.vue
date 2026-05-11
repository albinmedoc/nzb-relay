<script setup lang="ts">
import { error, notice } from '../state/messages';
</script>

<template>
  <p v-if="error" class="message error">{{ error }}</p>
  <p v-if="notice" class="message notice">{{ notice }}</p>
</template>
