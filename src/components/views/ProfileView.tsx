import React, { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { updateProfile } from '../../services/auth.service';
import { getStudentStats } from '../../services/attendance.service';
import { listEnrollmentsByStudent } from '../../services/classes.service';
import { listClassesByProfessor } from '../../services/classes.service';
import { ROLE_LABELS, ROLE_COLORS } from '../../lib/constants';
import { getInitials } from '../../lib/utils';
import { getAudioPrefs, setAudioPrefs, type AudioPrefs } from '../../lib/audioPrefs';
import { Save, BarChart3, Mic } from 'lucide-react';
import Button from '../ui/Button';
import { Field, TextInput } from '../ui/FormField';

export default function ProfileView() {
  const { profile, refreshProfile } = useAuth();
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Per-device audio prefs (localStorage). Affects every WebRTC capture from
  // this browser. AGC default OFF after audit §3.5 #1 (H1 — fade gradual de áudio).
  const [audioPrefs, setAudioPrefsState] = useState<AudioPrefs>(() => getAudioPrefs());

  function updateAudioPref<K extends keyof AudioPrefs>(key: K, value: AudioPrefs[K]) {
    const next = setAudioPrefs({ [key]: value } as Partial<AudioPrefs>);
    setAudioPrefsState(next);
  }

  // Stats
  const [stats, setStats] = useState<{ total: number; present: number; absent: number; justified: number } | null>(null);
  const [extraInfo, setExtraInfo] = useState('');

  useEffect(() => {
    if (!profile) return;
    async function loadExtra() {
      try {
        if (profile!.role === 'aluno') {
          const [st, enrollments] = await Promise.all([
            getStudentStats(profile!.id),
            listEnrollmentsByStudent(profile!.id),
          ]);
          setStats(st);
          setExtraInfo(`${enrollments.length} turma(s) matriculada(s)`);
        } else if (profile!.role === 'professor') {
          const cls = await listClassesByProfessor(profile!.id);
          setExtraInfo(`${cls.length} turma(s) como professor`);
        }
      } catch (err) {
        console.error(err);
      }
    }
    loadExtra();
  }, [profile]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setSaving(true);
    setMessage('');
    try {
      await updateProfile(profile.id, {
        full_name: fullName.trim(),
        phone: phone.trim() || null,
      });
      await refreshProfile();
      setMessage('Perfil atualizado com sucesso!');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  if (!profile) return null;

  return (
    <div className="space-y-6 max-w-lg">
      <h2 className="text-lg sm:text-xl font-bold text-iv-text">Meu Perfil</h2>

      {/* Avatar + role */}
      <div className="glass-panel p-6 flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-iv-accent/20 text-iv-accent flex items-center justify-center text-xl font-bold shrink-0">
          {getInitials(profile.full_name)}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold text-iv-text truncate">{profile.full_name}</h3>
          <p className="text-sm text-iv-muted truncate">{profile.email}</p>
          <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full border ${ROLE_COLORS[profile.role]}`}>
            {ROLE_LABELS[profile.role]}
          </span>
          {extraInfo && <p className="text-xs text-iv-muted mt-1">{extraInfo}</p>}
        </div>
      </div>

      {/* Attendance stats for students */}
      {stats && stats.total > 0 && (
        <div className="glass-panel p-4 space-y-2">
          <h3 className="text-sm font-medium text-iv-muted flex items-center gap-1.5"><BarChart3 size={14} /> Frequência</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Total', value: stats.total, color: 'text-iv-text' },
              { label: 'Presenças', value: stats.present, color: 'text-emerald-400' },
              { label: 'Faltas', value: stats.absent, color: 'text-red-400' },
              { label: 'Justif.', value: stats.justified, color: 'text-amber-400' },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs text-iv-muted">{s.label}</p>
              </div>
            ))}
          </div>
          <div className="w-full bg-white/5 rounded-full h-2 mt-2 overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${Math.round((stats.present / stats.total) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-iv-muted text-right">{Math.round((stats.present / stats.total) * 100)}% de presença</p>
        </div>
      )}

      {/* Áudio (preferências por dispositivo) */}
      <div className="glass-panel p-4 space-y-3">
        <h3 className="text-sm font-medium text-iv-muted flex items-center gap-1.5">
          <Mic size={14} /> Áudio nas aulas (este dispositivo)
        </h3>
        <p className="text-xs text-iv-muted">
          Ajustes aplicados ao seu microfone. Valem só neste navegador/aparelho. Se o áudio
          ficar abafado ou com volume oscilando, experimente desligar o ganho automático.
        </p>
        {([
          { key: 'autoGainControl', label: 'Ganho automático (AGC)', hint: 'Recomendado: desligado. Ligado pode reduzir o volume da sua voz com o tempo.' },
          { key: 'noiseSuppression', label: 'Supressão de ruído', hint: 'Reduz ruídos de fundo (ventilador, teclado).' },
          { key: 'echoCancellation', label: 'Cancelamento de eco', hint: 'Mantenha ligado se você usa caixa de som em vez de fone.' },
        ] as const).map(({ key, label, hint }) => (
          <label key={key} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={audioPrefs[key]}
              onChange={(e) => updateAudioPref(key, e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-iv-accent"
            />
            <span className="text-sm text-iv-text">
              {label}
              <span className="block text-xs text-iv-muted">{hint}</span>
            </span>
          </label>
        ))}
        <p className="text-[11px] text-iv-muted/80">As mudanças valem na próxima vez que você entrar em uma sala.</p>
      </div>

      {/* Edit form */}
      <form onSubmit={handleSave} className="glass-panel p-6 space-y-4">
        <Field label="Nome completo">
          <TextInput
            id="profile-name"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={100}
          />
        </Field>

        <Field label="Telefone">
          <TextInput
            id="profile-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(99) 99999-9999"
          />
        </Field>

        <Field label="E-mail">
          <TextInput
            type="email"
            value={profile.email ?? ''}
            disabled
            className="!bg-iv-bg/50 !border-white/5 !text-iv-muted cursor-not-allowed"
          />
        </Field>

        {message && (
          <div className={`px-3 py-2 rounded-xl text-sm ${
            message.includes('sucesso')
              ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
              : 'bg-red-500/10 border border-red-500/20 text-red-400'
          }`}>
            {message}
          </div>
        )}

        <Button type="submit" loading={saving} leftIcon={<Save size={16} />} haptic="success">
          Salvar alterações
        </Button>
      </form>
    </div>
  );
}
