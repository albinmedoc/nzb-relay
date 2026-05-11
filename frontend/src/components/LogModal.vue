<script setup lang="ts">
import { closeLog, logText, logTitle } from '../state/log';
</script>

<template>
  <div v-if="logText" class="modal-backdrop" @click.self="closeLog">
    <section class="modal">
      <header class="section-head">
        <h2>{{ logTitle }}</h2>
        <button class="secondary" type="button" @click="closeLog">Close</button>
      </header>
      <pre>{{ logText }}</pre>
    </section>
  </div>
</template>
