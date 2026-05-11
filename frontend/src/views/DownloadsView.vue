<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { deleteFile, downloadArtifact, listFiles, readText, retryFile } from '../api';
import EmptyState from '../components/EmptyState.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { openLog } from '../state/log';
import { clearMessages, runAction, setError, setNotice } from '../state/messages';
import type { FileJob } from '../types';
import { formatDate } from '../utils/format';

const loading = ref(false);
const files = ref<FileJob[]>([]);

async function load(reportErrors = true) {
  loading.value = true;
  if (reportErrors) {
    clearMessages();
  }
  try {
    files.value = (await listFiles()).items;
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

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <h2>Downloads</h2>
      <span class="muted">{{ files.length }} jobs</span>
    </div>

    <EmptyState v-if="files.length === 0" :message="loading ? 'Loading downloads.' : 'No downloads.'" />
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Status</th>
            <th>Created</th>
            <th>Completed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="file in files" :key="file.id">
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
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
