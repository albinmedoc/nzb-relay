<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppNav from './components/AppNav.vue';
import LogModal from './components/LogModal.vue';
import NoticeStack from './components/NoticeStack.vue';
import { backendLabel } from './runtime';
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>nzb-relay</h1>
        <p class="muted">Backend {{ backendLabel }}</p>
      </div>
      <a class="logout-link" href="/logout">Logout</a>
    </header>

    <AppNav />
    <NoticeStack />
    <RouterView />
    <LogModal />
  </main>
</template>
