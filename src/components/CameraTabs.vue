<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import CameraView from './CameraView.vue'
import PersonEventList from './PersonEventList.vue'
import { EVENT_LIMIT, readPersonEvents, savePersonEvents, type PersonEvent } from '../detection/person-events'
import type { PersonObservation } from '../detection/usePersonDetection'
import {
  apiRequest, errorMessage, isAborted,
  type Camera, type HistoryRecord, type RecordingPage,
} from '../api'

interface CameraHistory {
  records: HistoryRecord[]
  dates: string[]
  date: string
  total: number
  offset: number
  loading: boolean
  initializing: boolean
  loaded: boolean
  error: string
  datesError: string
  selected: HistoryRecord | null
}

const PAGE_SIZE = 20
const props = defineProps<{ account: string }>()
const personEvents = ref<PersonEvent[]>([])
const eventStorageError = ref('')
try { personEvents.value = readPersonEvents(props.account) }
catch { eventStorageError.value = '無法讀取此瀏覽器的事件紀錄，新事件仍會顯示在本頁。' }

function recordPersonEvent(camera: Camera, observation: PersonObservation) {
  personEvents.value = [{
    ...observation, id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    cameraId: camera.id, cameraName: camera.name,
  }, ...personEvents.value].slice(0, EVENT_LIMIT)
  try { savePersonEvents(props.account, personEvents.value); eventStorageError.value = '' }
  catch { eventStorageError.value = '瀏覽器無法保存事件紀錄；本次事件在關閉或重整頁面後可能遺失。' }
}
const activeTab = ref<'realtime' | 'history'>('realtime')
const cameras = ref<Camera[]>([])
const camerasLoading = ref(true)
const camerasError = ref('')
const history = reactive<Record<string, CameraHistory>>({})
const controller = new AbortController()
const recordRequests = new Map<string, AbortController>()

async function loadCameras() {
  camerasLoading.value = true
  camerasError.value = ''
  try {
    const result = await apiRequest<{ cameras: Camera[] }>('/api/cameras', { signal: controller.signal })
    cameras.value = result.cameras
    for (const camera of result.cameras) {
      history[camera.id] ??= {
        records: [], dates: [], date: '', total: 0, offset: 0,
        loading: false, initializing: false, loaded: false, error: '', datesError: '', selected: null,
      }
    }
    if (activeTab.value === 'history') void loadHistories()
  } catch (error) {
    if (!isAborted(error)) camerasError.value = errorMessage(error, '無法載入攝影機，請稍後再試。')
  } finally {
    camerasLoading.value = false
  }
}

async function loadDates(cameraId: string) {
  const state = history[cameraId]
  if (!state) return
  state.datesError = ''
  try {
    const result = await apiRequest<{ dates: string[] }>(
      `/api/cameras/${encodeURIComponent(cameraId)}/dates`, { signal: controller.signal },
    )
    state.dates = result.dates
    return result.dates
  } catch (error) {
    if (!isAborted(error)) state.datesError = errorMessage(error, '無法取得錄影日期，可直接輸入日期查詢。')
  }
}

async function loadRecords(cameraId: string, offset = 0) {
  const state = history[cameraId]
  if (!state) return
  recordRequests.get(cameraId)?.abort()
  const request = new AbortController()
  recordRequests.set(cameraId, request)
  state.loading = true
  state.error = ''
  state.records = []
  state.selected = null
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
  if (state.date) query.set('date', state.date)
  try {
    const result = await apiRequest<RecordingPage>(
      `/api/cameras/${encodeURIComponent(cameraId)}/records?${query}`, { signal: request.signal },
    )
    if (request.signal.aborted) return
    state.records = result.records
    state.total = result.total
    state.offset = result.offset
    state.loaded = true
  } catch (error) {
    if (!isAborted(error)) state.error = errorMessage(error, '無法載入歷史錄影，請稍後再試。')
  } finally {
    if (recordRequests.get(cameraId) === request) {
      state.loading = false
      recordRequests.delete(cameraId)
    }
  }
}

