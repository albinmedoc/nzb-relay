<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  deleteFile,
  deleteNzb,
  deleteWatchlistSource,
  downloadArtifact,
  downloadFileArchive,
  downloadNzbArchive,
  getWatchlistSource,
  listFiles,
  listNzbs,
  readText,
  retryFile,
  retryNzb,
  retryWatchlistSource,
  updateWatchlistSource
} from '../api';
import BulkActionBar from '../components/BulkActionBar.vue';
import BulkDownloadDialog from '../components/BulkDownloadDialog.vue';
import DataTable from '../components/DataTable.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TableToolbar from '../components/TableToolbar.vue';
import { usePagination } from '../composables/usePagination';
import { useRowSelection } from '../composables/useRowSelection';
import { openLog } from '../state/log';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { FileJob, JobStatus, NzbJob, WatchlistEpisodeStatus, WatchlistSourceDetail } from '../types';
import { bulkSummary, runBulk } from '../utils/bulk';
import { formatDate, nzbDownloadName } from '../utils/format';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const jobsLoading = ref(false);
const source = ref<WatchlistSourceDetail | null>(null);
const files = ref<FileJob[]>([]);
const nzbs = ref<NzbJob[]>([]);
const filesTotal = ref(0);
const nzbsTotal = ref(0);
const activeTab = ref<'episodes' | 'files' | 'nzbs'>('episodes');
const fileSelection = useRowSelection(files);
const nzbSelection = useRowSelection(nzbs);
const selectedFileIds = fileSelection.selectedIds;
const selectedFileRows = fileSelection.selectedRows;
const selectedNzbIds = nzbSelection.selectedIds;
const selectedNzbRows = nzbSelection.selectedRows;
const fileDownloadDialog = ref(false);
const nzbDownloadDialog = ref(false);
const { limit, offset, reset, setLimit, setOffset } = usePagination();
const {
  limit: fileLimit,
  offset: fileOffset,
  reset: resetFiles,
  setLimit: setFileLimit,
  setOffset: setFileOffset
} = usePagination();
const {
  limit: nzbLimit,
  offset: nzbOffset,
  reset: resetNzbs,
  setLimit: setNzbLimit,
  setOffset: setNzbOffset
} = usePagination();
const status = ref<'all' | WatchlistEpisodeStatus>('all');
const fileStatus = ref<'all' | JobStatus>('all');
const nzbStatus = ref<'all' | JobStatus>('all');
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
const jobStatusOptions: Array<'all' | JobStatus> = ['all', 'pending', 'running', 'completed', 'failed'];
const selectedFailedFiles = computed(() => selectedFileRows.value.filter((file) => file.status === 'failed' && !file.deleted));
const selectedCompletedFiles = computed(() =>
  selectedFileRows.value.filter((file) => file.status === 'completed' && !file.deleted)
);
const selectedFailedNzbs = computed(() => selectedNzbRows.value.filter((nzb) => nzb.status === 'failed'));
const selectedCompletedNzbs = computed(() => selectedNzbRows.value.filter((nzb) => nzb.status === 'completed'));

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
watch([fileLimit, fileOffset], () => {
  fileSelection.clearSelection();
  void loadFiles(false);
});
watch([nzbLimit, nzbOffset], () => {
  nzbSelection.clearSelection();
  void loadNzbs(false);
});
watch(fileStatus, () => {
  resetFiles();
  fileSelection.clearSelection();
  void loadFiles(false);
});
watch(nzbStatus, () => {
  resetNzbs();
  nzbSelection.clearSelection();
  void loadNzbs(false);
});

