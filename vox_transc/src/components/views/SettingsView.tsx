import React from 'react';
import { Info, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { SummaryTone, RecordingMode } from '../../types';

interface Settings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  fluidAnimations: boolean;
  showTooltips: boolean;
}

interface SetSettings {
  setEchoCancellation: (v: boolean) => void;
  setNoiseSuppression: (v: boolean) => void;
  setFluidAnimations: (v: boolean) => void;
  setShowTooltips: (v: boolean) => void;
}

interface Props {
  settings: Settings;
  setSettings: SetSettings;
  summaryTone: SummaryTone;
  setSummaryTone: (tone: SummaryTone) => void;
  recordingMode: RecordingMode;
  setRecordingMode: (mode: RecordingMode) => void;
}

const Toggle = ({ value, onChange, label, hint }: { value: boolean; onChange: (v: boolean) => void; label: string; hint: string }) => (
  <button
    onClick={() => onChange(!value)}
    className="w-full flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/5 hover:border-white/10 transition-all"
  >
    <div className="text-left">
      <span className="text-xs text-white block">{label}</span>
      <span className="text-[9px] text-hw-muted font-mono">{hint}</span>
    </div>
    <div className={cn('w-10 h-5 rounded-full relative transition-colors shrink-0', value ? 'bg-hw-accent' : 'bg-white/10')}>
      <div className={cn('absolute top-1 w-3 h-3 bg-hw-bg rounded-full transition-all', value ? 'right-1' : 'left-1')} />
    </div>
  </button>
);

export const SettingsView = ({ settings, setSettings, summaryTone, setSummaryTone, recordingMode, setRecordingMode }: Props) => (
  <div className="p-8 space-y-8 max-w-4xl mx-auto w-full">
    <header className="space-y-2">
      <h2 className="text-3xl font-bold text-white tracking-tight uppercase">
        Configurações <span className="text-hw-accent">Sistema</span>
      </h2>
      <p className="text-hw-muted font-mono text-xs uppercase tracking-widest">Ajustes de áudio, interface e preferências</p>
    </header>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
      <div className="space-y-6">
        <section className="space-y-4">
          <h3 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest">Processamento de Áudio</h3>
          <div className="space-y-3">
            <Toggle value={settings.echoCancellation} onChange={setSettings.setEchoCancellation} label="Cancelamento de Eco" hint="Reduz o eco do alto-falante" />
            <Toggle value={settings.noiseSuppression} onChange={setSettings.setNoiseSuppression} label="Supressão de Ruído" hint="Filtra ruídos de fundo" />
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest">Interface & UX</h3>
          <div className="space-y-3">
            <Toggle value={settings.fluidAnimations} onChange={setSettings.setFluidAnimations} label="Animações Fluídas" hint="Transições suaves na interface" />
            <Toggle value={settings.showTooltips} onChange={setSettings.setShowTooltips} label="Dicas de Ferramenta" hint="Mostrar balões de ajuda" />
          </div>
        </section>
      </div>

      <div className="space-y-6">
        <section className="space-y-4">
          <h3 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest">Preferências de Gravação</h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-[9px] font-mono uppercase text-hw-muted">Tom do Resumo Padrão</label>
              <div className="grid grid-cols-2 gap-2">
                {(['executive', 'technical', 'educational', 'full', 'interview'] as SummaryTone[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSummaryTone(t)}
                    className={cn(
                      'w-full py-2 px-3 rounded-xl border text-[9px] font-mono uppercase transition-all text-left flex items-center justify-between',
                      summaryTone === t
                        ? 'border-hw-accent bg-hw-accent/10 text-hw-accent'
                        : 'border-white/5 bg-white/5 text-hw-muted hover:border-white/20'
                    )}
                  >
                    {t === 'executive' ? 'Executivo' : t === 'technical' ? 'Técnico' : t === 'educational' ? 'Educação' : t === 'full' ? 'Completo' : 'Entrevista'}
                    {summaryTone === t && <CheckCircle2 className="w-3 h-3" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[9px] font-mono uppercase text-hw-muted">Modo de Gravação Padrão</label>
              <div className="flex gap-2">
                {(['live', 'hybrid', 'recorder'] as RecordingMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setRecordingMode(m)}
                    className={cn(
                      'flex-1 py-2 rounded-xl border text-[9px] font-mono uppercase transition-all',
                      recordingMode === m
                        ? 'border-hw-accent bg-hw-accent/10 text-hw-accent'
                        : 'border-white/5 bg-white/5 text-hw-muted hover:border-white/20'
                    )}
                  >
                    {m === 'live' ? 'Live' : m === 'hybrid' ? 'Híbrido' : 'Rec'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="p-6 rounded-2xl bg-hw-accent/5 border border-hw-accent/20 space-y-3">
          <div className="flex items-center gap-2 text-hw-accent">
            <Info className="w-4 h-4" />
            <span className="text-[10px] font-bold uppercase">Sobre o Sistema</span>
          </div>
          <div className="space-y-1">
            {[
              { label: 'Versão', value: '2.5.0-PRO' },
              { label: 'Build', value: '2026.04.11' },
              { label: 'Engine', value: 'Gemini 2.5 Flash' },
              { label: 'Storage', value: 'Local (Supabase em breve)' },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between text-[9px] font-mono">
                <span className="text-hw-muted">{label}</span>
                <span className="text-white">{value}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  </div>
);