async function initializeHistory(cameraId: string) {
  const state = history[cameraId]
  if (!state || state.initializing || state.loading) return
  state.initializing = true
  state.error = ''
  try {
    const dates = await loadDates(cameraId)
    if (controller.signal.aborted) return
    if (!dates) {
      state.error = '無法載入錄影日期，請重試，或選擇日期查詢。'
      return
    }
    // Discover directories first so the initial request reads only the newest day.
    state.date ||= dates[0] ?? ''
    if (state.date) await loadRecords(cameraId)
    else {
      state.records = []
      state.total = 0
      state.offset = 0
      state.loaded = true
    }
  } finally {
    state.initializing = false
  }
}

async function loadHistories() {
  await Promise.all(cameras.value
    .filter((camera) => !history[camera.id]?.loaded)
    .map((camera) => initializeHistory(camera.id)))
}

function refreshHistory(cameraId: string) {
  const state = history[cameraId]
  if (!state || state.initializing) return
  if (!state.loaded && !state.date) {
    void initializeHistory(cameraId)
    return
  }
  void loadDates(cameraId)
  void loadRecords(cameraId)
}

function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

async function selectRecording(cameraId: string, record: HistoryRecord) {
  const state = history[cameraId]
  if (!state) return
  state.selected = record
  await nextTick()
  if (controller.signal.aborted || state.selected?.id !== record.id) return
  const player = document.getElementById(`record-player-${cameraId}`)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  player?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' })
  player?.focus({ preventScroll: true })
}

watch(activeTab, (tab) => {
  // v-if below also releases streams when users switch to recording history.
  if (tab === 'history') void loadHistories()
  else for (const state of Object.values(history)) state.selected = null
})

onMounted(() => void loadCameras())
onBeforeUnmount(() => {
  controller.abort()
  for (const request of recordRequests.values()) request.abort()
  recordRequests.clear()
})
</script>

