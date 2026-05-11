<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  createWatchlistSource,
  deleteWatchlistSource,
  listWatchlist,
  retryWatchlistSource,
  updateWatchlistSource
} from '../api';
import EmptyState from '../components/EmptyState.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { WatchlistSource } from '../types';
import { formatDate } from '../utils/format';

const loading = ref(false);
const watchlist = ref<WatchlistSource[]>([]);
const form = reactive({
  url: '',
  backfill: true,
  deleteFileAfterNzb: true
});

async function load(reportErrors = true) {
  loading.value = true;
  if (reportErrors) {
    clearMessages();
  }
  try {
    watchlist.value = (await listWatchlist()).items;
  } catch (cause) {
    if (reportErrors) {
      setError(cause);
    } else {
      throw cause;
    }
  } finally {
    loading.value = false;
  }
}

async function addSource() {
  await runAction(async () => {
    await createWatchlistSource(form);
    form.url = '';
    await load(false);
    setNotice('Watchlist source added.');
  });
}

async function toggleSource(source: WatchlistSource) {
  await runAction(async () => {
    await updateWatchlistSource(source.id, { enabled: !source.enabled });
    await load(false);
    setNotice('Watchlist source updated.');
  });
}

async function retrySource(source: WatchlistSource) {
  await runAction(async () => {
    await retryWatchlistSource(source.id);
    await load(false);
    setNotice('Failed watchlist episodes queued for retry.');
  });
}

async function removeSource(source: WatchlistSource) {
  if (!confirm(`Remove ${source.title || source.url} from the watchlist?`)) {
    return;
  }
  await runAction(async () => {
    await deleteWatchlistSource(source.id);
    await load(false);
    setNotice('Watchlist source removed.');
  });
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <h2>Watchlist</h2>
      <span class="muted">{{ watchlist.length }} sources</span>
    </div>

    <form class="watch-form" @submit.prevent="addSource">
      <input v-model="form.url" required type="url" placeholder="https://www.svtplay.se/series-slug" />
      <label class="check">
        <input v-model="form.backfill" type="checkbox" />
        Backfill
      </label>
      <label class="check">
        <input v-model="form.deleteFileAfterNzb" type="checkbox" />
        Delete after NZB
      </label>
      <button type="submit">Add source</button>
    </form>

    <EmptyState v-if="watchlist.length === 0" :message="loading ? 'Loading watchlist.' : 'No watchlist sources.'" />
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Status</th>
            <th>Episodes</th>
            <th>Next scan</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="source in watchlist" :key="source.id">
            <td>
              <strong>{{ source.title || source.url }}</strong>
              <span class="subtext">{{ source.service }} · {{ source.type }}</span>
            </td>
            <td>
              <StatusBadge
                :status="source.lastError ? 'failed' : source.enabled ? 'enabled' : 'disabled'"
                :failed="Boolean(source.lastError)"
                :running="source.enabled && !source.lastError"
              />
              <span v-if="source.lastError" class="subtext">{{ source.lastError }}</span>
            </td>
            <td>
              {{ source.episodeCount ?? 0 }}
              <span class="subtext">{{ source.queuedCount ?? 0 }} queued · {{ source.postedCount ?? 0 }} posted</span>
            </td>
            <td>{{ formatDate(source.nextScanAt) }}</td>
            <td class="actions">
              <button class="secondary" type="button" @click="toggleSource(source)">
                {{ source.enabled ? 'Disable' : 'Enable' }}
              </button>
              <button class="secondary" type="button" @click="retrySource(source)">Retry</button>
              <button class="danger" type="button" @click="removeSource(source)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
