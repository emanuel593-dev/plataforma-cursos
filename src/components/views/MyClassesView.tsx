import { useEffect, useState } from 'react';
import { Users, ChevronRight, AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getStudentClassIds, getClass } from '../../services/classes.service';
import { listModules } from '../../services/modules.service';
import type { Class, Module } from '../../types';
import { CLASS_STATUS_LABELS, CLASS_STATUS_COLORS } from '../../lib/constants';
import StatusBadge from '../ui/StatusBadge';
import EmptyState from '../ui/EmptyState';
import PageLoader from '../ui/PageLoader';
import PullToRefresh from '../ui/PullToRefresh';

export default function MyClassesView() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [classes, setClasses] = useState<Class[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!profile?.id) return;
    try {
      setError(null);
      const [ids, mods] = await Promise.all([
        getStudentClassIds(profile.id),
        listModules(),
      ]);
      const list = await Promise.all(ids.map((id) => getClass(id)));
      setClasses(list.filter((c): c is Class => !!c));
      setModules(mods);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Erro ao carregar suas turmas.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [profile?.id]);

  function moduleName(id: string) {
    return modules.find((m) => m.id === id)?.name ?? '—';
  }
  function moduleColor(id: string) {
    return modules.find((m) => m.id === id)?.color ?? '#6366f1';
  }

  if (loading) return <PageLoader variant="list" rows={3} />;

  return (
    <PullToRefresh onRefresh={load}>
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xl sm:text-2xl font-bold text-iv-text">Minhas Turmas</h2>
          <span className="text-xs text-iv-muted">
            {classes.length} {classes.length === 1 ? 'turma' : 'turmas'}
          </span>
        </div>

        {error && (
          <div className="glass-panel p-4 flex items-start gap-3 border-red-500/30">
            <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
            <p className="text-sm text-red-200">{error}</p>
          </div>
        )}

        {classes.length === 0 ? (
          <EmptyState
            icon={<Users size={32} />}
            title="Você ainda não está em nenhuma turma"
            description="Assim que a coordenação te matricular em uma turma, ela aparecerá aqui."
          />
        ) : (
          <div className="space-y-2">
            {classes.map((cl) => (
              <button
                key={cl.id}
                onClick={() => navigate(`/turmas/${cl.id}`)}
                className="w-full glass-panel p-3 flex items-center gap-3 native-pressable text-left hover:border-white/15 transition-colors"
              >
                <div
                  className="w-1.5 self-stretch rounded-full shrink-0"
                  style={{ backgroundColor: moduleColor(cl.module_id) }}
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-iv-text truncate">{cl.name}</p>
                  <p className="text-xs text-iv-muted truncate">{moduleName(cl.module_id)}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <StatusBadge
                      label={CLASS_STATUS_LABELS[cl.status]}
                      colorClass={CLASS_STATUS_COLORS[cl.status]}
                    />
                    {(() => {
                      const m = cl.modality ?? 'online';
                      const cfg = {
                        online:     { label: '🟢 Online',     cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
                        presencial: { label: '🏛️ Presencial', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
                        hibrida:    { label: '🔀 Híbrida',    cls: 'bg-purple-500/10 text-purple-300 border-purple-500/20' },
                      }[m];
                      return (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <ChevronRight size={18} className="text-iv-muted shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}
