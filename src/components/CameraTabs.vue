<script setup lang="ts">
import { ref } from 'vue'
import CameraView from './CameraView.vue'
import CameraHistory from './CameraHistory.vue'

const activeTab = ref<'realtime' | 'history'>('realtime')
const cameras = [{ id: 'cam1', title: '客廳' }, { id: 'cam2', title: '大門' }]
</script>

<template>
  <div class="container mt-4">
    <nav class="nav nav-tabs" aria-label="影像模式">
      <button class="nav-link" :class="{ active: activeTab === 'realtime' }"
        :aria-pressed="activeTab === 'realtime'" @click="activeTab = 'realtime'">即時影像</button>
      <button class="nav-link" :class="{ active: activeTab === 'history' }"
        :aria-pressed="activeTab === 'history'" @click="activeTab = 'history'">歷史影像</button>
    </nav>

    <div v-if="activeTab === 'realtime'" class="row g-4 mt-1">
      <div v-for="camera in cameras" :key="camera.id" class="col-lg-6">
        <CameraView :title="camera.title" :video-url="`/${camera.id}`" />
      </div>
    </div>
    <section v-else class="history-section" aria-labelledby="history-heading">
      <div class="history-heading">
        <h1 id="history-heading">歷史錄影</h1>
        <p>選擇日期與時段，回看攝影機畫面。時段依錄影檔名顯示（台北時間 UTC+8）。</p>
      </div>
      <div class="row g-4">
        <div v-for="camera in cameras" :key="camera.id" class="col-lg-6">
          <CameraHistory :camera="camera.id" :title="camera.title" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.history-section { padding-top: 1.75rem; }
.history-heading { margin-bottom: 1.5rem; }
.history-heading h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; }
.history-heading p { color: #5c6c80; font-size: 0.9rem; margin: 0; line-height: 1.7; }
.nav-link { color: #52677b; }
.nav-link.active { color: #086b73; font-weight: 600; }
</style>
