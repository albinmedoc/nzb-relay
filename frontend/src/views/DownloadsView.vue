<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { deleteFile, downloadArtifact, listFiles, readText, retryFile } from '../api';
import BulkActionBar from '../components/BulkActionBar.vue';
import DataTable from '../components/DataTable.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TableToolbar from '../components/TableToolbar.vue';
import { useJobFilters } from '../composables/useJobFilters';
import { usePagination } from '../composables/usePagination';
import { useRowSelection } from '../composables/useRowSelection';
import { openLog } from '../state/log';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { FileJob, JobStatus } from '../types';
import { bulkSummary, runBulk } from '../utils/bulk';
import { formatDate } from '../utils/format';

const loading = ref(false);
const files = ref<FileJob[]>([]);
const total = ref(0);
const { limit, offset, reset, setLimit, setOffset } = usePagination();
const { selectedIds, selectedRows, toggleRow, toggleVisible, clearSelection } = useRowSelection(files);
const filters = useJobFilters(() => {
  reset();
  clearSelection();
  void load();
});

const statusOptions: Array<'all' | JobStatus> = ['all', 'pending', 'running', 'completed', 'failed'];
const selectedFailed = computed(() => selectedRows.value.filter((file) => file.status === 'failed'));
const selectedCompleted = computed(() => selectedRows.value.filter((file) => file.status === 'completed'));

watch([limit, offset], () => {
  clearSelection();
  void load();
});

async function load(reportErrors = true) {
  loading.value = true;
  if (reportErrors) {
    clearMessages();
  }
  try {
    const response = await listFiles({
      limit: limit.value,
      offset: offset.value,
      ...filters.apiFilters.value
    });
    files.value = response.items;
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

async function showLog(file: FileJob) {
  await runAction(async () => {
    openLog(file.filename, await readText(`/files/${file.id}/logs`));
  });
}

async function retry(file: FileJob) {
  await runAction(async () => {
    await retryFile(file.id);
    await load(false);
    setNotice('Download queued for retry.');
  });
}

async function remove(file: FileJob) {
  if (!confirm(`Delete ${file.filename}?`)) {
    return;
  }
  await runAction(async () => {
    await deleteFile(file.id);
    await load(false);
    setNotice('Download deleted.');
  });
}

async function retrySelected() {
  await runAction(async () => {
    const result = await runBulk(selectedFailed.value, (file) => retryFile(file.id).then(() => undefined));
    clearSelection();
    await load(false);
    setNotice(bulkSummary('Retry', result));
  });
}

async function deleteSelected() {
  const rows = [...selectedRows.value];
  if (!confirm(`Delete ${rows.length} selected download${rows.length === 1 ? '' : 's'}?`)) {
    return;
  }
  await runAction(async () => {
    const result = await runBulk(rows, (file) => deleteFile(file.id));
    clearSelection();
    await load(false);
    setNotice(bulkSummary('Delete', result));
  });
}

async function downloadSelected() {
  await runAction(async () => {
    const result = await runBulk(selectedCompleted.value, (file) => downloadArtifact(`/files/${file.id}/download`, file.filename));
    setNotice(bulkSummary('Download', result));
  });
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <h2>Downloads</h2>
      <span class="muted">{{ total }} jobs</span>
    </div>

    <TableToolbar>
      <label>
        Status
        <select v-model="filters.status" @change="filters.applyFilters">
          <option v-for="status in statusOptions" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label>
        Created after
        <input v-model="filters.createdAfter" type="date" @change="filters.applyFilters" />
      </label>
      <label>
        Created before
        <input v-model="filters.createdBefore" type="date" @change="filters.applyFilters" />
      </label>
      <template #actions>
        <button class="secondary" type="button" :disabled="loading" @click="filters.clearFilters">Clear filters</button>
        <button class="secondary" type="button" :disabled="loading" @click="() => load()">Refresh</button>
      </template>
    </TableToolbar>

    <BulkActionBar :selected-count="selectedRows.length" @clear="clearSelection">
      <button class="secondary" type="button" :disabled="selectedFailed.length === 0" @click="retrySelected">Retry</button>
      <button class="secondary" type="button" :disabled="selectedCompleted.length === 0" @click="downloadSelected">Download</button>
      <button class="danger" type="button" @click="deleteSelected">Delete</button>
    </BulkActionBar>

    <DataTable
      :rows="files"
      :loading="loading"
      empty-message="No downloads."
      selectable
      :selected-ids="selectedIds"
      @toggle-row="toggleRow"
      @toggle-visible="toggleVisible"
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
          <button class="secondary" type="button" @click="showLog(file)">Log</button>
          <button
            class="secondary"
            type="button"
            :disabled="file.status !== 'completed'"
            @click="downloadArtifact(`/files/${file.id}/download`, file.filename)"
          >
            Download
          </button>
          <button class="secondary" type="button" :disabled="file.status !== 'failed'" @click="retry(file)">Retry</button>
          <button class="danger" type="button" @click="remove(file)">Delete</button>
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
