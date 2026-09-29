<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import CameraView from './CameraView.vue'
import { apiRequest, errorMessage, type HistoryRecord, type RecordingPage } from '../api'

const PAGE_SIZE = 20
const props = defineProps<{ camera: string; title: string }>()
const dates = ref<string[]>([])
const selectedDate = ref('')
const records = ref<HistoryRecord[]>([])
const selected = ref<HistoryRecord | null>(null)
const loading = ref(false)
const error = ref('')
const playOnLoad = ref(false)
const player = ref<InstanceType<typeof CameraView> | null>(null)
const total = ref(0)
const offset = ref(0)
const playableCount = computed(() => records.value.filter(record => record.status === 'ready').length)
let request: AbortController | undefined
let initialized = false

async function fetchHistory(date = selectedDate.value, pageOffset = 0) {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  const previousId = selected.value?.id
  selected.value = null
  playOnLoad.value = false
  const timeout = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const base = `/api/cameras/${encodeURIComponent(props.camera)}`
    const available = await apiRequest<{ dates: string[] }>(`${base}/dates`, { signal: controller.signal })
    if (request !== controller || controller.signal.aborted) return
    dates.value = available.dates
    // Initially read only the latest nonempty day; all-date scanning is explicit.
    if (!initialized) date = date || available.dates[0] || ''
    selectedDate.value = date
    if (!date && available.dates.length === 0) {
      records.value = []
      total.value = 0
      offset.value = 0
      initialized = true
      return
    }
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageOffset) })
    if (date) query.set('date', date)
    const data = await apiRequest<RecordingPage>(`${base}/records?${query}`, { signal: controller.signal })
    if (request !== controller || controller.signal.aborted) return
    records.value = data.records
    total.value = data.total
    offset.value = data.offset
    selected.value = data.records.find(record => record.id === previousId && record.status === 'ready' && record.fileUrl)
      || data.records.find(record => record.status === 'ready' && record.fileUrl) || null
    initialized = true
  } catch (reason) {
    if (request !== controller) return
    records.value = []
    total.value = 0
    selected.value = null
    error.value = controller.signal.aborted ? '讀取錄影逾時，請重新整理。'
      : errorMessage(reason, '無法載入歷史錄影，請稍後重試。')
  } finally {
    window.clearTimeout(timeout)
    if (request === controller) loading.value = false
  }
}

