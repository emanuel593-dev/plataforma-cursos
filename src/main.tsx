import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';

// Global React Query client — stale time of 2 minutes avoids redundant refetches
// while still keeping data reasonably fresh on long sessions.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000, // 2 min
      retry: 1,
    },
  },
});

// ── PWA Update Toast ─────────────────────────────────────────────────────────
//
// Replaces the native browser `confirm()` dialog (blocking, unstyled) with a
// non-intrusive toast banner. The user can dismiss it and update at their
// convenience — important for professors who are mid-class and cannot afford
// a page reload at an arbitrary moment.

function showUpdateToast(updateFn: () => void) {
  const container = document.createElement('div');
  container.id = 'pwa-update-toast';
  Object.assign(container.style, {
    position: 'fixed',
    bottom: '80px', // above the mobile bottom nav
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '9999',
    maxWidth: '380px',
    width: 'calc(100% - 32px)',
  });
  document.body.appendChild(container);

  container.innerHTML = `
    <div style="
      background: #1e293b;
      border: 1px solid rgba(99,102,241,0.4);
      border-radius: 14px;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      font-family: inherit;
      animation: slideUp 0.3s ease;
    ">
      <span style="font-size:20px">🔄</span>
      <div style="flex:1">
        <p style="margin:0;font-size:13px;font-weight:600;color:#f1f5f9">Nova versão disponível</p>
        <p style="margin:2px 0 0;font-size:11px;color:#94a3b8">Atualize quando terminar sua atividade atual.</p>
      </div>
      <button id="pwa-update-btn" style="
        background:#6366f1;
        color:#fff;
        border:none;
        border-radius:8px;
        padding:6px 12px;
        font-size:12px;
        font-weight:600;
        cursor:pointer;
        white-space:nowrap;
      ">Atualizar</button>
      <button id="pwa-dismiss-btn" style="
        background:transparent;
        color:#64748b;
        border:none;
        font-size:18px;
        cursor:pointer;
        padding:0 4px;
        line-height:1;
      ">×</button>
    </div>
    <style>
      @keyframes slideUp {
        from { opacity:0; transform: translateY(16px); }
        to   { opacity:1; transform: translateY(0); }
      }
    </style>
  `;

  document.getElementById('pwa-update-btn')?.addEventListener('click', () => {
    container.remove();
    updateFn();
  });
  document.getElementById('pwa-dismiss-btn')?.addEventListener('click', () => {
    container.remove();
  });
}

// Register service worker with graceful update notification
const updateSW = registerSW({
  onNeedRefresh() {
    showUpdateToast(() => updateSW(true));
  },
  onOfflineReady() {
    console.log('[IV] App pronta para uso offline.');
  },
});

// Listen for navigation requests from the service worker (notification clicks
// on browsers where WindowClient.navigate isn't available).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'iv:navigate' && typeof data.url === 'string') {
      try {
        const url = new URL(data.url, window.location.origin);
        if (url.origin === window.location.origin) {
          window.history.pushState({}, '', url.pathname + url.search + url.hash);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
      } catch { /* malformed URL */ }
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
