import React from 'react';
import { History, Clock, Zap, ShieldCheck, Mic, Monitor, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { HistorySession, UserProfile, Organization } from '../../types';

interface Props {
  history: HistorySession[];
  onNavigateToWorkspace: () => void;
  userProfile: UserProfile | null;
  organization: Organization | null;
}

export const DashboardView = ({ history, onNavigateToWorkspace, userProfile, organization }: Props) => {
  const totalSessions = history.length;
  const totalDuration = history.reduce((acc, s) => acc + (s.duration || 0), 0);
  const totalInsights = history.filter(s => s.summary).length;

  return (
    <div className="p-8 space-y-12 max-w-6xl mx-auto w-full">
      <header className="flex items-center justify-between">
        <div className="space-y-2">
          <h2 className="text-3xl font-bold text-white tracking-tight uppercase">
            Dashboard <span className="text-hw-accent">Home</span>
          </h2>
          <p className="text-hw-muted font-mono text-xs uppercase tracking-widest">Visão geral do sistema e estatísticas</p>
        </div>
        {organization && (
          <div className="text-right">
            <div className="text-[10px] font-mono text-hw-muted uppercase tracking-widest">Organização</div>
            <div className="text-sm font-bold text-hw-accent uppercase">{organization.name}</div>
          </div>
        )}
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Sessões Pessoais', value: totalSessions, icon: History, color: 'text-blue-500' },
          { label: 'Tempo Gravado', value: `${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`, icon: Clock, color: 'text-hw-accent' },
          { label: 'Insights Gerados', value: totalInsights, icon: Zap, color: 'text-yellow-500' },
          { label: 'Status do Sistema', value: 'Operacional', icon: ShieldCheck, color: 'text-emerald-500' },
        ].map((stat, i) => (
          <div key={i} className="glass-panel p-6 space-y-3 border-white/5 hover:border-white/20 transition-all group">
            <div className="flex items-center justify-between">
              <stat.icon className={cn('w-5 h-5', stat.color)} />
              <div className="w-1.5 h-1.5 rounded-full bg-hw-accent animate-pulse" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white font-mono">{stat.value}</div>
              <div className="text-[10px] font-mono text-hw-muted uppercase tracking-widest">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Recent Activity */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest flex items-center gap-2">
              <History className="w-3 h-3" /> Atividade Recente
            </h3>
            <button onClick={onNavigateToWorkspace} className="text-[9px] font-mono text-hw-accent uppercase hover:underline">
              Ver Tudo
            </button>
          </div>
          <div className="space-y-3">
            {history.length === 0 ? (
              <div className="glass-panel p-12 text-center text-hw-muted/30 font-mono text-[10px] uppercase tracking-widest">
                Nenhuma atividade registrada
              </div>
            ) : (
              history.slice(0, 5).map((session) => (
                <div key={session.id} className="glass-panel p-4 flex items-center justify-between hover:bg-white/5 transition-all">
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      'w-10 h-10 rounded-xl flex items-center justify-center',
                      session.mode === 'local' ? 'bg-hw-accent/10 text-hw-accent' : 'bg-blue-500/10 text-blue-500'
                    )}>
                      {session.mode === 'local' ? <Mic className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
                    </div>
                    <div>
                      <div className="text-sm font-bold text-white uppercase tracking-tight">
                        {session.mode === 'local' ? 'Instantâneo' : 'Reunião'}
                        {session.externalId && (
                          <span className="ml-2 text-[9px] text-hw-accent bg-hw-accent/10 px-1.5 py-0.5 rounded">
                            ID: {session.externalId}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-hw-muted font-mono">
                        {session.timestamp.toDate().toLocaleDateString()} •{' '}
                        {session.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-[10px] font-mono text-hw-muted uppercase tracking-widest">Duração</div>
                      <div className="text-xs font-bold text-white font-mono">
                        {Math.floor((session.duration || 0) / 60)}m {(session.duration || 0) % 60}s
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-hw-muted" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Quick Actions & Org Info */}
        <div className="space-y-6">
          <div className="glass-panel p-6 space-y-4">
            <h3 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest flex items-center gap-2">
              <Zap className="w-3 h-3 text-hw-accent" /> Ações Rápidas
            </h3>
            <div className="grid gap-2">
              <button
                onClick={onNavigateToWorkspace}
                className="w-full p-3 rounded-xl bg-white/5 border border-white/5 hover:border-hw-accent/50 hover:bg-hw-accent/5 text-left transition-all flex items-center gap-3"
              >
                <div className="p-2 rounded-lg bg-hw-accent/10 text-hw-accent">
                  <Mic className="w-4 h-4" />
                </div>
                <div className="text-[10px] font-bold uppercase tracking-widest">Nova Gravação</div>
              </button>
            </div>
          </div>

          {organization && (userProfile?.role === 'owner' || userProfile?.role === 'admin') && (
            <div className="glass-panel p-6 space-y-4 border-hw-accent/20">
              <h3 className="text-[10px] font-mono uppercase text-hw-muted tracking-widest flex items-center gap-2">
                <ShieldCheck className="w-3 h-3 text-hw-accent" /> Org Admin
              </h3>
              <div className="p-3 rounded-xl bg-hw-accent/5 border border-hw-accent/10">
                <div className="text-[9px] text-hw-muted font-mono uppercase">Plano Atual</div>
                <div className="text-xs font-bold text-white uppercase">{organization.plan}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
