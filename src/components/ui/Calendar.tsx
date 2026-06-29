import React, { useMemo, useState } from 'react';
import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval,
  addWeeks, subWeeks, addMonths, subMonths, isSameDay, isSameMonth, format, isToday,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, List } from 'lucide-react';
import { cn } from '../../lib/utils';

/* ── Event type ────────────────────────────────────────────────────────── */

export interface CalendarEvent {
  id: string;
  /** ISO date-time */
  date: string;
  title: string;
  subtitle?: string;
  /** Tailwind color classes for the dot/badge (e.g. "bg-blue-500") */
  color?: string;
  /** Extra node rendered in agenda / tooltip */
  extra?: React.ReactNode;
}

export interface CalendarProps {
  events: CalendarEvent[];
  onEventClick?: (event: CalendarEvent) => void;
  onDateClick?: (date: Date) => void;
  /** Force view mode (default: auto — grid on ≥768px, agenda on <768px) */
  mode?: 'month' | 'week' | 'agenda' | 'auto';
  className?: string;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

const CAP = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function eventsByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = format(new Date(ev.date), 'yyyy-MM-dd');
    const arr = map.get(key) ?? [];
    arr.push(ev);
    map.set(key, arr);
  }
  return map;
}

/* ── Week day header ───────────────────────────────────────────────────── */

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(2024, 0, i); // Jan 2024 starts Mon(1)
  return format(d, 'EEEEE', { locale: ptBR }).toUpperCase();
});
// Fix: start from Sunday (ptBR default week start)
const WEEKDAYS_BR = (() => {
  // Sunday=0 through Saturday=6 using a known Sunday
  const sun = new Date(2024, 0, 7); // Jan 7 2024 = Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sun.getTime() + i * 86_400_000);
    return format(d, 'EEEEE', { locale: ptBR }).toUpperCase();
  });
})();

/* ── Component ─────────────────────────────────────────────────────────── */

