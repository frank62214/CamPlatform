<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CameraView from './CameraView.vue'
import { apiRequest, errorMessage, isAborted, type Camera, type HistoryRecord, type PersonEvent, type PersonEventPage } from '../api'

interface EventClip {
  status: 'ready' | 'pending' | 'unavailable'
  parts: { record: HistoryRecord; startSeconds: number; endSeconds: number }[]
  approximate: boolean
  partial?: boolean
}

defineProps<{ cameras: Camera[] }>()
const PAGE_SIZE = 50
const cameraFilter = ref('')
const dateFilter = ref('')
const events = ref<PersonEvent[]>([])
const total = ref(0)
const offset = ref(0)
const retentionDays = ref<number | null>(null)
const listLoading = ref(true)
const listError = ref('')
const lastUpdated = ref('')
let listRequest: AbortController | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const selected = ref<PersonEvent | null>(null)
const clip = ref<EventClip | null>(null)
const partIndex = ref(0)
const playerKey = ref(0)
const loading = ref(false)
const error = ref('')
const complete = ref(false)
const preview = ref<HTMLElement | null>(null)
const part = computed(() => clip.value?.parts[partIndex.value])
let request: AbortController | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })
}

async function loadEvents(pageOffset = offset.value, quiet = false) {
  if (disposed) return
  clearTimeout(pollTimer)
  listRequest?.abort()
  const current = new AbortController()
  listRequest = current
  if (!quiet) listLoading.value = true
  const timeout = setTimeout(() => current.abort(), 10_000)
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageOffset) })
  if (cameraFilter.value) query.set('cameraId', cameraFilter.value)
  if (dateFilter.value) query.set('date', dateFilter.value)
  try {
    const result = await apiRequest<PersonEventPage>(`/api/person-events?${query}`, { signal: current.signal })
    if (disposed || current !== listRequest || current.signal.aborted) return
    if (result.total > 0 && pageOffset >= result.total) {
      await loadEvents(Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE)
      return
    }
    events.value = result.events
    total.value = result.total
    offset.value = result.total ? result.offset : 0
    retentionDays.value = result.retentionDays
    lastUpdated.value = new Date().toISOString()
    listError.value = ''
  } catch (cause) {
    if (disposed || current !== listRequest) return
    listError.value = current.signal.aborted ? '事件清單讀取逾時，稍後將自動重試。'
      : errorMessage(cause, '無法讀取伺服器事件，稍後將自動重試。')
  } finally {
    clearTimeout(timeout)
    if (!disposed && current === listRequest) {
      listLoading.value = false
      pollTimer = setTimeout(() => void loadEvents(offset.value, true), 5000)
    }
  }
}

function closePreview() {
  request?.abort()
  clearTimeout(retryTimer)
  request = null
  selected.value = null
  clip.value = null
  loading.value = false
  error.value = ''
}

async function loadClip(event: PersonEvent, scroll = true) {
  request?.abort()
  clearTimeout(retryTimer)
  const current = new AbortController()
  request = current
  selected.value = event
  loading.value = true
  error.value = ''
  clip.value = null
  partIndex.value = 0
  complete.value = false
  playerKey.value++
  if (scroll) {
    await nextTick()
    preview.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    preview.value?.focus({ preventScroll: true })
  }
  if (current.signal.aborted || request !== current || disposed) return
  const timeout = setTimeout(() => current.abort(), 20_000)
  try {
    const result = await apiRequest<EventClip>(
      `/api/cameras/${encodeURIComponent(event.cameraId)}/event-clip?at=${encodeURIComponent(event.occurredAt)}`,
      { signal: current.signal },
    )
    if (current.signal.aborted || request !== current || disposed) return
    clip.value = result
    if (result.status === 'pending') retryTimer = setTimeout(() => void loadClip(event, false), 15000)
  } catch (cause) {
    if (request === current && !disposed) error.value = isAborted(cause) ? '取得事件片段逾時，請稍後重試。'
      : errorMessage(cause, '無法取得事件片段，請稍後重試。')
  } finally {
    clearTimeout(timeout)
    if (request === current) loading.value = false
  }
}

function nextPart() {
  if (!clip.value) return
  if (partIndex.value + 1 < clip.value.parts.length) partIndex.value++
  else complete.value = true
}

