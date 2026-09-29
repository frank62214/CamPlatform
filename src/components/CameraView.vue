<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type Hls from 'hls.js'
import { ApiError, apiRequest, handleUnauthorized, sameOriginUrl } from '../api'
import { usePersonDetection, type PersonObservation } from '../detection/usePersonDetection'

const props = withDefaults(defineProps<{
  title: string
  videoUrl: string
  kind?: 'live' | 'recording'
  clip?: { startSeconds: number; endSeconds: number }
  compact?: boolean
  playOnLoad?: boolean
}>(), { kind: 'live' })

const emit = defineEmits<{
  'person-event': [observation: PersonObservation]
  'clip-ended': []
}>()

const cam = ref<HTMLVideoElement | null>(null)
const loading = ref(true)
const error = ref('')
let hls: Hls | null = null
let request: AbortController | null = null
let generation = 0
let disposed = false
let checkingAuthentication = false
const playBlocked = ref(false)
let clipFinished = false
let clipTimer: ReturnType<typeof setInterval> | undefined

function frameTime(): { time: number; timing: PersonObservation['timing'] } {
  const video = cam.value
  const playingDate = hls?.playingDate
  if (playingDate && Number.isFinite(playingDate.getTime())) return { time: playingDate.getTime(), timing: 'stream' }
  const nativeStart = (video as (HTMLVideoElement & { getStartDate?: () => Date }) | null)?.getStartDate?.()
  if (nativeStart && Number.isFinite(nativeStart.getTime()) && video) {
    return { time: nativeStart.getTime() + video.currentTime * 1000, timing: 'stream' }
  }
  const delay = video?.seekable.length
    ? Math.max(0, video.seekable.end(video.seekable.length - 1) - video.currentTime) * 1000 : 0
  return { time: Date.now() - delay, timing: 'estimated' }
}

const detection = usePersonDetection(cam, () => props.videoUrl, () => props.kind === 'live', frameTime,
  (observation) => emit('person-event', observation))
const { enabled, status, statusText, present, count, latest } = detection

function finishClip() {
  if (!props.clip) return
  cam.value?.pause()
  if (clipFinished) return
  clipFinished = true
  emit('clip-ended')
}

function constrainClip() {
  const video = cam.value
  if (!video || !props.clip || video.readyState < 1) return
  const start = Math.max(0, props.clip.startSeconds)
  const end = Math.min(video.duration, props.clip.endSeconds)
  if (video.currentTime < start - 0.1) video.currentTime = start
  if (video.currentTime >= end) {
    if (video.currentTime > end + 0.05) video.currentTime = end
    finishClip()
  }
}

async function playClip() {
  if (!cam.value || !props.clip) return
  const current = generation
  if (clipFinished) {
    clipFinished = false
    cam.value.currentTime = props.clip.startSeconds
  }
  try { await cam.value.play(); if (current === generation && !disposed) playBlocked.value = false }
  catch { if (current === generation && !disposed) playBlocked.value = true }
}

function handleMetadata() {
  if (props.kind !== 'recording') return
  loading.value = false
  if (props.clip && cam.value) {
    if (!Number.isFinite(cam.value.duration) || props.clip.startSeconds >= cam.value.duration) {
      showError('錄影片段時間已改變，請重新選擇事件。')
      return
    }
    cam.value.currentTime = Math.max(0, props.clip.startSeconds)
    clipFinished = false
    clearInterval(clipTimer)
    clipTimer = setInterval(constrainClip, 80)
    void playClip()
  }
}

function releasePlayer() {
  detection.suspend()
  clearInterval(clipTimer)
  clipFinished = false
  playBlocked.value = false
  generation++
  request?.abort()
  request = null
  hls?.destroy()
  hls = null
  if (cam.value) {
    cam.value.pause()
    cam.value.removeAttribute('src')
    cam.value.load()
  }
}

function showError(message: string) {
  releasePlayer()
  loading.value = false
  error.value = message
}

async function verifyMediaSession() {
  if (checkingAuthentication || disposed) return
  const current = generation
  checkingAuthentication = true
  try {
    await apiRequest('/api/auth/me', {}, false)
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401 && current === generation && !disposed) {
      handleUnauthorized()
    }
  } finally {
    checkingAuthentication = false
  }
}

