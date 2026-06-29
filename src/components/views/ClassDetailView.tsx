import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Users,
  Megaphone,
  CalendarDays,
  Calendar,
  Clock,
  Loader2,
  Play,
  Percent,
  CheckCircle2,
  FileText,
  Link2,
  Video,
  Plus,
  Trash2,
  ChevronRight,
  AlertTriangle,
  GraduationCap,
  Settings,
  ClipboardList,
  Send,
  Star,
  Edit3,
  Film,
  Lock,
  Eye,
  Headphones,
} from 'lucide-react';
import {
  getClass,
  listEnrollmentsByClass,
  createEnrollment,
  deleteEnrollment,
  updateEnrollment,
  updateClass,
  listProfessorsOfClass,
  addProfessorToClass,
  removeProfessorFromClass,
} from '../../services/classes.service';
import {
  listMonitorsOfClass,
  addMonitorToClass,
  removeMonitorFromClass,
} from '../../services/monitors.service';
import { listByClass, createScheduledLesson } from '../../services/schedule.service';
import {
  listVisibleAnnouncements,
  markAnnouncementRead,
  getReadCountsBatch,
  getUserReadSet,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from '../../services/announcements.service';
import {
  listByClass as listMaterialsByClass,
  createMaterial,
  deleteMaterial,
} from '../../services/materials.service';
import { listModules, listLessonsByModule } from '../../services/modules.service';
import { listProfilesByRole } from '../../services/profiles.service';
import { listByScheduledLessonIds, type AttendanceStats } from '../../services/attendance.service';
import {
  listByClass as listAssignmentsByClass,
  createAssignment,
  updateAssignment,
  deleteAssignment,
} from '../../services/assignments.service';
import {
  listByAssignments as listSubmissionsByAssignments,
  submitWork,
  gradeSubmission,
} from '../../services/submissions.service';
import { listRecordings, type RecordingMeta } from '../../services/recording.service';
import { markWatched, listAllSubmissions } from '../../services/makeup.service';
import type { Class, Profile, EnrollmentWithRelations, ScheduledLesson, Announcement, ClassMaterial, Module, Lesson, Assignment, Submission, MakeupSubmission, AttendanceStatus, Attendance } from '../../types';
import { effectiveLessonModality } from '../../types';
import MakeupSummaryModal from '../ui/MakeupSummaryModal';
import MakeupStatusBadge from '../ui/MakeupStatusBadge';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';

import Modal from '../ui/Modal';
import EmptyState from '../ui/EmptyState';

function ProgressRing({ radius, stroke, progress, colorClass }: { radius: number, stroke: number, progress: number, colorClass: string }) {
  const normalizedRadius = radius - stroke * 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <svg height={radius * 2} width={radius * 2} className="transform -rotate-90">
      <circle
        stroke="rgba(255,255,255,0.05)"
        fill="transparent"
        strokeWidth={stroke}
        r={normalizedRadius}
        cx={radius}
        cy={radius}
      />
      <circle
        className={colorClass}
        stroke="currentColor"
        fill="transparent"
        strokeWidth={stroke}
        strokeDasharray={circumference + ' ' + circumference}
        style={{ strokeDashoffset, transition: 'stroke-dashoffset 0.5s ease 0s' }}
        strokeLinecap="round"
        r={normalizedRadius}
        cx={radius}
        cy={radius}
      />
    </svg>
  );
}

