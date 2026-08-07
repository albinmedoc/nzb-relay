<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { createMovie, deleteMovie, downloadArtifact, listMovies, retryMovie } from '../api';
import BulkActionBar from '../components/BulkActionBar.vue';
import DataTable from '../components/DataTable.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TableToolbar from '../components/TableToolbar.vue';
import { usePagination } from '../composables/usePagination';
import { useRowSelection } from '../composables/useRowSelection';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { MovieJob, MovieStatus } from '../types';
import { bulkSummary, runBulk } from '../utils/bulk';
import { formatDate } from '../utils/format';

const loading = ref(false);
const movies = ref<MovieJob[]>([]);
const total = ref(0);
const form = ref({
  url: ''
});
const status = ref<'all' | MovieStatus>('all');
const createdAfter = ref('');
const createdBefore = ref('');
const { limit, offset, reset, setLimit, setOffset } = usePagination();
const { selectedIds, selectedRows, toggleRow, toggleVisible, clearSelection } = useRowSelection(movies);

const statusOptions: Array<'all' | MovieStatus> = [
  'all',
  'download_queued',
  'download_failed',
  'download_completed',
  'nzb_queued',
  'nzb_failed',
  'posted',
  'blocked'
];
const selectedFailed = computed(() =>
  selectedRows.value.filter((movie) => ['download_failed', 'nzb_failed', 'blocked'].includes(movie.status))
);

watch([limit, offset], () => {
  clearSelection();
  void load();
});

async function submitMovie() {
  await runAction(async () => {
    await createMovie({ url: form.value.url });
    form.value.url = '';
    reset();
    clearSelection();
    await load(false);
    setNotice('Movie queued.');
  });
}

