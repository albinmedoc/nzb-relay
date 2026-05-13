<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { deleteNzb, downloadArtifact, downloadNzbArchive, listNzbs, readText, retryNzb } from '../api';
import BulkActionBar from '../components/BulkActionBar.vue';
import BulkDownloadDialog from '../components/BulkDownloadDialog.vue';
import DataTable from '../components/DataTable.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TableToolbar from '../components/TableToolbar.vue';
import { useJobFilters } from '../composables/useJobFilters';
import { usePagination } from '../composables/usePagination';
import { useRowSelection } from '../composables/useRowSelection';
import { openLog } from '../state/log';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { JobStatus, NzbJob } from '../types';
import { bulkSummary, runBulk } from '../utils/bulk';
import { formatDate, nzbDownloadName } from '../utils/format';

const loading = ref(false);
const nzbs = ref<NzbJob[]>([]);
const total = ref(0);
const { limit, offset, reset, setLimit, setOffset } = usePagination();
const { selectedIds, selectedRows, toggleRow, toggleVisible, clearSelection } = useRowSelection(nzbs);
const filters = useJobFilters(() => {
  reset();
  clearSelection();
  void load();
});

const statusOptions: Array<'all' | JobStatus> = ['all', 'pending', 'running', 'completed', 'failed'];
const selectedFailed = computed(() => selectedRows.value.filter((nzb) => nzb.status === 'failed'));
const selectedCompleted = computed(() => selectedRows.value.filter((nzb) => nzb.status === 'completed'));
const showDownloadDialog = ref(false);

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
    const response = await listNzbs({
      limit: limit.value,
      offset: offset.value,
      ...filters.apiFilters.value
    });
    nzbs.value = response.items;
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

async function showLog(nzb: NzbJob) {
  await runAction(async () => {
    openLog(nzb.nzbFile || nzb.id, await readText(`/nzb/${nzb.id}/logs`));
  });
}

async function retry(nzb: NzbJob) {
  await runAction(async () => {
    await retryNzb(nzb.id);
    await load(false);
    setNotice('NZB queued for retry.');
  });
}

async function remove(nzb: NzbJob) {
  if (!confirm(`Delete NZB job ${nzb.nzbFile || nzb.id}?`)) {
    return;
  }
  await runAction(async () => {
    await deleteNzb(nzb.id);
    await load(false);
    setNotice('NZB job deleted.');
  });
}

async function retrySelected() {
  await runAction(async () => {
    const result = await runBulk(selectedFailed.value, (nzb) => retryNzb(nzb.id).then(() => undefined));
    clearSelection();
    await load(false);
    setNotice(bulkSummary('Retry', result));
  });
}

async function deleteSelected() {
  const rows = [...selectedRows.value];
  if (!confirm(`Delete ${rows.length} selected NZB job${rows.length === 1 ? '' : 's'}?`)) {
    return;
  }
  await runAction(async () => {
    const result = await runBulk(rows, (nzb) => deleteNzb(nzb.id));
    clearSelection();
    await load(false);
    setNotice(bulkSummary('Delete', result));
  });
}

async function downloadSelected() {
  showDownloadDialog.value = true;
}

async function downloadSelectedIndividually() {
  showDownloadDialog.value = false;
  await runAction(async () => {
    const result = await runBulk(selectedCompleted.value, (nzb) =>
      downloadArtifact(`/nzb/${nzb.id}/download`, nzbDownloadName(nzb))
    );
    setNotice(bulkSummary('Download', result));
  });
}

async function downloadSelectedZip() {
  showDownloadDialog.value = false;
  await runAction(async () => {
    await downloadNzbArchive(selectedCompleted.value.map((nzb) => nzb.id));
    setNotice(`ZIP download started for ${selectedCompleted.value.length} item${selectedCompleted.value.length === 1 ? '' : 's'}.`);
  });
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <h2>NZBs</h2>
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
      :rows="nzbs"
      :loading="loading"
      empty-message="No NZB jobs."
      selectable
      :selected-ids="selectedIds"
      @toggle-row="toggleRow"
      @toggle-visible="toggleVisible"
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
          <button class="secondary" type="button" @click="showLog(nzb)">Log</button>
          <button
            class="secondary"
            type="button"
            :disabled="nzb.status !== 'completed'"
            @click="downloadArtifact(`/nzb/${nzb.id}/download`, nzbDownloadName(nzb))"
          >
            Download
          </button>
          <button class="secondary" type="button" :disabled="nzb.status !== 'failed'" @click="retry(nzb)">Retry</button>
          <button class="danger" type="button" @click="remove(nzb)">Delete</button>
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

    <BulkDownloadDialog
      v-if="showDownloadDialog"
      :count="selectedCompleted.length"
      label="NZB"
      @individual="downloadSelectedIndividually"
      @zip="downloadSelectedZip"
      @cancel="showDownloadDialog = false"
    />
  </section>
</template>