// ── Reposição Tab — recordings list with FJ gating for students ───────────────
function RecordingsTab({ classId }: { classId: string }) {
  const { profile } = useAuth();
  const isStaff   = profile?.role === 'coordenacao' || profile?.role === 'professor';
  const isStudent = profile?.role === 'aluno';

  const [recordings,    setRecordings]    = useState<RecordingMeta[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [attendanceMap, setAttendanceMap] = useState<Record<string, Attendance>>({});
  const [submissionMap, setSubmissionMap] = useState<Record<string, MakeupSubmission>>({});
  // recordingId that the student has clicked "Assistir" on this session
  const [playerOpen,    setPlayerOpen]    = useState<Set<string>>(new Set());
  const [summaryTarget, setSummaryTarget] = useState<{ rec: RecordingMeta; sub: MakeupSubmission } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const recs = await listRecordings({ classId });
        if (cancelled) return;
        setRecordings(recs);

        if (isStudent && profile?.id) {
          const slIds = recs.flatMap(r => r.scheduledLessonId ? [r.scheduledLessonId] : []);
          const recordingIds = recs.map(r => r.id);
          const [attendances, submissions] = await Promise.all([
            slIds.length
              ? listByScheduledLessonIds(slIds)
              : Promise.resolve([]),
            recordingIds.length
              ? listAllSubmissions({ studentId: profile.id, recordingIds })
              : Promise.resolve([] as MakeupSubmission[]),
          ]);
          if (cancelled) return;

          const attMap: Record<string, Attendance> = {};
          for (const a of attendances) {
            if (a.student_id === profile.id) {
              attMap[a.scheduled_lesson_id] = a;
            }
          }
          setAttendanceMap(attMap);

          const subMap: Record<string, MakeupSubmission> = {};
          for (const s of submissions) {
            subMap[s.recording_id] = s;
          }
          setSubmissionMap(subMap);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Erro ao carregar gravações.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [classId, isStudent, profile?.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-iv-muted">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">Carregando gravações…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel p-4 text-sm text-red-400 flex items-center gap-2">
        <AlertTriangle size={16} />
        {error}
      </div>
    );
  }

  if (recordings.length === 0) {
    return (
      <EmptyState
        title="Nenhuma gravação"
        description="As aulas gravadas aparecerão aqui após o upload."
      />
    );
  }

  async function handleWatch(rec: RecordingMeta) {
    if (!profile?.id) return;
    // Show iframe immediately for responsiveness
    setPlayerOpen(prev => new Set(prev).add(rec.id));
    // Record watched_at (idempotent)
    try {
      const sub = await markWatched(
        rec.id,
        profile.id,
        rec.scheduledLessonId ?? null,
        classId,
      );
      setSubmissionMap(prev => ({ ...prev, [rec.id]: sub }));
    } catch {
      // Non-fatal — UI already opened the player
    }
  }

  function handleSummaryClose() {
    setSummaryTarget(null);
  }

  function handleSummarySubmitted(rec: RecordingMeta) {
    setSummaryTarget(null);
    // Re-fetch only this recording's submission to reflect new status
    if (profile?.id) {
      listAllSubmissions({ studentId: profile.id, recordingIds: [rec.id] })
        .then(list => {
          if (list[0]) setSubmissionMap(prev => ({ ...prev, [rec.id]: list[0] }));
        })
        .catch(() => undefined);
    }
  }

  const IFRAME_BASE = 'https://drive.google.com/file/d';
  // Strip video extension for display (title is stored as filename)
  const displayTitle = (t: string) => t.replace(/\.(webm|mp4|mkv|ogg|avi)$/i, '');

  return (
    <>
      <div className="space-y-4">
        {recordings.map((rec) => {
          const slId       = rec.scheduledLessonId ?? null;
          const att        = slId ? attendanceMap[slId] : undefined;
          const attStatus  = att?.status;
          const deadline   = att?.makeup_deadline ?? null;
          const expired    = deadline ? new Date(deadline).getTime() < Date.now() : false;
          const sub        = submissionMap[rec.id];
          const watching   = playerOpen.has(rec.id);

          // ── Staff view ─────────────────────────────────────────────────────
          if (isStaff) {
            return (
              <div key={rec.id} className="glass-panel p-4 border border-white/8 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Film size={18} className="text-iv-accent shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-iv-text truncate">{rec.title}</p>
                      <p className="text-xs text-iv-muted">
                        {new Date(rec.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                        {rec.durationS ? ` · ${Math.floor(rec.durationS / 60)} min` : ''}
                      </p>
                    </div>
                  </div>
                  {rec.status === 'ready' && rec.gdriveFileId ? (
                    <a
                      href={rec.gdriveViewLink ?? `${IFRAME_BASE}/${rec.gdriveFileId}/view`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-iv-accent hover:bg-iv-accent-hover text-white text-xs font-medium transition-colors"
                    >
                      <Play size={12} /> Abrir
                    </a>
                  ) : (
                    <span className="shrink-0 text-xs text-iv-muted capitalize">{rec.status}</span>
                  )}
                </div>
              </div>
            );
          }

          // ── Student: locked (F — unjustified absence) ─────────────────────
          if (isStudent && slId && attStatus === 'absent') {
            return (
              <div key={rec.id} className="glass-panel p-4 border border-white/8 opacity-60">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-red-500/10 flex items-center justify-center shrink-0">
                    <Lock size={16} className="text-red-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-iv-text truncate">{displayTitle(rec.title)}</p>
                    <p className="text-xs text-red-400 mt-0.5">
                      Falta não justificada — solicite FJ à coordenação para liberar acesso.
                    </p>
                  </div>
                </div>
              </div>
            );
          }

          // ── Student: allowed (FJ / no attendance requirement / no SL) ─────
          if (isStudent) {
            // Single source of truth for the visual is `MakeupStatusBadge`.
            // We pass `watched` so 'pending' renders as 'Aguardando resumo'
            // when the recording was already viewed.
            const statusBadge = sub
              ? <MakeupStatusBadge status={sub.status} watched={!!sub.watched_at} />
              : null;

            // Submission gate:
            //   - 'pending' (watched, no summary yet)            → allow submit
            //   - 'rejected' (coord asked for revision)          → allow re-submit
            //   - 'submitted' / 'approved'                       → block
            // Note: we explicitly check `status !== 'submitted'` instead of
            // `!submitted_at`, because a rejected submission keeps its
            // submitted_at filled (the review only updates status/notes).
            const canSubmitSummary = !!sub
              && sub.status !== 'approved'
              && sub.status !== 'submitted'
              && !expired;

            // Friendly deadline label (only when an FJ deadline exists)
            const deadlineBadge = (() => {
              if (!deadline || sub?.status === 'submitted' || sub?.status === 'approved') return null;
              const ms = new Date(deadline).getTime() - Date.now();
              if (ms <= 0)
                return <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">Prazo encerrado</span>;
              const hours = Math.floor(ms / 3_600_000);
              const days  = Math.floor(hours / 24);
              const label = hours < 1 ? 'menos de 1h'
                          : hours < 24 ? `${hours}h`
                          : `${days} ${days === 1 ? 'dia' : 'dias'}`;
              const cls   = ms < 48 * 3_600_000
                ? 'bg-amber-500/15 text-amber-400'
                : 'bg-blue-500/15 text-blue-400';
              return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>Prazo: {label}</span>;
            })();

            return (
              <div key={rec.id} className="glass-panel p-4 border border-white/8 space-y-3">
                {/* Header row — wraps on mobile to avoid badge+button squeezing the title */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Film size={18} className="text-iv-accent shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-iv-text truncate">{displayTitle(rec.title)}</p>
                      <p className="text-xs text-iv-muted">
                        {new Date(rec.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                        {rec.durationS ? ` · ${Math.floor(rec.durationS / 60)} min` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    {deadlineBadge}
                    {statusBadge}
                    {rec.status === 'ready' && rec.gdriveFileId && !watching && (
                      <button
                        onClick={() => handleWatch(rec)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-iv-accent hover:bg-iv-accent-hover text-white text-xs font-medium transition-colors"
                      >
                        <Eye size={12} /> Assistir
                      </button>
                    )}
                    {watching && canSubmitSummary && (
                      <button
                        onClick={() => sub && setSummaryTarget({ rec, sub })}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
                      >
                        Enviar Resumo
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline iframe player */}
                {watching && rec.gdriveFileId && (
                  <div className="rounded-xl overflow-hidden border border-white/10 bg-black aspect-video max-h-[38vh] sm:max-h-none">
                    <iframe
                      src={`${IFRAME_BASE}/${rec.gdriveFileId}/preview`}
                      title={rec.title}
                      allow="autoplay"
                      allowFullScreen
                      className="w-full h-full"
                    />
                  </div>
                )}

                {/* Reviewer notes if rejected */}
                {sub?.status === 'rejected' && sub.reviewer_notes && (
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300">
                    <span className="font-semibold">Feedback: </span>{sub.reviewer_notes}
                  </div>
                )}
              </div>
            );
          }

          // Fallback (anonymous / unknown role) — hide
          return null;
        })}
      </div>

      {/* Summary modal */}
      {summaryTarget && (
        <MakeupSummaryModal
          submissionId={summaryTarget.sub.id}
          recordingTitle={summaryTarget.rec.title}
          deadline={
            (summaryTarget.rec.scheduledLessonId
              ? attendanceMap[summaryTarget.rec.scheduledLessonId]?.makeup_deadline
              : null) ?? null
          }
          // Re-submission UX: when previous attempt was rejected, pre-fill the
          // textarea so the student can refine it, and surface the reviewer's
          // feedback at the top of the modal.
          isResubmission={summaryTarget.sub.status === 'rejected'}
          initialText={
            summaryTarget.sub.status === 'rejected'
              ? summaryTarget.sub.summary ?? ''
              : null
          }
          reviewerNotes={
            summaryTarget.sub.status === 'rejected'
              ? summaryTarget.sub.reviewer_notes
              : null
          }
          onClose={handleSummaryClose}
          onSubmitted={() => handleSummarySubmitted(summaryTarget.rec)}
        />
      )}
    </>
  );
}

export default function ClassDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { profile } = useAuth();
  const { showToast } = useToast();
  
  const [loading, setLoading] = useState(true);
  const [cls, setCls] = useState<Class | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentWithRelations[]>([]);
  const [lessons, setLessons] = useState<ScheduledLesson[]>([]);
  const [students, setStudents] = useState<Profile[]>([]);
  const [professors, setProfessors] = useState<Profile[]>([]);
  const [monitors, setMonitors] = useState<Profile[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  type ClassTab = 'mural' | 'aulas' | 'membros' | 'professores' | 'monitores' | 'materiais' | 'tarefas' | 'config' | 'reposicao';
  const VALID_TABS: readonly ClassTab[] = ['mural','aulas','membros','professores','monitores','materiais','tarefas','config','reposicao'] as const;
  // Honor `?tab=` from deep-links (e.g. push notifications opening the
  // Reposição tab directly). Defaults to 'mural' when absent or invalid.
  const initialTabRaw = searchParams.get('tab') as ClassTab | null;
  const initialTab: ClassTab = initialTabRaw && VALID_TABS.includes(initialTabRaw) ? initialTabRaw : 'mural';
  const [activeTab, setActiveTabState] = useState<ClassTab>(initialTab);
  // Wrapper that keeps the URL in sync — makes the tab linkable / shareable
  // and lets back/forward navigation restore the previously-selected tab.
  const setActiveTab = useCallback((next: ClassTab) => {
    setActiveTabState(next);
    const sp = new URLSearchParams(searchParams);
    if (next === 'mural') sp.delete('tab'); else sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  }, [searchParams, setSearchParams]);
  const [profAssignSelectedId, setProfAssignSelectedId] = useState('');
  const [profSaving, setProfSaving] = useState(false);
  const [monAssignSelectedId, setMonAssignSelectedId] = useState('');
  const [monSaving, setMonSaving] = useState(false);
  const [enrollModal, setEnrollModal] = useState(false);
  const [enrollStudentId, setEnrollStudentId] = useState('');
  const [saving, setSaving] = useState(false);

  // Mural
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [readCounts, setReadCounts] = useState<Record<string, number>>({});
  const [userReadSet, setUserReadSet] = useState<Set<string>>(new Set());
  const [announcementModal, setAnnouncementModal] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<Announcement | null>(null);
  const [annTitle, setAnnTitle] = useState('');
  const [annContent, setAnnContent] = useState('');
  const [annSaving, setAnnSaving] = useState(false);

  // Lesson
  const [lessonModal, setLessonModal] = useState(false);
  const [lessonDate, setLessonDate] = useState('');
  const [lessonTime, setLessonTime] = useState('');
  const [lessonDuration, setLessonDuration] = useState(60);
  const [lessonSelectedId, setLessonSelectedId] = useState('');
  const [lessonProfessorId, setLessonProfessorId] = useState('');
  // Override de modalidade da aula (apenas exposto em turmas híbridas).
  // 'inherit' = NULL no DB (herda da turma). Em turma online/presencial pura
  // este estado nunca é alterado pela UI.
  const [lessonModalityOverride, setLessonModalityOverride] = useState<'inherit' | 'online' | 'presencial'>('inherit');
  const [availableLessons, setAvailableLessons] = useState<Lesson[]>([]);
  const [loadingLessons, setLoadingLessons] = useState(false);

  // Materials
  const [materials, setMaterials] = useState<ClassMaterial[]>([]);
  const [materialModal, setMaterialModal] = useState(false);
  const [matTitle, setMatTitle] = useState('');
  const [matUrl, setMatUrl] = useState('');
  const [matType, setMatType] = useState<'link' | 'pdf' | 'video' | 'other'>('link');

  // Assignments
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [submissionsMap, setSubmissionsMap] = useState<Record<string, Submission[]>>({});
  const [assignmentModal, setAssignmentModal] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<Assignment | null>(null);
  const [asgTitle, setAsgTitle] = useState('');
  const [asgDescription, setAsgDescription] = useState('');
  const [asgDueDate, setAsgDueDate] = useState('');
  const [asgMaxScore, setAsgMaxScore] = useState(10);
  const [asgStatus, setAsgStatus] = useState<'draft' | 'published'>('draft');

  // Student submission
  const [submitModal, setSubmitModal] = useState<Assignment | null>(null);
  const [submitContent, setSubmitContent] = useState('');
  const [submitFileUrl, setSubmitFileUrl] = useState('');

  // Grading
  const [gradeModal, setGradeModal] = useState<{ submission: Submission; assignment: Assignment } | null>(null);
  const [gradeScore, setGradeScore] = useState(0);
  const [gradeFeedback, setGradeFeedback] = useState('');

  // Confirmation modal
  const [confirmModal, setConfirmModal] = useState<{ open: boolean; title: string; message: string; onConfirm: () => void }>({ open: false, title: '', message: '', onConfirm: () => {} });

  // Advance module modal
  const [advanceModal, setAdvanceModal] = useState(false);

  const [studentStats, setStudentStats] = useState<Record<string, AttendanceStats>>({});
  // Multi-professor: list of professor ids assigned to THIS class via junction.
  const [classProfessorIds, setClassProfessorIds] = useState<string[]>([]);
  // Multi-monitor: list of monitor ids assigned to THIS class via junction.
  const [classMonitorIds, setClassMonitorIds] = useState<string[]>([]);
  
  async function load() {
    if (!id) return;
    try {
      // Load all class context in parallel. Resilient: a single failure
      // (e.g. announcements offline) should not blank out the whole screen.
      const results = await Promise.allSettled([
        getClass(id),
        listEnrollmentsByClass(id),
        listProfilesByRole('aluno'),
        listProfilesByRole('professor'),
        listByClass(id),
        listVisibleAnnouncements(20),
        listMaterialsByClass(id),
        listModules(),
        listProfessorsOfClass(id),
        listProfilesByRole('monitor'),
        listMonitorsOfClass(id),
      ]);
      const v = <T,>(i: number, fallback: T): T => {
        const r = results[i];
        return r.status === 'fulfilled' ? (r.value as T) : fallback;
      };
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.warn(`[ClassDetailView.load] task #${i} failed:`, r.reason);
        }
      });
      const c          = v(0, null as Class | null);
      const enrolls    = v(1, [] as EnrollmentWithRelations[]);
      const studs      = v(2, [] as Profile[]);
      const profs      = v(3, [] as Profile[]);
      const allLessons = v(4, [] as ScheduledLesson[]);
      const allAnns    = v(5, [] as Announcement[]);
      const mats       = v(6, [] as ClassMaterial[]);
      const mods       = v(7, [] as Module[]);
      const classProfs = v(8, [] as string[]);
      const mons       = v(9, [] as Profile[]);
      const classMons  = v(10, [] as string[]);
      setCls(c);
      setStudents(studs);
      setProfessors(profs);
      setMonitors(mons);
      setModules(mods);
      setClassProfessorIds(classProfs);
      setClassMonitorIds(classMons);
      setLessons(allLessons.sort((a,b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime()));
      setMaterials(mats);

      // Assignments + submissions
      const allAssign = await listAssignmentsByClass(id);
      setAssignments(allAssign);
      if (allAssign.length > 0) {
        const allSubs = await listSubmissionsByAssignments(allAssign.map(a => a.id));
        const grouped: Record<string, Submission[]> = {};
        for (const s of allSubs) {
          if (!grouped[s.assignment_id]) grouped[s.assignment_id] = [];
          grouped[s.assignment_id].push(s);
        }
        setSubmissionsMap(grouped);
      }

      const classAnns = allAnns.filter(a => a.class_id === id || a.class_id === null);
      setAnnouncements(classAnns);

      // Announcement reads
      const annIds = classAnns.map(a => a.id);
      const [counts, readSet] = await Promise.all([
        getReadCountsBatch(annIds),
        profile ? getUserReadSet(profile.id, annIds) : Promise.resolve(new Set<string>()),
      ]);
      setReadCounts(counts);
      setUserReadSet(readSet);
      
      const enriched: EnrollmentWithRelations[] = enrolls.map(e => ({
        ...e,
        student: studs.find(s => s.id === e.student_id)
      }));
      setEnrollments(enriched);

      // Stats per student scoped to THIS class's lessons only
      const lessonIds = allLessons.map(l => l.id);
      const allAttendance = await listByScheduledLessonIds(lessonIds);
      const map: Record<string, AttendanceStats> = {};
      for (const e of enriched) {
        const studentAtt = allAttendance.filter(a => a.student_id === e.student_id);
        const total = studentAtt.length;
        const present = studentAtt.filter(a => a.status === 'present').length;
        const absent = studentAtt.filter(a => a.status === 'absent').length;
        const justified = studentAtt.filter(a => a.status === 'justified').length;
        map[e.student_id] = {
          total,
          present,
          absent,
          justified,
          percentage: total > 0 ? Math.round((present / total) * 100) : 0,
        };
      }
      setStudentStats(map);

    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  function openEnroll() {
    setEnrollStudentId(students[0]?.id ?? '');
    setEnrollModal(true);
  }

  async function handleEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !enrollStudentId) return;
    setSaving(true);
    try {
      const newEnrollment = await createEnrollment({ class_id: id, student_id: enrollStudentId, status: 'active' });
      const student = students.find(s => s.id === enrollStudentId);
      setEnrollments(prev => [...prev, { ...newEnrollment, student }]);
      setEnrollModal(false);
      showToast('Aluno matriculado com sucesso.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao matricular.', 'error');
    } finally {
      setSaving(false);
    }
  }

  function requestRemoveEnrollment(enrollmentId: string, studentName: string) {
    setConfirmModal({
      open: true,
      title: 'Remover Matrícula',
      message: `Deseja realmente remover a matrícula de "${studentName}"? Esta ação não pode ser desfeita.`,
      onConfirm: async () => {
        await deleteEnrollment(enrollmentId);
        setEnrollments(prev => prev.filter(e => e.id !== enrollmentId));
        showToast('Matrícula removida.', 'success');
        setConfirmModal(prev => ({ ...prev, open: false }));
      },
    });
  }

  async function handleMarkRead(announcementId: string) {
    if (!profile) return;
    try {
      await markAnnouncementRead(announcementId, profile.id);
      setUserReadSet(prev => new Set([...prev, announcementId]));
      setReadCounts(prev => ({ ...prev, [announcementId]: (prev[announcementId] ?? 0) + 1 }));
      showToast('Marcado como lido.', 'success');
    } catch (err) {
      showToast('Erro ao marcar como lido.', 'error');
    }
  }

  function openNewAnnouncement() {
    setEditingAnnouncement(null);
    setAnnTitle('');
    setAnnContent('');
    setAnnouncementModal(true);
  }

  function openEditAnnouncement(a: Announcement) {
    setEditingAnnouncement(a);
    setAnnTitle(a.title);
    setAnnContent(a.content);
    setAnnouncementModal(true);
  }

  async function handleSubmitAnnouncement(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !profile) return;
    if (!annTitle.trim() || !annContent.trim()) {
      showToast('Preencha título e conteúdo.', 'error');
      return;
    }
    setAnnSaving(true);
    try {
      if (editingAnnouncement) {
        await updateAnnouncement(editingAnnouncement.id, {
          title: annTitle.trim(),
          content: annContent.trim(),
        });
        setAnnouncements(prev => prev.map(a =>
          a.id === editingAnnouncement.id
            ? { ...a, title: annTitle.trim(), content: annContent.trim() }
            : a
        ));
        showToast('Aviso atualizado.', 'success');
      } else {
        const created = await createAnnouncement({
          class_id: id,
          author_id: profile.id,
          title: annTitle.trim(),
          content: annContent.trim(),
        });
        setAnnouncements(prev => [created, ...prev]);
        showToast('Aviso publicado. Notificações serão enviadas em instantes.', 'success');
      }
      setAnnouncementModal(false);
      setEditingAnnouncement(null);
      setAnnTitle('');
      setAnnContent('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao salvar aviso.', 'error');
    } finally {
      setAnnSaving(false);
    }
  }

  function requestDeleteAnnouncement(a: Announcement) {
    setConfirmModal({
      open: true,
      title: 'Excluir aviso',
      message: `Deseja realmente excluir o aviso "${a.title}"? Esta ação não pode ser desfeita.`,
      onConfirm: async () => {
        try {
          await deleteAnnouncement(a.id);
          setAnnouncements(prev => prev.filter(x => x.id !== a.id));
          showToast('Aviso excluído.', 'success');
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Erro ao excluir aviso.', 'error');
        } finally {
          setConfirmModal(prev => ({ ...prev, open: false }));
        }
      },
    });
  }

  async function openNewLesson() {
    setLessonDate('');
    setLessonTime('');
    setLessonDuration(60);
    setLessonSelectedId('');
    // Pre-select the only class professor when there's just one; otherwise
    // leave blank so the user is forced to make an explicit choice.
    setLessonProfessorId(classProfessorIds.length === 1 ? classProfessorIds[0] : '');
    setLessonModalityOverride('inherit');
    setLessonModal(true);
    if (cls) {
      setLoadingLessons(true);
      try {
        const moduleLessons = await listLessonsByModule(cls.module_id);
        // Filter out lessons already scheduled for this class
        const usedIds = lessons.filter(s => s.lesson_id).map(s => s.lesson_id!);
        setAvailableLessons(moduleLessons.filter(l => !usedIds.includes(l.id)));
      } catch { setAvailableLessons([]); }
      finally { setLoadingLessons(false); }
    }
  }

  async function handleCreateLesson(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !lessonDate || !lessonTime) return;
    if (!lessonProfessorId) {
      showToast('Selecione um professor titular para a aula.', 'error');
      return;
    }
    setSaving(true);
    try {
      const scheduled_at = new Date(`${lessonDate}T${lessonTime}:00`).toISOString();
      const newLesson = await createScheduledLesson({
        class_id: id,
        lesson_id: lessonSelectedId || null,
        scheduled_at,
        duration_minutes: lessonDuration,
        professor_id: lessonProfessorId,
        // Só envia override em turma híbrida; demais permanecem null (herdam).
        modality: cls?.modality === 'hibrida' && lessonModalityOverride !== 'inherit'
          ? lessonModalityOverride
          : null,
      });
      setLessons(prev => [newLesson, ...prev].sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime()));
      setLessonModal(false);
      showToast('Aula agendada com sucesso.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao agendar aula.', 'error');
    } finally {
      setSaving(false);
    }
  }

  // Materials
  function openNewMaterial() {
    setMatTitle('');
    setMatUrl('');
    setMatType('link');
    setMaterialModal(true);
  }

  async function handleCreateMaterial(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !profile) return;
    setSaving(true);
    try {
      const newMat = await createMaterial({
        class_id: id,
        title: matTitle,
        url: matUrl,
        type: matType,
        uploaded_by: profile.id,
      });
      setMaterials(prev => [newMat, ...prev]);
      setMaterialModal(false);
      showToast('Material adicionado.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao adicionar material.', 'error');
    } finally {
      setSaving(false);
    }
  }

  function requestDeleteMaterial(materialId: string, title: string) {
    setConfirmModal({
      open: true,
      title: 'Excluir Material',
      message: `Deseja excluir o material "${title}"? Esta ação não pode ser desfeita.`,
      onConfirm: async () => {
        await deleteMaterial(materialId);
        setMaterials(prev => prev.filter(m => m.id !== materialId));
        showToast('Material excluído.', 'success');
        setConfirmModal(prev => ({ ...prev, open: false }));
      },
    });
  }

  // ── Assignments & Submissions handlers ─────────────────────────────────────

  function openNewAssignment() {
    setEditingAssignment(null);
    setAsgTitle('');
    setAsgDescription('');
    setAsgDueDate('');
    setAsgMaxScore(10);
    setAsgStatus('draft');
    setAssignmentModal(true);
  }

  function openEditAssignment(a: Assignment) {
    setEditingAssignment(a);
    setAsgTitle(a.title);
    setAsgDescription(a.description || '');
    setAsgDueDate(a.due_date ? a.due_date.slice(0, 16) : '');
    setAsgMaxScore(a.max_score);
    setAsgStatus(a.status === 'closed' ? 'published' : a.status);
    setAssignmentModal(true);
  }

  async function handleSaveAssignment(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !profile) return;
    setSaving(true);
    try {
      if (editingAssignment) {
        const updates = {
          title: asgTitle.trim(),
          description: asgDescription.trim() || null,
          due_date: asgDueDate ? new Date(asgDueDate).toISOString() : null,
          max_score: asgMaxScore,
          status: asgStatus as any,
        };
        await updateAssignment(editingAssignment.id, updates);
        setAssignments(prev => prev.map(a => a.id === editingAssignment.id ? { ...a, ...updates } : a));
        showToast('Tarefa atualizada.', 'success');
      } else {
        const newAsg = await createAssignment({
          class_id: id,
          title: asgTitle.trim(),
          description: asgDescription.trim() || null,
          due_date: asgDueDate ? new Date(asgDueDate).toISOString() : null,
          max_score: asgMaxScore,
          status: asgStatus as any,
          created_by: profile.id,
        });
        setAssignments(prev => [newAsg, ...prev]);
        showToast('Tarefa criada.', 'success');
      }
      setAssignmentModal(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao salvar tarefa.', 'error');
    } finally {
      setSaving(false);
    }
  }

  function requestDeleteAssignment(asgId: string, title: string) {
    setConfirmModal({
      open: true,
      title: 'Excluir Tarefa',
      message: `Deseja excluir a tarefa "${title}"? Todas as entregas serão perdidas.`,
      onConfirm: async () => {
        await deleteAssignment(asgId);
        setAssignments(prev => prev.filter(a => a.id !== asgId));
        setSubmissionsMap(prev => {
          const next = { ...prev };
          delete next[asgId];
          return next;
        });
        showToast('Tarefa excluída.', 'success');
        setConfirmModal(prev => ({ ...prev, open: false }));
      },
    });
  }

  async function handleSubmitWork(e: React.FormEvent) {
    e.preventDefault();
    if (!submitModal || !profile) return;
    setSaving(true);
    try {
      const sub = await submitWork({
        assignment_id: submitModal.id,
        student_id: profile.id,
        content: submitContent.trim() || null,
        file_url: submitFileUrl.trim() || null,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
      });
      setSubmissionsMap(prev => {
        const list = prev[submitModal.id] || [];
        const idx = list.findIndex(s => s.student_id === profile.id);
        if (idx >= 0) list[idx] = sub;
        else list.push(sub);
        return { ...prev, [submitModal.id]: [...list] };
      });
      setSubmitModal(null);
      setSubmitContent('');
      setSubmitFileUrl('');
      showToast('Entrega realizada com sucesso!', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao enviar entrega.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleGradeSubmission(e: React.FormEvent) {
    e.preventDefault();
    if (!gradeModal || !profile) return;
    setSaving(true);
    try {
      await gradeSubmission(gradeModal.submission.id, gradeScore, gradeFeedback.trim() || null, profile.id);
      setSubmissionsMap(prev => {
        const list = prev[gradeModal.assignment.id] || [];
        return {
          ...prev,
          [gradeModal.assignment.id]: list.map(s =>
            s.id === gradeModal.submission.id
              ? { ...s, score: gradeScore, feedback: gradeFeedback.trim() || null, status: 'graded' as const, graded_by: profile.id, graded_at: new Date().toISOString() }
              : s,
          ),
        };
      });
      setGradeModal(null);
      showToast('Nota atribuída.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao avaliar.', 'error');
    } finally {
      setSaving(false);
    }
  }

  // ── Module Progression (Fase 4) ────────────────────────────────────────────

  const currentModule = useMemo(() => modules.find(m => m.id === cls?.module_id), [modules, cls]);
  const nextModule = useMemo(() => {
    if (!currentModule) return null;
    return modules
      .filter(m => m.order_index > currentModule.order_index)
      .sort((a, b) => a.order_index - b.order_index)[0] || null;
  }, [modules, currentModule]);
  const isLastModule = useMemo(() => {
    if (!currentModule) return false;
    const maxOrder = Math.max(...modules.map(m => m.order_index));
    return currentModule.order_index >= maxOrder;
  }, [modules, currentModule]);

  // Reprovação: >=3 faltas → failed
  const MAX_ABSENCES = 3;
  const failedStudentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [sid, stats] of Object.entries(studentStats)) {
      if (stats.absent >= MAX_ABSENCES) ids.add(sid);
    }
    return ids;
  }, [studentStats]);

  // Compute grade averages per student
  const studentGrades = useMemo(() => {
    const map: Record<string, { avg: number; graded: number; total: number }> = {};
    const allSubs = Object.values(submissionsMap).flat();
    for (const e of enrollments) {
      const subs = allSubs.filter(s => s.student_id === e.student_id && s.status === 'graded' && s.score != null);
      const total = assignments.filter(a => a.status !== 'draft').length;
      if (subs.length > 0) {
        const avg = subs.reduce((sum, s) => sum + (s.score ?? 0), 0) / subs.length;
        map[e.student_id] = { avg: Math.round(avg * 100) / 100, graded: subs.length, total };
      } else {
        map[e.student_id] = { avg: 0, graded: 0, total };
      }
    }
    return map;
  }, [submissionsMap, enrollments, assignments]);

  async function handleAdvanceModule() {
    if (!cls || !id) return;
    setSaving(true);
    try {
      // 1. Mark failed students
      for (const e of enrollments) {
        if (failedStudentIds.has(e.student_id) && e.status === 'active') {
          await updateEnrollment(e.id, { status: 'failed' });
        }
      }

      if (isLastModule) {
        // Graduation: mark active students as graduated, class as completed
        for (const e of enrollments) {
          if (e.status === 'active' && !failedStudentIds.has(e.student_id)) {
            await updateEnrollment(e.id, { status: 'graduated' });
          }
        }
        await updateClass(id, { status: 'completed' });
        showToast('Turma concluída! Alunos aprovados foram graduados.', 'success');
      } else if (nextModule) {
        // Advance to next module
        // Failed students get 'failed' status (already done above)
        await updateClass(id, { module_id: nextModule.id });
        showToast(`Turma avançou para ${nextModule.name}.`, 'success');
      }

      setAdvanceModal(false);
      // Optimistic: update enrollments and class locally
      setEnrollments(prev => prev.map(e => {
        if (failedStudentIds.has(e.student_id) && e.status === 'active') return { ...e, status: 'failed' as const };
        if (isLastModule && e.status === 'active') return { ...e, status: 'graduated' as const };
        return e;
      }));
      if (isLastModule) {
        setCls(prev => prev ? { ...prev, status: 'completed' as const } : prev);
      } else if (nextModule) {
        setCls(prev => prev ? { ...prev, module_id: nextModule.id } : prev);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao avançar módulo.', 'error');
    } finally {
      setSaving(false);
    }
  }

  // Enrollment counts
  const activeEnrollments = enrollments.filter(e => e.status === 'active');
  const totalStudentsForReadCalc = activeEnrollments.length;
  const avgAttendance = useMemo(() => {
    if (activeEnrollments.length === 0) return 0;
    const sum = activeEnrollments.reduce((acc, e) => acc + (studentStats[e.student_id]?.percentage ?? 0), 0);
    return Math.round(sum / activeEnrollments.length);
  }, [activeEnrollments, studentStats]);

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-iv-accent" /></div>;
  }

  if (!cls) {
    return <div className="p-6 text-center text-iv-muted">Turma não encontrada.</div>;
  }

  const classProfList = professors.filter((p) => classProfessorIds.includes(p.id));
  const profDisplay = classProfList.length === 0
    ? 'Sem professor'
    : classProfList.length <= 2
      ? classProfList.map((p) => p.full_name).join(', ')
      : `${classProfList[0].full_name} +${classProfList.length - 1}`;
  const isCoord = profile?.role === 'coordenacao';
  const isProf = profile?.role === 'professor';
  const canManage = isCoord || isProf;
  const role = profile?.role;
  const isMonitor = role === 'monitor';
  // Monitors assigned to this class can view (read-only) the Monitores tab
  // so they know who else is monitoring. Add/remove controls remain coord-only.
  const isAssignedMonitor = isMonitor && profile?.id ? classMonitorIds.includes(profile.id) : false;
  const canViewMonitors = canManage || isAssignedMonitor;
  const tabItems: Array<{ id: ClassTab; label: string; icon: React.ReactNode }> = [
    { id: 'mural', label: 'Geral', icon: <Megaphone size={14} /> },
    { id: 'aulas', label: 'Aulas', icon: <CalendarDays size={14} /> },
    { id: 'membros', label: 'Membros', icon: <Users size={14} /> },
    ...(canManage ? [{ id: 'professores' as const, label: 'Professores', icon: <GraduationCap size={14} /> }] : []),
    ...(canViewMonitors ? [{ id: 'monitores' as const, label: 'Monitores', icon: <Headphones size={14} /> }] : []),
    { id: 'materiais', label: 'Materiais', icon: <FileText size={14} /> },
    { id: 'tarefas', label: 'Tarefas', icon: <ClipboardList size={14} /> },
    { id: 'reposicao', label: 'Reposição', icon: <Film size={14} /> },
    ...(isCoord ? [{ id: 'config' as const, label: 'Gestão', icon: <Settings size={14} /> }] : []),
  ];
  
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
      <div className="glass-panel p-3 sm:p-4 space-y-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <button
            onClick={() => navigate('/turmas')}
            className="p-2 rounded-xl border border-white/8 bg-iv-card hover:bg-white/5 transition-colors text-iv-muted native-pressable shrink-0"
            aria-label="Voltar para Turmas"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wide text-iv-muted">Detalhes da turma</p>
            <h2 className="text-base sm:text-xl font-bold text-iv-text leading-tight break-words">{cls.name}</h2>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs text-iv-muted min-w-0">
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-white/5 border border-white/10 max-w-full">
                <Users size={12} className="shrink-0" />
                <span>{activeEnrollments.length} ativos</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-white/5 border border-white/10 max-w-full">
                <span className="truncate" title={classProfList.map((p) => p.full_name).join(', ')}>{profDisplay}</span>
              </span>
              {currentModule && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border" style={{ backgroundColor: currentModule.color + '20', color: currentModule.color, borderColor: currentModule.color + '40' }}>
                  {currentModule.name}
                </span>
              )}
              {cls.status === 'completed' && (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  <GraduationCap size={12} /> Concluída
                </span>
              )}
              {(() => {
                const m = cls.modality ?? 'online';
                const cfg = {
                  online:     { label: '🟢 Online',     cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
                  presencial: { label: '🏛️ Presencial', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
                  hibrida:    { label: '🔀 Híbrida',    cls: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
                }[m];
                return (
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] border ${cfg.cls}`}>
                    {cfg.label}
                  </span>
                );
              })()}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Alunos</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{activeEnrollments.length}</p>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Aulas</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{lessons.length}</p>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-2.5 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-iv-muted">Frequência</p>
            <p className="text-sm font-semibold text-iv-text mt-0.5">{avgAttendance}%</p>
          </div>
        </div>
      </div>

      <div className="glass-panel p-3 sm:p-4 space-y-3">
        <div className="sm:hidden">
          <label className="text-[11px] uppercase tracking-wide text-iv-muted">Seção</label>
          <select
            value={activeTab}
            onChange={(e) => setActiveTab(e.target.value as typeof activeTab)}
            className="mt-1.5 w-full rounded-xl bg-iv-bg border border-white/10 text-iv-text text-sm px-3 py-2.5 focus:outline-none focus:border-iv-accent/50"
          >
            {tabItems.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="hidden sm:flex flex-wrap items-center gap-2">
          {tabItems.map((t) => (
            <TabButton key={t.id} id={t.id} icon={t.icon} label={t.label} active={activeTab} onClick={setActiveTab} />
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="pt-2">
        {activeTab === 'mural' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-3">
                {canManage && (
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-xs uppercase tracking-wider text-iv-muted font-semibold">Avisos da turma</h4>
                    <button
                      onClick={openNewAnnouncement}
                      className="inline-flex items-center gap-1.5 text-xs bg-iv-accent hover:bg-iv-accent-hover text-white px-3 py-2 rounded-lg transition-colors font-medium touch-target"
                    >
                      <Plus size={14} /> Novo aviso
                    </button>
                  </div>
                )}
                {announcements.length === 0 ? (
                  <EmptyState title="Nenhum aviso" description="Nenhum aviso publicado ainda." />
                ) : (
                  announcements.map(a => {
                    const isRead = userReadSet.has(a.id);
                    const count = readCounts[a.id] ?? 0;
                    const canEditThis = isCoord || (isProf && a.author_id === profile?.id);
                    return (
                      <div key={a.id} className={`glass-panel p-4 space-y-2 border ${isRead ? 'border-emerald-500/20' : 'border-white/8'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-iv-text">{a.title}</p>
                            <p className="text-xs text-iv-muted">{new Date(a.created_at).toLocaleDateString('pt-BR')} {a.class_id ? '' : '• Geral'}</p>
                          </div>
                          {canEditThis && (
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => openEditAnnouncement(a)}
                                aria-label="Editar aviso"
                                className="p-2 rounded-lg text-iv-muted hover:text-iv-accent hover:bg-iv-accent/10 transition-colors touch-target"
                              >
                                <Edit3 size={14} />
                              </button>
                              <button
                                onClick={() => requestDeleteAnnouncement(a)}
                                aria-label="Excluir aviso"
                                className="p-2 rounded-lg text-iv-muted hover:text-red-400 hover:bg-red-500/10 transition-colors touch-target"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          )}
                        </div>
                        <p className="text-sm text-iv-muted leading-relaxed mt-2 whitespace-pre-wrap">{a.content}</p>
                        <div className="flex items-center justify-between pt-2 border-t border-white/5">
                          {isRead ? (
                            <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 size={14}/> Lido</span>
                          ) : (
                            <button
                              onClick={() => handleMarkRead(a.id)}
                              className="text-xs bg-iv-accent/10 text-iv-accent hover:bg-iv-accent hover:text-white px-3 py-1 rounded-lg flex items-center gap-1 transition-colors"
                            >
                              <CheckCircle2 size={14}/> Marcar como lido
                            </button>
                          )}
                          {(isCoord || isProf) && totalStudentsForReadCalc > 0 && (
                            <span className="text-xs text-iv-muted">{count}/{totalStudentsForReadCalc} leram</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="glass-panel p-4 border border-white/8 h-fit">
                 <h4 className="text-sm font-semibold uppercase tracking-wider text-iv-muted mb-3">Aulas Pendentes ({lessons.filter(l => l.status === 'scheduled').length})</h4>
                 {lessons.filter(l => l.status === 'scheduled').length === 0 ? (
                    <p className="text-sm text-iv-muted">Nenhuma aula programada.</p>
                 ) : (
                    <ul className="space-y-2">
                      {lessons.filter(l => l.status === 'scheduled').slice(0, 3).map(l => (
                        <li key={l.id} className="text-sm text-iv-text flex items-center justify-between border-b last:border-0 border-white/5 pb-2">
                          <div className="flex flex-col">
                            <span>{new Date(l.scheduled_at).toLocaleDateString('pt-BR')}</span>
                          </div>
                          <span className="text-xs bg-white/10 px-2 py-1 rounded">{l.duration_minutes} min</span>
                        </li>
                      ))}
                    </ul>
                 )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'aulas' && (
          <div className="glass-panel p-4 space-y-4">
             <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-2">
               <div>
                  <h3 className="font-semibold text-iv-text">Painel de Aulas</h3>
                  <p className="text-xs text-iv-muted">({lessons.length}) Total de aulas em histórico</p>
               </div>
               {isCoord && (
                 <button onClick={openNewLesson} className="text-xs bg-iv-accent text-white px-3 py-1.5 rounded-lg flex items-center gap-2 touch-target">
                   <Calendar size={14} />
                   <span className="hidden sm:inline">Agendar Nova Aula</span><span className="sm:hidden">Agendar</span>
                 </button>
               )}
             </div>
             {lessons.length === 0 ? (
               <EmptyState 
                 icon={<CalendarDays size={32} />} 
                 title="Agenda vazia" 
                 description="Nenhuma aula agendada para esta turma." 
               />
             ) : (
               <div className="space-y-2">
                 {lessons.map(l => {
                   const lessonModality = effectiveLessonModality(l, cls);
                   const isPresencialLesson = lessonModality === 'presencial';
                   return (
                   <div key={l.id} className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 p-3 rounded-xl border border-white/8 bg-white/[0.02]">
                     <div className="flex items-center gap-3 min-w-0">
                       <div className="flex flex-col items-center justify-center bg-white/5 w-12 h-12 rounded-xl shrink-0 border border-white/10">
                         <span className="text-[10px] uppercase font-semibold text-iv-muted">{new Date(l.scheduled_at).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</span>
                         <span className="text-lg font-bold text-iv-text leading-none">{new Date(l.scheduled_at).getDate()}</span>
                       </div>
                       
                       <div className="min-w-0">
                         <p className="text-sm font-bold text-iv-text flex flex-wrap items-center gap-2">
                           {new Date(l.scheduled_at).toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}
                           {l.status === 'in_progress' && (
                             <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded uppercase tracking-wider animate-pulse flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-400"></span> Ao Vivo</span>
                           )}
                           {l.status === 'completed' && (
                             <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded uppercase tracking-wider">Finalizada</span>
                           )}
                           {lessonModality !== 'online' && (
                             <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider border ${
                               isPresencialLesson
                                 ? 'bg-amber-500/15 text-amber-300 border-amber-500/20'
                                 : 'bg-purple-500/15 text-purple-300 border-purple-500/20'
                             }`}>
                               {isPresencialLesson ? 'Presencial' : 'Híbrida'}
                             </span>
                           )}
                         </p>
                         <p className="text-xs text-iv-muted mt-1 truncate">{l.duration_minutes} minutos previstos</p>
                       </div>
                     </div>
                     <div className="flex justify-end shrink-0 w-full sm:w-auto">
                       {l.status === 'completed' ? (
                         <button onClick={() => navigate(`/relatorios?aula=${l.id}`)} className="text-xs font-medium text-iv-muted hover:text-white transition-colors bg-white/5 hover:bg-white/10 px-3 py-2 sm:py-1.5 rounded-lg flex items-center justify-center gap-1.5 touch-target sm:min-h-0 sm:min-w-0 w-full sm:w-auto">
                           Visualizar Relatório
                         </button>
                       ) : isPresencialLesson ? (
                         // Aula presencial — sem sala virtual. Coordenação/monitor registra presença manualmente.
                         canManage ? (
                           <button onClick={() => navigate(`/presencas?aula=${l.id}`)} className="text-xs font-medium text-amber-300 hover:text-white transition-colors bg-amber-500/15 hover:bg-amber-500/30 border border-amber-500/20 px-3 py-2 sm:py-1.5 rounded-lg flex items-center justify-center gap-1.5 touch-target sm:min-h-0 sm:min-w-0 w-full sm:w-auto">
                             🏛️ Registrar presença
                           </button>
                         ) : (
                           <span className="text-xs text-amber-300/70 flex items-center justify-center gap-1.5 px-3 py-1.5 cursor-default w-full sm:w-auto">
                             🏛️ Aula presencial
                           </span>
                         )
                       ) : (canManage || l.status === 'in_progress') ? (
                         // Staff can always enter (to start the lesson); students only after host clicks "Iniciar"
                         <button onClick={() => navigate(`/sala/${l.room_id || l.id}?aula=${l.id}`)} className="text-xs font-medium text-iv-accent hover:text-white transition-colors bg-iv-accent/10 hover:bg-iv-accent px-3 py-2 sm:py-1.5 rounded-lg flex items-center justify-center gap-1.5 touch-target sm:min-h-0 sm:min-w-0 w-full sm:w-auto">
                           <Play size={14} /> Entrar
                         </button>
                       ) : (
                         // Lesson scheduled but not yet started — hide entry point for students
                         <span className="text-xs text-iv-muted/50 flex items-center justify-center gap-1.5 px-3 py-1.5 cursor-default w-full sm:w-auto">
                           <Clock size={12} /> Aguardando início
                         </span>
                       )}
                     </div>
                   </div>
                   );
                 })}
               </div>
             )}
          </div>
        )}

        {activeTab === 'membros' && (
           <div className="glass-panel p-4 space-y-4">
             <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
               <div>
                  <h3 className="font-semibold text-iv-text">Alunos Matriculados</h3>
                  <p className="text-xs text-iv-muted">Análise e histórico. ({enrollments.length} total, {activeEnrollments.length} ativos)</p>
               </div>
               {isCoord && (
                 <button onClick={openEnroll} className="text-xs font-medium bg-iv-accent hover:bg-iv-accent-hover text-white px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors touch-target">
                   <span className="hidden sm:inline">Adicionar Estudante</span><span className="sm:hidden">Adicionar</span>
                 </button>
               )}
             </div>
             
             {enrollments.length === 0 ? (
               <EmptyState 
                 icon={<Users size={32} />} 
                 title="Sem alunos" 
                 description="Esta turma ainda não tem matrículas." 
               />
             ) : (
               <div className="space-y-3">
                 {enrollments.map(e => {
                   const stats = studentStats[e.student_id] || { percentage: 0, absent: 0 };
                   const freq = stats.percentage;
                   const isFailed = failedStudentIds.has(e.student_id);
                   const isGraduated = e.status === 'graduated';
                   const isDropped = e.status === 'dropped';
                   const isFailedStatus = e.status === 'failed';
                   const isInactive = isGraduated || isDropped || isFailedStatus;
                   
                   let colorClass = 'text-emerald-400';
                   if (freq < 75 && freq >= 50) colorClass = 'text-amber-400';
                   if (freq < 50) colorClass = 'text-red-400';

                   return (
                     <div key={e.id} className={`group flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 p-3 rounded-xl border transition-all bg-white/[0.02] ${isInactive ? 'border-white/5 opacity-60' : isFailed ? 'border-red-500/20' : 'border-white/8 hover:border-iv-accent/20'}`}>
                       <div className="flex items-center gap-3">
                         <div className="relative flex items-center justify-center">
                           <ProgressRing radius={20} stroke={2.5} progress={freq} colorClass={colorClass} />
                           <span className={`absolute text-[9px] font-bold ${colorClass}`}>{freq}<Percent size={8} className="inline opacity-0"/></span>
                         </div>
                         <div>
                           <span className="text-sm font-medium text-iv-text flex items-center gap-2">
                             {e.student?.full_name}
                             {isFailed && e.status === 'active' && (
                               <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded flex items-center gap-1">
                                 <AlertTriangle size={10}/> {stats.absent}+ faltas
                               </span>
                             )}
                           </span>
                           <p className="text-[11px] text-iv-muted">{e.student?.email}</p>
                           {studentGrades[e.student_id]?.graded > 0 && (
                             <p className="text-[11px] text-iv-muted flex items-center gap-1 mt-0.5">
                               <Star size={10} className="text-amber-400" />
                               Média: <span className="font-medium text-iv-text">{studentGrades[e.student_id].avg}</span>
                               <span className="text-iv-muted/60">({studentGrades[e.student_id].graded}/{studentGrades[e.student_id].total} tarefas)</span>
                             </p>
                           )}
                         </div>
                       </div>
                       <div className="flex items-center gap-3">
                         <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                           e.status === 'active' && !isFailed ? 'bg-emerald-500/10 text-emerald-400' :
                           e.status === 'active' && isFailed ? 'bg-red-500/10 text-red-400' :
                           e.status === 'graduated' ? 'bg-blue-500/10 text-blue-400' :
                           e.status === 'failed' ? 'bg-red-500/10 text-red-400' :
                           'bg-gray-500/10 text-gray-400'}`}>
                           {e.status === 'active' && !isFailed ? 'Ativo' : 
                            e.status === 'active' && isFailed ? 'Reprovado' :
                            e.status === 'graduated' ? 'Formado' : 
                            e.status === 'failed' ? 'Reprovado' :
                            e.status === 'dropped' ? 'Desistente' : 'Inativo'}
                         </span>
                         {isCoord && e.status === 'active' && (
                           <button 
                             onClick={() => requestRemoveEnrollment(e.id, e.student?.full_name ?? 'Aluno')} 
                             className="text-xs text-red-400 hover:text-red-300 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity p-1"
                           >
                             Remover
                           </button>
                         )}
                       </div>
                     </div>
                   );
                 })}
               </div>
             )}
           </div>
        )}

        {/* Professores Tab (Coordenação + Professor podem visualizar; só coord altera) */}
        {activeTab === 'professores' && canManage && (
          <div className="glass-panel p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div>
                <h3 className="font-semibold text-iv-text">Professores da Turma</h3>
                <p className="text-xs text-iv-muted">
                  {classProfList.length === 0
                    ? 'Nenhum professor atribuído'
                    : `${classProfList.length} professor(es) com acesso`}
                </p>
              </div>
            </div>

            {classProfList.length === 0 ? (
              <EmptyState
                icon={<GraduationCap size={32} />}
                title="Sem professores atribuídos"
                description={isCoord ? 'Adicione abaixo o primeiro professor.' : 'Apenas coordenação pode atribuir professores.'}
              />
            ) : (
              <ul className="space-y-2">
                {classProfList.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-white/8 bg-white/[0.02]">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-iv-text truncate">{p.full_name}</p>
                      <p className="text-[11px] text-iv-muted truncate">{p.email}</p>
                    </div>
                    {isCoord && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (!cls) return;
                          try {
                            await removeProfessorFromClass(cls.id, p.id);
                            setClassProfessorIds((prev) => prev.filter((id) => id !== p.id));
                            showToast(`${p.full_name} removido(a) da turma.`, 'info');
                          } catch (err) {
                            showToast(err instanceof Error ? err.message : 'Erro ao remover professor.', 'error');
                          }
                        }}
                        className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded-lg transition-colors native-pressable"
                        aria-label={`Remover ${p.full_name} da turma`}
                      >
                        Remover
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {isCoord && (
              <div className="pt-3 border-t border-white/8 space-y-2">
                <label className="text-xs text-iv-muted">Adicionar professor</label>
                <div className="flex gap-2">
                  <select
                    value={profAssignSelectedId}
                    onChange={(e) => setProfAssignSelectedId(e.target.value)}
                    className="flex-1 px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm"
                  >
                    <option value="">Selecione um professor…</option>
                    {professors
                      .filter((p) => !classProfessorIds.includes(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>{p.full_name}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={!profAssignSelectedId || profSaving || !cls}
                    onClick={async () => {
                      if (!cls || !profAssignSelectedId) return;
                      setProfSaving(true);
                      try {
                        await addProfessorToClass(cls.id, profAssignSelectedId);
                        const added = professors.find((p) => p.id === profAssignSelectedId);
                        setClassProfessorIds((prev) => [...prev, profAssignSelectedId]);
                        setProfAssignSelectedId('');
                        showToast(`${added?.full_name ?? 'Professor'} adicionado(a) à turma.`, 'success');
                      } catch (err) {
                        showToast(err instanceof Error ? err.message : 'Erro ao adicionar professor.', 'error');
                      } finally {
                        setProfSaving(false);
                      }
                    }}
                    className="px-4 py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed native-pressable"
                  >
                    {profSaving ? 'Adicionando…' : 'Adicionar'}
                  </button>
                </div>
                <p className="text-[11px] text-iv-muted">
                  Professores adicionados aqui passam a ter acesso à turma e podem ser atribuídos a aulas individuais no calendário.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Monitores Tab */}
        {activeTab === 'monitores' && canViewMonitors && (() => {
          const classMonList = monitors.filter((m) => classMonitorIds.includes(m.id));
          return (
          <div className="glass-panel p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div>
                <h3 className="font-semibold text-iv-text">Monitores da Turma</h3>
                <p className="text-xs text-iv-muted">
                  {classMonList.length === 0
                    ? 'Nenhum monitor atribuído'
                    : `${classMonList.length} monitor(es) com acesso`}
                </p>
              </div>
            </div>

            {classMonList.length === 0 ? (
              <EmptyState
                icon={<Headphones size={32} />}
                title="Sem monitores atribuídos"
                description={isCoord ? 'Adicione abaixo o primeiro monitor.' : 'Apenas coordenação pode atribuir monitores.'}
              />
            ) : (
              <ul className="space-y-2">
                {classMonList.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-white/8 bg-white/[0.02]">
                    <div className="min-w-0 flex items-center gap-2">
                      <div className="w-9 h-9 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center font-bold shrink-0">
                        {m.full_name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-iv-text truncate">{m.full_name}</p>
                        <p className="text-[11px] text-iv-muted truncate">{m.email}</p>
                      </div>
                    </div>
                    {isCoord && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (!cls) return;
                          try {
                            await removeMonitorFromClass(cls.id, m.id);
                            setClassMonitorIds((prev) => prev.filter((mid) => mid !== m.id));
                            showToast(`${m.full_name} removido(a) da turma.`, 'info');
                          } catch (err) {
                            showToast(err instanceof Error ? err.message : 'Erro ao remover monitor.', 'error');
                          }
                        }}
                        className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded-lg transition-colors native-pressable"
                        aria-label={`Remover ${m.full_name} da turma`}
                      >
                        Remover
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {isCoord && (
              <div className="pt-3 border-t border-white/8 space-y-2">
                <label className="text-xs text-iv-muted">Adicionar monitor</label>
                <div className="flex gap-2">
                  <select
                    value={monAssignSelectedId}
                    onChange={(e) => setMonAssignSelectedId(e.target.value)}
                    className="flex-1 px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm"
                  >
                    <option value="">Selecione um monitor…</option>
                    {monitors
                      .filter((m) => !classMonitorIds.includes(m.id))
                      .map((m) => (
                        <option key={m.id} value={m.id}>{m.full_name}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={!monAssignSelectedId || monSaving || !cls}
                    onClick={async () => {
                      if (!cls || !monAssignSelectedId) return;
                      setMonSaving(true);
                      try {
                        await addMonitorToClass(cls.id, monAssignSelectedId);
                        const added = monitors.find((m) => m.id === monAssignSelectedId);
                        setClassMonitorIds((prev) => [...prev, monAssignSelectedId]);
                        setMonAssignSelectedId('');
                        showToast(`${added?.full_name ?? 'Monitor'} adicionado(a) à turma.`, 'success');
                      } catch (err) {
                        showToast(err instanceof Error ? err.message : 'Erro ao adicionar monitor.', 'error');
                      } finally {
                        setMonSaving(false);
                      }
                    }}
                    className="px-4 py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed native-pressable"
                  >
                    {monSaving ? 'Adicionando…' : 'Adicionar'}
                  </button>
                </div>
                <p className="text-[11px] text-iv-muted">
                  Monitores acompanham as aulas, podem marcar presença e moderar o chat das turmas atribuídas.
                </p>
              </div>
            )}
          </div>
          );
        })()}

        {/* Materials Tab */}
        {activeTab === 'materiais' && (
          <div className="glass-panel p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div>
                <h3 className="font-semibold text-iv-text">Materiais de Apoio</h3>
                <p className="text-xs text-iv-muted">Links, PDFs e vídeos da turma.</p>
              </div>
              {canManage && (
                <button onClick={openNewMaterial} className="text-xs bg-iv-accent text-white px-3 py-1.5 rounded-lg flex items-center gap-2 touch-target">
                  <Plus size={14}/> <span className="hidden sm:inline">Novo Material</span><span className="sm:hidden">Novo</span>
                </button>
              )}
            </div>
            {materials.length === 0 ? (
              <EmptyState icon={<FileText size={32}/>} title="Sem materiais" description="Nenhum material adicionado a esta turma." />
            ) : (
              <div className="space-y-2">
                {materials.map(m => (
                  <div key={m.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 rounded-xl border border-white/8 bg-white/[0.02] group">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        m.type === 'pdf' ? 'bg-red-500/10 text-red-400' :
                        m.type === 'video' ? 'bg-purple-500/10 text-purple-400' :
                        m.type === 'link' ? 'bg-blue-500/10 text-blue-400' :
                        'bg-gray-500/10 text-gray-400'
                      }`}>
                        {m.type === 'pdf' ? <FileText size={18}/> :
                         m.type === 'video' ? <Video size={18}/> :
                         <Link2 size={18}/>}
                      </div>
                      <div className="min-w-0">
                        <a href={m.url} target="_blank" rel="noopener noreferrer" className="block text-sm font-medium text-iv-text hover:text-iv-accent transition-colors truncate">
                          {m.title}
                        </a>
                        <p className="text-[11px] text-iv-muted">{m.type.toUpperCase()} • {new Date(m.created_at).toLocaleDateString('pt-BR')}</p>
                      </div>
                    </div>
                    {canManage && (
                      <button
                        onClick={() => requestDeleteMaterial(m.id, m.title)}
                        className="text-red-400 hover:text-red-300 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity p-2"
                      >
                        <Trash2 size={16}/>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tarefas Tab */}
        {activeTab === 'tarefas' && (
          <div className="space-y-4">
            <div className="glass-panel p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                <div>
                  <h3 className="font-semibold text-iv-text">Tarefas</h3>
                  <p className="text-xs text-iv-muted">{assignments.length} tarefa(s)</p>
                </div>
                {canManage && (
                  <button onClick={openNewAssignment} className="text-xs font-medium bg-iv-accent hover:bg-iv-accent-hover text-white px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors">
                    <Plus size={14} /> Nova Tarefa
                  </button>
                )}
              </div>

              {assignments.length === 0 ? (
                <EmptyState
                  icon={<ClipboardList size={32} />}
                  title="Sem tarefas"
                  description={canManage ? 'Crie a primeira tarefa para esta turma.' : 'Nenhuma tarefa publicada ainda.'}
                />
              ) : (
                <div className="space-y-3">
                  {assignments
                    .filter(a => canManage || a.status === 'published')
                    .map(a => {
                      const subs = submissionsMap[a.id] || [];
                      const mySub = role === 'aluno' && profile ? subs.find(s => s.student_id === profile.id) : null;
                      const gradedCount = subs.filter(s => s.status === 'graded').length;
                      const submittedCount = subs.filter(s => s.status === 'submitted' || s.status === 'graded').length;
                      const isOverdue = a.due_date && new Date(a.due_date) < new Date() && a.status === 'published';

                      return (
                        <div key={a.id} className="p-4 rounded-xl border border-white/8 bg-white/[0.02] space-y-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-iv-text flex items-center gap-2">
                                {a.title}
                                {a.status === 'draft' && (
                                  <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded uppercase">Rascunho</span>
                                )}
                                {a.status === 'closed' && (
                                  <span className="text-[10px] bg-gray-500/20 text-gray-400 px-1.5 py-0.5 rounded uppercase">Encerrada</span>
                                )}
                                {isOverdue && (
                                  <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded uppercase">Atrasada</span>
                                )}
                              </p>
                              {a.description && (
                                <p className="text-xs text-iv-muted mt-1 line-clamp-2">{a.description}</p>
                              )}
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-iv-muted">
                                {a.due_date && (
                                  <span className="flex items-center gap-1">
                                    <Calendar size={12} />
                                    {new Date(a.due_date).toLocaleDateString('pt-BR')} {new Date(a.due_date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                )}
                                <span>Nota máx: {a.max_score}</span>
                                {canManage && <span>{submittedCount} entrega(s) · {gradedCount} corrigida(s)</span>}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {/* Student: submit or view status */}
                              {role === 'aluno' && a.status === 'published' && (
                                mySub ? (
                                  <span className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 ${
                                    mySub.status === 'graded'
                                      ? 'bg-emerald-500/15 text-emerald-400'
                                      : mySub.status === 'submitted'
                                      ? 'bg-blue-500/15 text-blue-400'
                                      : 'bg-yellow-500/15 text-yellow-400'
                                  }`}>
                                    {mySub.status === 'graded' && <><Star size={12} /> {mySub.score}/{a.max_score}</>}
                                    {mySub.status === 'submitted' && <><CheckCircle2 size={12} /> Enviada</>}
                                    {mySub.status === 'returned' && <><Edit3 size={12} /> Devolvida</>}
                                    {mySub.status === 'pending' && 'Pendente'}
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => { setSubmitModal(a); setSubmitContent(''); setSubmitFileUrl(''); }}
                                    className="text-xs font-medium bg-iv-accent/10 text-iv-accent hover:bg-iv-accent hover:text-white px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors"
                                  >
                                    <Send size={12} /> Entregar
                                  </button>
                                )
                              )}
                              {/* Prof/Coord: view submissions, edit, delete */}
                              {canManage && (
                                <>
                                  <button
                                    onClick={() => openEditAssignment(a)}
                                    className="p-1.5 rounded-lg hover:bg-white/5 text-iv-muted hover:text-iv-text transition-colors"
                                    title="Editar"
                                  >
                                    <Edit3 size={14} />
                                  </button>
                                  <button
                                    onClick={() => requestDeleteAssignment(a.id, a.title)}
                                    className="p-1.5 rounded-lg hover:bg-red-500/10 text-iv-muted hover:text-red-400 transition-colors"
                                    title="Excluir"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>

                          {/* Prof/Coord: submission list for this assignment */}
                          {canManage && subs.length > 0 && (
                            <div className="border-t border-white/5 pt-3 space-y-2">
                              <p className="text-xs font-semibold text-iv-muted uppercase tracking-wider">Entregas</p>
                              {subs.map(s => {
                                const student = enrollments.find(e => e.student_id === s.student_id)?.student;
                                return (
                                    <div key={s.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-2 rounded-lg bg-white/[0.02] border border-white/5">
                                    <div className="min-w-0">
                                      <p className="text-xs font-medium text-iv-text truncate">{student?.full_name || 'Aluno'}</p>
                                      <p className="text-[10px] text-iv-muted">
                                        {s.submitted_at ? new Date(s.submitted_at).toLocaleDateString('pt-BR') : 'Não enviada'}
                                        {s.content && ` · "${s.content.slice(0, 50)}${s.content.length > 50 ? '…' : ''}"`}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      {s.status === 'graded' ? (
                                        <span className="text-xs text-emerald-400 font-medium">{s.score}/{a.max_score}</span>
                                      ) : s.status === 'submitted' ? (
                                        <button
                                          onClick={() => { setGradeModal({ submission: s, assignment: a }); setGradeScore(0); setGradeFeedback(''); }}
                                          className="text-xs font-medium bg-iv-accent/10 text-iv-accent hover:bg-iv-accent hover:text-white px-2.5 py-1 rounded-lg transition-colors"
                                        >
                                          Avaliar
                                        </button>
                                      ) : (
                                        <span className="text-[10px] text-iv-muted">{s.status}</span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Student: show feedback if graded */}
                          {role === 'aluno' && mySub?.status === 'graded' && mySub.feedback && (
                            <div className="border-t border-white/5 pt-3">
                              <p className="text-xs font-semibold text-iv-muted mb-1">Feedback do professor:</p>
                              <p className="text-xs text-iv-muted bg-white/[0.02] p-2 rounded-lg">{mySub.feedback}</p>
                            </div>
                          )}
                          {role === 'aluno' && mySub?.status === 'returned' && (
                            <div className="border-t border-white/5 pt-3 space-y-2">
                              {mySub.feedback && (
                                <div>
                                  <p className="text-xs font-semibold text-yellow-400 mb-1">Devolvida para revisão:</p>
                                  <p className="text-xs text-iv-muted bg-white/[0.02] p-2 rounded-lg">{mySub.feedback}</p>
                                </div>
                              )}
                              <button
                                onClick={() => { setSubmitModal(a); setSubmitContent(mySub.content || ''); setSubmitFileUrl(mySub.file_url || ''); }}
                                className="text-xs font-medium bg-iv-accent/10 text-iv-accent hover:bg-iv-accent hover:text-white px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors"
                              >
                                <Send size={12} /> Re-enviar
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Reposição Tab — recordings for this class, visible to all roles */}
        {activeTab === 'reposicao' && (
          <RecordingsTab classId={id!} />
        )}

        {/* Config / Gestão Tab (Coordenação only) */}
        {activeTab === 'config' && isCoord && (          <div className="space-y-4">
            <div className="glass-panel p-4 sm:p-5 space-y-4">
              <h3 className="font-semibold text-iv-text flex items-center gap-2"><Settings size={18}/> Gestão da Turma</h3>
              
              {/* Module Progress */}
              <div className="p-4 rounded-xl border border-white/8 bg-white/[0.02] space-y-3">
                <h4 className="text-sm font-semibold text-iv-text">Progressão de Módulo</h4>
                <div className="flex flex-wrap items-center gap-2 pb-1 max-w-full min-w-0">
                  {modules.sort((a,b) => a.order_index - b.order_index).map((m, i) => {
                    const isCurrent = m.id === cls.module_id;
                    const isPast = currentModule && m.order_index < currentModule.order_index;
                    return (
                      <React.Fragment key={m.id}>
                        {i > 0 && <ChevronRight size={14} className="text-iv-muted/40 shrink-0"/>}
                        <span className={`text-xs px-3 py-1.5 rounded-lg font-medium break-words ${
                          isCurrent ? 'bg-iv-accent text-white' :
                          isPast ? 'bg-emerald-500/20 text-emerald-400' :
                          'bg-white/5 text-iv-muted'
                        }`}>
                          {m.name}
                        </span>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* Failed students warning */}
              {failedStudentIds.size > 0 && (
                <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5 space-y-2">
                  <h4 className="text-sm font-semibold text-red-400 flex items-center gap-2">
                    <AlertTriangle size={16}/> Alunos em Situação de Reprovação
                  </h4>
                  <p className="text-xs text-iv-muted">
                    {failedStudentIds.size} aluno(s) com {MAX_ABSENCES}+ faltas. Ao avançar módulo, eles serão marcados como reprovados e não progredirão.
                  </p>
                  <ul className="space-y-1">
                    {enrollments.filter(e => failedStudentIds.has(e.student_id) && e.status === 'active').map(e => (
                      <li key={e.id} className="text-xs text-red-400">• {e.student?.full_name} ({studentStats[e.student_id]?.absent} faltas)</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Advance button */}
              {cls.status === 'active' && (
                <button
                  onClick={() => setAdvanceModal(true)}
                  className="w-full py-3 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2 bg-iv-accent hover:bg-iv-accent-hover text-white"
                >
                  {isLastModule ? (
                    <><GraduationCap size={18}/> Concluir Turma & Graduar Alunos</>
                  ) : (
                    <><ChevronRight size={18}/> Avançar para {nextModule?.name}</>
                  )}
                </button>
              )}

              {cls.status === 'completed' && (
                <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 text-center">
                  <GraduationCap size={24} className="text-emerald-400 mx-auto mb-2"/>
                  <p className="text-sm font-semibold text-emerald-400">Turma Concluída</p>
                  <p className="text-xs text-iv-muted mt-1">Todos os módulos foram finalizados.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <Modal open={announcementModal} onClose={() => { if (!annSaving) { setAnnouncementModal(false); setEditingAnnouncement(null); } }} title={editingAnnouncement ? 'Editar aviso' : 'Novo aviso'}>
        <form onSubmit={handleSubmitAnnouncement} className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 text-xs bg-iv-bg border border-white/8 rounded-lg p-2.5">
            <span className="text-iv-muted">Turma:</span>
            <span className="font-bold text-iv-text">{cls.name}</span>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Título</label>
            <input
              type="text"
              value={annTitle}
              onChange={e => setAnnTitle(e.target.value)}
              required
              maxLength={120}
              placeholder="Ex.: Material da aula 3 disponível"
              className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Conteúdo</label>
            <textarea
              value={annContent}
              onChange={e => setAnnContent(e.target.value)}
              required
              rows={5}
              maxLength={2000}
              placeholder="Escreva o aviso aqui…"
              className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm resize-y"
            />
          </div>
          <p className="text-[11px] text-iv-muted">
            Os membros da turma receberão uma notificação push em até 1 minuto.
          </p>
          <button type="submit" disabled={annSaving} className="w-full py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {annSaving && <Loader2 size={16} className="animate-spin" />}
            {editingAnnouncement ? 'Salvar alterações' : 'Publicar aviso'}
          </button>
        </form>
      </Modal>

      <Modal open={lessonModal} onClose={() => setLessonModal(false)} title="Agendar Nova Aula">
        <form onSubmit={handleCreateLesson} className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 text-xs bg-iv-bg border border-white/8 rounded-lg p-2.5">
            <span className="text-iv-muted">Turma selecionada:</span>
            <span className="font-bold text-iv-text">{cls.name}</span>
          </div>
          
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Aula (opcional)</label>
            <select
              value={lessonSelectedId}
              onChange={e => setLessonSelectedId(e.target.value)}
              disabled={loadingLessons}
              className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm"
            >
              <option value="">Nenhuma (aula livre)</option>
              {availableLessons.map(l => (
                <option key={l.id} value={l.id}>{l.title}</option>
              ))}
            </select>
            {loadingLessons && <p className="text-xs text-iv-muted">Carregando aulas…</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm text-iv-muted">Data</label>
              <input type="date" value={lessonDate} onChange={e => setLessonDate(e.target.value)} required className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm text-iv-muted">Horário</label>
              <input type="time" value={lessonTime} onChange={e => setLessonTime(e.target.value)} required className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Duração Estimada (min)</label>
            <input type="number" min="15" max="300" step="15" value={lessonDuration} onChange={e => setLessonDuration(parseInt(e.target.value))} required className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm" />
          </div>

          {cls.modality === 'hibrida' && (
            <div className="space-y-1.5">
              <label className="text-sm text-iv-muted">
                Modalidade desta aula <span className="text-red-400">*</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { v: 'inherit',    label: 'Herdar', hint: 'usa padrão da turma' },
                  { v: 'online',     label: '🟢 Online',     hint: 'WebRTC' },
                  { v: 'presencial', label: '🏛️ Presencial', hint: 'sem sala virtual' },
                ] as const).map((opt) => (
                  <button
                    type="button"
                    key={opt.v}
                    onClick={() => setLessonModalityOverride(opt.v)}
                    className={[
                      'px-2 py-2 rounded-xl text-xs border transition-colors text-center',
                      lessonModalityOverride === opt.v
                        ? 'bg-iv-accent/15 border-iv-accent text-iv-text'
                        : 'bg-iv-bg border-white/10 text-iv-muted hover:border-white/20',
                    ].join(' ')}
                  >
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-[10px] opacity-60 mt-0.5">{opt.hint}</div>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-iv-muted/70">
                Turma híbrida — escolha se esta aula específica será online ou presencial.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">
              Professor titular <span className="text-red-400">*</span>
            </label>
            <select
              value={lessonProfessorId}
              onChange={(e) => setLessonProfessorId(e.target.value)}
              required
              className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm"
            >
              <option value="">— Selecione o titular —</option>
              {professors
                .filter((p) => classProfessorIds.includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.full_name}</option>
                ))}
            </select>
            {classProfessorIds.length === 0 && (
              <p className="text-[11px] text-amber-400/80">
                Nenhum professor está vinculado a esta turma. Adicione um professor antes de agendar aulas.
              </p>
            )}
            <p className="text-[11px] text-iv-muted/70">
              Apenas o titular poderá iniciar, encerrar e gravar esta aula. A coordenação pode trocar o titular depois pela edição da aula.
            </p>
          </div>

          <button type="submit" disabled={saving} className="w-full py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {saving && <Loader2 size={16} className="animate-spin" />}
            Confirmar Agendamento
          </button>
        </form>
      </Modal>

      <Modal open={enrollModal} onClose={() => setEnrollModal(false)} title="Nova Matrícula">
        <form onSubmit={handleEnroll} className="space-y-4">
          <div>
            <label className="block text-sm text-iv-muted mb-1">Aluno</label>
            <select
              value={enrollStudentId}
              onChange={(e) => setEnrollStudentId(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-iv-bg border border-white/10 text-iv-text"
              required
            >
              {students.map((s) => (
                <option key={s.id} value={s.id}>{s.full_name}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="w-full py-2 bg-iv-accent hover:bg-iv-accent-hover text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          >
            {saving ? 'Salvando...' : 'Matricular'}
          </button>
        </form>
      </Modal>

      {/* Material Modal */}
      <Modal open={materialModal} onClose={() => setMaterialModal(false)} title="Novo Material">
        <form onSubmit={handleCreateMaterial} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Título</label>
            <input type="text" value={matTitle} onChange={e => setMatTitle(e.target.value)} required maxLength={200} placeholder="Ex: Apostila Módulo 1" className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">URL do Recurso</label>
            <input type="url" value={matUrl} onChange={e => setMatUrl(e.target.value)} required placeholder="https://..." className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 focus:ring-1 focus:ring-iv-accent/30 transition-colors text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Tipo</label>
            <select value={matType} onChange={e => setMatType(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text text-sm">
              <option value="link">Link</option>
              <option value="pdf">PDF</option>
              <option value="video">Vídeo</option>
              <option value="other">Outro</option>
            </select>
          </div>
          <button type="submit" disabled={saving} className="w-full py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {saving && <Loader2 size={16} className="animate-spin"/>}
            Adicionar Material
          </button>
        </form>
      </Modal>

      {/* Advance Module Modal */}
      <Modal open={advanceModal} onClose={() => setAdvanceModal(false)} title={isLastModule ? 'Concluir Turma' : `Avançar para ${nextModule?.name}`}>
        <div className="space-y-4">
          <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/5 space-y-2">
            <p className="text-sm font-semibold text-amber-400 flex items-center gap-2">
              <AlertTriangle size={16}/> Ação Irreversível
            </p>
            <p className="text-xs text-iv-muted">
              {isLastModule
                ? 'Ao concluir, alunos aprovados serão marcados como "Formados" e a turma será encerrada.'
                : `Ao avançar, o módulo da turma será alterado de "${currentModule?.name}" para "${nextModule?.name}".`
              }
            </p>
          </div>

          {failedStudentIds.size > 0 && (
            <div className="p-3 rounded-xl border border-red-500/20 bg-red-500/5 space-y-1">
              <p className="text-xs font-semibold text-red-400">{failedStudentIds.size} aluno(s) serão reprovados:</p>
              {enrollments.filter(e => failedStudentIds.has(e.student_id) && e.status === 'active').map(e => (
                <p key={e.id} className="text-xs text-red-400/80">• {e.student?.full_name}</p>
              ))}
            </div>
          )}

          <div className="text-xs text-iv-muted space-y-1">
            <p>• Alunos aprovados: <span className="text-emerald-400 font-medium">{activeEnrollments.length - failedStudentIds.size}</span></p>
            <p>• Alunos reprovados: <span className="text-red-400 font-medium">{failedStudentIds.size}</span></p>
            <p>• Histórico de frequência será preservado para consulta</p>
          </div>

          <div className="flex gap-3">
            <button onClick={() => setAdvanceModal(false)} className="flex-1 py-2.5 rounded-xl border border-white/10 text-iv-muted hover:text-iv-text text-sm font-medium transition-colors">
              Cancelar
            </button>
            <button onClick={handleAdvanceModule} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 size={16} className="animate-spin"/>}
              {isLastModule ? 'Confirmar Formatura' : 'Confirmar Avanço'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Confirmation Modal (for deletes) */}
      <Modal open={confirmModal.open} onClose={() => setConfirmModal(prev => ({ ...prev, open: false }))} title={confirmModal.title}>
        <div className="space-y-4">
          <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5">
            <p className="text-sm text-iv-muted flex items-start gap-2">
              <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5"/>
              {confirmModal.message}
            </p>
          </div>
          <div className="flex gap-3">
            <button onClick={() => setConfirmModal(prev => ({ ...prev, open: false }))} className="flex-1 py-2.5 rounded-xl border border-white/10 text-iv-muted hover:text-iv-text text-sm font-medium transition-colors">
              Cancelar
            </button>
            <button onClick={confirmModal.onConfirm} className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2">
              <Trash2 size={16}/> Confirmar Exclusão
            </button>
          </div>
        </div>
      </Modal>

      {/* Assignment Modal */}
      <Modal open={assignmentModal} onClose={() => setAssignmentModal(false)} title={editingAssignment ? 'Editar Tarefa' : 'Nova Tarefa'}>
        <form onSubmit={handleSaveAssignment} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Título</label>
            <input type="text" value={asgTitle} onChange={e => setAsgTitle(e.target.value)} required maxLength={200} placeholder="Ex: Resumo da Lição 3" className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Descrição (opcional)</label>
            <textarea value={asgDescription} onChange={e => setAsgDescription(e.target.value)} rows={3} maxLength={2000} placeholder="Instruções para o aluno..." className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 text-sm resize-y" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm text-iv-muted">Data limite (opcional)</label>
              <input type="datetime-local" value={asgDueDate} onChange={e => setAsgDueDate(e.target.value)} className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 text-sm [color-scheme:dark]" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm text-iv-muted">Nota máxima</label>
              <input type="number" min={1} max={100} step={0.5} value={asgMaxScore} onChange={e => setAsgMaxScore(parseFloat(e.target.value))} className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 text-sm" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Status</label>
            <select value={asgStatus} onChange={e => setAsgStatus(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text text-sm">
              <option value="draft">Rascunho (não visível para alunos)</option>
              <option value="published">Publicada</option>
            </select>
          </div>
          <button type="submit" disabled={saving} className="w-full py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {saving && <Loader2 size={16} className="animate-spin" />}
            {editingAssignment ? 'Salvar Alterações' : 'Criar Tarefa'}
          </button>
        </form>
      </Modal>

      {/* Submit Work Modal (Student) */}
      <Modal open={!!submitModal} onClose={() => setSubmitModal(null)} title={`Entregar: ${submitModal?.title ?? ''}`}>
        <form onSubmit={handleSubmitWork} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Resposta / Comentário</label>
            <textarea value={submitContent} onChange={e => setSubmitContent(e.target.value)} rows={4} maxLength={5000} placeholder="Escreva sua resposta aqui..." className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 text-sm resize-y" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Link de arquivo (opcional)</label>
            <input type="url" value={submitFileUrl} onChange={e => setSubmitFileUrl(e.target.value)} placeholder="https://drive.google.com/..." className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 text-sm" />
          </div>
          <button type="submit" disabled={saving || (!submitContent.trim() && !submitFileUrl.trim())} className="w-full py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {saving && <Loader2 size={16} className="animate-spin" />}
            <Send size={16} /> Enviar Entrega
          </button>
        </form>
      </Modal>

      {/* Grade Modal (Prof/Coord) */}
      <Modal open={!!gradeModal} onClose={() => setGradeModal(null)} title={`Avaliar: ${gradeModal?.submission ? (enrollments.find(e => e.student_id === gradeModal.submission.student_id)?.student?.full_name ?? 'Aluno') : ''}`}>
        <form onSubmit={handleGradeSubmission} className="space-y-4">
          {gradeModal?.submission.content && (
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5">
              <p className="text-xs font-semibold text-iv-muted mb-1">Resposta do aluno:</p>
              <p className="text-sm text-iv-text whitespace-pre-wrap">{gradeModal.submission.content}</p>
            </div>
          )}
          {gradeModal?.submission.file_url && (
            <a href={gradeModal.submission.file_url} target="_blank" rel="noopener noreferrer" className="text-xs text-iv-accent hover:underline flex items-center gap-1">
              <Link2 size={12} /> Arquivo anexado
            </a>
          )}
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Nota (0-{gradeModal?.assignment.max_score})</label>
            <input type="number" min={0} max={gradeModal?.assignment.max_score ?? 10} step={0.5} value={gradeScore} onChange={e => setGradeScore(parseFloat(e.target.value))} required className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-iv-muted">Feedback (opcional)</label>
            <textarea value={gradeFeedback} onChange={e => setGradeFeedback(e.target.value)} rows={3} maxLength={2000} placeholder="Comentários para o aluno..." className="w-full px-3 py-2.5 rounded-xl bg-iv-bg border border-white/10 text-iv-text focus:outline-none focus:border-iv-accent/50 text-sm resize-y" />
          </div>
          <button type="submit" disabled={saving} className="w-full py-2.5 rounded-xl bg-iv-accent hover:bg-iv-accent-hover text-white font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {saving && <Loader2 size={16} className="animate-spin" />}
            <Star size={16} /> Atribuir Nota
          </button>
        </form>
      </Modal>

    </div>
  );
}

function TabButton({ id, icon, label, active, onClick }: { id: any, icon: React.ReactNode, label: string, active: any, onClick: any }) {
  const isActive = active === id;
  return (
    <button
      onClick={() => {
        if (typeof navigator !== 'undefined') {
          try { (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(5); } catch { /* ignore */ }
        }
        onClick(id);
      }}
      className={`inline-flex max-w-full items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] sm:text-sm font-medium transition-colors native-pressable border ${
        isActive
          ? 'text-iv-accent border-iv-accent/40 bg-iv-accent/10'
          : 'text-iv-muted border-white/10 bg-white/[0.02] hover:text-iv-text hover:border-white/20'
      }`}
      aria-current={isActive ? 'page' : undefined}
    >
      {icon} {label}
    </button>
  );
}
