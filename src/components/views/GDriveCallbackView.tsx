/**
 * GDriveCallbackView.tsx
 *
 * Tiny page rendered at /oauth/gdrive.
 * Google redirects here after the professor approves the OAuth consent screen.
 * This page extracts the authorization code and posts it back to the opener
 * window (which is waiting inside authorizeViaPopup()), then closes itself.
 *
 * The page lives at the same origin as the app, so postMessage is safe and
 * the code never traverses the network a second time.
 */

import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

export default function GDriveCallbackView() {
  const [state, setState] = useState<'processing' | 'done' | 'error'>('processing');
  const [message, setMessage] = useState('Autorizando Google Drive…');

  useEffect(() => {
    const params  = new URLSearchParams(window.location.search);
    const code    = params.get('code');
    const errParam = params.get('error');

    if (errParam) {
      setMessage(`Autorização negada: ${errParam}`);
      setState('error');
      window.opener?.postMessage(
        { type: 'gdrive_auth_code', error: errParam },
        window.location.origin,
      );
      setTimeout(() => window.close(), 2500);
      return;
    }

    if (!code) {
      setMessage('Código de autorização não encontrado.');
      setState('error');
      window.opener?.postMessage(
        { type: 'gdrive_auth_code', error: 'no_code' },
        window.location.origin,
      );
      setTimeout(() => window.close(), 2500);
      return;
    }

    // Deliver code to the waiting authorizeViaPopup() call
    window.opener?.postMessage(
      { type: 'gdrive_auth_code', code },
      window.location.origin,
    );

    setMessage('Google Drive conectado com sucesso!');
    setState('done');
    setTimeout(() => window.close(), 1500);
  }, []);

  return (
    <div className="min-h-screen bg-iv-bg flex items-center justify-center p-4">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        {state === 'processing' && (
          <>
            <Loader2 size={36} className="animate-spin text-iv-accent" />
            <p className="text-white/70 text-sm">{message}</p>
          </>
        )}
        {state === 'done' && (
          <>
            <CheckCircle2 size={36} className="text-emerald-400" />
            <p className="text-white text-sm font-medium">{message}</p>
            <p className="text-white/40 text-xs">Esta janela fechará automaticamente.</p>
          </>
        )}
        {state === 'error' && (
          <>
            <AlertCircle size={36} className="text-red-400" />
            <p className="text-white/80 text-sm">{message}</p>
            <p className="text-white/40 text-xs">Esta janela fechará automaticamente.</p>
          </>
        )}
      </div>
    </div>
  );
}
