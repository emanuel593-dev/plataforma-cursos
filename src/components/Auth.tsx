import React, { useState, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import Button from './ui/Button';
import { Field, TextInput } from './ui/FormField';

type Mode = 'login' | 'forgot';

export function ChangePasswordRequired() {
  const { changePassword, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('As senhas não coincidem.'); return; }
    if (password.length < 8) { setError('A senha deve ter no mínimo 8 caracteres.'); return; }
    setLoading(true);
    try {
      await changePassword(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao alterar senha.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-iv-bg flex items-center justify-center p-4 overflow-y-auto">
      <div className="glass-panel p-6 sm:p-8 max-w-sm w-full space-y-6 my-auto">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-500/15 text-amber-400">
            <KeyRound size={28} />
          </div>
          <h1 className="text-xl font-bold text-iv-text">Altere sua senha</h1>
          <p className="text-iv-muted text-sm">Este é seu primeiro acesso. Defina uma nova senha para continuar.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Nova senha">
            <div className="relative">
              <TextInput
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                required
                minLength={8}
                autoComplete="new-password"
                className="pr-10"
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-iv-muted hover:text-iv-text" tabIndex={-1} aria-label={showPw ? 'Ocultar senha' : 'Mostrar senha'}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
          <Field label="Confirmar senha">
            <div className="relative">
              <TextInput
                type={showConfirm ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repita a senha"
                required
                autoComplete="new-password"
                className="pr-10"
              />
              <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-iv-muted hover:text-iv-text" tabIndex={-1} aria-label={showConfirm ? 'Ocultar confirmação' : 'Mostrar confirmação'}>
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
          {error && <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}
          <Button type="submit" loading={loading} fullWidth haptic="success">Salvar nova senha</Button>
        </form>
        <div className="text-center">
          <button onClick={() => signOut()} className="text-xs text-iv-muted hover:text-iv-text transition-colors">
            Sair e entrar com outra conta
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Auth() {
  const { signIn } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  // Client-side rate limiting: lock out after 5 consecutive failures
  const [failCount, setFailCount] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  const LOCK_THRESHOLD = 5;
  const LOCK_DURATION_MS = 60_000; // 1 minute

  function isLocked() {
    if (lockedUntil === null) return false;
    if (Date.now() < lockedUntil) return true;
    // Lock expired — reset
    setLockedUntil(null);
    setFailCount(0);
    return false;
  }

  function remainingSeconds() {
    if (lockedUntil === null) return 0;
    return Math.ceil((lockedUntil - Date.now()) / 1000);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isLocked()) return;
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await signIn(email.trim(), password);
        setFailCount(0);
      } else {
        // Forgot password — in localStorage mode, show contact admin message
        setSuccess('Contate a coordenação para redefinir sua senha. Se você for professor, aguarde o e-mail de convite com suas credenciais.');
      }
    } catch (err) {
      const newCount = failCount + 1;
      setFailCount(newCount);
      if (newCount >= LOCK_THRESHOLD) {
        setLockedUntil(Date.now() + LOCK_DURATION_MS);
        setError(`Muitas tentativas. Aguarde 1 minuto antes de tentar novamente.`);
      } else {
        setError(err instanceof Error ? err.message : 'Erro desconhecido.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-iv-bg flex items-center justify-center p-4">
      <div className="glass-panel p-6 sm:p-8 max-w-sm w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <img src="/logo-192.png" alt="iSede" className="w-14 h-14 rounded-2xl object-cover" loading="lazy" decoding="async" />
          <h1 className="text-xl font-bold text-iv-text">
            Instituto de <span className="text-iv-accent">Vencedores</span>
          </h1>
          <p className="text-iv-muted text-sm">
            {mode === 'login' ? 'Acesse sua conta' : 'Recuperar acesso'}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="E-mail">
            <TextInput
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              required
              autoComplete="email"
              inputMode="email"
              enterKeyHint={mode === 'login' ? 'next' : 'send'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>

          {mode === 'login' && (
            <Field label="Senha">
              <div className="relative">
                <TextInput
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Sua senha"
                  required
                  autoComplete="current-password"
                  enterKeyHint="go"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-iv-muted hover:text-iv-text transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>
          )}

          {error && (
            <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
          )}
          {success && (
            <div className="px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">{success}</div>
          )}

          <Button
            type="submit"
            loading={loading}
            disabled={isLocked()}
            fullWidth
            haptic="success"
          >
            {isLocked()
              ? `Aguarde ${remainingSeconds()}s`
              : mode === 'login' ? 'Entrar' : 'Recuperar acesso'}
          </Button>
        </form>

        {/* Toggle */}
        <div className="text-center text-sm text-iv-muted">
          {mode === 'login' ? 'Esqueceu sua senha?' : 'Já tem sua senha?'}{' '}
          <button
            onClick={() => { setMode(mode === 'login' ? 'forgot' : 'login'); setError(''); setSuccess(''); }}
            className="text-iv-accent hover:text-iv-accent-hover font-medium transition-colors"
          >
            {mode === 'login' ? 'Esqueci minha senha' : 'Fazer login'}
          </button>
        </div>

        {/* Module dots */}
        <div className="flex gap-1.5 justify-center pt-2">
          <span className="w-2 h-2 rounded-full bg-mod-blue" />
          <span className="w-2 h-2 rounded-full bg-mod-green" />
          <span className="w-2 h-2 rounded-full bg-mod-red" />
        </div>
      </div>
    </div>
  );
}
