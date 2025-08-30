<script setup lang="ts">
import CameraView from "./CameraView.vue";
import { ref,onMounted  } from "vue";
type TabType = "realtime" | "history";
const activeTab = ref<TabType>("realtime");


const cam1 = ref<HTMLVideoElement | null>(null);
const cam2 = ref<HTMLVideoElement | null>(null);

const cam1Ip = "https://su.hackdog.tw/cam1";
const cam2Ip = "https://su.hackdog.tw/cam2";

function setupHls(video: HTMLVideoElement | null, ip: string) {
  if (!video) return;
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    console.log("Native HLS supported");
  } else {
    import("hls.js").then((Hls) => {
      if (Hls.default.isSupported()) {
        const hls = new Hls.default();
        hls.loadSource(ip + "/hls/stream.m3u8");
        hls.attachMedia(video);
      }
    });
  }
}

onMounted(() => {
  setupHls(cam1.value, cam1Ip);
  setupHls(cam2.value, cam2Ip);
});


</script>

<template>
  <div class="container mt-4">
    <!-- Tabs -->
    <ul class="nav nav-tabs">
      <li class="nav-item">
        <button
          class="nav-link"
          :class="{ active: activeTab === 'realtime' }"
          @click="activeTab = 'realtime'"
        >
          即時影像
        </button>
      </li>
      <li class="nav-item">
        <button
          class="nav-link"
          :class="{ active: activeTab === 'history' }"
          @click="activeTab = 'history'"
        >
          歷史影像
        </button>
      </li>
    </ul>

    <!-- Tab Content -->
    <div class="tab-content mt-3">
      <!-- 即時影像 -->
      <div
        class="tab-pane fade"
        :class="{ show: activeTab === 'realtime', active: activeTab === 'realtime' }"
      >
        <div class="row">
          <div class="col-md-6">
            <CameraView title="即時影像1" videoUrl="https://su.hackdog.tw/cam1" />
          </div>
          <div class="col-md-6">
            <CameraView title="即時影像2" videoUrl="https://su.hackdog.tw/cam2" />
          </div>
        </div>
      </div>

      <!-- 歷史影像 -->
      <div
        class="tab-pane fade"
        :class="{ show: activeTab === 'history', active: activeTab === 'history' }"
      >
        <div class="row">
          <div class="col-md-6">
            
          </div>
          <div class="col-md-6">
            
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
