import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'

// Error tracking, gated by VITE_SENTRY_DSN (baked in at build time). With no DSN
// the SDK never initializes, so this is a no-op by default. The DSN can point at
// Sentry's SaaS or a self-hosted GlitchTip instance. Disabled in Vite dev so
// local work doesn't spam Sentry.
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
if (dsn && import.meta.env.PROD) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
  })
}

// Installability + offline shell ("save to home screen"). Dev builds skip it
// so Vite's HMR never fights a stale cache.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ })
  })
}

// A tab left open across a deploy still asks for the old build's lazy chunks
// (by hash), which no longer exist — Safari reports that as "Importing a module
// script failed". Reload once to pick up the current build. The timestamp guard
// stops a reload loop if the chunk is genuinely broken rather than stale.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'presio:chunk-reload'
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0)
    if (Date.now() - last < 30_000) return
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

// Installed app (added to the home screen) only: opt into the full-bleed
// viewport so safe-area insets become available and the UI can span the
// screen edge to edge. Browser tabs keep the plain meta, so nothing shifts
// under the notch there. `navigator.standalone` covers older iOS Safari.
const nav = navigator as Navigator & { standalone?: boolean }
if (window.matchMedia('(display-mode: standalone)').matches || nav.standalone) {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center' }}>
          <p>Something went wrong. Please reload the page.</p>
        </div>
      }
    >
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