function replay() {
  partIndex.value = 0
  complete.value = false
  playerKey.value++
}

watch([cameraFilter, dateFilter], () => {
  closePreview()
  events.value = []
  total.value = 0
  offset.value = 0
  lastUpdated.value = ''
  listError.value = ''
  void loadEvents(0)
})
onMounted(() => void loadEvents())
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(pollTimer)
  listRequest?.abort()
  closePreview()
})
</script>

<template>
  <section class="events-card" aria-labelledby="person-events-title">
    <div class="events-heading">
      <div>
        <h2 id="person-events-title">人物事件 <span>{{ total }} 筆</span></h2>
        <p>伺服器保存人物出現的時刻，所有裝置共用；點選即可回看前後各 10 秒。</p>
      </div>
      <div class="events-filters">
        <div class="events-filter">
          <label for="person-events-camera">攝影機</label>
          <select id="person-events-camera" v-model="cameraFilter" class="form-select form-select-sm">
            <option value="">全部攝影機</option>
            <option v-for="camera in cameras" :key="camera.id" :value="camera.id">{{ camera.name }}</option>
          </select>
        </div>
        <div class="events-filter">
          <label for="person-events-date">日期（台北）</label>
          <input id="person-events-date" v-model="dateFilter" type="date" class="form-control form-control-sm" />
        </div>
        <button v-if="dateFilter" type="button" class="btn btn-sm btn-outline-secondary" @click="dateFilter = ''">全部日期</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="listLoading" @click="loadEvents()">重新整理</button>
      </div>
    </div>
    <p v-if="listError" class="text-danger small" role="alert">{{ listError }}<span v-if="events.length"> 以下保留上次取得的事件。</span></p>
    <p v-if="listLoading" class="events-empty" role="status">正在讀取伺服器事件…</p>
    <p v-else-if="!events.length && !listError" class="events-empty">{{ cameraFilter || dateFilter ? '此篩選條件下尚無人物事件，可調整攝影機或日期。' : '尚無人物事件。在即時影像開啟「伺服器持續偵測」，有人出現時會列在這裡。' }}</p>
    <div v-else-if="events.length && !listLoading" class="table-responsive">
      <table class="table align-middle event-table">
        <thead><tr><th scope="col">事件時間</th><th scope="col">攝影機</th><th scope="col">事件</th><th scope="col">片段</th></tr></thead>
        <tbody>
          <tr v-for="event in events" :key="event.id" :class="{ selected: selected?.id === event.id }">
            <td><time :datetime="event.occurredAt">{{ formatTime(event.occurredAt) }}</time>
              <small v-if="event.timing === 'estimated'">影像時間為估算值</small></td>
            <td>{{ cameras.find((camera) => camera.id === event.cameraId)?.name ?? event.cameraName }}</td>
            <td><span class="event-tag">人物出現 · {{ event.count }} 人</span></td>
            <td><button type="button" class="btn btn-sm btn-outline-primary text-nowrap"
              :aria-label="`回看 ${event.cameraName} ${formatTime(event.occurredAt)} 前後 10 秒`"
              :aria-pressed="selected?.id === event.id" @click="loadClip(event)">回看 ±10 秒</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav v-if="total > PAGE_SIZE" class="events-pagination" aria-label="人物事件分頁">
      <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="listLoading || offset === 0" @click="loadEvents(Math.max(0, offset - PAGE_SIZE))">上一頁</button>
      <span>{{ offset + 1 }}–{{ offset + events.length }} / {{ total }}</span>
      <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="listLoading || offset + PAGE_SIZE >= total" @click="loadEvents(offset + PAGE_SIZE)">下一頁</button>
    </nav>

    <div v-if="selected" ref="preview" class="event-preview" tabindex="-1" aria-label="事件片段回放">
      <div class="preview-heading">
        <h3>{{ selected.cameraName }} · {{ formatTime(selected.occurredAt) }}</h3>
        <button type="button" class="btn btn-sm btn-outline-secondary" @click="closePreview">關閉片段</button>
      </div>
      <p v-if="loading" role="status">正在尋找事件前後的錄影…</p>
      <div v-else-if="error" role="alert"><p>{{ error }}</p><button class="btn btn-sm btn-outline-secondary" @click="loadClip(selected)">重試</button></div>
      <template v-else-if="clip?.status === 'ready' && part">
        <p v-if="clip.approximate || selected.timing === 'estimated'" class="clip-notice">此事件或舊錄影缺少精確時間，回放位置為估算值。</p>
        <p v-if="clip.partial" class="clip-notice">事件前後部分錄影尚未完成或缺失，目前播放可用範圍。
          <button type="button" class="btn btn-sm btn-link" @click="loadClip(selected, false)">重新檢查</button></p>
        <p class="clip-caption">事件前 10 秒 → 人物出現 → 事件後 10 秒<span v-if="clip.parts.length > 1"> · 第 {{ partIndex + 1 }} / {{ clip.parts.length }} 段</span></p>
        <CameraView v-if="part.record.fileUrl" :key="`${selected.id}-${playerKey}-${partIndex}`" :title="part.record.name" :video-url="part.record.fileUrl"
          kind="recording" :clip="part" @clip-ended="nextPart" />
        <div v-if="complete" class="clip-complete" role="status">事件片段播放完畢。
          <button type="button" class="btn btn-sm btn-outline-primary" @click="replay">重新播放片段</button>
        </div>
      </template>
      <p v-else-if="clip?.status === 'pending'" role="status">錄影仍在寫入，完成後才能回放；每 15 秒自動檢查。小時錄影可能需等目前這段結束。</p>
      <p v-else role="status">找不到涵蓋此事件的已完成錄影。錄影可能已移除，或當時沒有錄到影像。
        <button type="button" class="btn btn-sm btn-outline-secondary" @click="loadClip(selected)">重新檢查</button></p>
    </div>
    <p class="events-footnote">關閉網頁仍持續監控。<span v-if="retentionDays !== null">伺服器保留最近 {{ retentionDays }} 天事件；</span>事件時間以台北時間顯示，錄影仍依錄影保存期限提供。
      <span v-if="lastUpdated">清單更新於 {{ formatTime(lastUpdated) }}，每 5 秒自動更新。</span>
    </p>
  </section>