async function load(reportErrors = true) {
  loading.value = true;
  if (reportErrors) {
    clearMessages();
  }
  try {
    source.value = await getWatchlistSource(String(route.params.sourceId));
    await Promise.all([loadFiles(false), loadNzbs(false)]);
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

async function loadFiles(reportErrors = true) {
  if (!source.value) {
    return;
  }
  jobsLoading.value = true;
  try {
    const response = await listFiles({
      watchlistSourceId: source.value.id,
      includeDeleted: true,
      limit: fileLimit.value,
      offset: fileOffset.value,
      status: fileStatus.value === 'all' ? undefined : fileStatus.value
    });
    files.value = response.items;
    filesTotal.value = response.total;
  } catch (cause) {
    if (reportErrors) {
      setError(cause);
    } else {
      throw cause;
    }
  } finally {
    jobsLoading.value = false;
  }
}

async function loadNzbs(reportErrors = true) {
  if (!source.value) {
    return;
  }
  jobsLoading.value = true;
  try {
    const response = await listNzbs({
      watchlistSourceId: source.value.id,
      limit: nzbLimit.value,
      offset: nzbOffset.value,
      status: nzbStatus.value === 'all' ? undefined : nzbStatus.value
    });
    nzbs.value = response.items;
    nzbsTotal.value = response.total;
  } catch (cause) {
    if (reportErrors) {
      setError(cause);
    } else {
      throw cause;
    }
  } finally {
    jobsLoading.value = false;
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

async function showFileLog(file: FileJob) {
  await runAction(async () => {
    openLog(file.filename, await readText(`/files/${file.id}/logs`));
  });
}

async function retryDownload(file: FileJob) {
  await runAction(async () => {
    await retryFile(file.id);
    await load(false);
    setNotice('Download queued for retry.');
  });
}

async function removeFile(file: FileJob) {
  if (!confirm(`Delete ${file.filename}?`)) {
    return;
  }
  await runAction(async () => {
    await deleteFile(file.id);
    await load(false);
    setNotice('Download deleted.');
  });
}

async function retrySelectedFiles() {
  await runAction(async () => {
    const result = await runBulk(selectedFailedFiles.value, (file) => retryFile(file.id).then(() => undefined));
    fileSelection.clearSelection();
    await load(false);
    setNotice(bulkSummary('Retry', result));
  });
}

async function deleteSelectedFiles() {
  const rows = [...selectedFileRows.value];
  if (!confirm(`Delete ${rows.length} selected file${rows.length === 1 ? '' : 's'}?`)) {
    return;
  }
  await runAction(async () => {
    const result = await runBulk(rows, (file) => deleteFile(file.id));
    fileSelection.clearSelection();
    await load(false);
    setNotice(bulkSummary('Delete', result));
  });
}

function downloadSelectedFiles() {
  fileDownloadDialog.value = true;
}

async function downloadSelectedFilesIndividually() {
  fileDownloadDialog.value = false;
  await runAction(async () => {
    const result = await runBulk(selectedCompletedFiles.value, (file) => downloadArtifact(`/files/${file.id}/download`, file.filename));
    setNotice(bulkSummary('Download', result));
  });
}

async function downloadSelectedFilesZip() {
  fileDownloadDialog.value = false;
  await runAction(async () => {
    await downloadFileArchive(selectedCompletedFiles.value.map((file) => file.id));
    setNotice(`ZIP download started for ${selectedCompletedFiles.value.length} item${selectedCompletedFiles.value.length === 1 ? '' : 's'}.`);
  });
}

async function showNzbLog(nzb: NzbJob) {
  await runAction(async () => {
    openLog(nzb.nzbFile || nzb.id, await readText(`/nzb/${nzb.id}/logs`));
  });
}

async function retryNzbJob(nzb: NzbJob) {
  await runAction(async () => {
    await retryNzb(nzb.id);
    await load(false);
    setNotice('NZB queued for retry.');
  });
}

async function removeNzb(nzb: NzbJob) {
  if (!confirm(`Delete NZB job ${nzb.nzbFile || nzb.id}?`)) {
    return;
  }
  await runAction(async () => {
    await deleteNzb(nzb.id);
    await load(false);
    setNotice('NZB job deleted.');
  });
}

async function retrySelectedNzbs() {
  await runAction(async () => {
    const result = await runBulk(selectedFailedNzbs.value, (nzb) => retryNzb(nzb.id).then(() => undefined));
    nzbSelection.clearSelection();
    await load(false);
    setNotice(bulkSummary('Retry', result));
  });
}

async function deleteSelectedNzbs() {
  const rows = [...selectedNzbRows.value];
  if (!confirm(`Delete ${rows.length} selected NZB job${rows.length === 1 ? '' : 's'}?`)) {
    return;
  }
  await runAction(async () => {
    const result = await runBulk(rows, (nzb) => deleteNzb(nzb.id));
    nzbSelection.clearSelection();
    await load(false);
    setNotice(bulkSummary('Delete', result));
  });
}

function downloadSelectedNzbs() {
  nzbDownloadDialog.value = true;
}

async function downloadSelectedNzbsIndividually() {
  nzbDownloadDialog.value = false;
  await runAction(async () => {
    const result = await runBulk(selectedCompletedNzbs.value, (nzb) =>
      downloadArtifact(`/nzb/${nzb.id}/download`, nzbDownloadName(nzb))
    );
    setNotice(bulkSummary('Download', result));
  });
}

async function downloadSelectedNzbsZip() {
  nzbDownloadDialog.value = false;
  await runAction(async () => {
    await downloadNzbArchive(selectedCompletedNzbs.value.map((nzb) => nzb.id));
    setNotice(`ZIP download started for ${selectedCompletedNzbs.value.length} item${selectedCompletedNzbs.value.length === 1 ? '' : 's'}.`);
  });
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
      <div class="tabs" role="tablist" aria-label="Watchlist detail views">
        <button
          class="secondary"
          type="button"
          :class="{ active: activeTab === 'episodes' }"
          role="tab"
          :aria-selected="activeTab === 'episodes'"
          @click="activeTab = 'episodes'"
        >
          Episodes
        </button>
        <button
          class="secondary"
          type="button"
          :class="{ active: activeTab === 'files' }"
          role="tab"
          :aria-selected="activeTab === 'files'"
          @click="activeTab = 'files'"
        >
          Files
        </button>
        <button
          class="secondary"
          type="button"
          :class="{ active: activeTab === 'nzbs' }"
          role="tab"
          :aria-selected="activeTab === 'nzbs'"
          @click="activeTab = 'nzbs'"
        >
          NZBs
        </button>
      </div>
      <span v-if="activeTab === 'episodes'" class="muted">{{ filteredEpisodes.length }} episodes</span>
      <span v-if="activeTab === 'files'" class="muted">{{ filesTotal }} files</span>
      <span v-if="activeTab === 'nzbs'" class="muted">{{ nzbsTotal }} NZBs</span>
    </div>

    <TableToolbar v-if="activeTab === 'episodes'">
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

    <DataTable v-if="activeTab === 'episodes'" :rows="visibleEpisodes" :loading="loading" empty-message="No watchlist episodes.">
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
      v-if="activeTab === 'episodes'"
      :total="filteredEpisodes.length"
      :limit="limit"
      :offset="offset"
      :disabled="loading"
      @update:limit="setLimit"
      @update:offset="setOffset"
    />

    <TableToolbar v-if="activeTab === 'files'">
      <label>
        Status
        <select v-model="fileStatus">
          <option v-for="option in jobStatusOptions" :key="option" :value="option">{{ option }}</option>
        </select>
      </label>
      <template #actions>
        <button class="secondary" type="button" :disabled="loading || jobsLoading" @click="() => loadFiles()">Refresh</button>
      </template>
    </TableToolbar>

    <BulkActionBar v-if="activeTab === 'files'" :selected-count="selectedFileRows.length" @clear="fileSelection.clearSelection">
      <button class="secondary" type="button" :disabled="selectedFailedFiles.length === 0" @click="retrySelectedFiles">Retry</button>
      <button class="secondary" type="button" :disabled="selectedCompletedFiles.length === 0" @click="downloadSelectedFiles">Download</button>
      <button class="danger" type="button" @click="deleteSelectedFiles">Delete</button>
    </BulkActionBar>

    <DataTable
      v-if="activeTab === 'files'"
      :rows="files"
      :loading="loading || jobsLoading"
      empty-message="No watchlist files."
      selectable
      :selected-ids="selectedFileIds"
      @toggle-row="fileSelection.toggleRow"
      @toggle-visible="fileSelection.toggleVisible"
    >
      <template #header>
        <th>File</th>
        <th>Status</th>
        <th>Created</th>
        <th>Completed</th>
        <th>Actions</th>
      </template>
      <template #row="{ row: file }">
        <td>
          <strong>{{ file.filename }}</strong>
          <span class="subtext">{{ file.url }}</span>
        </td>
        <td>
          <StatusBadge :status="file.status" />
          <span v-if="file.deleted" class="subtext">deleted</span>
          <span v-if="file.error" class="subtext">{{ file.error }}</span>
        </td>
        <td>{{ formatDate(file.createdAt) }}</td>
        <td>{{ formatDate(file.downloadedAt) }}</td>
        <td class="actions">
          <button class="secondary" type="button" @click="showFileLog(file)">Log</button>
          <button
            class="secondary"
            type="button"
            :disabled="file.status !== 'completed' || file.deleted"
            @click="downloadArtifact(`/files/${file.id}/download`, file.filename)"
          >
            Download
          </button>
          <button class="secondary" type="button" :disabled="file.status !== 'failed' || file.deleted" @click="retryDownload(file)">
            Retry
          </button>
          <button class="danger" type="button" @click="removeFile(file)">Delete</button>
        </td>
      </template>
    </DataTable>

    <PaginationControls
      v-if="activeTab === 'files'"
      :total="filesTotal"
      :limit="fileLimit"
      :offset="fileOffset"
      :disabled="loading || jobsLoading"
      @update:limit="setFileLimit"
      @update:offset="setFileOffset"
    />

    <TableToolbar v-if="activeTab === 'nzbs'">
      <label>
        Status
        <select v-model="nzbStatus">
          <option v-for="option in jobStatusOptions" :key="option" :value="option">{{ option }}</option>
        </select>
      </label>
      <template #actions>
        <button class="secondary" type="button" :disabled="loading || jobsLoading" @click="() => loadNzbs()">Refresh</button>
      </template>
    </TableToolbar>

    <BulkActionBar v-if="activeTab === 'nzbs'" :selected-count="selectedNzbRows.length" @clear="nzbSelection.clearSelection">
      <button class="secondary" type="button" :disabled="selectedFailedNzbs.length === 0" @click="retrySelectedNzbs">Retry</button>
      <button class="secondary" type="button" :disabled="selectedCompletedNzbs.length === 0" @click="downloadSelectedNzbs">Download</button>
      <button class="danger" type="button" @click="deleteSelectedNzbs">Delete</button>
    </BulkActionBar>

    <DataTable
      v-if="activeTab === 'nzbs'"
      :rows="nzbs"
      :loading="loading || jobsLoading"
      empty-message="No watchlist NZBs."
      selectable
      :selected-ids="selectedNzbIds"
      @toggle-row="nzbSelection.toggleRow"
      @toggle-visible="nzbSelection.toggleVisible"
    >
      <template #header>
        <th>NZB</th>
        <th>Status</th>
        <th>Files</th>
        <th>Created</th>
        <th>Posted</th>
        <th>Actions</th>
      </template>
      <template #row="{ row: nzb }">
        <td>
          <strong>{{ nzb.nzbFile || nzb.id }}</strong>
          <span class="subtext">{{ nzb.id }}</span>
        </td>
        <td>
          <StatusBadge :status="nzb.status" />
          <span v-if="nzb.error" class="subtext">{{ nzb.error }}</span>
        </td>
        <td>{{ nzb.files.length }}</td>
        <td>{{ formatDate(nzb.createdAt) }}</td>
        <td>{{ formatDate(nzb.postedAt) }}</td>
        <td class="actions">
          <button class="secondary" type="button" @click="showNzbLog(nzb)">Log</button>
          <button
            class="secondary"
            type="button"
            :disabled="nzb.status !== 'completed'"
            @click="downloadArtifact(`/nzb/${nzb.id}/download`, nzbDownloadName(nzb))"
          >
            Download
          </button>
          <button class="secondary" type="button" :disabled="nzb.status !== 'failed'" @click="retryNzbJob(nzb)">Retry</button>
          <button class="danger" type="button" @click="removeNzb(nzb)">Delete</button>
        </td>
      </template>
    </DataTable>

    <PaginationControls
      v-if="activeTab === 'nzbs'"
      :total="nzbsTotal"
      :limit="nzbLimit"
      :offset="nzbOffset"
      :disabled="loading || jobsLoading"
      @update:limit="setNzbLimit"
      @update:offset="setNzbOffset"
    />

    <BulkDownloadDialog
      v-if="fileDownloadDialog"
      :count="selectedCompletedFiles.length"
      label="file"
      @individual="downloadSelectedFilesIndividually"
      @zip="downloadSelectedFilesZip"
      @cancel="fileDownloadDialog = false"
    />

    <BulkDownloadDialog
      v-if="nzbDownloadDialog"
      :count="selectedCompletedNzbs.length"
      label="NZB"
      @individual="downloadSelectedNzbsIndividually"
      @zip="downloadSelectedNzbsZip"
      @cancel="nzbDownloadDialog = false"
    />
  </section>
</template>
