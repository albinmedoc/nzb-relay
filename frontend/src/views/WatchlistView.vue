<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  createWatchlistSource,
  deleteWatchlistSource,
  listWatchlist,
  retryWatchlistSource,
  updateWatchlistSource
} from '../api';
import BulkActionBar from '../components/BulkActionBar.vue';
import DataTable from '../components/DataTable.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TableToolbar from '../components/TableToolbar.vue';
import { usePagination } from '../composables/usePagination';
import { useRowSelection } from '../composables/useRowSelection';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { WatchlistSource } from '../types';
import { bulkSummary, runBulk } from '../utils/bulk';
import { formatDate } from '../utils/format';

const loading = ref(false);
const watchlist = ref<WatchlistSource[]>([]);
const total = ref(0);
const { limit, offset, setLimit, setOffset } = usePagination();
const { selectedIds, selectedRows, toggleRow, toggleVisible, clearSelection } = useRowSelection(watchlist);
const form = reactive({
  url: '',
  backfill: true,
  deleteFileAfterNzb: true
});

const selectedDisabled = computed(() => selectedRows.value.filter((source) => !source.enabled));
const selectedEnabled = computed(() => selectedRows.value.filter((source) => source.enabled));

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
    const response = await listWatchlist({ limit: limit.value, offset: offset.value });
    watchlist.value = response.items;
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

async function enableSelected() {
  await updateSelectedEnabled(selectedDisabled.value, true);
}

async function disableSelected() {
  await updateSelectedEnabled(selectedEnabled.value, false);
}

async function updateSelectedEnabled(rows: WatchlistSource[], enabled: boolean) {
  await runAction(async () => {
    const result = await runBulk(rows, (source) => updateWatchlistSource(source.id, { enabled }).then(() => undefined));
    clearSelection();
    await load(false);
    setNotice(bulkSummary(enabled ? 'Enable' : 'Disable', result));
  });
}

async function retrySelected() {
  await runAction(async () => {
    const result = await runBulk(selectedRows.value, (source) => retryWatchlistSource(source.id).then(() => undefined));
    clearSelection();
    await load(false);
    setNotice(bulkSummary('Retry', result));
  });
}

async function deleteSelected() {
  const rows = [...selectedRows.value];
  if (!confirm(`Remove ${rows.length} selected watchlist source${rows.length === 1 ? '' : 's'}?`)) {
    return;
  }
  await runAction(async () => {
    const result = await runBulk(rows, (source) => deleteWatchlistSource(source.id));
    clearSelection();
    await load(false);
    setNotice(bulkSummary('Delete', result));
  });
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <h2>Watchlist</h2>
      <span class="muted">{{ total }} sources</span>
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

    <TableToolbar>
      <template #actions>
        <button class="secondary" type="button" :disabled="loading" @click="() => load()">Refresh</button>
      </template>
    </TableToolbar>

    <BulkActionBar :selected-count="selectedRows.length" @clear="clearSelection">
      <button class="secondary" type="button" :disabled="selectedDisabled.length === 0" @click="enableSelected">Enable</button>
      <button class="secondary" type="button" :disabled="selectedEnabled.length === 0" @click="disableSelected">Disable</button>
      <button class="secondary" type="button" @click="retrySelected">Retry</button>
      <button class="danger" type="button" @click="deleteSelected">Delete</button>
    </BulkActionBar>

    <DataTable
      :rows="watchlist"
      :loading="loading"
      empty-message="No watchlist sources."
      selectable
      :selected-ids="selectedIds"
      @toggle-row="toggleRow"
      @toggle-visible="toggleVisible"
    >
      <template #header>
        <th>Source</th>
        <th>Status</th>
        <th>Episodes</th>
        <th>Next scan</th>
        <th>Actions</th>
      </template>
      <template #row="{ row: source }">
        <td>
          <RouterLink class="table-link" :to="`/watchlist/${source.id}`">
            <strong>{{ source.title || source.url }}</strong>
          </RouterLink>
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