</template>

<style scoped>
.events-card { margin-top: 1.75rem; padding: clamp(1rem, 2vw, 1.4rem); background: #fff; border: 1px solid #dde5ee; border-radius: 0.65rem; }
.events-heading, .preview-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; }
.events-heading h2 { margin: 0 0 0.4rem; font-size: 1.2rem; }
.events-heading h2 span { margin-left: 0.25rem; color: #65748a; font-size: 0.9rem; }
.events-heading p, .events-footnote { margin: 0; color: #65748a; font-size: 0.83rem; line-height: 1.6; }
.events-filter { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; white-space: nowrap; }
.events-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem; }
.events-filter select, .events-filter input { width: auto; min-width: 0; }
.events-pagination { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; margin: 0.8rem 0; font-size: 0.85rem; }
.events-empty { padding: 1.25rem 0; color: #65748a; font-size: 0.92rem; }
.event-table { font-size: 0.85rem; }
.event-table th { color: #65748a; font-weight: 500; white-space: nowrap; }
.event-table td { min-width: 5rem; }
.event-table small { display: block; color: #8d671e; margin-top: 0.2rem; }
.event-table .selected td { background: #eef8f8; }
.event-tag { color: #956117; white-space: nowrap; }
.event-preview { margin: 1rem 0; padding: 1rem; background: #f4f7fb; border: 1px solid #d8e2eb; border-radius: 0.6rem; scroll-margin-top: 1rem; }
.preview-heading h3 { margin: 0; font-size: 1rem; line-height: 1.5; }
.clip-notice { color: #8d671e; font-size: 0.85rem; }
.clip-caption { font-size: 0.86rem; color: #466174; }
.clip-complete { display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem; margin-top: 0.8rem; }
.events-footnote { margin-top: 1rem; }
@media (max-width: 575px) {
  .events-filters { width: 100%; }
  .events-filter { width: 100%; justify-content: space-between; }
  .events-filter select, .events-filter input { max-width: 65%; }
  .event-table th:nth-child(3), .event-table td:nth-child(3) { display: none; }
  .event-table th, .event-table td { min-width: 0; padding: 0.65rem 0.3rem; }
  .event-table .btn { font-size: 0.78rem; padding-inline: 0.4rem; }
}
</style>
