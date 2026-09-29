<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import CameraView from './CameraView.vue'
import CameraHistory from './CameraHistory.vue'
import PersonEventList from './PersonEventList.vue'
import { apiRequest, errorMessage, isAborted, type Camera } from '../api'
import { EVENT_LIMIT, readPersonEvents, savePersonEvents, type PersonEvent } from '../detection/person-events'
import type { PersonObservation } from '../detection/usePersonDetection'

const props = defineProps<{ account: string }>()
const activeTab = ref<'realtime' | 'history' | 'events'>('realtime')
const cameras = ref<Camera[]>([])
const camerasLoading = ref(true)
const camerasError = ref('')
const personEvents = ref<PersonEvent[]>([])
const eventStorageError = ref('')
const controller = new AbortController()

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

async function loadCameras() {
  camerasLoading.value = true
  camerasError.value = ''
  try {
    const result = await apiRequest<{ cameras: Camera[] }>('/api/cameras', { signal: controller.signal })
    if (!controller.signal.aborted) cameras.value = result.cameras
  } catch (error) {
    if (!isAborted(error)) camerasError.value = errorMessage(error, '無法載入攝影機，請稍後再試。')
  } finally {
    if (!controller.signal.aborted) camerasLoading.value = false
  }
}

onMounted(() => void loadCameras())
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <div class="container camera-tabs">
    <nav class="nav nav-tabs" aria-label="影像模式">
      <button type="button" class="nav-link" :class="{ active: activeTab === 'realtime' }"
        :aria-pressed="activeTab === 'realtime'" @click="activeTab = 'realtime'">即時影像</button>
      <button type="button" class="nav-link" :class="{ active: activeTab === 'history' }"
        :aria-pressed="activeTab === 'history'" @click="activeTab = 'history'">歷史影像</button>
      <button type="button" class="nav-link" :class="{ active: activeTab === 'events' }"
        :aria-pressed="activeTab === 'events'" @click="activeTab = 'events'">人物事件</button>
    </nav>

    <p v-if="camerasLoading" class="status-message" role="status">正在載入攝影機…</p>
    <div v-else-if="camerasError" class="alert alert-danger mt-3" role="alert">
      {{ camerasError }}
      <button type="button" class="btn btn-sm btn-outline-danger ms-2" @click="loadCameras">重試</button>
    </div>
    <p v-else-if="cameras.length === 0" class="status-message">目前沒有可用的攝影機。</p>
    <template v-else>
      <section v-if="activeTab === 'history'" class="history-section" aria-labelledby="history-heading">
        <div class="history-heading">
          <h1 id="history-heading">歷史錄影</h1>
          <p>各台攝影機可獨立選片與播放。時間依錄影檔名顯示（台北時間 UTC+8）；舊檔僅記錄小時，相同時段不代表相同起點。</p>
        </div>
        <div class="history-grid">
          <div v-for="camera in cameras" :key="camera.id">
            <CameraHistory :camera="camera.id" :title="camera.name" />
          </div>
        </div>
      </section>
      <div v-else class="camera-content">
        <div v-if="activeTab === 'realtime'" class="row g-4 mt-1">
          <div v-for="camera in cameras" :key="camera.id" class="col-lg-6">
            <CameraView :title="camera.name" :video-url="camera.liveUrl" @person-event="recordPersonEvent(camera, $event)" />
          </div>
        </div>
        <PersonEventList :events="personEvents" :cameras="cameras" :storage-error="eventStorageError" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.camera-tabs { padding-top: 1.5rem; }
.camera-content { min-width: 0; }
.history-section { padding-top: 1.75rem; }
.history-grid { display: grid; gap: 1.5rem; }
.history-grid > div { min-width: 0; }
.history-heading { margin-bottom: 1.5rem; }
.history-heading h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; }
.history-heading p { color: #5c6c80; font-size: 0.9rem; margin: 0; line-height: 1.7; }
.nav-link { color: #52677b; }
.nav-link.active { color: #086b73; font-weight: 600; }
.status-message { margin: 0; padding: 2rem 0; color: #65748a; }

@media (min-width: 992px) {
  .history-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* Keep short windows and stacked mobile cards in normal document flow. */
@media (min-width: 992px) and (min-height: 820px) {
  .camera-tabs, .history-section { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .nav, .history-heading { flex-shrink: 0; }
  .history-grid { flex: 1; min-height: 0; grid-template-rows: minmax(0, 1fr); }
  .history-grid > div { min-height: 0; }
  .camera-content { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; padding-bottom: 0.75rem; }
}
</style>
