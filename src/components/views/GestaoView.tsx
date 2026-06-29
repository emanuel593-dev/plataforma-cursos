import React, { useState, useEffect, useCallback } from 'react';
import { UserCheck, GraduationCap, HardDrive, CheckCircle2, Loader2, AlertCircle, Headphones } from 'lucide-react';
import PageLoader from '../ui/PageLoader';
import { authorizeViaPopup, exchangeSystemCode, isSystemDriveReady } from '../../services/recording.service';
import { supabase } from '../../lib/supabase';

const ProfessoresView = React.lazy(() => import('./ProfessoresView'));
const StudentsView = React.lazy(() => import('./StudentsView'));
const MonitoresView = React.lazy(() => import('./MonitoresView'));

type Tab = 'professores' | 'monitores' | 'alunos' | 'drive';

// ── Drive Settings Panel ──────────────────────────────────────────────────────
function DriveSettingsPanel() {
  const [ready,      setReady]      = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    isSystemDriveReady().then(setReady);
  }, []);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const redirectUri = `${window.location.origin}/oauth/gdrive`;
      const code = await authorizeViaPopup(redirectUri);

      // Get the current session JWT to prove coordinator identity
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token;
      if (!jwt) throw new Error('Sessão expirada. Faça login novamente.');

      await exchangeSystemCode(code, redirectUri, jwt);
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao conectar Google Drive.');
    } finally {
      setConnecting(false);
    }
  }, []);

  if (ready === null) {
    return (
      <div className="flex items-center gap-2 py-8 text-iv-muted">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Verificando status do Drive…</span>
      </div>
    );
  }

  return (
    <div className="glass-panel p-5 space-y-4 border border-white/8">
      <div className="flex items-center gap-3">
        <HardDrive size={20} className={ready ? 'text-emerald-400' : 'text-iv-muted'} />
        <div>
          <p className="text-sm font-semibold text-iv-text">Conta Google Drive Central</p>
          <p className="text-xs text-iv-muted">
            Todas as gravações de aulas são armazenadas nesta conta.
          </p>
        </div>
      </div>

      {ready ? (
        <div className="flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle2 size={16} />
          Conta conectada e pronta para receber gravações.
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-iv-muted">
            Nenhuma conta configurada. Clique abaixo para conectar a conta Google Drive
            que será usada como repositório central de todas as aulas gravadas.
          </p>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {connecting ? <Loader2 size={15} className="animate-spin" /> : <HardDrive size={15} />}
            {connecting ? 'Conectando…' : 'Conectar conta Google Drive'}
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-400">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {ready && (
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="text-xs text-iv-muted hover:text-iv-text underline"
        >
          {connecting ? 'Reconectando…' : 'Reconectar / trocar conta'}
        </button>
      )}
    </div>
  );
}

export default function GestaoView() {
  const [activeTab, setActiveTab] = useState<Tab>('professores');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 border-b border-white/8 overflow-x-auto scrollbar-hide -mx-4 px-4 sm:-mx-5 sm:px-5 md:-mx-6 md:px-6">
        <button
          onClick={() => setActiveTab('professores')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 text-sm font-medium transition-colors border-b-2 whitespace-nowrap touch-target ${
            activeTab === 'professores'
              ? 'text-iv-accent border-iv-accent bg-iv-accent/5'
              : 'text-iv-muted border-transparent hover:text-iv-text hover:bg-white/5'
          }`}
        >
          <UserCheck size={16} /> <span className="hidden sm:inline">Professores</span>
        </button>
        <button
          onClick={() => setActiveTab('monitores')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 text-sm font-medium transition-colors border-b-2 whitespace-nowrap touch-target ${
            activeTab === 'monitores'
              ? 'text-iv-accent border-iv-accent bg-iv-accent/5'
              : 'text-iv-muted border-transparent hover:text-iv-text hover:bg-white/5'
          }`}
        >
          <Headphones size={16} /> <span className="hidden sm:inline">Monitores</span>
        </button>
        <button
          onClick={() => setActiveTab('alunos')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 text-sm font-medium transition-colors border-b-2 whitespace-nowrap touch-target ${
            activeTab === 'alunos'
              ? 'text-iv-accent border-iv-accent bg-iv-accent/5'
              : 'text-iv-muted border-transparent hover:text-iv-text hover:bg-white/5'
          }`}
        >
          <GraduationCap size={16} /> <span className="hidden sm:inline">Alunos</span>
        </button>
        <button
          onClick={() => setActiveTab('drive')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 text-sm font-medium transition-colors border-b-2 whitespace-nowrap touch-target ${
            activeTab === 'drive'
              ? 'text-iv-accent border-iv-accent bg-iv-accent/5'
              : 'text-iv-muted border-transparent hover:text-iv-text hover:bg-white/5'
          }`}
        >
          <HardDrive size={16} /> <span className="hidden sm:inline">Google Drive</span>
        </button>
      </div>

      <React.Suspense fallback={<PageLoader variant="list" rows={3} />}>
        {activeTab === 'professores' && <ProfessoresView />}
        {activeTab === 'monitores' && <MonitoresView />}
        {activeTab === 'alunos' && <StudentsView />}
        {activeTab === 'drive' && <DriveSettingsPanel />}
      </React.Suspense>
    </div>
  );
}
