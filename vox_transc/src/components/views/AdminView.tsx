import React, { useState } from 'react';
import { Key, Users, Plus, Trash2, ShieldCheck, Loader2, Copy } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../lib/utils';
import { Organization, ApiKey, UserProfile, UserRole } from '../../types';

interface Props {
  organization: Organization | null;
  orgKeys: ApiKey[];
  orgMembers: UserProfile[];
  currentUserId: string | null;
  onUpdateOrg: (data: Partial<Organization>) => Promise<void>;
  onCreateKey: (name: string) => Promise<string | null>;
  onDeleteKey: (id: string) => Promise<void>;
  onUpdateMemberRole: (uid: string, role: UserRole) => Promise<void>;
}

export const AdminView = ({
  organization,
  orgKeys,
  orgMembers,
  currentUserId,
  onCreateKey,
  onDeleteKey,
  onUpdateMemberRole,
}: Props) => {
  const [newKeyName, setNewKeyName] = useState('');
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text);
  const canManageRoles = organization?.ownerId === currentUserId;

  if (!organization) {
    return (
      <div className="flex flex-col items-center justify-center h-full space-y-4">
        <Loader2 className="w-8 h-8 text-hw-accent animate-spin" />
        <p className="text-hw-muted font-mono text-xs uppercase tracking-widest">Carregando Organização...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white uppercase tracking-tight">Gestão da Organização</h2>
          <p className="text-hw-muted text-xs font-mono uppercase tracking-widest mt-1">
            {organization.name} • Plano {organization.plan}
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-hw-accent/10 border border-hw-accent/20">
          <ShieldCheck className="w-3 h-3 text-hw-accent" />
          <span className="text-[10px] font-bold text-hw-accent uppercase">Admin Console</span>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* API Keys */}
        <section className="glass-panel p-6 space-y-6">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-hw-accent" />
            <h3 className="text-xs font-bold text-white uppercase tracking-widest">Chaves de API</h3>
          </div>

          <div className="space-y-3">
            {orgKeys.length === 0 ? (
              <div className="py-8 text-center text-[10px] font-mono text-hw-muted/30 uppercase tracking-widest">
                Nenhuma chave ativa
              </div>
            ) : (
              orgKeys.map(key => (
                <div key={key.id} className="p-3 rounded-xl bg-white/5 border border-white/5 flex items-center justify-between group">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-white uppercase truncate">{key.name}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-[9px] font-mono text-hw-accent bg-hw-accent/10 px-1.5 py-0.5 rounded truncate max-w-[150px]">
                        {key.keyPrefix}••••••••
                      </code>
                      <span className="text-[8px] text-hw-muted font-mono uppercase ml-2">
                        {key.lastUsedAt ? `Usada: ${key.lastUsedAt.toDate().toLocaleDateString()}` : 'Nunca usada'}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => onDeleteKey(key.id)}
                    className="p-2 text-hw-muted hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}

            <div className="pt-4 border-t border-white/5 space-y-3">
              <div className="text-[10px] font-mono text-hw-muted uppercase">Gerar Nova Chave</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="Nome da Integração (ex: ATS)"
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-xs text-white focus:outline-none focus:border-hw-accent/50"
                />
                <button
                  onClick={async () => {
                    if (!newKeyName) return;
                    setIsCreatingKey(true);
                    const key = await onCreateKey(newKeyName);
                    if (key) { setNewlyCreatedKey(key); setNewKeyName(''); }
                    setIsCreatingKey(false);
                  }}
                  disabled={isCreatingKey || !newKeyName}
                  className="px-4 py-2 bg-hw-accent text-hw-bg rounded-xl font-bold text-[10px] uppercase tracking-widest hover:bg-hw-accent/90 transition-all disabled:opacity-50"
                >
                  {isCreatingKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* New Key Modal */}
        <AnimatePresence>
          {newlyCreatedKey && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
            >
              <motion.div
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-zinc-900 border border-hw-accent/30 p-8 rounded-3xl max-w-md w-full shadow-2xl space-y-6"
              >
                <div className="flex items-center gap-3 text-hw-accent">
                  <ShieldCheck className="w-6 h-6" />
                  <h3 className="text-lg font-bold uppercase tracking-tight">Chave Gerada com Sucesso</h3>
                </div>
                <p className="text-xs text-hw-muted leading-relaxed">
                  Por segurança, esta chave será exibida apenas{' '}
                  <span className="text-white font-bold">uma vez</span>. Copie e guarde-a em um local seguro.
                </p>
                <div className="relative group">
                  <div className="absolute -inset-1 bg-hw-accent/20 rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000" />
                  <div className="relative flex items-center gap-2 bg-black/60 border border-white/10 rounded-xl p-4">
                    <code className="flex-1 text-hw-accent font-mono text-xs break-all">{newlyCreatedKey}</code>
                    <button
                      onClick={() => copyToClipboard(newlyCreatedKey)}
                      className="p-2 hover:bg-white/5 rounded-lg text-hw-muted hover:text-hw-accent transition-colors"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => setNewlyCreatedKey(null)}
                  className="w-full py-4 bg-hw-accent text-hw-bg rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-hw-accent/90 transition-all"
                >
                  Entendido, salvei a chave
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Members */}
        <section className="glass-panel p-6 space-y-6 md:col-span-2">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-hw-accent" />
            <h3 className="text-xs font-bold text-white uppercase tracking-widest">Membros da Equipe</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {orgMembers.map(member => (
              <div key={member.uid} className="p-3 rounded-xl bg-white/5 border border-white/5 flex items-center gap-3">
                <img
                  src={member.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(member.displayName || member.email)}`}
                  className="w-8 h-8 rounded-lg"
                  referrerPolicy="no-referrer"
                  alt={member.displayName || member.email}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-bold text-white truncate uppercase">{member.displayName || member.email}</div>
                  <div className="text-[9px] text-hw-muted font-mono truncate">{member.email}</div>
                </div>
                <div className="flex items-center gap-2">
                  <div className={cn(
                    'px-2 py-0.5 rounded-full text-[8px] font-bold uppercase',
                    member.role === 'owner' ? 'bg-hw-accent/20 text-hw-accent' :
                    member.role === 'admin' ? 'bg-blue-500/20 text-blue-400' : 'bg-white/10 text-hw-muted'
                  )}>
                    {member.role}
                  </div>
                  {canManageRoles && member.role !== 'owner' && (
                    <select
                      value={member.role}
                      onChange={(e) => onUpdateMemberRole(member.uid, e.target.value as UserRole)}
                      className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-[8px] font-mono text-white outline-none focus:border-hw-accent"
                    >
                      <option value="member">Membro</option>
                      <option value="admin">Admin</option>
                    </select>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
