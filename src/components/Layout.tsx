import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { useThemeColor } from '../hooks/useThemeColor';
import { useHaptic } from '../hooks/useHaptic';
import { useRealtime } from '../hooks/useRealtime';
import { listEnrollmentsByStudent, listClassesByProfessor } from '../services/classes.service';
import type { UserRole } from '../types';
import { ROLE_LABELS } from '../lib/constants';
import { getInitials } from '../lib/utils';
import {
  listInAppNotifications,
  markNotificationsSeen,
  markAllSeen,
  isItemUnread,
  dispatchSystemNotifications,
  requestSystemNotificationPermission,
  type InAppNotification,
} from '../services/notifications.service';
import {
  LayoutDashboard,
  Calendar,
  User,
  Users,
  ClipboardCheck,
  Menu,
  X,
  LogOut,
  MoreHorizontal,
  ChevronRight,
  UserCheck,
  FileBarChart2,
  Bell,
  CheckCheck,
  Settings2,
  Film,
  Star,
  RefreshCcw,
} from 'lucide-react';
import RecordingRecoveryManager from './ui/RecordingRecoveryManager';

// ── Nav item definition ──────────────────────────────────────────────────────

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  roles: UserRole[];
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: <LayoutDashboard size={20} />, roles: ['coordenacao', 'professor', 'aluno', 'monitor'] },
  { path: '/calendario', label: 'Calendário', icon: <Calendar size={20} />, roles: ['coordenacao', 'professor', 'aluno', 'monitor'] },
  { path: '/turmas', label: 'Turmas', icon: <Users size={20} />, roles: ['coordenacao', 'professor', 'aluno', 'monitor'] },
  { path: '/presencas', label: 'Presenças', icon: <ClipboardCheck size={20} />, roles: ['coordenacao', 'professor', 'monitor'] },
  { path: '/avaliacoes', label: 'Avaliações', icon: <Star size={20} />, roles: ['coordenacao', 'monitor'] },
  { path: '/reposicoes', label: 'Reposições', icon: <RefreshCcw size={20} />, roles: ['coordenacao', 'professor', 'aluno', 'monitor'] },
  { path: '/gravacoes', label: 'Gravações', icon: <Film size={20} />, roles: ['coordenacao', 'professor', 'aluno', 'monitor'] },
  { path: '/gestao', label: 'Gestão', icon: <Settings2 size={20} />, roles: ['coordenacao'] },
  { path: '/relatorios', label: 'Relatórios', icon: <FileBarChart2 size={20} />, roles: ['coordenacao'] },
  { path: '/perfil', label: 'Meu Perfil', icon: <User size={20} />, roles: ['coordenacao', 'professor', 'aluno', 'monitor'] },
];

