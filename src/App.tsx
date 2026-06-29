import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider, useToast } from './contexts/ToastContext';
import ErrorBoundary from './components/ui/ErrorBoundary';
import Auth, { ChangePasswordRequired } from './components/Auth';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { Loader2 } from 'lucide-react';
import { useSingleSession } from './hooks/useSingleSession';

// ── Lazy-loaded views (code splitting per route) ──────────────────────────────
const DashboardView   = lazy(() => import('./components/views/DashboardView'));
const CalendarView    = lazy(() => import('./components/views/CalendarView'));
const ModulesView     = lazy(() => import('./components/views/ModulesView'));
const ClassesView     = lazy(() => import('./components/views/ClassesView'));
const MyClassesView   = lazy(() => import('./components/views/MyClassesView'));
const AttendanceView  = lazy(() => import('./components/views/AttendanceView'));
const StudentsView    = lazy(() => import('./components/views/StudentsView'));
const ProfileView     = lazy(() => import('./components/views/ProfileView'));
const ClassroomView   = lazy(() => import('./components/views/ClassroomView'));
const ProfessoresView = lazy(() => import('./components/views/ProfessoresView'));
const GestaoView      = lazy(() => import('./components/views/GestaoView'));
const ReportsView     = lazy(() => import('./components/views/ReportsView'));
const ClassDetailView = lazy(() => import('./components/views/ClassDetailView'));
const DiagView        = lazy(() => import('./components/views/DiagView'));
const RecordingsView  = lazy(() => import('./components/views/RecordingsView'));
const GDriveCallbackView = lazy(() => import('./components/views/GDriveCallbackView'));
const AvaliacoesView     = lazy(() => import('./components/views/AvaliacoesView'));
const ReposicoesView     = lazy(() => import('./components/views/ReposicoesView'));

function RouteLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 size={24} className="animate-spin text-iv-accent" />
    </div>
  );
}

/** Renders the staff classes manager for coord/prof/monitor (ClassesView is
 *  filtered to the monitor's assigned classes), and a lightweight list for alunos. */
function ClassesRoute() {
  const { profile } = useAuth();
  if (profile?.role === 'aluno') return <MyClassesView />;
  return <ClassesView />;
}

function AppContent() {
  const { isLoading, isAuthenticated, mustChangePassword, user, signOut } = useAuth();
  const { showToast } = useToast();

  // Single-session enforcement (free-tier compatible). Quando o mesmo usuario
  // loga em outro dispositivo/aba, esta sessao recebe o claim mais novo via
  // Realtime broadcast e faz signOut, exibindo um aviso amigavel.
  useSingleSession(user?.id ?? null, async () => {
    showToast(
      'Sua sessao foi encerrada porque voce entrou em outro dispositivo.',
      'warning',
    );
    await signOut();
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-iv-bg flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-iv-accent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Auth />;
  }

  if (mustChangePassword) {
    return <ChangePasswordRequired />;
  }

  return (
    <Layout>
      <Suspense fallback={<RouteLoader />}>
        <Routes>
        <Route path="/" element={<DashboardView />} />
        <Route path="/calendario" element={<CalendarView />} />
        <Route path="/sala/:roomId" element={
          <ProtectedRoute allowedRoles={['coordenacao', 'professor', 'aluno', 'monitor']}>
            <ClassroomView />
          </ProtectedRoute>
        } />
        <Route path="/turmas" element={
          <ProtectedRoute allowedRoles={['coordenacao', 'professor', 'aluno', 'monitor']}>
            <ClassesRoute />
          </ProtectedRoute>
        } />
        <Route path="/turmas/:id" element={
          <ProtectedRoute allowedRoles={['coordenacao', 'professor', 'aluno', 'monitor']}>
            <ClassDetailView />
          </ProtectedRoute>
        } />
        <Route path="/presencas" element={
          <ProtectedRoute allowedRoles={['coordenacao', 'professor', 'monitor']}>
            <AttendanceView />
          </ProtectedRoute>
        } />
        <Route path="/modulos" element={
          <ProtectedRoute allowedRoles={['coordenacao']}>
            <ModulesView />
          </ProtectedRoute>
        } />
        <Route path="/alunos" element={
          <ProtectedRoute allowedRoles={['coordenacao']}>
            <StudentsView />
          </ProtectedRoute>
        } />
        <Route path="/professores" element={
          <ProtectedRoute allowedRoles={['coordenacao']}>
            <ProfessoresView />
          </ProtectedRoute>
        } />
        <Route path="/gestao" element={
          <ProtectedRoute allowedRoles={['coordenacao']}>
            <GestaoView />
          </ProtectedRoute>
        } />
        <Route path="/relatorios" element={
          <ProtectedRoute allowedRoles={['coordenacao']}>
            <ReportsView />
          </ProtectedRoute>
        } />
        <Route path="/diag" element={
          <ProtectedRoute allowedRoles={['coordenacao']}>
            <DiagView />
          </ProtectedRoute>
        } />
        <Route path="/perfil" element={<ProfileView />} />
        <Route path="/gravacoes" element={
          <ProtectedRoute allowedRoles={['coordenacao', 'professor', 'aluno', 'monitor']}>
            <RecordingsView />
          </ProtectedRoute>
        } />
        <Route path="/avaliacoes" element={
          <ProtectedRoute allowedRoles={['coordenacao', 'monitor']}>
            <AvaliacoesView />
          </ProtectedRoute>
        } />
        <Route path="/reposicoes" element={
          <ProtectedRoute allowedRoles={['coordenacao', 'professor', 'aluno', 'monitor']}>
            <ReposicoesView />
          </ProtectedRoute>
        } />
        <Route path="/oauth/gdrive" element={<GDriveCallbackView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
