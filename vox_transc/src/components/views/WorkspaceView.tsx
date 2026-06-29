import React from 'react';
import { Mic, Video, Copy, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { HistorySession } from '../../types';

interface Props {
  history: HistorySession[];
  onSelectSession: (session: HistorySession) => void;
  onDeleteSession: (id: string) => void;
}

export const WorkspaceView = ({ history, onSelectSession, onDeleteSession }: Props) => {
  const recordings = history.filter(s => s.mode === 'local');
  const meetings = history.filter(s => s.mode === 'meeting');

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text);

  const SessionCard = ({ session }: { session: HistorySession }) => (
    <div className="glass-panel p-6 text-left hover:border-hw-accent/50 transition-all group flex flex-col gap-4 relative">
      <div className="flex items-center justify-between w-full">
        <div className={cn(
          'w-10 h-10 rounded-xl flex items-center justify-center',
          session.mode === 'local' ? 'bg-hw-accent/10 text-hw-accent' : 'bg-blue-500/10 text-blue-500'
        )}>
          {session.mode === 'local' ? <Mic className="w-5 h-5" /> : <Video className="w-5 h-5" />}
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[10px] text-hw-muted font-mono">
            {session.timestamp.toDate().toLocaleDateString()}
          </div>
          <div className="text-[10px] text-hw-muted font-mono">
            {session.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>

      <div onClick={() => onSelectSession(session)} className="cursor-pointer space-y-1">
        <div className="text-sm font-bold text-white uppercase tracking-tight">
          {session.mode === 'local' ? 'Instantâneo' : 'Reunião'}
        </div>
        {session.externalId && (
          <span className="text-[9px] font-mono text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded uppercase">
            Candidato: {session.externalId}
          </span>
        )}
        <div className="text-[10px] font-mono text-hw-muted uppercase tracking-widest">
          Duração: {Math.floor((session.duration || 0) / 60)}m {(session.duration || 0) % 60}s
        </div>
      </div>

      <div className="text-[10px] text-hw-muted line-clamp-2 group-hover:text-hw-text transition-colors border-t border-white/5 pt-3 mt-auto">
        {session.summary || 'Sem resumo disponível'}
      </div>

      <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); copyToClipboard(session.id); }}
          className="p-1.5 rounded-lg bg-white/5 hover:bg-hw-accent/20 text-hw-muted hover:text-hw-accent border border-white/10"
          title="Copiar ID"
        >
          <Copy className="w-3 h-3" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
          className="p-1.5 rounded-lg bg-white/5 hover:bg-red-500/20 text-hw-muted hover:text-red-500 border border-white/10"
          title="Deletar Sessão"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );

  const EmptyState = ({ label }: { label: string }) => (
    <div className="col-span-full glass-panel p-12 text-center text-hw-muted/30 font-mono text-[10px] uppercase tracking-widest">
      {label}
    </div>
  );

  return (
    <div className="p-8 space-y-12 max-w-6xl mx-auto w-full">
      <header className="space-y-2">
        <h2 className="text-3xl font-bold text-white tracking-tight uppercase">
          Workspace <span className="text-hw-accent">Pessoal</span>
        </h2>
        <p className="text-hw-muted font-mono text-xs uppercase tracking-widest">
          Gerencie suas gravações, histórico e relatórios
        </p>
      </header>

      <div className="space-y-4">
        <h3 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest flex items-center gap-2">
          <Mic className="w-3 h-3" /> Gravações
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {recordings.length === 0
            ? <EmptyState label="Nenhuma gravação encontrada" />
            : recordings.map(s => <SessionCard key={s.id} session={s} />)
          }
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest flex items-center gap-2">
          <Video className="w-3 h-3" /> Videoconferências
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {meetings.length === 0
            ? <EmptyState label="Nenhuma videoconferência encontrada" />
            : meetings.map(s => <SessionCard key={s.id} session={s} />)
          }
        </div>
      </div>
    </div>
  );
};
