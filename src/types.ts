// ── Enums (mirror Postgres enums) ────────────────────────────────────────────

export type UserRole = 'coordenacao' | 'professor' | 'aluno' | 'monitor';
export type EnrollmentStatus = 'active' | 'completed' | 'dropped' | 'graduated' | 'failed';
export type ClassStatus = 'active' | 'completed' | 'cancelled';
export type ClassModality = 'online' | 'presencial' | 'hibrida';
export type LessonStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
export type AttendanceStatus = 'present' | 'absent' | 'justified';
export type AssignmentStatus = 'draft' | 'published' | 'closed';
export type SubmissionStatus = 'pending' | 'submitted' | 'graded' | 'returned';
export type SwapRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
export type LessonAssignmentKind = 'assignment' | 'substitution' | 'swap' | 'cancellation' | 'reinstatement' | 'reschedule';

// ── Row types (matches DB tables) ────────────────────────────────────────────

export interface Profile {
  id: string;
  /** Nullable a partir da mig 034: perfis managed (is_managed_only=true) podem
   *  nao ter email pois nao logam no app. */
  email: string | null;
  full_name: string;
  avatar_url: string | null;
  role: UserRole;
  phone: string | null;
  must_change_password: boolean;
  /** Quando true, este perfil eh apenas registro de gestao (aluno/professor
   *  presencial). Nao tem auth.users, nao loga, nao recebe push. Mig 034. */
  is_managed_only: boolean;
  created_at: string;
  updated_at: string;
}

export interface Module {
  id: string;
  name: string;
  description: string | null;
  color: string;
  order_index: number;
  created_at: string;
}

export interface Lesson {
  id: string;
  module_id: string;
  title: string;
  description: string | null;
  order_index: number;
  created_at: string;
}

export interface Class {
  id: string;
  name: string;
  module_id: string;
  status: ClassStatus;
  /** Modalidade padrao da turma. Aulas individuais podem sobrescrever via
   *  scheduled_lessons.modality (apenas em hibridas). Mig 034. */
  modality: ClassModality;
  /** Local fisico (sala, endereco). NULL em turmas online. Mig 034. */
  location: string | null;
  created_at: string;
}

/** N:N junction — multiple professors per class. */
export interface ClassProfessor {
  class_id: string;
  professor_id: string;
  added_at: string;
  added_by: string | null;
}

/** N:N junction — multiple monitors per class. */
export interface ClassMonitor {
  class_id: string;
  monitor_id: string;
  added_at: string;
  added_by: string | null;
}

/** Phase 3 monitor: confidential post-lesson evaluation written by a class
 *  monitor and visible only to the author + coordenação. The professor being
 *  evaluated MUST NOT see this row (enforced by RLS). */
export type LessonEvaluationDuration = 'curta' | 'adequada' | 'longa';

export interface LessonEvaluation {
  id: string;
  scheduled_lesson_id: string;
  /** Denormalized from scheduled_lessons for cheap RLS evaluation. */
  class_id: string;
  monitor_id: string;
  /** 1..5 — qualidade do conteúdo apresentado. */
  content_score: number;
  /** Percepção do tempo da aula. */
  duration_assessment: LessonEvaluationDuration;
  /** 1..5 — qualidade das dinâmicas / atividades. */
  dynamics_score: number;
  /** 1..5 — engajamento aparente da turma. */
  engagement_score: number;
  notes: string | null;
  suggestions: string | null;
  created_at: string;
  updated_at: string;
}

export type LessonEvaluationInsert = Omit<LessonEvaluation, 'id' | 'created_at' | 'updated_at'>;
export type LessonEvaluationUpdate = Partial<Omit<LessonEvaluation,
  'id' | 'scheduled_lesson_id' | 'class_id' | 'monitor_id' | 'created_at' | 'updated_at'
>>;

/** Phase 4 monitor: in-class live polls / dynamics. */
export type LessonPollKind   = 'multiple_choice' | 'true_false' | 'open_text';
export type LessonPollStatus = 'draft' | 'open' | 'closed';

export interface LessonPoll {
  id: string;
  scheduled_lesson_id: string;
  class_id: string;
  created_by: string;
  kind: LessonPollKind;
  question: string;
  /** 2..6 strings for multiple_choice / true_false. null for open_text. */
  options: string[] | null;
  /** 0-based index into options[]; null = no answer key. */
  correct_option: number | null;
  status: LessonPollStatus;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
}

export type LessonPollInsert = Omit<LessonPoll, 'id' | 'opened_at' | 'closed_at' | 'created_at' | 'status'> & {
  status?: LessonPollStatus;
};
export type LessonPollUpdate = Partial<Pick<LessonPoll,
  'kind' | 'question' | 'options' | 'correct_option' | 'status' | 'opened_at' | 'closed_at'
