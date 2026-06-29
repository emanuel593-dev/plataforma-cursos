/**
 * src/queries/useReportsQuery.ts
 *
 * Centralised React Query hooks for the ReportsView heavy data fetching.
 * Replaces the Promise.all inside load() + useEffect([]).
 *
 * Benefits:
 *  - Automatic caching: switching tabs does not re-fetch for 2 minutes
 *  - Background refresh: data is silently refreshed on window focus
 *  - Single request deduplication: multiple consumers get the same cache entry
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { listReports } from '../services/reports.service';
import { listScheduledLessons } from '../services/schedule.service';
import { listClasses } from '../services/classes.service';
import { listProfilesByRole } from '../services/profiles.service';
import { listAllLessons } from '../services/modules.service';
import { listAssignmentHistory } from '../services/assignmentHistory.service';
import { listAllSwaps } from '../services/swaps.service';
import { listAllSubmissions } from '../services/makeup.service';
import { listJustifiedWithDeadline } from '../services/attendance.service';
import { listAllEvaluations } from '../services/lessonEvaluations.service';
import type { Profile } from '../types';

// 5-minute stale time for this view: data is large and changes infrequently
const STALE = 5 * 60 * 1000;

export function useReportsData() {
  const { profile } = useAuth();
  const isCoord = profile?.role === 'coordenacao';

  const reports      = useQuery({ queryKey: ['reports'],          queryFn: listReports,            staleTime: STALE });
  const scheduled    = useQuery({ queryKey: ['scheduled-lessons'], queryFn: listScheduledLessons,  staleTime: STALE });
  const classes      = useQuery({ queryKey: ['classes'],           queryFn: listClasses,            staleTime: STALE });
  const lessons      = useQuery({ queryKey: ['all-lessons'],       queryFn: listAllLessons,         staleTime: STALE });
  const history      = useQuery({ queryKey: ['assignment-history'], queryFn: () => listAssignmentHistory({ limit: 200 }).catch(() => []), staleTime: STALE });
  const swaps        = useQuery({ queryKey: ['swaps'],        queryFn: () => listAllSwaps().catch(() => []),        staleTime: STALE, enabled: isCoord });
  const makeupSubs   = useQuery({ queryKey: ['makeup-subs'],  queryFn: () => listAllSubmissions().catch(() => []),  staleTime: STALE, enabled: isCoord });
  const justifiedRows = useQuery({ queryKey: ['justified-rows'], queryFn: () => listJustifiedWithDeadline().catch(() => []), staleTime: STALE, enabled: isCoord });

  // Profiles: merge professors, students, and monitors into a lookup map
  const professors = useQuery({ queryKey: ['profiles', 'professor'], queryFn: () => listProfilesByRole('professor'), staleTime: STALE });
  const students   = useQuery({ queryKey: ['profiles', 'aluno'],     queryFn: () => listProfilesByRole('aluno').catch(() => [] as Profile[]),   staleTime: STALE });
  const monitors   = useQuery({ queryKey: ['profiles', 'monitor'],   queryFn: () => listProfilesByRole('monitor').catch(() => [] as Profile[]), staleTime: STALE });

  const profilesById: Record<string, Profile> = {};
  for (const p of [...(professors.data ?? []), ...(students.data ?? []), ...(monitors.data ?? [])]) {
    profilesById[p.id] = p;
  }

  const loading = [reports, scheduled, classes, lessons, professors, students, monitors].some(q => q.isLoading);

  return {
    reports:      reports.data ?? [],
    scheduled:    scheduled.data ?? [],
    classes:      classes.data ?? [],
    lessonsById:  Object.fromEntries((lessons.data ?? []).map(l => [l.id, l])),
    profilesById,
    history:      history.data ?? [],
    swaps:        swaps.data ?? [],
    makeupSubs:   makeupSubs.data ?? [],
    justifiedRows: justifiedRows.data ?? [],
    loading,
    refetch: () => {
      void reports.refetch();
      void scheduled.refetch();
      void classes.refetch();
    },
  };
}

/** Lazy-loaded evaluations — only fetched when the 'avaliacoes' tab is opened. */
export function useEvaluationsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['evaluations'],
    queryFn: listAllEvaluations,
    enabled,
    staleTime: STALE,
  });
}
