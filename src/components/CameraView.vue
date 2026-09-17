<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import type Hls from "hls.js";
interface Props {
    title: string;
    videoUrl: string;
}
const props = defineProps<Props>();
const cam = ref<HTMLVideoElement | null>(null);
let hls: Hls | undefined;
let disposed = false;

function setupHls(video: HTMLVideoElement | null, ip: string) {
    if (!video) return;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
        console.log("Native HLS supported");
    } else {
        import("hls.js").then((Hls) => {
            if (!disposed && Hls.default.isSupported()) {
                hls = new Hls.default();
                hls.loadSource(ip + "/hls/stream.m3u8");
                hls.attachMedia(video);
            }
        });
    }
}

onMounted(() => {
    setupHls(cam.value, props.videoUrl);
});

onBeforeUnmount(() => {
    disposed = true;
    hls?.destroy();
    if (cam.value) {
        cam.value.pause();
        cam.value.removeAttribute('src');
        cam.value.querySelector('source')?.removeAttribute('src');
        cam.value.load();
    }
});
</script>

<template>
    <h3>{{ props.title }}</h3>
    <!-- <div class="flex justify-center items-center h-screen bg-gray-900"> -->
    <video
      ref="cam"
      controls
      autoplay
      muted
      width="100%"
      style="border-radius: 10px"
    > <source :src="props.videoUrl + '/hls/stream.m3u8'" type="application/x-mpegURL" />
    </video>
    <!-- </div> -->
</template>

<style scoped></style>
