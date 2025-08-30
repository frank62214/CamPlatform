<script setup lang="ts">
import CameraTabs from "./components/CameraTabs.vue";
</script>

<template>
   <div>
    <h1 class="m-3">攝影機監控</h1>
    <CameraTabs />
  </div>
</template>

<style scoped>
button {
  transition: all 0.2s;
}
button:hover {
  color: #2563eb; /* hover 藍色 */
}
</style>