async function startPlayer() {
  releasePlayer()
  if (!cam.value || disposed) return
  const current = generation
  const video = cam.value
  const currentRequest = new AbortController()
  request = currentRequest
  loading.value = true
  error.value = ''

  try {
    const source = sameOriginUrl(props.videoUrl)
    // Native media errors hide HTTP status, so verify access before attaching a source.
    const response = await fetch(source, {
      method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: currentRequest.signal,
    })
    if (current !== generation || disposed) return
    if (response.status === 401) {
      handleUnauthorized()
      return
    }
    if (!response.ok) {
      showError(response.status === 404
        ? (props.kind === 'live' ? '目前沒有即時串流，請確認攝影機連線後重試。' : '錄影檔案已不存在，請重新整理列表。')
        : response.status === 409 ? '此錄影尚未完成，請稍後再試。' : '無法載入影像，請稍後重試。')
      return
    }

    if (props.kind === 'recording' || video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source
      video.load()
      return
    }

    const { default: HlsPlayer } = await import('hls.js')
    if (current !== generation || disposed) return
    if (!HlsPlayer.isSupported()) {
      showError('此瀏覽器不支援即時影像播放，請使用支援 HLS 的瀏覽器。')
      return
    }
    hls = new HlsPlayer({
      xhrSetup: (xhr, url) => {
        sameOriginUrl(url)
        xhr.withCredentials = true
      },
      fetchSetup: (context, initParams) => new Request(
        new URL(sameOriginUrl(context.url), window.location.origin),
        { ...initParams, credentials: 'same-origin' },
      ),
    })
    hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
      if (current !== generation || disposed) return
      if (data.response?.code === 401) {
        handleUnauthorized()
        return
      }
      if (data.fatal) {
        showError('串流連線中斷或無法播放，請重試。')
        void verifyMediaSession()
      }
    })
    hls.loadSource(source)
    hls.attachMedia(video)
  } catch {
    if (current !== generation || disposed) return
    showError('無法連線至影像服務，請確認網路後重試。')
  }
}

function handleMediaError() {
  if (disposed || !cam.value?.getAttribute('src') || error.value) return
  showError('影像無法播放或連線已中斷，請重試。')
  void verifyMediaSession()
}

// A history-row click is a user gesture; native controls remain available if autoplay is blocked.
defineExpose({ play: () => cam.value?.play().catch(() => {}) })

watch(() => props.videoUrl, () => void startPlayer())
onMounted(() => void startPlayer())
onBeforeUnmount(() => {
  disposed = true
  releasePlayer()
})
</script>

<template>
  <div class="camera-view">
    <div v-if="!compact || kind === 'live'" class="camera-heading">
      <h3>{{ title }}</h3>
      <label v-if="kind === 'live'" class="detection-toggle">
        <input v-model="enabled" type="checkbox" role="switch" :aria-label="`${title} 人物偵測`" />
        人物偵測
      </label>
    </div>
    <video ref="cam" controls :autoplay="kind === 'live' || playOnLoad" :muted="kind === 'live'" playsinline
      preload="metadata" crossorigin="use-credentials" :aria-label="title"
      @loadedmetadata="handleMetadata" @timeupdate="constrainClip" @seeking="constrainClip" @ended="finishClip"
      @canplay="loading = false" @loadeddata="loading = false" @error="handleMediaError" />
    <button v-if="playBlocked" class="btn btn-primary mt-2" type="button" @click="playClip">播放事件片段</button>
    <div v-if="kind === 'live'" class="detection-panel" :class="{ 'detection-panel--present': present }">
      <p class="detection-state" role="status">
        <span class="detection-dot" :class="{ active: status === 'watching', detected: present }" aria-hidden="true" />
        <strong v-if="present">有人出現 · {{ count }} 人</strong>
        <span v-else>{{ statusText }}</span>
        <button v-if="status === 'error'" type="button" class="btn btn-sm btn-outline-secondary" @click="detection.retry">重試偵測</button>
      </p>
      <p v-if="latest" class="detection-last">最近事件 {{ new Date(latest.occurredAt).toLocaleTimeString('zh-TW', { hour12: false }) }} · 已加入下方事件清單</p>
      <p v-else class="detection-last">啟用後，人物出現時會記錄事件，方便回看片段。</p>
    </div>
    <p v-if="loading && !error" class="camera-status" role="status">正在載入影像…</p>
    <div v-if="error" class="camera-error" role="alert">
      <p>{{ error }}</p>
      <button type="button" class="btn btn-sm btn-outline-secondary" @click="startPlayer">重新載入影像</button>
    </div>
  </div>
</template>

<style scoped>
.camera-view h3 { margin-bottom: 0.75rem; font-size: 1.2rem; overflow-wrap: anywhere; }
.camera-heading { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
.camera-heading h3 { margin: 0; }
.detection-toggle { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; cursor: pointer; }
.detection-toggle input { width: 1.1rem; height: 1.1rem; accent-color: #087f82; }
.detection-panel { padding: 0.85rem; margin-top: 0.65rem; border: 1px solid #d8e2eb; border-radius: 10px; background: #fff; }
.detection-panel--present { border-color: #ce8620; background: #fff7e7; }
.detection-state { display: flex; align-items: center; flex-wrap: wrap; gap: 0.45rem; margin: 0; font-size: 0.88rem; }
.detection-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #8090a3; }
.detection-dot.active { background: #087f82; }
.detection-dot.detected { background: #b76c0b; }
.detection-last { margin: 0.4rem 0 0; color: #65748a; font-size: 0.8rem; }
.camera-view video { display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; background: #091727; }
.camera-status, .camera-error { padding: 0.75rem 0; color: #65748a; font-size: 0.9rem; }
.camera-error p { margin-bottom: 0.6rem; color: #9e3544; }
</style>
