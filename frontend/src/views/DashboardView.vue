<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getHealth, listFiles, listNzbs, listWatchlist } from '../api';
import EmptyState from '../components/EmptyState.vue';
import { clearMessages, setError } from '../state/messages';
import type { Health } from '../types';

const loading = ref(false);
const health = ref<Health | null>(null);
const watchlistCount = ref(0);
const fileCount = ref(0);
const nzbCount = ref(0);

async function load() {
  loading.value = true;
  clearMessages();
  try {
    const [healthResult, watchlistResult, filesResult, nzbsResult] = await Promise.all([
      getHealth(),
      listWatchlist(),
      listFiles(),
      listNzbs()
    ]);
    health.value = healthResult;
    watchlistCount.value = watchlistResult.total;
    fileCount.value = filesResult.total;
    nzbCount.value = nzbsResult.total;
  } catch (cause) {
    setError(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <h2>Dashboard</h2>
      <button class="secondary" type="button" :disabled="loading" @click="load">Refresh</button>
    </div>

    <div v-if="!health && !loading" class="empty">API status unavailable</div>
    <div v-else class="summary-grid">
      <article class="summary-item">
        <span class="muted">API</span>
        <strong>{{ health ? `${health.status} · ${health.version}` : 'Loading' }}</strong>
      </article>
      <article class="summary-item">
        <span class="muted">Watchlist</span>
        <strong>{{ watchlistCount }}</strong>
      </article>
      <article class="summary-item">
        <span class="muted">Downloads</span>
        <strong>{{ fileCount }}</strong>
      </article>
      <article class="summary-item">
        <span class="muted">NZBs</span>
        <strong>{{ nzbCount }}</strong>
      </article>
    </div>

    <EmptyState v-if="loading" message="Loading dashboard." />
  </section>
</template>
