<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { deleteNzb, downloadArtifact, listNzbs, readText, retryNzb } from '../api';
import EmptyState from '../components/EmptyState.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { openLog } from '../state/log';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { NzbJob } from '../types';
import { formatDate, nzbDownloadName } from '../utils/format';

const loading = ref(false);
const nzbs = ref<NzbJob[]>([]);

async function load(reportErrors = true) {
  loading.value = true;
  if (reportErrors) {
    clearMessages();
  }
  try {
    nzbs.value = (await listNzbs()).items;
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

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <h2>NZBs</h2>
      <span class="muted">{{ nzbs.length }} jobs</span>
    </div>

    <EmptyState v-if="nzbs.length === 0" :message="loading ? 'Loading NZB jobs.' : 'No NZB jobs.'" />
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>NZB</th>
            <th>Status</th>
            <th>Files</th>
            <th>Created</th>
            <th>Posted</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="nzb in nzbs" :key="nzb.id">
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
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
