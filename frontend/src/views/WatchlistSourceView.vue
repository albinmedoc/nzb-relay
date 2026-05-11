<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { deleteWatchlistSource, getWatchlistSource, retryWatchlistSource, updateWatchlistSource } from '../api';
import DataTable from '../components/DataTable.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TableToolbar from '../components/TableToolbar.vue';
import { usePagination } from '../composables/usePagination';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { WatchlistEpisodeStatus, WatchlistSourceDetail } from '../types';
import { formatDate } from '../utils/format';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const source = ref<WatchlistSourceDetail | null>(null);
const { limit, offset, reset, setLimit, setOffset } = usePagination();
const status = ref<'all' | WatchlistEpisodeStatus>('all');
const season = ref<'all' | string>('all');
const query = ref('');

const statusOptions: Array<'all' | WatchlistEpisodeStatus> = [
  'all',
  'seen',
  'discovered',
  'download_queued',
  'download_failed',
  'download_completed',
  'nzb_queued',
  'nzb_failed',
  'posted',
  'blocked'
];

const episodes = computed(() => source.value?.episodes ?? []);
const seasonOptions = computed(() =>
  Array.from(new Set(episodes.value.map((episode) => episode.season))).sort((a, b) => a - b)
);
const filteredEpisodes = computed(() => {
  const normalizedQuery = query.value.trim().toLowerCase();
  const seasonNumber = season.value === 'all' ? null : Number(season.value);
  return episodes.value.filter((episode) => {
    if (status.value !== 'all' && episode.status !== status.value) {
      return false;
    }
    if (seasonNumber !== null && episode.season !== seasonNumber) {
      return false;
    }
    if (normalizedQuery && !`${episode.title} ${episode.url}`.toLowerCase().includes(normalizedQuery)) {
      return false;
    }
    return true;
  });
});
const visibleEpisodes = computed(() => filteredEpisodes.value.slice(offset.value, offset.value + limit.value));

watch([status, season, query], reset);

async function load(reportErrors = true) {
  loading.value = true;
  if (reportErrors) {
    clearMessages();
  }
  try {
    source.value = await getWatchlistSource(String(route.params.sourceId));
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

async function toggleSource() {
  if (!source.value) {
    return;
  }
  await runAction(async () => {
    source.value = {
      ...source.value!,
      ...(await updateWatchlistSource(source.value!.id, { enabled: !source.value!.enabled }))
    };
    setNotice('Watchlist source updated.');
  });
}

async function retrySource() {
  if (!source.value) {
    return;
  }
  await runAction(async () => {
    await retryWatchlistSource(source.value!.id);
    await load(false);
    setNotice('Failed watchlist episodes queued for retry.');
  });
}

async function removeSource() {
  if (!source.value || !confirm(`Remove ${source.value.title || source.value.url} from the watchlist?`)) {
    return;
  }
  await runAction(async () => {
    await deleteWatchlistSource(source.value!.id);
    setNotice('Watchlist source removed.');
    await router.push('/watchlist');
  });
}

function clearFilters() {
  status.value = 'all';
  season.value = 'all';
  query.value = '';
  reset();
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <div>
        <h2>{{ source?.title || 'Watchlist source' }}</h2>
        <span v-if="source" class="muted">{{ source.url }}</span>
      </div>
      <RouterLink class="logout-link" to="/watchlist">Back to watchlist</RouterLink>
    </div>

    <div v-if="source" class="detail-grid">
      <article class="summary-item">
        <span class="muted">Status</span>
        <strong>{{ source.lastError ? 'failed' : source.enabled ? 'enabled' : 'disabled' }}</strong>
      </article>
      <article class="summary-item">
        <span class="muted">Episodes</span>
        <strong>{{ source.episodes.length }}</strong>
      </article>
      <article class="summary-item">
        <span class="muted">Last scan</span>
        <strong>{{ formatDate(source.lastScannedAt) }}</strong>
      </article>
      <article class="summary-item">
        <span class="muted">Next scan</span>
        <strong>{{ formatDate(source.nextScanAt) }}</strong>
      </article>
    </div>

    <div v-if="source" class="detail-actions">
      <button class="secondary" type="button" @click="toggleSource">{{ source.enabled ? 'Disable' : 'Enable' }}</button>
      <button class="secondary" type="button" @click="retrySource">Retry</button>
      <button class="danger" type="button" @click="removeSource">Delete</button>
    </div>
  </section>

  <section class="panel">
    <div class="section-head">
      <h2>Episodes</h2>
      <span class="muted">{{ filteredEpisodes.length }} episodes</span>
    </div>

    <TableToolbar>
      <label>
        Status
        <select v-model="status">
          <option v-for="option in statusOptions" :key="option" :value="option">{{ option }}</option>
        </select>
      </label>
      <label>
        Season
        <select v-model="season">
          <option value="all">all</option>
          <option v-for="option in seasonOptions" :key="option" :value="String(option)">Season {{ option }}</option>
        </select>
      </label>
      <label>
        Search
        <input v-model="query" type="search" placeholder="Title or URL" />
      </label>
      <template #actions>
        <button class="secondary" type="button" :disabled="loading" @click="clearFilters">Clear filters</button>
        <button class="secondary" type="button" :disabled="loading" @click="() => load()">Refresh</button>
      </template>
    </TableToolbar>

    <DataTable :rows="visibleEpisodes" :loading="loading" empty-message="No watchlist episodes.">
      <template #header>
        <th>Episode</th>
        <th>Status</th>
        <th>Attempts</th>
        <th>Queued</th>
        <th>Completed</th>
        <th>Posted</th>
      </template>
      <template #row="{ row: episode }">
        <td>
          <strong>S{{ episode.season }} E{{ episode.episode }} · {{ episode.title }}</strong>
          <span class="subtext">{{ episode.quality }} · {{ episode.url }}</span>
        </td>
        <td>
          <StatusBadge :status="episode.status" :failed="Boolean(episode.lastError)" />
          <span v-if="episode.lastError" class="subtext">{{ episode.lastError }}</span>
        </td>
        <td>{{ episode.downloadAttempts }} download · {{ episode.nzbAttempts }} NZB</td>
        <td>
          <span class="subtext">Download {{ formatDate(episode.downloadQueuedAt) }}</span>
          <span class="subtext">NZB {{ formatDate(episode.nzbQueuedAt) }}</span>
        </td>
        <td>{{ formatDate(episode.downloadedAt) }}</td>
        <td>{{ formatDate(episode.postedAt) }}</td>
      </template>
    </DataTable>

    <PaginationControls
      :total="filteredEpisodes.length"
      :limit="limit"
      :offset="offset"
      :disabled="loading"
      @update:limit="setLimit"
      @update:offset="setOffset"
    />
  </section>
</template>
