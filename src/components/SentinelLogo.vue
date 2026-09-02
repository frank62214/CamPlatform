<script setup lang="ts">
withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  {
    compact: false,
  },
)
</script>

<template>
  <div class="sentinel-logo" :class="{ 'sentinel-logo--compact': compact }" aria-label="SENTINEL">
    <svg class="sentinel-logo__mark" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="28" />
      <path d="M32 4 48 17 58 38 42 60 16 54 4 31 17 11Z" />
      <path d="m17 11 15 21 16-15M4 31h28l10 29M58 38 32 32 16 54" />
    </svg>
    <span class="sentinel-logo__wordmark">SENTINEL</span>
  </div>
</template>

<style scoped>
.sentinel-logo {
  display: inline-flex;
  align-items: center;
  gap: 1.3rem;
  color: #f6f9fc;
}

.sentinel-logo__mark {
  width: 4.25rem;
  height: 4.25rem;
  fill: none;
  stroke: #31d5d8;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.25;
  filter: drop-shadow(0 0 14px rgba(49, 213, 216, 0.16));
}

.sentinel-logo__wordmark {
  font-family: "Arial Narrow", "Aptos Narrow", "Segoe UI", sans-serif;
  font-size: 1.45rem;
  font-weight: 400;
  letter-spacing: 0.56em;
  line-height: 1;
}

.sentinel-logo--compact {
  gap: 0.8rem;
}

.sentinel-logo--compact .sentinel-logo__mark {
  width: 2.35rem;
  height: 2.35rem;
}

.sentinel-logo--compact .sentinel-logo__wordmark {
  font-size: 0.86rem;
  letter-spacing: 0.42em;
}

@media (max-width: 480px) {
  .sentinel-logo {
    gap: 1rem;
  }

  .sentinel-logo__mark {
    width: 3.5rem;
    height: 3.5rem;
  }

  .sentinel-logo__wordmark {
    font-size: 1.16rem;
    letter-spacing: 0.43em;
  }
}

@media (min-width: 821px) and (max-height: 820px) {
  .sentinel-logo {
    gap: 1rem;
  }

  .sentinel-logo__mark {
    width: 3.35rem;
    height: 3.35rem;
  }

  .sentinel-logo__wordmark {
    font-size: 1.12rem;
    letter-spacing: 0.48em;
  }
}
</style>