>>;

export interface LessonPollResponse {
  id: string;
  poll_id: string;
  class_id: string;
  student_id: string;
  /** null for open_text responses. */
  selected_option: number | null;
  text_answer: string | null;
  submitted_at: string;
}

export type LessonPollResponseInsert = Omit<LessonPollResponse, 'id' | 'submitted_at'>;
export type LessonPollResponseUpdate = Partial<Pick<LessonPollResponse, 'selected_option' | 'text_answer'>>;

export interface Enrollment {
  id: string;
  class_id: string;
  student_id: string;
  status: EnrollmentStatus;
  enrolled_at: string;
}

export interface ScheduledLesson {
  id: string;
  class_id: string;
  lesson_id: string | null;
  /** Professor assigned to THIS specific lesson (overrides class roster). */
  professor_id: string | null;
  scheduled_at: string;
  duration_minutes: number;
  room_id: string | null;
  status: LessonStatus;
  /** Override da modalidade desta aula (apenas em turmas hibridas). NULL =
   *  herda de classes.modality. Mig 034. */
  modality: ClassModality | null;
  started_at: string | null;
  ended_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface LessonSwapRequest {
  id: string;
  scheduled_lesson_id: string;
  requester_id: string;
  target_id: string;
  offered_lesson_id: string | null;
  message: string | null;
  status: SwapRequestStatus;
  responded_at: string | null;
  created_at: string;
}

export interface LessonAssignmentHistory {
  id: string;
  scheduled_lesson_id: string;
  previous_professor_id: string | null;
  new_professor_id: string | null;
  changed_by: string | null;
  reason: string | null;
  kind: LessonAssignmentKind;
  created_at: string;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
}

export interface Attendance {
  id: string;
  scheduled_lesson_id: string;
  student_id: string;
  status: AttendanceStatus;
  joined_at: string | null;
  left_at: string | null;
  duration_seconds: number | null;
  marked_by: string | null;
  notes: string | null;
  verified_checks: number;
  total_checks: number;
  /** Deadline to submit the makeup summary (only when status='justified').
   *  Computed as (next scheduled lesson of the class - 24h) at the moment FJ
   *  is marked. Frozen — does not move if the next lesson is rescheduled. */
  makeup_deadline?: string | null;
  last_reminder_sent_at?: string | null;
  updated_at?: string | null;
  /** When true, the server-side recompute trigger preserves status/notes set
   *  manually by coordination. Set by the attendance grid (P/F/FJ click) and
   *  by markPresent/markAbsent/markJustified. Default false. */
  manually_overridden?: boolean;
  /** True when a related makeup_submission was approved by staff. Closes the
   *  FJ obligation without changing the original status. Set by the
   *  makeup_submission_reconcile_attendance trigger (migration 042). */
  makeup_satisfied?: boolean;
}

export interface Announcement {
  id: string;
  class_id: string | null;
  author_id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  expires_at: string | null;
  created_at: string;
}

export interface AnnouncementRead {
  id: string;
  announcement_id: string;
  user_id: string;
  read_at: string;
}

export interface ClassMaterial {
  id: string;
  class_id: string;
  title: string;
  url: string;
  type: 'link' | 'pdf' | 'video' | 'other';
  uploaded_by: string;
  created_at: string;
}

export interface Assignment {
  id: string;
  class_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  max_score: number;
  status: AssignmentStatus;
  created_by: string;
  created_at: string;
}

export interface Submission {
  id: string;
  assignment_id: string;
  student_id: string;
  content: string | null;
  file_url: string | null;
  status: SubmissionStatus;
  score: number | null;
  feedback: string | null;
  graded_by: string | null;
  submitted_at: string | null;
  graded_at: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export type MakeupSubmissionStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

export interface MakeupSubmission {
  id:                   string;
  recording_id:         string;
  scheduled_lesson_id:  string | null;
  class_id:             string | null;
  student_id:           string;
  watched_at:           string | null;   // ISO timestamp
  submitted_at:         string | null;
  reviewed_at:          string | null;
  summary:              string | null;
  status:               MakeupSubmissionStatus;
  reviewer_notes:       string | null;
  reviewed_by:          string | null;
  created_at:           string;
  updated_at:           string;
}

// ── Insert types (for create operations) ─────────────────────────────────────

export type ModuleInsert = Omit<Module, 'id' | 'created_at'> & { id?: string };
export type LessonInsert = Omit<Lesson, 'id' | 'created_at'>;
export type ClassInsert = Omit<Class, 'id' | 'created_at' | 'status' | 'modality' | 'location'> & {
  status?: ClassStatus;
  modality?: ClassModality;
  location?: string | null;
};
export type ClassProfessorInsert = Pick<ClassProfessor, 'class_id' | 'professor_id'> & Partial<Pick<ClassProfessor, 'added_by'>>;
export type ClassMonitorInsert = Pick<ClassMonitor, 'class_id' | 'monitor_id'> & Partial<Pick<ClassMonitor, 'added_by'>>;
export type EnrollmentInsert = Omit<Enrollment, 'id' | 'enrolled_at'>;
export type ScheduledLessonInsert = Omit<ScheduledLesson, 'id' | 'created_at' | 'room_id' | 'status' | 'started_at' | 'ended_at' | 'notes' | 'professor_id' | 'modality'> & {
  professor_id?: string | null;
  modality?: ClassModality | null;
};
export type LessonSwapRequestInsert = Pick<LessonSwapRequest, 'scheduled_lesson_id' | 'requester_id' | 'target_id'> & Partial<Pick<LessonSwapRequest, 'offered_lesson_id' | 'message'>>;
export type LessonSwapRequestUpdate = Partial<Pick<LessonSwapRequest, 'status' | 'message' | 'responded_at'>>;
export type PushSubscriptionInsert = Pick<PushSubscriptionRow, 'user_id' | 'endpoint' | 'p256dh' | 'auth'> & Partial<Pick<PushSubscriptionRow, 'user_agent'>>;
export type AttendanceInsert = Pick<Attendance, 'scheduled_lesson_id' | 'student_id'> & Partial<Pick<Attendance, 'status' | 'joined_at' | 'left_at' | 'duration_seconds' | 'marked_by' | 'notes' | 'verified_checks' | 'total_checks' | 'manually_overridden'>>;
export type AnnouncementInsert = Omit<Announcement, 'id' | 'created_at' | 'is_pinned' | 'expires_at'>
  & Partial<Pick<Announcement, 'is_pinned' | 'expires_at'>>;
export type AnnouncementReadInsert = Omit<AnnouncementRead, 'id' | 'read_at'>;
export type ClassMaterialInsert = Omit<ClassMaterial, 'id' | 'created_at'>;
export type AssignmentInsert = Omit<Assignment, 'id' | 'created_at'>;
export type SubmissionInsert = Omit<Submission, 'id' | 'created_at' | 'score' | 'feedback' | 'graded_by' | 'graded_at'>;
export type AuditLogInsert = Omit<AuditLog, 'id' | 'created_at'>;

// ── Update types ─────────────────────────────────────────────────────────────

export type ModuleUpdate = Partial<Omit<Module, 'id' | 'created_at'>>;
export type LessonUpdate = Partial<Omit<Lesson, 'id' | 'module_id' | 'created_at'>>;
export type ClassUpdate = Partial<Omit<Class, 'id' | 'created_at'>>;
export type ClassProfessorsUpdate = { professor_ids: string[] };
export type ClassMonitorsUpdate = { monitor_ids: string[] };
export type EnrollmentUpdate = Partial<Pick<Enrollment, 'status'>>;
export type ScheduledLessonUpdate = Partial<Omit<ScheduledLesson, 'id' | 'class_id' | 'created_at'>>;
export type AttendanceUpdate = Partial<Omit<Attendance, 'id' | 'scheduled_lesson_id' | 'student_id'>>;
export type ProfileUpdate = Partial<Pick<Profile, 'full_name' | 'avatar_url' | 'phone' | 'role' | 'email'>>;
export type AnnouncementUpdate = Partial<Pick<Announcement, 'title' | 'content' | 'is_pinned' | 'expires_at'>>;
export type ClassMaterialUpdate = Partial<Pick<ClassMaterial, 'title' | 'url' | 'type'>>;
export type AssignmentUpdate = Partial<Pick<Assignment, 'title' | 'description' | 'due_date' | 'max_score' | 'status'>>;
export type SubmissionUpdate = Partial<Pick<Submission, 'content' | 'file_url' | 'status' | 'score' | 'feedback' | 'graded_by' | 'graded_at' | 'submitted_at'>>;

// ── Joined / enriched types (for queries with relations) ─────────────────────

export interface ClassWithRelations extends Class {
  module?: Module;
  /** All professors assigned to the class (junction). */
  professors?: Profile[];
  _count?: { enrollments: number };
}

export interface ScheduledLessonWithRelations extends ScheduledLesson {
  class?: ClassWithRelations;
  lesson?: Lesson;
  professor?: Profile;
  _count?: { attendance: number };
}

export interface LessonSwapRequestWithRelations extends LessonSwapRequest {
  scheduled_lesson?: ScheduledLessonWithRelations;
  requester?: Profile;
  target?: Profile;
  offered_lesson?: ScheduledLessonWithRelations;
}

export interface AttendanceWithRelations extends Attendance {
  student?: Profile;
  scheduled_lesson?: ScheduledLessonWithRelations;
}

export interface EnrollmentWithRelations extends Enrollment {
  student?: Profile;
  class?: ClassWithRelations;
}

export interface SubmissionWithRelations extends Submission {
  student?: Profile;
  assignment?: Assignment;
}

// ── UI navigation ────────────────────────────────────────────────────────────

export type ActiveView =
  | 'dashboard'
  | 'calendar'
  | 'classroom'
  | 'profile'
  | 'classes'
  | 'attendance'
  | 'modules'
  | 'students'
  | 'professors'
  | 'reports';

// ── Lesson reports ────────────────────────────────────────────────────────────

export interface LessonReport {
  id: string;
  scheduled_lesson_id: string | null;  title?: string;  professor_id: string;
  professor_name: string;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  participants: Array<{ userId: string; userName: string }>;
  created_at: string;
}

// ── Supabase Database type (for createClient<Database>) ──────────────────────

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, 'created_at' | 'updated_at'>;
        Update: ProfileUpdate;
      };
      modules: {
        Row: Module;
        Insert: ModuleInsert;
        Update: ModuleUpdate;
      };
      lessons: {
        Row: Lesson;
        Insert: LessonInsert;
        Update: LessonUpdate;
      };
      classes: {
        Row: Class;
        Insert: ClassInsert;
        Update: ClassUpdate;
      };
      enrollments: {
        Row: Enrollment;
        Insert: EnrollmentInsert;
        Update: EnrollmentUpdate;
      };
      scheduled_lessons: {
        Row: ScheduledLesson;
        Insert: ScheduledLessonInsert;
        Update: ScheduledLessonUpdate;
      };
      attendance: {
        Row: Attendance;
        Insert: AttendanceInsert;
        Update: AttendanceUpdate;
      };
      announcements: {
        Row: Announcement;
        Insert: AnnouncementInsert;
        Update: AnnouncementUpdate;
      };
      announcement_reads: {
        Row: AnnouncementRead;
        Insert: AnnouncementReadInsert;
        Update: never;
      };
      class_materials: {
        Row: ClassMaterial;
        Insert: ClassMaterialInsert;
        Update: ClassMaterialUpdate;
      };
      lesson_reports: {
        Row: LessonReport;
        Insert: Omit<LessonReport, 'id' | 'created_at'>;
        Update: Partial<Omit<LessonReport, 'id' | 'created_at'>>;
      };
      assignments: {
        Row: Assignment;
        Insert: AssignmentInsert;
        Update: AssignmentUpdate;
      };
      submissions: {
        Row: Submission;
        Insert: SubmissionInsert;
        Update: SubmissionUpdate;
      };
      audit_logs: {
        Row: AuditLog;
        Insert: AuditLogInsert;
        Update: never;
      };
      class_professors: {
        Row: ClassProfessor;
        Insert: ClassProfessorInsert;
        Update: never;
      };
      class_monitors: {
        Row: ClassMonitor;
        Insert: ClassMonitorInsert;
        Update: never;
      };
      lesson_evaluations: {
        Row: LessonEvaluation;
        Insert: LessonEvaluationInsert;
        Update: LessonEvaluationUpdate;
      };
      lesson_polls: {
        Row: LessonPoll;
        Insert: LessonPollInsert;
        Update: LessonPollUpdate;
      };
      lesson_poll_responses: {
        Row: LessonPollResponse;
        Insert: LessonPollResponseInsert;
        Update: LessonPollResponseUpdate;
      };
      lesson_swap_requests: {
        Row: LessonSwapRequest;
        Insert: LessonSwapRequestInsert;
        Update: LessonSwapRequestUpdate;
      };
      lesson_assignment_history: {
        Row: LessonAssignmentHistory;
        Insert: Omit<LessonAssignmentHistory, 'id' | 'created_at'>;
        Update: never;
      };
      push_subscriptions: {
        Row: PushSubscriptionRow;
        Insert: PushSubscriptionInsert;
        Update: Partial<Pick<PushSubscriptionRow, 'last_used_at' | 'user_agent'>>;
      };
    };
    Enums: {
      user_role: UserRole;
      enrollment_status: EnrollmentStatus;  // 'active' | 'completed' | 'dropped' | 'graduated' | 'failed'
      class_status: ClassStatus;
      class_modality: ClassModality;
      lesson_status: LessonStatus;
      attendance_status: AttendanceStatus;
      assignment_status: AssignmentStatus;
      submission_status: SubmissionStatus;
      swap_request_status: SwapRequestStatus;
    };
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Modalidade efetiva da aula: override por aula > padrão da turma. */
export function effectiveLessonModality(
  lesson: Pick<ScheduledLesson, 'modality'> | null | undefined,
  cls: Pick<Class, 'modality'> | null | undefined
): ClassModality {
  return lesson?.modality ?? cls?.modality ?? 'online';
}