<template>
  <div class="container mt-4">
    <ul class="nav nav-tabs" role="tablist" aria-label="攝影機影像">
      <li class="nav-item" role="presentation">
        <button id="live-tab" class="nav-link" type="button" role="tab" aria-controls="live-panel"
          :aria-selected="activeTab === 'realtime'" :class="{ active: activeTab === 'realtime' }"
          @click="activeTab = 'realtime'">即時影像</button>
      </li>
      <li class="nav-item" role="presentation">
        <button id="history-tab" class="nav-link" type="button" role="tab" aria-controls="history-panel"
          :aria-selected="activeTab === 'history'" :class="{ active: activeTab === 'history' }"
          @click="activeTab = 'history'">歷史影像</button>
      </li>
    </ul>

    <p v-if="camerasLoading" class="status-message" role="status">正在載入攝影機…</p>
    <div v-else-if="camerasError" class="alert alert-danger mt-3" role="alert">
      {{ camerasError }}
      <button type="button" class="btn btn-sm btn-outline-danger ms-2" @click="loadCameras">重試</button>
    </div>
    <p v-else-if="cameras.length === 0" class="status-message">目前沒有可用的攝影機。</p>
    <div v-else class="tab-content mt-3">
      <div v-if="activeTab === 'realtime'" id="live-panel" role="tabpanel" aria-labelledby="live-tab" class="row g-4">
        <div v-for="camera in cameras" :key="camera.id" class="col-md-6">
          <CameraView :title="camera.name" :video-url="camera.liveUrl" @person-event="recordPersonEvent(camera, $event)" />
        </div>
      </div>

      <div v-else id="history-panel" role="tabpanel" aria-labelledby="history-tab" class="row g-4">
        <section v-for="camera in cameras" :key="camera.id" class="col-md-6" :aria-label="`${camera.name} 歷史錄影`">
          <div v-if="history[camera.id]" class="history-card">
            <div class="history-heading">
              <h2>{{ camera.name }}</h2>
              <button type="button" class="btn btn-sm btn-outline-secondary"
                :disabled="history[camera.id]!.loading || history[camera.id]!.initializing" @click="refreshHistory(camera.id)">重新整理</button>
            </div>
            <div class="history-filter">
              <label :for="`date-${camera.id}`">錄影日期</label>
              <input :id="`date-${camera.id}`" v-model="history[camera.id]!.date" type="date"
                :list="`dates-${camera.id}`" :disabled="history[camera.id]!.initializing"
                class="form-control" @change="loadRecords(camera.id)" />
              <datalist :id="`dates-${camera.id}`">
                <option v-for="date in history[camera.id]!.dates" :key="date" :value="date" />
              </datalist>
              <button v-if="history[camera.id]!.date || !history[camera.id]!.loaded" type="button" class="btn btn-sm btn-outline-secondary"
                :disabled="history[camera.id]!.initializing"
                @click="history[camera.id]!.date = ''; loadRecords(camera.id)">全部日期</button>
            </div>
            <p v-if="history[camera.id]!.datesError" class="small text-warning-emphasis" role="status">
              {{ history[camera.id]!.datesError }}
            </p>

            <p v-if="history[camera.id]!.loading || history[camera.id]!.initializing" class="status-message" role="status">正在載入歷史錄影…</p>
            <div v-else-if="history[camera.id]!.error" class="alert alert-danger" role="alert">
              {{ history[camera.id]!.error }}
              <button type="button" class="btn btn-sm btn-outline-danger" @click="refreshHistory(camera.id)">重試</button>
            </div>
            <p v-else-if="history[camera.id]!.records.length === 0" class="status-message">
              {{ history[camera.id]!.date ? '此日期沒有已完成的錄影。' : '目前沒有已完成的歷史錄影。' }}
            </p>
            <template v-else>
              <div class="table-responsive">
                <table class="table table-striped align-middle">
                  <thead><tr><th scope="col">錄影檔案</th><th scope="col">大小</th><th scope="col">播放</th></tr></thead>
                  <tbody>
                    <tr v-for="item in history[camera.id]!.records" :key="item.id">
                      <td class="record-name">{{ item.name }}<small>{{ item.date }}</small></td>
                      <td class="text-nowrap">{{ formatSize(item.size) }}</td>
                      <td><button type="button" class="btn btn-sm btn-primary text-nowrap"
                        :aria-label="`播放 ${item.name}`"
                        :aria-pressed="history[camera.id]!.selected?.id === item.id"
                        @click="selectRecording(camera.id, item)">播放</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <nav class="history-pagination" :aria-label="`${camera.name} 錄影分頁`">
                <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="history[camera.id]!.offset === 0"
                  @click="loadRecords(camera.id, Math.max(0, history[camera.id]!.offset - PAGE_SIZE))">上一頁</button>
                <span>{{ history[camera.id]!.offset + 1 }}–{{ history[camera.id]!.offset + history[camera.id]!.records.length }} / {{ history[camera.id]!.total }}</span>
                <button type="button" class="btn btn-sm btn-outline-secondary"
                  :disabled="history[camera.id]!.offset + PAGE_SIZE >= history[camera.id]!.total"
                  @click="loadRecords(camera.id, history[camera.id]!.offset + PAGE_SIZE)">下一頁</button>
              </nav>
            </template>

            <div v-if="history[camera.id]!.selected" :id="`record-player-${camera.id}`"
              class="record-player mt-3" tabindex="-1" :aria-label="`${camera.name} 錄影播放`">
              <button type="button" class="btn btn-sm btn-outline-secondary mb-2"
                @click="history[camera.id]!.selected = null">關閉播放</button>
              <CameraView :key="history[camera.id]!.selected!.id"
                :title="history[camera.id]!.selected!.name" :video-url="history[camera.id]!.selected!.fileUrl" kind="recording" />
            </div>
          </div>
        </section>
      </div>
    </div>
    <PersonEventList v-if="!camerasLoading && !camerasError" :events="personEvents" :cameras="cameras" :storage-error="eventStorageError" />
  </div>
</template>

<style scoped>
.history-card {
  padding: 1.2rem;
  border: 1px solid #dde5ee;
  border-radius: 0.65rem;
  background: #fff;
}
.history-heading, .history-filter, .history-pagination {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  flex-wrap: wrap;
}
.history-heading, .history-pagination { justify-content: space-between; }
.history-heading { margin-bottom: 1rem; }
.history-heading h2 { margin: 0; font-size: 1.25rem; }
.history-filter { margin-bottom: 1rem; }
.history-filter .form-control { flex: 1; min-width: 10rem; }
.history-filter label, .history-pagination { font-size: 0.88rem; }
.record-name { overflow-wrap: anywhere; }
.record-name small { display: block; color: #65748a; }
.record-player { scroll-margin-top: 1.25rem; }
.status-message { margin: 0; padding: 2rem 0; color: #65748a; }
.table th, .table td { font-size: 0.88rem; }
</style>