async function load(reportErrors = true) {
  loading.value = true;
  if (reportErrors) {
    clearMessages();
  }
  try {
    const response = await listMovies({
      limit: limit.value,
      offset: offset.value,
      status: status.value === 'all' ? undefined : status.value,
      createdAfter: createdAfter.value || undefined,
      createdBefore: createdBefore.value || undefined
    });
    movies.value = response.items;
    total.value = response.total;
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

function applyFilters() {
  reset();
  clearSelection();
  void load();
}

function clearFilters() {
  status.value = 'all';
  createdAfter.value = '';
  createdBefore.value = '';
  applyFilters();
}

async function retry(movie: MovieJob) {
  await runAction(async () => {
    await retryMovie(movie.id);
    await load(false);
    setNotice('Movie queued for retry.');
  });
}

async function remove(movie: MovieJob) {
  if (!confirm(`Delete movie job ${movie.title}?`)) {
    return;
  }
  await runAction(async () => {
    await deleteMovie(movie.id);
    await load(false);
    setNotice('Movie job deleted.');
  });
}

async function retrySelected() {
  await runAction(async () => {
    const result = await runBulk(selectedFailed.value, (movie) => retryMovie(movie.id).then(() => undefined));
    clearSelection();
    await load(false);
    setNotice(bulkSummary('Retry', result));
  });
}

async function deleteSelected() {
  const rows = [...selectedRows.value];
  if (!confirm(`Delete ${rows.length} selected movie job${rows.length === 1 ? '' : 's'}?`)) {
    return;
  }
  await runAction(async () => {
    const result = await runBulk(rows, (movie) => deleteMovie(movie.id));
    clearSelection();
    await load(false);
    setNotice(bulkSummary('Delete', result));
  });
}

function isFailed(statusValue: MovieStatus) {
  return ['download_failed', 'nzb_failed', 'blocked'].includes(statusValue);
}

function isRunning(statusValue: MovieStatus) {
  return ['download_queued', 'download_completed', 'nzb_queued'].includes(statusValue);
}

function canDownloadMovieFile(movie: MovieJob) {
  return Boolean(movie.fileId) && ['download_completed', 'nzb_queued', 'nzb_failed', 'posted', 'blocked'].includes(movie.status);
}

function canDownloadMovieNzb(movie: MovieJob) {
  return Boolean(movie.nzbId) && movie.status === 'posted';
}

function movieFileDownloadName(movie: MovieJob) {
  return `${movieReleaseName(movie)}.mkv`;
}

function movieNzbDownloadName(movie: MovieJob) {
  return `${movieReleaseName(movie)}.nzb`;
}

function movieReleaseName(movie: MovieJob) {
  const title = sanitizeToken(movie.title) || movie.id;
  const service = sanitizeToken(movie.service) || 'svtplay';
  return `${title}.${service}`;
}

function sanitizeToken(value: string) {
  return value
    .trim()
    .replace(/\s+/g, '.')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <h2>Movies</h2>
      <span class="muted">{{ total }} jobs</span>
    </div>

    <form class="movie-form" @submit.prevent="submitMovie">
      <label>
        URL
        <input v-model="form.url" required type="url" placeholder="https://www.svtplay.se/video/..." />
      </label>
      <button type="submit" :disabled="loading">Queue movie</button>
    </form>

    <TableToolbar>
      <label>
        Status
        <select v-model="status" @change="applyFilters">
          <option v-for="option in statusOptions" :key="option" :value="option">{{ option }}</option>
        </select>
      </label>
      <label>
        Created after
        <input v-model="createdAfter" type="date" @change="applyFilters" />
      </label>
      <label>
        Created before
        <input v-model="createdBefore" type="date" @change="applyFilters" />
      </label>
      <template #actions>
        <button class="secondary" type="button" :disabled="loading" @click="clearFilters">Clear filters</button>
        <button class="secondary" type="button" :disabled="loading" @click="() => load()">Refresh</button>
      </template>
    </TableToolbar>

    <BulkActionBar :selected-count="selectedRows.length" @clear="clearSelection">
      <button class="secondary" type="button" :disabled="selectedFailed.length === 0" @click="retrySelected">Retry</button>
      <button class="danger" type="button" @click="deleteSelected">Delete</button>
    </BulkActionBar>

    <DataTable
      :rows="movies"
      :loading="loading"
      empty-message="No movie jobs."
      selectable
      :selected-ids="selectedIds"
      @toggle-row="toggleRow"
      @toggle-visible="toggleVisible"
    >
      <template #header>
        <th>Movie</th>
        <th>Status</th>
        <th>Attempts</th>
        <th>Created</th>
        <th>Posted</th>
        <th>Actions</th>
      </template>
      <template #row="{ row: movie }">
        <td>
          <strong>{{ movie.title }}</strong>
          <span class="subtext">{{ movie.url }}</span>
          <span v-if="movie.fileId" class="subtext">File {{ movie.fileId }}</span>
          <span v-if="movie.nzbId" class="subtext">NZB {{ movie.nzbId }}</span>
        </td>
        <td>
          <StatusBadge :status="movie.status" :failed="isFailed(movie.status)" :running="isRunning(movie.status)" />
          <span v-if="movie.lastError" class="subtext">{{ movie.lastError }}</span>
        </td>
        <td>{{ movie.downloadAttempts }} download · {{ movie.nzbAttempts }} NZB</td>
        <td>{{ formatDate(movie.createdAt) }}</td>
        <td>{{ formatDate(movie.postedAt) }}</td>
        <td class="actions">
          <button
            class="secondary"
            type="button"
            :disabled="!canDownloadMovieFile(movie)"
            @click="movie.fileId && downloadArtifact(`/files/${movie.fileId}/download`, movieFileDownloadName(movie))"
          >
            File
          </button>
          <button
            class="secondary"
            type="button"
            :disabled="!canDownloadMovieNzb(movie)"
            @click="movie.nzbId && downloadArtifact(`/nzb/${movie.nzbId}/download`, movieNzbDownloadName(movie))"
          >
            NZB
          </button>
          <button class="secondary" type="button" :disabled="!isFailed(movie.status)" @click="retry(movie)">Retry</button>
          <button class="danger" type="button" @click="remove(movie)">Delete</button>
        </td>
      </template>
    </DataTable>

    <PaginationControls
      :total="total"
      :limit="limit"
      :offset="offset"
      :disabled="loading"
      @update:limit="setLimit"
      @update:offset="setOffset"
    />
  </section>
</template>
