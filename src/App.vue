<script setup lang="ts">
import { ref } from 'vue'

import CameraTabs from './components/CameraTabs.vue'
import LoginView from './components/LoginView.vue'
import SentinelLogo from './components/SentinelLogo.vue'

const AUTH_SESSION_KEY = 'sentinel-authenticated'
const isAuthenticated = ref(sessionStorage.getItem(AUTH_SESSION_KEY) === 'true')

function handleAuthenticated() {
  sessionStorage.setItem(AUTH_SESSION_KEY, 'true')
  isAuthenticated.value = true
}

function handleLogout() {
  sessionStorage.removeItem(AUTH_SESSION_KEY)
  isAuthenticated.value = false
}
</script>

<template>
  <LoginView v-if="!isAuthenticated" @authenticated="handleAuthenticated" />

  <div v-else class="monitor-shell">
    <header class="monitor-header">
      <SentinelLogo compact />
      <div class="monitor-header__actions">
        <span>攝影機監控</span>
        <button type="button" @click="handleLogout">登出</button>
      </div>
    </header>
    <main class="monitor-main">
      <CameraTabs />
    </main>
  </div>
</template>

<style scoped>
.monitor-shell {
  min-height: 100vh;
  background: #f4f7fb;
  color: #15243a;
}

.monitor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 4.75rem;
  padding: 0.8rem clamp(1rem, 3vw, 2.75rem);
  border-bottom: 1px solid rgba(63, 208, 211, 0.2);
  background: #091727;
  box-shadow: 0 8px 30px rgba(14, 30, 49, 0.1);
}

.monitor-header__actions {
  display: flex;
  align-items: center;
  gap: 1.2rem;
  color: #c8d3df;
  font-size: 0.92rem;
  letter-spacing: 0.08em;
}

.monitor-header__actions button {
  min-height: 2.35rem;
  padding: 0 1rem;
  border: 1px solid #3c596e;
  border-radius: 0.4rem;
  background: transparent;
  color: #e4edf5;
  font: inherit;
  font-size: 0.84rem;
  transition:
    border-color 180ms ease,
    color 180ms ease,
    background-color 180ms ease;
}

.monitor-header__actions button:hover,
.monitor-header__actions button:focus-visible {
  border-color: #31d5d8;
  outline: none;
  background: rgba(49, 213, 216, 0.08);
  color: #73eeeb;
}

.monitor-main {
  padding: 0.25rem 0 0.75rem;
}

@media (min-width: 992px) and (min-height: 820px) {
  .monitor-shell {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }

  .monitor-header {
    flex-shrink: 0;
  }

  .monitor-main {
    display: flex;
    flex: 1;
    min-height: 0;
  }
}

@media (max-width: 520px) {
  .monitor-header__actions span {
    display: none;
  }
}
</style>
