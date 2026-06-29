import {
  getCurrentUserRole,
  getProfile,
  updateProfile,
  listProfiles,
  listProfilesByRole,
} from './auth.service';
import type { UserRole } from '../types';

// Re-export the canonical profile functions from auth.service to avoid
// duplicate implementations and ensure a single source of truth (H3).
export { getProfile, updateProfile, listProfiles, listProfilesByRole };

// ── Public API ───────────────────────────────────────────────────────────────

export async function updateRole(uid: string, role: UserRole): Promise<void> {
  const currentRole = getCurrentUserRole();
  if (currentRole !== null && currentRole !== 'coordenacao') {
    throw new Error('Apenas coordenação pode alterar papéis.');
  }
  await updateProfile(uid, { role });
}

export async function countByRole(): Promise<Record<UserRole, number>> {
  const all = await listProfiles();
  return {
    coordenacao: all.filter((p) => p.role === 'coordenacao').length,
    professor: all.filter((p) => p.role === 'professor').length,
    aluno: all.filter((p) => p.role === 'aluno').length,
    monitor: all.filter((p) => p.role === 'monitor').length,
  };
}
