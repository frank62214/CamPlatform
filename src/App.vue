<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import CameraTabs from './components/CameraTabs.vue'
import LoginView from './components/LoginView.vue'
import SentinelLogo from './components/SentinelLogo.vue'
import { ApiError, apiRequest, setUnauthorizedHandler, type Session } from './api'

const session = ref<Session | null>(null)
const checkingSession = ref(true)
const notice = ref('')
const loggingOut = ref(false)
const logoutFailed = ref(false)
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let authRevision = 0
const controller = new AbortController()

function clearExpiryTimer() {
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = undefined
}

function expireSession() {
  authRevision++
  clearExpiryTimer()
  session.value = null
  notice.value = '登入已失效，請重新登入。'
}

function handleAuthenticated(value: Session) {
  authRevision++
  clearExpiryTimer()
  const expires = typeof value.expiresAt === 'number'
    ? value.expiresAt * (value.expiresAt < 1e12 ? 1000 : 1)
    : Date.parse(value.expiresAt)
  const remaining = expires - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) {
    expireSession()
    return
  }
  // Retain only session metadata. The JWT remains in the HttpOnly cookie.
  session.value = { user: value.user, expiresAt: value.expiresAt }
  notice.value = ''
  expiryTimer = setTimeout(() => {
    if (Date.now() >= expires) expireSession()
    else handleAuthenticated(value)
  }, Math.min(remaining, 2_147_483_647))
}

async function restoreSession() {
  const revision = authRevision
  try {
    const result = await apiRequest<Session>('/api/auth/me', { signal: controller.signal }, false)
    if (revision === authRevision && !loggingOut.value && !logoutFailed.value) handleAuthenticated(result)
  } catch (error) {
    if (revision !== authRevision) return
    if (error instanceof ApiError && error.status === 401) {
      if (session.value) expireSession()
    } else if (checkingSession.value && !controller.signal.aborted) {
      notice.value = '無法確認登入狀態，請確認連線後重新登入。'
    }
  } finally {
    checkingSession.value = false
  }
}

async function handleLogout() {
  if (loggingOut.value) return
  authRevision++
  clearExpiryTimer()
  session.value = null
  loggingOut.value = true
  logoutFailed.value = false
  notice.value = '正在登出…'
  try {
    await apiRequest<void>('/api/auth/logout', { method: 'POST' }, false)
    notice.value = '已登出監控中心。'
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      notice.value = '已登出監控中心。'
    } else {
      logoutFailed.value = true
      notice.value = '無法完成伺服器登出，請確認連線後重試。'
    }
  } finally {
    loggingOut.value = false
  }
}

function handleVisibility() {
  if (document.visibilityState === 'visible' && session.value) void restoreSession()
}

setUnauthorizedHandler(() => {
  if (session.value) expireSession()
})

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibility)
  void restoreSession()
})

onBeforeUnmount(() => {
  clearExpiryTimer()
  controller.abort()
  setUnauthorizedHandler()
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<template>
  <main v-if="checkingSession" class="session-loading" role="status">正在確認登入狀態…</main>
  <LoginView
    v-else-if="!session"
    :notice="notice"
    :disabled="loggingOut || logoutFailed"
    :logout-failed="logoutFailed"
    @authenticated="handleAuthenticated"
    @retry-logout="handleLogout"
  />

  <div v-else class="monitor-shell">
    <header class="monitor-header">
      <SentinelLogo compact />
      <div class="monitor-header__actions">
        <span>{{ session.user.username }} · 攝影機監控</span>
        <button type="button" @click="handleLogout">登出</button>
      </div>
    </header>
    <main class="monitor-main">
      <CameraTabs :account="session.user.username" />
    </main>
  </div>
</template>

<style scoped>
.session-loading {
  display: grid;
  min-height: 100vh;
  place-items: center;
  color: #e4edf5;
  background: #091727;
}

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