// ── Props ────────────────────────────────────────────────────────────────────

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { profile, user, signOut } = useAuth();
  const role = profile?.role ?? 'aluno';
  const location = useLocation();
  const navigate = useNavigate();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // Tick whenever local read state changes, so per-item unread visuals refresh
  const [readTick, setReadTick] = useState(0);
  const { isOnline, networkState } = useNetworkStatus();
  const haptic = useHaptic();

  const activePath = location.pathname;

  // Native-feeling navigation enhancements
  useScrollRestore();
  // Subtle status-bar tint shift on offline → amber, otherwise base.
  useThemeColor(isOnline ? '#0f1117' : '#92400e');

  useEffect(() => {
    let isMounted = true;
    async function loadNotifications() {
      if (!user || !profile) {
        if (isMounted) {
          setNotifications([]);
          setUnreadCount(0);
        }
        return;
      }
      try {
        const result = await listInAppNotifications(user.id, profile.role, 12);
        if (isMounted) {
          setNotifications(result.items);
          setUnreadCount(result.unreadCount);
          // Fire system notifications for unseen items the OS hasn't shown yet
          dispatchSystemNotifications(user.id, result.items);
        }
      } catch {
        if (isMounted) {
          setNotifications([]);
          setUnreadCount(0);
        }
      }
    }

    loadNotifications();
    // Refresh every 30s so reminder thresholds (60 / 30 / 10 min) flip in time
    const interval = setInterval(loadNotifications, 30_000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [user, profile, activePath, readTick]);

  // Ask for browser notification permission once after sign-in. Modern
  // browsers require a user gesture; we attach to the first navigation tap.
  useEffect(() => {
    if (!user) return;
    const handler = () => {
      requestSystemNotificationPermission().finally(async () => {
        window.removeEventListener('pointerdown', handler);
        // After permission granted, register the Web Push subscription so the
        // server can deliver reminders even with the PWA closed.
        try {
          const { ensurePushSubscription } = await import('../services/push.service');
          await ensurePushSubscription(user.id);
        } catch { /* push optional */ }
      });
    };
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      window.addEventListener('pointerdown', handler, { once: true });
      return () => window.removeEventListener('pointerdown', handler);
    }
    // Already-granted: still ensure a subscription exists.
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      (async () => {
        try {
          const { ensurePushSubscription } = await import('../services/push.service');
          await ensurePushSubscription(user.id);
        } catch { /* noop */ }
      })();
    }
  }, [user]);

  // Listen for `iv:push-resubscribe` from the SW (fired when the browser
  // rotates the push subscription endpoint, e.g. after a long offline period).
  // The SW posts the message; here we re-subscribe and persist the new keys.
  useEffect(() => {
    if (!user) return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = async (ev: MessageEvent) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type !== 'iv:push-resubscribe') return;
      try {
        const { subscribeToPush } = await import('../services/push.service');
        await subscribeToPush(user.id);
      } catch { /* noop */ }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [user]);

  // Realtime: refresh on new announcements or scheduled lessons
  // Debounced 1.5 s so a burst of inserts (e.g. 6 lessons starting in the
  // same minute) collapses into a single fetch instead of 6.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);
  const REFRESH_DEBOUNCE_MS = 1500;
  const refreshNotifications = useCallback(() => {
    if (!user || !profile) return;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(async () => {
      refreshTimerRef.current = null;
      // Guard: component may have unmounted (logout / navigate) during the
      // debounce window. Without this, listInAppNotifications races against
      // unmount and setState fires on a dead component (React warning +
      // wasted Supabase round-trip).
      if (!isMountedRef.current || !user || !profile) return;
      try {
        const result = await listInAppNotifications(user.id, profile.role, 12);
        if (!isMountedRef.current) return;
        setNotifications(result.items);
        setUnreadCount(result.unreadCount);
        dispatchSystemNotifications(user.id, result.items);
        haptic.tap();
      } catch { /* ignore */ }
    }, REFRESH_DEBOUNCE_MS);
  }, [user, profile, haptic]);

  useEffect(() => () => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // Resolve the user's class IDs once per (user,role) to scope Realtime
  // subscriptions. Coordenacao stays unfiltered (it sees everything).
  // Non-coord roles only get postgres_changes events that match their
  // class_id, slashing per-client noise from O(N_total_lessons) to
  // O(N_my_lessons).
  const [myClassIds, setMyClassIds] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!user || !profile) { setMyClassIds(null); return; }
    if (profile.role === 'coordenacao') { setMyClassIds(null); return; }
    (async () => {
      try {
        if (profile.role === 'aluno') {
          const e = await listEnrollmentsByStudent(user.id);
          if (!cancelled) setMyClassIds(e.filter((x) => x.status === 'active').map((x) => x.class_id));
        } else {
          const c = await listClassesByProfessor(user.id);
          if (!cancelled) setMyClassIds(c.map((x) => x.id));
        }
      } catch {
        if (!cancelled) setMyClassIds([]);
      }
    })();
    return () => { cancelled = true; };
  }, [user, profile]);

  const isCoord = profile?.role === 'coordenacao';
  // Postgres realtime accepts `column=in.(uuid1,uuid2)` filters. Empty list
  // becomes `in.()` which matches nothing — good (no useless events).
  const classFilter =
    !isCoord && myClassIds ? `class_id=in.(${myClassIds.join(',')})` : undefined;

  // Coord: no filter. Non-coord: subscribe to (class_id IN my classes) and
  // additionally to global announcements (class_id IS NULL).
  useRealtime({
    table: 'announcements',
    events: ['INSERT', 'UPDATE', 'DELETE'],
    enabled: !!user && (isCoord || myClassIds !== null),
    filter: classFilter,
    onPayload: refreshNotifications,
  });
  useRealtime({
    table: 'announcements',
    events: ['INSERT', 'UPDATE', 'DELETE'],
    // Global announcements (class_id NULL) are visible to everyone; only
    // subscribe separately when we ARE filtering (coord already covered).
    enabled: !!user && !isCoord && myClassIds !== null,
    filter: 'class_id=is.null',
    onPayload: refreshNotifications,
  });

  useRealtime({
    table: 'scheduled_lessons',
    events: ['INSERT', 'UPDATE', 'DELETE'],
    enabled: !!user && (isCoord || myClassIds !== null),
    filter: classFilter,
    onPayload: refreshNotifications,
  });

  // Lock body scroll while any popover overlay is open (mobile bottom sheet
  // would otherwise let the underlying page scroll behind it).
  useEffect(() => {
    const anyOpen = notificationsOpen || moreMenuOpen || userMenuOpen;
    if (!anyOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [notificationsOpen, moreMenuOpen, userMenuOpen]);

  function handleOpenNotifications() {
    if (!user) return;
    setNotificationsOpen((prev) => !prev);
  }

  function handleNotificationClick(item: InAppNotification) {
    if (!user) return;
    const wasUnread = isItemUnread(user.id, item);
    markNotificationsSeen(user.id, [item.id]);
    if (wasUnread) setUnreadCount((c) => Math.max(0, c - 1));
    setReadTick((t) => t + 1);
    if (item.link) {
      navigate(item.link);
      setNotificationsOpen(false);
    }
  }

  function handleMarkAllAsSeen() {
    if (!user) return;
    markAllSeen(user.id, notifications);
    setUnreadCount(0);
    setReadTick((t) => t + 1);
  }

  function isActive(path: string) {
    if (path === '/') return activePath === '/';
    return activePath.startsWith(path);
  }

  const visibleItems = NAV_ITEMS.filter((item) => item.roles.includes(role));
  const activeItem = visibleItems.find((i) => isActive(i.path));

  // Count of unseen swap-incoming notifications (used as badge on Calendário).
  const pendingSwapCount = React.useMemo(() => {
    if (!user) return 0;
    return notifications.filter(
      (n) => n.kind === 'swap-incoming' && isItemUnread(user.id, n),
    ).length;
    // readTick triggers re-evaluation when local read state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications, user, readTick]);

  function badgeFor(path: string): number {
    if (path === '/calendario') return pendingSwapCount;
    return 0;
  }

  // Mobile bottom nav: max 4 items + "Mais" if needed
  const MAX_BOTTOM_NAV = 4;
  const bottomItems = visibleItems.length <= MAX_BOTTOM_NAV + 1
    ? visibleItems
    : visibleItems.slice(0, MAX_BOTTOM_NAV);
  const overflowItems = visibleItems.length > MAX_BOTTOM_NAV + 1
    ? visibleItems.slice(MAX_BOTTOM_NAV)
    : [];

  function handleNav(path: string) {
    if (path !== activePath) haptic.selection();
    navigate(path);
    setMoreMenuOpen(false);
  }

  return (
    <div className="min-h-dvh bg-iv-bg flex">
      {/* ── Desktop sidebar (lg+) ─────────────────────────────────────── */}
      <aside className="hidden lg:flex flex-col w-52 border-r border-white/8 bg-iv-card/50 h-dvh sticky top-0">
        {/* Logo */}
        <div className="p-4 border-b border-white/8">
          <div className="flex items-center gap-3">
            <img src="/logo-192.png" alt="iSede" className="w-9 h-9 rounded-xl object-cover shrink-0" loading="lazy" decoding="async" />
            <div>
              <h2 className="text-sm font-bold text-iv-text leading-tight">LMS Education Platform</h2>
              <span className="text-[10px] text-iv-muted font-mono uppercase tracking-wider">{ROLE_LABELS[role]}</span>
            </div>
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto scrollbar-hide">
          {visibleItems.map((item) => {
            const badge = badgeFor(item.path);
            return (
            <button
              key={item.path}
              onClick={() => handleNav(item.path)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                isActive(item.path)
                  ? 'bg-iv-accent/15 text-iv-accent'
                  : 'text-iv-muted hover:text-iv-text hover:bg-white/5'
              }`}
            >
              <span className="relative inline-flex">
                {item.icon}
                {badge > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-[9px] font-bold text-white flex items-center justify-center" aria-label={`${badge} pendentes`}>
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </span>
              {item.label}
            </button>
          );})}
        </nav>

        {/* User card + signout */}
        <div className="p-3 border-t border-white/8">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-iv-accent/20 text-iv-accent flex items-center justify-center text-xs font-bold">
              {getInitials(profile?.full_name ?? '?')}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-iv-text truncate">{profile?.full_name}</p>
              <p className="text-[10px] text-iv-muted truncate">{profile?.email}</p>
            </div>
            <button
              onClick={signOut}
              className="text-iv-muted hover:text-red-400 transition-colors"
              title="Sair"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content area ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-dvh">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center justify-between px-4 min-h-16 pt-[env(safe-area-inset-top,0px)] border-b border-white/8 bg-iv-card/80 backdrop-blur-xl sticky top-0 z-30">
          <div className="flex items-center gap-2 min-w-0">
            <img src="/logo-192.png" alt="iSede" className="w-7 h-7 rounded-xl object-cover shadow-sm" loading="lazy" decoding="async" />
            <div className="min-w-0">
              <span className="text-sm font-bold text-iv-text tracking-wide block leading-tight">iSede</span>
              <span className="text-[11px] text-iv-muted truncate block leading-tight">{activeItem?.label ?? 'Dashboard'}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleOpenNotifications}
              className="relative text-iv-muted hover:text-iv-text transition-colors touch-target flex items-center justify-center p-2 rounded-full focus:bg-white/5 active:bg-white/10"
              aria-label="Notificações"
            >
              <Bell size={20} />
              {unreadCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] leading-4 text-center ring-2 ring-iv-card">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>
            <button
              onClick={() => { haptic.tap(); setUserMenuOpen((v) => !v); }}
              className="w-9 h-9 rounded-full bg-iv-accent/20 text-iv-accent flex items-center justify-center text-xs font-bold border border-iv-accent/20 shadow-inner native-pressable"
              aria-label="Menu da conta"
              aria-expanded={userMenuOpen}
            >
              {getInitials(profile?.full_name ?? '?')}
            </button>
          </div>
        </header>

        {/* Mobile user menu (avatar dropdown) */}
        {userMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-40 lg:hidden"
              onClick={() => setUserMenuOpen(false)}
            />
            <div className="lg:hidden fixed z-50 right-3 top-[calc(env(safe-area-inset-top,0px)+3.75rem)] w-60 bg-iv-card border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in duration-200">
              <div className="px-4 py-3 border-b border-white/8">
                <p className="text-sm font-semibold text-iv-text truncate">{profile?.full_name}</p>
                <p className="text-[11px] text-iv-muted truncate">{profile?.email}</p>
                <p className="text-[10px] text-iv-muted/80 mt-1 uppercase tracking-wider">{ROLE_LABELS[role]}</p>
              </div>
              <button
                onClick={() => { setUserMenuOpen(false); navigate('/perfil'); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-iv-text hover:bg-white/5 transition-colors border-b border-white/5"
              >
                <User size={18} />
                Meu Perfil
              </button>
              <button
                onClick={() => { setUserMenuOpen(false); signOut(); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LogOut size={18} />
                Sair
              </button>
            </div>
          </>
        )}

        {/* Desktop topbar */}
        <header className="hidden lg:flex items-center h-14 px-6 border-b border-white/8">
          <h1 className="text-lg font-semibold text-iv-text">
            {activeItem?.label ?? 'Dashboard'}
          </h1>
          <div className="ml-auto relative">
            <button
              onClick={handleOpenNotifications}
              className="relative p-2 rounded-xl text-iv-muted hover:text-iv-text hover:bg-white/5 transition-colors"
              aria-label="Notificações"
            >
              <Bell size={18} />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] leading-4 text-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>
          </div>
        </header>

        {notificationsOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setNotificationsOpen(false)}
            />
            <div className="fixed z-50 bg-iv-card border border-white/10 shadow-2xl
              bottom-0 left-0 right-0 rounded-t-2xl max-h-[78dvh] safe-bottom
              sm:bottom-auto sm:top-16 sm:right-4 sm:left-auto sm:rounded-2xl sm:w-[360px] sm:max-w-[calc(100vw-2rem)] sm:max-h-[60dvh]
            ">
              {/* Mobile drag handle */}
              <div className="sm:hidden flex justify-center pt-3 pb-1" onClick={() => setNotificationsOpen(false)}>
                <div className="w-10 h-1.5 bg-white/20 rounded-full" />
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
                <h3 className="text-sm font-semibold text-iv-text">Notificações</h3>
                <button
                  onClick={handleMarkAllAsSeen}
                  className="inline-flex items-center gap-1 text-xs text-iv-muted hover:text-iv-text touch-target"
                >
                  <CheckCheck size={14} /> Marcar como lidas
                </button>
              </div>
              {/* Permission banner: shown when the user hasn't granted OS
                  notification permission yet. Tapping triggers the permission
                  prompt + push subscription persist. */}
              {typeof Notification !== 'undefined' && Notification.permission !== 'granted' && (
                <div className="px-4 py-3 border-b border-white/8 bg-iv-accent/5">
                  <p className="text-xs text-iv-muted leading-snug mb-2">
                    {Notification.permission === 'denied'
                      ? 'As notificações estão bloqueadas. Habilite nas configurações do navegador para receber alertas mesmo com o app fechado.'
                      : 'Ative as notificações para receber lembretes de aulas, trocas e avisos mesmo com o app fechado.'}
                  </p>
                  {Notification.permission !== 'denied' && (
                    <button
                      onClick={async () => {
                        const result = await requestSystemNotificationPermission();
                        if (result === 'granted' && user) {
                          try {
                            const { ensurePushSubscription } = await import('../services/push.service');
                            await ensurePushSubscription(user.id);
                          } catch { /* noop */ }
                        }
                      }}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-iv-accent text-iv-bg hover:opacity-90 transition-opacity"
                    >
                      Ativar notificações
                    </button>
                  )}
                </div>
              )}
              <div className="overflow-y-auto p-2 space-y-2 max-h-[calc(78dvh-5rem)] sm:max-h-[calc(60dvh-4rem)]">
                {notifications.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-iv-muted">
                    Nenhuma notificação recente.
                  </div>
                ) : notifications.map((item) => {
                  const isUnread = user ? isItemUnread(user.id, item) : false;
                  void readTick; // re-evaluated when readTick changes
                  const kindMeta = (() => {
                    switch (item.kind) {
                      case 'announcement':         return { label: 'Aviso',        tone: 'text-iv-muted' };
                      case 'lesson-started':       return { label: 'Ao vivo',      tone: 'text-emerald-400' };
                      case 'lesson-cancelled':     return { label: 'Cancelada',    tone: 'text-rose-400' };
                      case 'lesson-reminder':      return { label: 'Lembrete',     tone: 'text-amber-400' };
                      case 'lesson-reschedule':    return { label: 'Reagendada',   tone: 'text-amber-400' };
                      case 'lesson-reinstatement': return { label: 'Reativada',    tone: 'text-emerald-400' };
                      case 'swap-incoming':        return { label: 'Troca',        tone: 'text-violet-400' };
                      case 'swap-accepted':        return { label: 'Troca',        tone: 'text-emerald-400' };
                      case 'swap-rejected':        return { label: 'Troca',        tone: 'text-rose-400' };
                      case 'substitution':         return { label: 'Substituição', tone: 'text-violet-400' };
                      case 'fj-assigned':          return { label: 'FJ',           tone: 'text-amber-400' };
                      case 'makeup-d1-reminder':   return { label: 'Reposição',    tone: 'text-rose-400' };
                      case 'makeup-submitted':     return { label: 'Reposição',    tone: 'text-violet-400' };
                      case 'makeup-approved':      return { label: 'Reposição',    tone: 'text-emerald-400' };
                      case 'makeup-rejected':      return { label: 'Reposição',    tone: 'text-rose-400' };
                      case 'lesson':
                      default:                     return { label: 'Aula',         tone: 'text-iv-muted' };
                    }
                  })();
                  return (
                    <div
                      key={item.id}
                      onClick={() => handleNotificationClick(item)}
                      className={`relative rounded-xl border px-3 py-2.5 transition-colors ${
                        isUnread
                          ? 'border-iv-accent/30 bg-iv-accent/[0.06]'
                          : 'border-white/8 bg-white/[0.02]'
                      } ${item.link ? 'cursor-pointer hover:bg-white/[0.06]' : ''}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {isUnread && (
                          <span className="w-1.5 h-1.5 rounded-full bg-iv-accent shrink-0" aria-label="Não lida" />
                        )}
                        <p className={`text-xs uppercase tracking-wider font-semibold ${kindMeta.tone}`}>
                          {kindMeta.label}
                        </p>
                        <p className="ml-auto text-[10px] text-iv-muted">
                          {new Date(item.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                        </p>
                      </div>
                      <p className={`text-sm ${isUnread ? 'font-semibold text-iv-text' : 'font-medium text-iv-text/90'}`}>{item.title}</p>
                      <p className="text-xs text-iv-muted mt-1 leading-relaxed truncate-2">{item.message}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Network status banner — three states: offline | reconnecting | (nothing) */}
        {networkState !== 'online' && (
          <div
            className={`text-white text-xs font-medium text-center py-1.5 px-4 z-[60] transition-colors duration-500 ${
              networkState === 'reconnecting'
                ? 'bg-sky-600/90'
                : 'bg-amber-600/90'
            }`}
          >
            {networkState === 'reconnecting'
              ? '↻ Reconectando… os dados serão atualizados em breve.'
              : '⚠️ Sem conexão. Você está vendo dados em cache.'}
          </div>
        )}
        
        {/* Global Modal to rescue orphan recordings */}
        <RecordingRecoveryManager />

        {/* Content */}
        <main className="flex-1 overflow-x-hidden safe-left safe-right">
          <div
            key={activePath}
            className="mx-auto w-full max-w-6xl px-4 sm:px-5 md:px-6 pb-[calc(5rem+env(safe-area-inset-bottom,0px))] lg:pb-6 pt-4 sm:pt-5 md:pt-6 page-enter"
          >
            {children}
          </div>
        </main>

        {/* ── Mobile bottom nav ─────────────────────────────────────── */}
        <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-iv-card/95 backdrop-blur-xl border-t border-white/8 safe-bottom z-30 shadow-[0_-8px_24px_rgba(0,0,0,0.28)]">
          <div className="flex items-center justify-around h-16">
            {bottomItems.map((item) => {
              const active = isActive(item.path);
              const badge = badgeFor(item.path);
              return (
                <button
                  key={item.path}
                  onClick={() => handleNav(item.path)}
                  className={`relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full native-pressable transition-colors ${
                    active ? 'text-iv-accent' : 'text-iv-muted'
                  }`}
                  aria-current={active ? 'page' : undefined}
                >
                  {active && (
                    <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-full bg-iv-accent" aria-hidden="true" />
                  )}
                  <span className="relative inline-flex">
                    {item.icon}
                    {badge > 0 && (
                      <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-[9px] font-bold text-white flex items-center justify-center" aria-label={`${badge} pendentes`}>
                        {badge > 9 ? '9+' : badge}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] font-medium max-w-full truncate px-1">{item.label}</span>
                </button>
              );
            })}

            {overflowItems.length > 0 && (
              <div className="flex-1 relative flex flex-col items-center justify-center">
                <button
                  onClick={() => { haptic.tap(); setMoreMenuOpen(!moreMenuOpen); }}
                  className={`flex flex-col items-center justify-center gap-0.5 w-full h-16 native-pressable transition-colors ${
                    overflowItems.some((i) => isActive(i.path))
                      ? 'text-iv-accent'
                      : 'text-iv-muted'
                  }`}
                  aria-expanded={moreMenuOpen}
                >
                  <MoreHorizontal size={20} />
                  <span className="text-[10px] font-medium">Mais</span>
                </button>

                {moreMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setMoreMenuOpen(false)}
                    />
                    <div className="absolute bottom-[calc(100%+0.5rem)] right-2 w-48 bg-iv-card border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-50 animate-in slide-in-from-bottom-2 fade-in duration-200">
                      {overflowItems.map((item) => (
                        <button
                          key={item.path}
                          onClick={() => handleNav(item.path)}
                          className={`w-full flex flex-col lg:flex-row items-center lg:justify-start gap-3 px-4 py-3 text-sm font-medium transition-colors border-b border-white/5 last:border-0 ${
                            isActive(item.path)
                              ? 'bg-iv-accent/15 text-iv-accent'
                              : 'text-iv-muted hover:text-iv-text hover:bg-white/5'
                          }`}
                        >
                          <div className="flex items-center gap-3 w-full">
                            {item.icon}
                            {item.label}
                          </div>
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          setMoreMenuOpen(false);
                          signOut();
                        }}
                        className="w-full flex items-center gap-3 px-4 py-3 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <LogOut size={20} />
                        Sair
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </nav>
      </div>
    </div>
  );
}
