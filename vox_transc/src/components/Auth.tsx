import React, { useState } from 'react';
import { authService } from '../services/auth.service';
import { dbService } from '../services/database.service';
import { Mic, Mail, Lock, LogIn, UserPlus, Loader2 } from 'lucide-react';

export const Auth = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const upsertProfile = async (uid: string, userEmail: string, displayName: string) => {
    const existing = await dbService.getUserProfile(uid);
    if (!existing) {
      const newOrgId = dbService.generateId();
      await dbService.createOrganization({
        id: newOrgId,
        name: `${displayName || userEmail.split('@')[0]}'s Organization`,
        ownerId: uid,
        plan: 'free',
        createdAt: dbService.serverTimestamp(),
      });
      await dbService.setUserProfile(uid, {
        uid,
        email: userEmail,
        displayName: displayName || userEmail.split('@')[0],
        photoURL: '',
        role: 'owner',
        orgId: newOrgId,
        createdAt: dbService.serverTimestamp(),
      }, false);
    }
  };

  const handleGoogleAuth = async () => {
    setLoading(true);
    setError('');
    try {
      await authService.signInWithGoogle();
    } catch (err: any) {
      setError(err.message || 'Erro ao autenticar com o Google.');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (isLogin) {
        await authService.signInWithEmail(email, password);
      } else {
        const user = await authService.signUpWithEmail(email, password);
        await upsertProfile(user.uid, user.email || '', user.displayName || '');
      }
    } catch (err: any) {
      const code = err?.code || '';
      if (code === 'auth/email-already-in-use') setError('Este e-mail já está em uso.');
      else if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') setError('E-mail ou senha incorretos.');
      else if (code === 'auth/weak-password') setError('A senha deve ter pelo menos 6 caracteres.');
      else setError(err.message || 'Erro ao autenticar.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-2xl sm:rounded-3xl p-6 sm:p-10 backdrop-blur-xl shadow-2xl">
        <div className="flex flex-col items-center mb-8 sm:mb-10">
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl sm:rounded-3xl bg-gradient-to-br from-hw-accent to-blue-500 flex items-center justify-center mb-4 sm:mb-6 shadow-[0_0_30px_rgba(0,255,157,0.3)]">
            <Mic className="w-8 h-8 sm:w-10 sm:h-10 text-black" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight text-center">VoxTranscribe <span className="text-hw-accent">Pro</span></h1>
          <p className="text-hw-muted text-sm sm:text-base mt-2 text-center max-w-[280px]">
            {isLogin ? 'Faça login para acessar suas transcrições' : 'Crie sua conta para começar a transcrever'}
          </p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-sm text-center animate-shake">
            {error}
          </div>
        )}

        <form onSubmit={handleEmailAuth} className="space-y-5 sm:space-y-6">
          <div>
            <label className="block text-[10px] sm:text-xs font-bold text-hw-muted uppercase tracking-widest mb-2 ml-1">E-mail</label>
            <div className="relative group">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-hw-muted group-focus-within:text-hw-accent transition-colors" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-black/50 border border-white/10 rounded-xl py-3.5 sm:py-4 pl-12 pr-4 text-white placeholder:text-white/20 focus:outline-none focus:border-hw-accent focus:ring-1 focus:ring-hw-accent transition-all text-base"
                placeholder="seu@email.com"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] sm:text-xs font-bold text-hw-muted uppercase tracking-widest mb-2 ml-1">Senha</label>
            <div className="relative group">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-hw-muted group-focus-within:text-hw-accent transition-colors" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="w-full bg-black/50 border border-white/10 rounded-xl py-3.5 sm:py-4 pl-12 pr-4 text-white placeholder:text-white/20 focus:outline-none focus:border-hw-accent focus:ring-1 focus:ring-hw-accent transition-all text-base"
                placeholder="••••••••"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-hw-accent hover:bg-hw-accent/90 text-black font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-3 mt-8 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-hw-accent/20 active:scale-[0.98]"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : (isLogin ? <LogIn className="w-5 h-5" /> : <UserPlus className="w-5 h-5" />)}
            <span className="uppercase tracking-widest text-sm">{loading ? 'Aguarde...' : (isLogin ? 'Entrar' : 'Criar Conta')}</span>
          </button>
        </form>

        <div className="mt-8 flex items-center gap-4">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-[10px] text-hw-muted uppercase tracking-widest font-bold">ou</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>

        <button
          onClick={handleGoogleAuth}
          disabled={loading}
          className="w-full mt-8 bg-white hover:bg-gray-100 text-black font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg active:scale-[0.98]"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          <span className="uppercase tracking-widest text-sm">Continuar com Google</span>
        </button>

        <p className="mt-10 text-center text-sm text-hw-muted">
          {isLogin ? "Não tem uma conta? " : "Já tem uma conta? "}
          <button
            onClick={() => {
              setIsLogin(!isLogin);
              setError('');
            }}
            className="text-hw-accent hover:underline font-bold uppercase tracking-widest text-xs ml-1"
          >
            {isLogin ? 'Registre-se' : 'Faça login'}
          </button>
        </p>
      </div>
    </div>
  );
};