export default function CalendarComponent({
  events,
  onEventClick,
  onDateClick,
  mode = 'auto',
  className,
}: CalendarProps) {
  const [cursor, setCursor] = useState(new Date());
  const [gridMode, setGridMode] = useState<'month' | 'week'>('month');

  const byDay = useMemo(() => eventsByDay(events), [events]);

  /* ── Grid days ─────────────────────────────────────── */
  const gridDays = useMemo(() => {
    if (gridMode === 'week') {
      const start = startOfWeek(cursor, { weekStartsOn: 0 });
      const end = endOfWeek(cursor, { weekStartsOn: 0 });
      return eachDayOfInterval({ start, end });
    }
    // month: fill from startOfWeek of monthStart to endOfWeek of monthEnd
    const mStart = startOfMonth(cursor);
    const mEnd = endOfMonth(cursor);
    const start = startOfWeek(mStart, { weekStartsOn: 0 });
    const end = endOfWeek(mEnd, { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [cursor, gridMode]);

  /* ── Agenda days (sorted unique event days) ──────── */
  const agendaDays = useMemo(() => {
    const keys = [...byDay.keys()].sort();
    return keys.map((k) => ({ key: k, date: new Date(k + 'T12:00:00'), events: byDay.get(k)! }));
  }, [byDay]);

  /* ── Navigate ────────────────────────────────────── */
  function prev() {
    setCursor((c) => gridMode === 'week' ? subWeeks(c, 1) : subMonths(c, 1));
  }
  function next() {
    setCursor((c) => gridMode === 'week' ? addWeeks(c, 1) : addMonths(c, 1));
  }
  function goToday() {
    setCursor(new Date());
  }

  /* ── Grid Header Label ─────────────────────────── */
  const headerLabel = gridMode === 'week'
    ? `${format(gridDays[0], "dd 'de' MMM", { locale: ptBR })} – ${format(gridDays[6], "dd 'de' MMM yyyy", { locale: ptBR })}`
    : CAP(format(cursor, 'MMMM yyyy', { locale: ptBR }));

  /* ── Grid View (desktop) ────────────────────────── */
  const grid = (
    <div className={cn('glass-panel overflow-hidden', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
        <div className="flex items-center gap-2">
          <button onClick={prev} className="p-2 rounded-lg hover:bg-white/10 text-iv-muted hover:text-iv-text transition-colors touch-target">
            <ChevronLeft size={16} />
          </button>
          <h3 className="text-sm font-semibold text-iv-text min-w-[180px] text-center">
            {headerLabel}
          </h3>
          <button onClick={next} className="p-2 rounded-lg hover:bg-white/10 text-iv-muted hover:text-iv-text transition-colors touch-target">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={goToday}
            className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-iv-muted hover:text-iv-text hover:bg-white/5 transition-colors touch-target"
          >
            Hoje
          </button>
          <button
            onClick={() => setGridMode('week')}
            className={cn(
              'px-3 py-1.5 text-xs rounded-lg transition-colors touch-target',
              gridMode === 'week' ? 'bg-iv-accent/15 text-iv-accent' : 'text-iv-muted hover:text-iv-text hover:bg-white/5',
            )}
          >
            Semana
          </button>
          <button
            onClick={() => setGridMode('month')}
            className={cn(
              'px-3 py-1.5 text-xs rounded-lg transition-colors touch-target',
              gridMode === 'month' ? 'bg-iv-accent/15 text-iv-accent' : 'text-iv-muted hover:text-iv-text hover:bg-white/5',
            )}
          >
            Mês
          </button>
        </div>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-white/8">
        {WEEKDAYS_BR.map((d, i) => (
          <div key={i} className="px-1 py-2 text-center text-[10px] font-bold text-iv-muted uppercase tracking-wider">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {gridDays.map((day) => {
          const key = format(day, 'yyyy-MM-dd');
          const dayEvents = byDay.get(key) ?? [];
          const inMonth = isSameMonth(day, cursor);
          const today = isToday(day);

          return (
            <div
              key={key}
              className={cn(
                'min-h-[80px] border-b border-r border-white/5 p-1 transition-colors',
                !inMonth && 'opacity-30',
                onDateClick && 'cursor-pointer hover:bg-white/[0.03]',
              )}
              onClick={onDateClick ? () => onDateClick(day) : undefined}
            >
              {/* Day number */}
              <div className="flex justify-end px-1">
                <span
                  className={cn(
                    'text-xs font-medium leading-5',
                    today
                      ? 'bg-iv-accent text-white w-5 h-5 rounded-full flex items-center justify-center'
                      : 'text-iv-muted',
                  )}
                >
                  {format(day, 'd')}
                </span>
              </div>

              {/* Events (max 3 visible + overflow) */}
              <div className="space-y-0.5 mt-0.5">
                {dayEvents.slice(0, 3).map((ev) => (
                  <button
                    key={ev.id}
                    className={cn(
                      'w-full text-left text-[10px] leading-tight px-1 py-0.5 rounded truncate font-medium transition-colors',
                      ev.color ?? 'bg-iv-accent/20 text-iv-accent',
                      onEventClick && 'hover:brightness-125 cursor-pointer',
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick?.(ev);
                    }}
                  >
                    {ev.title}
                  </button>
                ))}
                {dayEvents.length > 3 && (
                  <span className="block text-[10px] text-iv-muted px-1">
                    +{dayEvents.length - 3} mais
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  /* ── Agenda View (mobile) ───────────────────────── */
  const agenda = (
    <div className={cn('space-y-4', className)}>
      {agendaDays.length === 0 && (
        <div className="glass-panel p-8 flex flex-col items-center text-center space-y-2">
          <CalendarIcon size={28} className="text-iv-muted/40" />
          <p className="text-sm text-iv-muted">Nenhum evento encontrado.</p>
        </div>
      )}

      {agendaDays.map(({ key, date, events: dayEvents }) => (
        <div key={key}>
          {/* Day header */}
          <h4 className={cn(
            'text-sm font-semibold uppercase tracking-wide mb-2 px-1',
            isToday(date) ? 'text-iv-accent' : 'text-iv-muted',
          )}>
            {isToday(date) && <span className="mr-1">●</span>}
            {CAP(format(date, "EEEE, dd 'de' MMMM", { locale: ptBR }))}
          </h4>

          {/* Event cards */}
          <div className="space-y-2">
            {dayEvents
              .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
              .map((ev) => (
                <div
                  key={ev.id}
                  className={cn(
                    'glass-panel p-4 flex items-center gap-3',
                    onEventClick && 'cursor-pointer hover:bg-white/[0.03] transition-colors',
                  )}
                  onClick={onEventClick ? () => onEventClick(ev) : undefined}
                >
                  {/* Time */}
                  <div className="flex flex-col items-center shrink-0 w-14">
                    <span className="text-sm font-mono text-iv-text">
                      {format(new Date(ev.date), 'HH:mm')}
                    </span>
                  </div>

                  {/* Dot */}
                  <div className={cn('w-2 h-2 rounded-full shrink-0', ev.color ?? 'bg-iv-accent')} />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-iv-text truncate">{ev.title}</p>
                    {ev.subtitle && <p className="text-xs text-iv-muted truncate">{ev.subtitle}</p>}
                  </div>

                  {/* Extra */}
                  {ev.extra}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );

  /* ── Mode resolution ────────────────────────────── */
  if (mode === 'month' || mode === 'week') {
    if (mode === 'week') setGridMode('week');
    return grid;
  }
  if (mode === 'agenda') return agenda;

  // auto: grid hidden on mobile, agenda hidden on desktop
  return (
    <>
      <div className="hidden md:block">{grid}</div>
      <div className="md:hidden">{agenda}</div>
    </>
  );
}
