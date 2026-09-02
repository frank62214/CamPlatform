<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'

import SentinelLogo from './SentinelLogo.vue'

const emit = defineEmits<{
  authenticated: []
}>()

const VALID_USERNAME = 'admin'
const VALID_PASSWORD = '!Taico12345'

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const errorMessage = ref('')
const usernameInput = ref<HTMLInputElement | null>(null)

onMounted(() => {
  usernameInput.value?.focus()
})

function clearError() {
  if (errorMessage.value) {
    errorMessage.value = ''
  }
}

async function handleSubmit() {
  if (username.value === VALID_USERNAME && password.value === VALID_PASSWORD) {
    password.value = ''
    errorMessage.value = ''
    emit('authenticated')
    return
  }

  errorMessage.value = '帳號或密碼不正確，請再試一次。'
  password.value = ''
  await nextTick()
  usernameInput.value?.focus()
}
</script>

<template>
  <main class="login-shell">
    <section class="login-visual" aria-hidden="true">
      <div class="login-visual__scanline"></div>
    </section>

    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-panel__grid" aria-hidden="true"></div>

      <div class="login-content">
        <SentinelLogo />

        <div class="login-heading">
          <h1 id="login-title">安全監控中心</h1>
          <p>登入以檢視即時串流與錄影</p>
        </div>

        <form class="login-form" novalidate @submit.prevent="handleSubmit">
          <div class="field-group">
            <label for="username">帳號</label>
            <input
              id="username"
              ref="usernameInput"
              v-model="username"
              name="username"
              type="text"
              autocomplete="username"
              placeholder="輸入帳號"
              required
              autofocus
              :aria-invalid="Boolean(errorMessage)"
              :aria-describedby="errorMessage ? 'login-error' : undefined"
              @input="clearError"
            />
          </div>

          <div class="field-group">
            <label for="password">密碼</label>
            <div class="password-field">
              <input
                id="password"
                v-model="password"
                name="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="輸入密碼"
                required
                :aria-invalid="Boolean(errorMessage)"
                :aria-describedby="errorMessage ? 'login-error' : undefined"
                @input="clearError"
              />
              <button
                class="password-toggle"
                type="button"
                :aria-label="showPassword ? '隱藏密碼' : '顯示密碼'"
                :aria-pressed="showPassword"
                @click="showPassword = !showPassword"
              >
                <svg v-if="!showPassword" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                  <circle cx="12" cy="12" r="2.75" />
                </svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m3 3 18 18M10.6 6.1A9.3 9.3 0 0 1 12 6c6 0 9.5 6 9.5 6a15.5 15.5 0 0 1-2.2 2.9M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6c1.2 0 2.3-.2 3.3-.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                </svg>
              </button>
            </div>
          </div>

          <p id="login-error" class="login-error" role="alert" aria-live="polite">
            {{ errorMessage }}
          </p>

          <button class="login-submit" type="submit">進入監控中心</button>
        </form>

        <div class="login-capabilities">
          <span aria-hidden="true"></span>
          <p>兩路攝影機 · 即時串流 · 錄影回放</p>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.login-shell {
  --sentinel-bg: #071321;
  --sentinel-panel: #0a1728;
  --sentinel-text: #f6f9fc;
  --sentinel-muted: #8b99aa;
  --sentinel-border: #536276;
  --sentinel-accent: #31d5d8;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  grid-template-columns: minmax(27rem, 52%) minmax(30rem, 48%);
  overflow: hidden;
  background: var(--sentinel-bg);
  color: var(--sentinel-text);
}

.login-visual {
  position: relative;
  z-index: 1;
  min-height: 100%;
  background-image:
    linear-gradient(90deg, rgba(2, 9, 16, 0.24), rgba(5, 17, 29, 0.04) 62%, rgba(5, 17, 29, 0.7)),
    url('../assets/sentinel-command-center.png');
  background-position: center 49%;
  background-size: cover;
  clip-path: polygon(0 0, 91% 0, 100% 50%, 91% 100%, 0 100%);
}

.login-visual::after {
  position: absolute;
  inset: 0;
  content: '';
  background: linear-gradient(180deg, rgba(3, 11, 19, 0.12), transparent 45%, rgba(3, 11, 19, 0.22));
  pointer-events: none;
}