async function selectRecord(record: HistoryRecord) {
  if (record.status !== 'ready' || !record.fileUrl) return
  playOnLoad.value = true
  selected.value = record
  await nextTick()
  if (selected.value?.id === record.id) await player.value?.play()
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function timeLabel(record: HistoryRecord) {
  if (!record.time) return record.fileName
  // Also recognize legacy names while frontend/server roll out separately.
  const hourly = record.timePrecision === 'hour'
    || /^(?:\d{4}-\d{2}-\d{2}_)?\d{2}\.mp4$/i.test(record.fileName)
  if (hourly) return `${record.time.slice(0, 2)} 時（起點未校準）`
  return record.timePrecision === 'minute' ? record.time.slice(0, 5) : record.time
}

onMounted(() => fetchHistory())
onBeforeUnmount(() => {
  const current = request
  request = undefined
  current?.abort()
})
</script>

<template>
  <article class="history-card" :aria-label="`${title}歷史錄影`" :aria-busy="loading">
    <header class="camera-heading">
      <div><span class="camera-id">{{ camera.toUpperCase() }}</span><h2>{{ title }}</h2></div>
      <button type="button" class="refresh-button" :disabled="loading" @click="fetchHistory()">
        {{ loading ? '讀取中…' : '重新整理' }}
      </button>
    </header>

    <div class="date-filter">
      <label :for="`${camera}-date`">錄影日期</label>
      <select :id="`${camera}-date`" v-model="selectedDate" :disabled="loading || dates.length === 0" @change="fetchHistory()">
        <option v-if="dates.length === 0" value="">尚無可用日期</option>
        <option v-else value="">全部日期</option>
        <option v-if="selectedDate && !dates.includes(selectedDate)" :value="selectedDate">{{ selectedDate }}</option>
        <option v-for="date in dates" :key="date" :value="date">{{ date }}</option>
      </select>
    </div>

    <div v-if="error" class="history-message history-message--error" role="alert">
      <strong>暫時無法取得錄影</strong><span>{{ error }}</span>
      <button type="button" class="refresh-button" @click="fetchHistory()">重試</button>
    </div>
    <div v-else-if="loading" class="history-message" role="status">正在讀取錄影列表…</div>
    <template v-else>
      <div v-if="selected?.fileUrl" class="playback">
        <CameraView ref="player" :key="selected.id" :title="`${title} ${timeLabel(selected)}`" :video-url="selected.fileUrl"
          kind="recording" compact :play-on-load="playOnLoad" />
        <div class="playback-caption">
          <span>{{ selected.date }} · {{ timeLabel(selected) }}</span>
          <a :href="selected.fileUrl" :download="selected.fileName">下載錄影</a>
        </div>
      </div>
      <div v-else class="history-message player-placeholder">
        <strong>{{ records.length ? '尚無可播放的片段' : selectedDate ? '這天沒有歷史錄影' : '尚無歷史錄影' }}</strong>
        <span>{{ records.length ? '錄影完成後，重新整理即可查看可播放片段。' : '請選擇其他日期，或稍後重新整理。' }}</span>
      </div>

      <div class="record-summary" aria-live="polite">
        <span>錄影片段</span><span>本頁 {{ playableCount }} 段可播放 / 共 {{ total }} 段</span>
      </div>
      <ul v-if="records.length" class="record-list" :aria-label="`${title}錄影片段`">
        <li v-for="record in records" :key="record.id">
          <button type="button" class="record-button" :class="{ 'is-selected': selected?.id === record.id }"
            :disabled="record.status !== 'ready' || !record.fileUrl" :aria-pressed="selected?.id === record.id" @click="selectRecord(record)">
            <span class="record-details"><strong>{{ timeLabel(record) }}</strong>
              <span class="record-file">{{ record.fileName }} · {{ formatSize(record.size) }}</span></span>
            <span class="record-status" :class="`record-status--${record.status}`">
              {{ record.status === 'recording' ? '錄製中' : record.status === 'unavailable' ? '檔案未完成' : selected?.id === record.id ? '已選取' : '播放' }}
            </span>
          </button>
        </li>
      </ul>
      <nav v-if="total > PAGE_SIZE" class="history-pagination" :aria-label="`${title} 錄影分頁`">
        <button type="button" class="refresh-button" :disabled="offset === 0"
          @click="fetchHistory(selectedDate, Math.max(0, offset - PAGE_SIZE))">上一頁</button>
        <span>{{ offset + 1 }}–{{ offset + records.length }} / {{ total }}</span>
        <button type="button" class="refresh-button" :disabled="offset + PAGE_SIZE >= total"
          @click="fetchHistory(selectedDate, offset + PAGE_SIZE)">下一頁</button>
      </nav>
      <p v-if="records.some(record => record.status !== 'ready')" class="record-note">
        錄製中或未完成的檔案暫時無法播放。
      </p>
    </template>
  </article>
</template>

<style scoped>
.history-card { padding: 1.25rem; border: 1px solid #dce5ec; border-radius: 0.9rem; background: #fff; box-shadow: 0 5px 20px #17344a06; }
.camera-heading { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1.2rem; }
.camera-heading h2 { font-size: 1.25rem; font-weight: 700; margin: 0.15rem 0 0; }
.camera-id { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.12em; color: #61768a; }
.refresh-button { border: 1px solid #d1dfe7; border-radius: 0.4rem; padding: 0.4rem 0.7rem; background: #fff; color: #31546a; font-size: 0.82rem; }
.refresh-button:disabled { opacity: 0.6; cursor: wait; }
.date-filter { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1rem; font-size: 0.85rem; }
.date-filter label { flex-shrink: 0; color: #5c6c80; }
.date-filter select { flex: 1; min-width: 0; border: 1px solid #ccd9e2; border-radius: 0.4rem; padding: 0.55rem; background: #f8fafc; color: #243a50; }
.playback :deep(video) { display: block; width: 100%; aspect-ratio: 16 / 9; background: #081727; border-radius: 0.5rem; }
.playback-caption { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; justify-content: space-between; margin-top: 0.65rem; font-size: 0.78rem; color: #55697d; }
.playback-caption a { color: #086b73; font-weight: 600; }
.history-message { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.7rem; min-height: 12rem; padding: 1.5rem; text-align: center; font-size: 0.88rem; background: #f4f7fa; border-radius: 0.5rem; color: #5c6c80; }
.history-message strong { color: #31485e; }
.history-message--error { background: #fff4f0; color: #913c2f; }
.player-placeholder { aspect-ratio: 16 / 9; }
.record-summary { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; margin: 1.3rem 0 0.6rem; font-size: 0.8rem; color: #61768a; }
.record-summary > :first-child { color: #253e53; font-weight: 600; }
.record-list { list-style: none; padding: 0; margin: 0; max-height: 24rem; overflow-y: auto; }
.record-list li + li { margin-top: 0.4rem; }
.record-button { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; width: 100%; padding: 0.85rem; border: 1px solid #e6edf2; border-radius: 0.5rem; background: #fff; text-align: left; color: #2b4257; }
.record-button:hover:enabled { border-color: #72b6bb; background: #f6fcfc; }
.record-button.is-selected { border-color: #3f979f; background: #edf8f8; }
.record-button:disabled { cursor: default; background: #f8fafb; }
.record-details { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.record-details strong { font-size: 0.9rem; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.record-file { font-size: 0.72rem; color: #65788a; overflow-wrap: anywhere; }
.record-status { flex-shrink: 0; font-size: 0.74rem; font-weight: 600; color: #0c6d72; }
.record-status--recording { color: #91611a; }
.record-status--unavailable { color: #697988; }
.record-note { font-size: 0.74rem; color: #697988; margin: 0.85rem 0 0; }
.history-pagination { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.8rem; font-size: 0.8rem; color: #61768a; }
button:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid #55b6c0; outline-offset: 2px; }

@media (min-width: 992px) and (min-height: 820px) {
  .history-card { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .history-card > :not(.record-list) { flex-shrink: 0; }
  .playback :deep(video:not(:fullscreen)), .player-placeholder { max-height: max(12rem, calc(100dvh - 44rem)); object-fit: contain; }
  .record-list { flex: 1 1 0; min-height: 4rem; max-height: none; overscroll-behavior-y: contain; scrollbar-gutter: stable; }
}

@media (max-width: 480px) { .history-card { padding: 1rem; } }
</style>
