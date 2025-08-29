<script setup lang="ts">
  import { ref, onMounted } from "vue";
  const cam1 = ref(null);
  const cam2 = ref(null);

onMounted(() => {
  // 如果瀏覽器不支援 HLS，這裡可以加 hls.js 播放
  if (cam1.value.canPlayType("application/vnd.apple.mpegurl")) {
    console.log("Native HLS supported");
  } else {
    import("hls.js").then((Hls) => {
      if (Hls.default.isSupported()) {
        const hls = new Hls.default();
        hls.loadSource("http://localhost:3000/hls/stream.m3u8");
        hls.attachMedia(cam1.value);
      }
    });
  }
  if (cam2.value.canPlayType("application/vnd.apple.mpegurl")) {
    console.log("Native HLS supported");
  } else {
    import("hls.js").then((Hls) => {
      if (Hls.default.isSupported()) {
        const hls = new Hls.default();
        hls.loadSource("http://localhost:3001/hls/stream.m3u8");
        hls.attachMedia(cam2.value);
      }
    });
  }
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
      <source src="http://localhost:3000/hls/3000/stream.m3u8" type="application/x-mpegURL" />
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
      <source src="http://localhost:3001/hls/3001/stream.m3u8" type="application/x-mpegURL" />
    </video>
  </div>
</template>

<style scoped>
</style>