.login-visual__scanline {
  position: absolute;
  z-index: 2;
  top: 0;
  right: 4.3%;
  width: 1px;
  height: 100%;
  overflow: hidden;
  background: rgba(49, 213, 216, 0.5);
  transform: skewX(-5deg);
  transform-origin: center;
  box-shadow: 0 0 18px rgba(49, 213, 216, 0.28);
}

.login-visual__scanline::after {
  position: absolute;
  top: -12%;
  left: -1px;
  width: 3px;
  height: 12%;
  content: '';
  background: linear-gradient(transparent, #8ff9f7, transparent);
  animation: scan 5.6s ease-in-out infinite;
}

.login-panel {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: clamp(3rem, 4.25vw, 7rem);
  background:
    radial-gradient(circle at 8% 50%, rgba(23, 95, 111, 0.11), transparent 40%),
    var(--sentinel-panel);
}

.login-panel__grid {
  position: absolute;
  inset: 0;
  opacity: 0.05;
  background-image:
    linear-gradient(rgba(124, 205, 211, 0.35) 1px, transparent 1px),
    linear-gradient(90deg, rgba(124, 205, 211, 0.35) 1px, transparent 1px);
  background-size: 72px 72px;
  mask-image: linear-gradient(90deg, black, transparent 82%);
  pointer-events: none;
}

.login-content {
  position: relative;
  z-index: 1;
  width: min(100%, 35rem);
}

.login-heading {
  margin-top: clamp(3.2rem, 5.5vh, 4.25rem);
}

.login-heading h1 {
  margin: 0;
  font-size: clamp(2.35rem, 3.6vw, 3.75rem);
  font-weight: 400;
  letter-spacing: 0.03em;
  line-height: 1.12;
}

.login-heading p {
  margin: 1.25rem 0 0;
  color: var(--sentinel-muted);
  font-size: clamp(1rem, 1.3vw, 1.25rem);
  letter-spacing: 0.04em;
}

.login-form {
  margin-top: clamp(2.5rem, 4.4vh, 3.4rem);
}

.field-group + .field-group {
  margin-top: 1.75rem;
}

.field-group label {
  display: block;
  margin-bottom: 0.75rem;
  color: #e8eef5;
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.08em;
}

.field-group input {
  width: 100%;
  height: 4.5rem;
  padding: 0 1.25rem;
  border: 1px solid var(--sentinel-border);
  border-radius: 0.55rem;
  outline: none;
  background: rgba(5, 15, 27, 0.42);
  color: var(--sentinel-text);
  font: inherit;
  font-size: 1.04rem;
  letter-spacing: 0.02em;
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease,
    background-color 180ms ease;
}

.field-group input::placeholder {
  color: #778598;
  opacity: 1;
}

.field-group input:hover {
  border-color: #728298;
}

.field-group input:focus {
  border-color: var(--sentinel-accent);
  background: rgba(7, 22, 37, 0.75);
  box-shadow: 0 0 0 3px rgba(49, 213, 216, 0.12);
}

.field-group input[aria-invalid='true'] {
  border-color: #f08292;
}

.password-field {
  position: relative;
}

.password-field input {
  padding-right: 4.25rem;
}

.password-toggle {
  position: absolute;
  top: 50%;
  right: 0.8rem;
  display: grid;
  width: 2.75rem;
  height: 2.75rem;
  padding: 0;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: #aab6c5;
  place-items: center;
  transform: translateY(-50%);
  transition:
    color 180ms ease,
    background-color 180ms ease;
}

.password-toggle:hover,
.password-toggle:focus-visible {
  outline: none;
  background: rgba(49, 213, 216, 0.08);
  color: var(--sentinel-accent);
}

.password-toggle svg {
  width: 1.65rem;
  height: 1.65rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.65;
}

.login-error {
  min-height: 1.45rem;
  margin: 0.75rem 0 0;
  color: #ff9aaa;
  font-size: 0.9rem;
  letter-spacing: 0.02em;
}

.login-submit {
  width: 100%;
  height: 4.6rem;
  margin-top: 1.45rem;
  border: 1px solid #67e6e4;
  border-radius: 0.55rem;
  background: #31cbd0;
  box-shadow: 0 12px 36px rgba(19, 161, 170, 0.18);
  color: #03141b;
  font: inherit;
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  transition:
    transform 180ms ease,
    background-color 180ms ease,
    box-shadow 180ms ease;
}

.login-submit:hover {
  background: #57dcde;
  box-shadow: 0 16px 42px rgba(19, 161, 170, 0.24);
  transform: translateY(-1px);
}

.login-submit:focus-visible {
  outline: 3px solid rgba(143, 249, 247, 0.5);
  outline-offset: 3px;
}

.login-submit:active {
  transform: translateY(1px);
}

.login-capabilities {
  margin-top: clamp(3.5rem, 7vh, 5.25rem);
  color: #8491a2;
  text-align: center;
}

.login-capabilities span {
  position: relative;
  display: block;
  height: 1px;
  margin-bottom: 1.25rem;
  background: linear-gradient(90deg, #45556a 0 46%, transparent 46% 54%, #45556a 54% 100%);
}

.login-capabilities span::before,
.login-capabilities span::after {
  position: absolute;
  top: 50%;
  left: 50%;
  content: '';
  border: 1px solid rgba(49, 213, 216, 0.5);
  transform: translate(-50%, -50%);
}

.login-capabilities span::before {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
}

.login-capabilities span::after {
  width: 1.5rem;
  height: 1px;
  border-width: 1px 0 0;
}

.login-capabilities p {
  margin: 0;
  font-size: 0.95rem;
  letter-spacing: 0.08em;
}

@keyframes scan {
  0%,
  20% {
    transform: translateY(0);
  }

  80%,
  100% {
    transform: translateY(930%);
  }
}

@media (max-width: 1080px) {
  .login-shell {
    grid-template-columns: 45% 55%;
  }

  .login-panel {
    padding: 3.5rem;
  }
}

@media (min-width: 821px) and (max-height: 820px) {
  .login-panel {
    padding-top: 2.25rem;
    padding-bottom: 2.25rem;
  }

  .login-heading {
    margin-top: 2.35rem;
  }

  .login-heading h1 {
    font-size: clamp(2.15rem, 3.2vw, 3rem);
  }

  .login-heading p {
    margin-top: 0.75rem;
    font-size: 1rem;
  }

  .login-form {
    margin-top: 2rem;
  }

  .field-group + .field-group {
    margin-top: 1.2rem;
  }

  .field-group label {
    margin-bottom: 0.5rem;
  }

  .field-group input {
    height: 3.75rem;
  }

  .login-error {
    margin-top: 0.45rem;
  }

  .login-submit {
    height: 3.8rem;
    margin-top: 0.75rem;
  }

  .login-capabilities {
    margin-top: 2.25rem;
  }

  .login-capabilities span {
    margin-bottom: 0.8rem;
  }
}

@media (max-width: 820px) {
  .login-shell {
    position: relative;
    display: block;
  }

  .login-visual {
    position: absolute;
    inset: 0;
    min-height: 100%;
    opacity: 0.25;
    background-position: center;
    clip-path: none;
  }

  .login-visual__scanline {
    display: none;
  }

  .login-panel {
    z-index: 2;
    min-height: 100vh;
    min-height: 100dvh;
    padding: 3rem 1.75rem;
    background: linear-gradient(180deg, rgba(5, 16, 28, 0.66), rgba(7, 19, 33, 0.96) 36%);
  }

  .login-content {
    width: min(100%, 34rem);
  }
}

@media (max-width: 480px) {
  .login-panel {
    align-items: flex-start;
    padding: 2.25rem 1.25rem 2rem;
  }

  .login-heading {
    margin-top: 2.8rem;
  }

  .login-heading h1 {
    font-size: 2.18rem;
  }

  .login-heading p {
    margin-top: 0.8rem;
    font-size: 0.98rem;
  }

  .login-form {
    margin-top: 2.3rem;
  }

  .field-group + .field-group {
    margin-top: 1.35rem;
  }

  .field-group input,
  .login-submit {
    height: 3.8rem;
  }

  .login-error {
    font-size: 0.84rem;
  }

  .login-submit {
    margin-top: 0.9rem;
    font-size: 1.02rem;
  }

  .login-capabilities {
    margin-top: 2.4rem;
  }

  .login-capabilities p {
    font-size: 0.78rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-visual__scanline::after {
    animation: none;
  }

  .login-submit,
  .field-group input,
  .password-toggle {
    transition: none;
  }
}
</style>
