<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import CameraView from './CameraView.vue'
import CameraHistory from './CameraHistory.vue'
import PersonEventList from './PersonEventList.vue'
import { apiRequest, errorMessage, isAborted, type Camera, type DetectionStatus, type DetectionCameraStatus } from '../api'

defineProps<{ account: string }>()
const activeTab = ref<'realtime' | 'history' | 'events'>('realtime')
const cameras = ref<Camera[]>([])
const camerasLoading = ref(true)
const camerasError = ref('')
const controller = new AbortController()
const detection = ref<DetectionStatus | null>(null)
const detectionError = ref('')
const savingCamera = ref<string | null>(null)
const controlErrors = ref<Record<string, string>>({})
let statusRequest: AbortController | undefined
let controlRequest: AbortController | undefined
let statusTimer: ReturnType<typeof setTimeout> | undefined
let statusGeneration = 0
let disposed = false

async function loadDetection() {
  if (disposed || savingCamera.value) return
  clearTimeout(statusTimer)
  statusRequest?.abort()
  const current = new AbortController()
  statusRequest = current
  const generation = ++statusGeneration
  const timeout = setTimeout(() => current.abort(), 10_000)
  try {
    const result = await apiRequest<DetectionStatus>('/api/detection', { signal: current.signal })
    if (disposed || generation !== statusGeneration || current.signal.aborted) return
    detection.value = result
    detectionError.value = ''
  } catch (cause) {
    if (disposed || generation !== statusGeneration) return
    detectionError.value = current.signal.aborted ? '偵測狀態讀取逾時，無法確認目前是否正常監控。'
      : errorMessage(cause, '無法連線至偵測服務，目前狀態尚未確認。')
  } finally {
    clearTimeout(timeout)
    if (!disposed && generation === statusGeneration) statusTimer = setTimeout(() => void loadDetection(), 5000)
  }
}

async function setDetection(cameraId: string, enabled: boolean) {
  if (disposed || savingCamera.value || !detection.value?.enabled || detectionError.value) return
  clearTimeout(statusTimer)
  ++statusGeneration
  statusRequest?.abort()
  const current = new AbortController()
  controlRequest = current
  savingCamera.value = cameraId
  controlErrors.value[cameraId] = ''
  const timeout = setTimeout(() => current.abort(), 10_000)
  try {
    const status = await apiRequest<DetectionCameraStatus>(`/api/cameras/${encodeURIComponent(cameraId)}/detection`, {
      method: 'POST', body: JSON.stringify({ enabled }), signal: current.signal,
    })
    if (disposed || current.signal.aborted || controlRequest !== current) return
    if (detection.value) detection.value.cameras = detection.value.cameras.map(camera => camera.cameraId === cameraId ? status : camera)
  } catch (cause) {
    if (disposed || controlRequest !== current) return
    controlErrors.value[cameraId] = current.signal.aborted ? '設定儲存逾時；開關將以重新取得的伺服器設定為準，請確認後再試。'
      : errorMessage(cause, '設定儲存未獲確認；開關以伺服器回傳值為準，請確認後再試。')
  } finally {
    clearTimeout(timeout)
    if (!disposed && controlRequest === current) {
      savingCamera.value = null
      controlRequest = undefined
      void loadDetection()
    }
  }
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

onMounted(() => { void loadCameras(); void loadDetection() })
onBeforeUnmount(() => {
  disposed = true
  ++statusGeneration
  clearTimeout(statusTimer)
  controller.abort()
  statusRequest?.abort()
  controlRequest?.abort()
})
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
        <div class="monitoring-note">
          <strong>伺服器持續偵測 · 關閉網頁仍持續監控</strong>
          <p>啟用的攝影機由伺服器分析與記錄，切換分頁或登出不會停止偵測。設定會同步至所有裝置。</p>
          <p v-if="detection && !detection.enabled" class="text-warning-emphasis" role="status">伺服器偵測服務目前未啟用，請聯絡管理者。</p>
          <p v-if="detectionError" class="text-danger" role="alert">{{ detectionError }}
            <button type="button" class="btn btn-sm btn-outline-secondary ms-2" :disabled="!!savingCamera" @click="loadDetection">重新確認</button>
          </p>
        </div>
        <div v-if="activeTab === 'realtime'" class="row g-4 mt-1">
          <div v-for="camera in cameras" :key="camera.id" class="col-lg-6">
            <CameraView :title="camera.name" :video-url="camera.liveUrl"
              :detection-status="detection?.cameras.find(status => status.cameraId === camera.id)"
              :detection-unavailable="detectionError" :detection-saving="savingCamera === camera.id"
              :detection-controls-disabled="!detection?.enabled || !!savingCamera || !!detectionError"
              :detection-control-error="controlErrors[camera.id]"
              @detection-change="setDetection(camera.id, $event)" />
          </div>
        </div>
        <PersonEventList :cameras="cameras" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.camera-tabs { padding-top: 1.5rem; }
.camera-content { min-width: 0; }
.monitoring-note { margin-top: 1.25rem; padding: 0.9rem 1rem; border-radius: 0.6rem; background: #eef7f7; color: #245e63; font-size: 0.88rem; line-height: 1.65; }
.monitoring-note p { margin: 0.35rem 0 0; }
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
