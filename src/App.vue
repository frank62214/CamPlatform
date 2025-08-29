<script setup lang="ts">
import { ref, onMounted } from "vue";

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
  <div class="flex justify-center items-center h-screen bg-gray-900">
    <video
      ref="cam1"
      controls
      autoplay
      muted
      width="640"
      style="border-radius: 10px"
    >
      <source :src="cam1Ip + '/hls/stream.m3u8'" type="application/x-mpegURL" />
    </video>
  </div>
    <div class="flex justify-center items-center h-screen bg-gray-900">
    <video
      ref="cam2"
      controls
      autoplay
      muted
      width="640"
      style="border-radius: 10px"
    >
      <source :src="cam2Ip + '/hls/stream.m3u8'" type="application/x-mpegURL" />
    </video>
  </div>
</template>

<style scoped>
</style>
