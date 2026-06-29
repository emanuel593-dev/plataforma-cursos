/**
 * recording.service.ts
 *
 * Decoupled recording service — handles:
 *  1. Google Drive OAuth 2.0 flow (popup-based) for the CENTRAL coordinator account
 *  2. Retrieving a valid short-lived access_token from the Netlify gdrive-token function
 *  3. Resumable upload to Google Drive with progress callbacks
 *  4. Folder management in Drive ("IV Platform - Gravações de Aulas")
 *  5. CRUD on the `recordings` Supabase table
 *
 * Architecture: ONE central Google Drive account (coordinator's personal account).
 * The refresh_token is stored server-side only. The browser receives only a short-lived
 * access_token via GET /api/gdrive/token.
 *
 * Environment variables required:
 *   VITE_GDRIVE_CLIENT_ID   — public OAuth client ID (baked at build time, used for OAuth UI)
 *   GDRIVE_CLIENT_ID        — same value, Netlify-side
 *   GDRIVE_CLIENT_SECRET    — secret, Netlify-side only (NEVER exposed to browser)
 *   SUPABASE_URL            — Supabase project URL (Netlify-side)
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (Netlify-side only)
 */

import { supabase } from '../lib/supabase';
import { authHeaders } from '../lib/apiAuth';

// ── Constants ────────────────────────────────────────────────────────────────

const CLIENT_ID           = import.meta.env.VITE_GDRIVE_CLIENT_ID as string | undefined ?? '';
const DRIVE_SCOPE         = 'https://www.googleapis.com/auth/drive.file';
const AUTH_ENDPOINT       = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_FILES_API     = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API    = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
const ROOT_FOLDER_NAME    = 'IV Platform - Gravações de Aulas';
const CHUNK_SIZE          = 5 * 1024 * 1024; // 5 MB per upload chunk
const AUTH_FUNCTION_URL   = '/api/gdrive/auth';
const TOKEN_FUNCTION_URL  = '/api/gdrive/token';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RecordingMeta {
  id:                    string;
  scheduledLessonId?:    string | null;
  classId?:              string | null;
  recordedBy:            string;
  gdriveFileId:          string;
  gdriveViewLink?:       string | null;
  gdriveFolderId?:       string | null;
  title:                 string;
  durationS?:            number | null;
  sizeBytes?:            number | null;
  mimeType:              string;
  status:                'recording' | 'uploading' | 'ready' | 'error';
  /** Origin of the recording (migration 040). Default 'platform'. */
  source:                'platform' | 'external';
  errorMessage?:         string | null;
  createdAt:             string;
  updatedAt:             string;
}

/** A completed lesson enriched with its class title, used to populate the
 *  lesson selector in the "Registrar gravação externa" modal. */
export interface LessonOption {
  scheduledLessonId: string;
  classId:           string;
  classTitle:        string;
  scheduledAt:       string;
}

export interface UploadProgress {
  loaded:    number; // bytes uploaded
  total:     number; // total bytes
  percent:   number; // 0-100
}

// ── System token ─────────────────────────────────────────────────────────────

/**
 * Returns a short-lived access_token for the central coordinator Drive account.
 * Calls GET /api/gdrive/token which refreshes automatically server-side.
 * Throws if the system token is not configured yet.
 */
export async function getSystemAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_FUNCTION_URL, { headers: await authHeaders() });
  if (res.status === 503) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? 'Google Drive central não configurado.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Erro ao obter token do Drive (${res.status})`);
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

/**
 * Checks whether the system Drive token is configured.
 * Returns true if GET /api/gdrive/token returns 200.
 */
export async function isSystemDriveReady(): Promise<boolean> {
  try {
    const res = await fetch(TOKEN_FUNCTION_URL, { headers: await authHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

// ── OAuth helpers (used by GestaoView to connect the central account) ──────────

/** Builds the Google OAuth2 authorization URL that the popup will navigate to. */
export function buildOAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         DRIVE_SCOPE,
    access_type:   'offline',
    prompt:        'consent', // force refresh_token on every auth
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Opens a popup window that redirects the user through Google's OAuth consent
 * screen. Returns once the popup delivers the authorization code via postMessage,
 * or rejects if the user closes the popup without authorizing.
 */
export function authorizeViaPopup(redirectUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!CLIENT_ID) {
      reject(new Error('VITE_GDRIVE_CLIENT_ID não configurado.'));
      return;
    }
    const url = buildOAuthUrl(redirectUri);
    const popup = window.open(url, 'gdrive-oauth', 'width=540,height=660,left=200,top=100');
    if (!popup) {
      reject(new Error('Popup bloqueado pelo navegador. Permita popups para este site.'));
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'gdrive_auth_code') {
        window.removeEventListener('message', onMessage);
        clearInterval(pollClosed);
        if (event.data.code) {
          resolve(event.data.code as string);
        } else {
          reject(new Error(event.data.error ?? 'Autorização negada.'));
        }
      }
    };
    window.addEventListener('message', onMessage);

    // Detect if user simply closes the popup.
    // Guard with try/catch: while the popup is on accounts.google.com,
    // COOP (Cross-Origin-Opener-Policy) from Google blocks reading
    // popup.closed and Chrome logs a console error every 500 ms.
    // The try/catch silences those — we still clean up correctly when
    // the gdrive_auth_code postMessage arrives (clearInterval above).
    const pollClosed = setInterval(() => {
      let closed = false;
      try { closed = popup.closed; } catch { closed = false; }
      if (closed) {
        clearInterval(pollClosed);
        window.removeEventListener('message', onMessage);
        reject(new Error('Janela de autorização fechada sem concluir.'));
      }
    }, 500);
  });
}

/**
 * Exchanges an authorization code for the system (coordinator) Drive account.
 * Sends `isSystem: true` to gdrive-auth which verifies the coordenacao role
 * and persists tokens server-side. Browser receives only { ok: true }.
 */
export async function exchangeSystemCode(
  code: string,
  redirectUri: string,
  userJwt: string,
): Promise<void> {
  const res = await fetch(AUTH_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${userJwt}`,
    },
    body: JSON.stringify({ action: 'exchange', code, redirectUri, isSystem: true }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Erro ao salvar conta central (${res.status})`);
  }
}

// ── Google Drive folder/file helpers ─────────────────────────────────────────

interface DriveFile {
  id:          string;
  name:        string;
  webViewLink?: string;
}

/** Finds or creates the root recordings folder in Google Drive. */
export async function ensureRootFolder(accessToken: string): Promise<string> {
  // Search for an existing folder with this exact name
  const query = encodeURIComponent(
    `name='${ROOT_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const res = await fetch(`${DRIVE_FILES_API}?q=${query}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Falha de autorização no Google Drive (${res.status}) ao localizar a pasta de gravações. ` +
        `O token pode ter expirado ou o acesso foi revogado. ` +
        `Peça à coordenação para reconectar a conta em Gestão → Google Drive. ` +
        `Detalhes: ${detail.slice(0, 200)}`,
      );
    }
    throw new Error(`Drive API error: ${res.status}`);
  }
  const data = await res.json() as { files: DriveFile[] };

  if (data.files.length > 0) return data.files[0].id;

  // Create it
  const createRes = await fetch(DRIVE_FILES_API, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name:     ROOT_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!createRes.ok) {
    if (createRes.status === 401 || createRes.status === 403) {
      const detail = await createRes.text().catch(() => '');
      throw new Error(
        `Falha de autorização no Google Drive (${createRes.status}) ao criar a pasta de gravações. ` +
        `Peça à coordenação para reconectar a conta em Gestão → Google Drive. ` +
        `Detalhes: ${detail.slice(0, 200)}`,
      );
    }
    throw new Error(`Drive folder creation error: ${createRes.status}`);
  }
  const folder = await createRes.json() as DriveFile;
  return folder.id;
}

/** Fetches the webViewLink for a file by its ID. */
export async function getDriveFileLink(
  fileId: string,
  accessToken: string,
): Promise<string | null> {
  const res = await fetch(
    `${DRIVE_FILES_API}/${fileId}?fields=webViewLink`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const data = await res.json() as { webViewLink?: string };
  return data.webViewLink ?? null;
}

/**
 * Uploads a Blob to Google Drive using the resumable upload API.
 * Reports progress via `onProgress` callback (0–100).
 * Returns the created file ID and webViewLink.
 */
export async function uploadToDrive(
  blob: Blob,
  fileName: string,
  folderId: string,
  accessToken: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ fileId: string; viewLink: string | null }> {
  // Step 1: Initiate resumable upload session
  const initiateRes = await fetch(DRIVE_UPLOAD_API, {
    method: 'POST',
    headers: {
      Authorization:             `Bearer ${accessToken}`,
      'Content-Type':            'application/json',
      'X-Upload-Content-Type':   blob.type || 'video/webm',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify({
      name:    fileName,
      parents: [folderId],
    }),
  });
  if (!initiateRes.ok) {
    const errText = await initiateRes.text();
    // Surface auth failures distinctly so the UI can show a "Reconectar Drive"
    // call-to-action. 401 = expired access_token; 403 = consent revoked / scope
    // mismatch / app not authorized for this account / quota issue.
    if (initiateRes.status === 401 || initiateRes.status === 403) {
      throw new Error(
        `Falha de autorização no Google Drive (${initiateRes.status}). ` +
        `O acesso pode ter sido revogado ou o token expirou. ` +
        `Peça à coordenação para reconectar a conta em Gestão → Google Drive. ` +
        `Detalhes: ${errText.slice(0, 200)}`,
      );
    }
    throw new Error(`Drive upload initiation failed (${initiateRes.status}): ${errText}`);
  }
  const uploadUrl = initiateRes.headers.get('Location');
  if (!uploadUrl) throw new Error('Google Drive não retornou upload URL.');

  // Step 2: Upload in chunks with progress reporting
  let offset    = 0;
  let fileId    = '';

  while (offset < blob.size) {
    const end   = Math.min(offset + CHUNK_SIZE, blob.size);
    const chunk = blob.slice(offset, end);

    const chunkRes = await fetch(uploadUrl, {
      method:  'PUT',
      headers: {
        'Content-Type':  blob.type || 'video/webm',
        'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`,
      },
      body: chunk,
    });

    // 308 = Resume Incomplete (chunk accepted, keep going)
    // 200/201 = Upload complete
    if (chunkRes.status === 308) {
      offset = end;
      onProgress?.({ loaded: offset, total: blob.size, percent: Math.round((offset / blob.size) * 100) });
      continue;
    }
    if (chunkRes.status === 200 || chunkRes.status === 201) {
      const created = await chunkRes.json() as { id: string };
      fileId = created.id;
      offset = blob.size;
      onProgress?.({ loaded: blob.size, total: blob.size, percent: 100 });
      break;
    }

    const errText = await chunkRes.text();
    throw new Error(`Drive chunk upload failed (${chunkRes.status}): ${errText}`);
  }

  const viewLink = fileId ? await getDriveFileLink(fileId, accessToken) : null;

  // Make file publicly accessible ("anyone with the link can view") so it can
  // be embedded via iframe without requiring the viewer to be signed into Google.
  // Uses drive.file scope — only works on files created by this app.
  if (fileId) {
    await makeFilePublic(fileId, accessToken);
  }

  return { fileId, viewLink };
}

/**
 * Sets "anyone with the link can view" permission on a Drive file.
 * This enables iframe embedding without Google sign-in requirements.
 * Non-fatal: if it fails the file is still accessible via gdriveViewLink.
 */
export async function makeFilePublic(
  fileId: string,
  accessToken: string,
): Promise<void> {
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
  } catch {
    // Non-fatal — file can still be opened via viewLink with Google sign-in
    console.warn('[recording.service] makeFilePublic failed for', fileId);
  }
}

// ── Supabase recordings CRUD ──────────────────────────────────────────────────

type RecordingInsert = Omit<RecordingMeta, 'id' | 'createdAt' | 'updatedAt'>;

/** Inserts a new recording row (status = 'uploading') and returns its ID. */
export async function createRecordingRow(data: RecordingInsert): Promise<string> {
  const { data: row, error } = await (supabase
    .from('recordings') as any)
    .insert({
      scheduled_lesson_id: data.scheduledLessonId ?? null,
      class_id:            data.classId ?? null,
      recorded_by:         data.recordedBy,
      gdrive_file_id:      data.gdriveFileId,
      gdrive_view_link:    data.gdriveViewLink ?? null,
      gdrive_folder_id:    data.gdriveFolderId ?? null,
      title:               data.title,
      duration_s:          data.durationS ?? null,
      size_bytes:          data.sizeBytes ?? null,
      mime_type:           data.mimeType,
      status:              data.status,
      source:              data.source ?? 'platform',
      error_message:       data.errorMessage ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return (row as { id: string }).id;
}

/** Updates an existing recording row (e.g. status → ready, duration, size). */
export async function updateRecordingRow(
  id: string,
  patch: Partial<{
    gdriveFileId:  string;
    gdriveViewLink: string | null;
    title:         string;
    durationS:     number;
    sizeBytes:     number;
    status:        RecordingMeta['status'];
    errorMessage:  string | null;
  }>,
): Promise<void> {
  const { error } = await (supabase
    .from('recordings') as any)
    .update({
      ...(patch.gdriveFileId   !== undefined && { gdrive_file_id:   patch.gdriveFileId   }),
      ...(patch.gdriveViewLink !== undefined && { gdrive_view_link: patch.gdriveViewLink }),
      ...(patch.title          !== undefined && { title:            patch.title          }),
      ...(patch.durationS      !== undefined && { duration_s:       patch.durationS      }),
      ...(patch.sizeBytes      !== undefined && { size_bytes:       patch.sizeBytes      }),
      ...(patch.status         !== undefined && { status:           patch.status         }),
      ...(patch.errorMessage   !== undefined && { error_message:    patch.errorMessage   }),
    })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Lists recordings accessible by the current user, ordered newest first. */
export async function listRecordings(opts?: {
  classId?:            string;
  scheduledLessonId?:  string;
  limit?:              number;
}): Promise<RecordingMeta[]> {
  let query = (supabase.from('recordings') as any).select('*')
    .order('created_at', { ascending: false });

  if (opts?.classId)           query = query.eq('class_id', opts.classId);
  if (opts?.scheduledLessonId) query = query.eq('scheduled_lesson_id', opts.scheduledLessonId);
  if (opts?.limit)             query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(rowToMeta);
}

/** Lists ready recordings that match a set of scheduled lesson IDs or class IDs.
 *  Used by the Reposições view to find recordings for a student's FJ absences. */
export async function listRecordingsForLessons(opts: {
  scheduledLessonIds?: string[];
  classIds?:           string[];
}): Promise<RecordingMeta[]> {
  const { scheduledLessonIds = [], classIds = [] } = opts;
  if (scheduledLessonIds.length === 0 && classIds.length === 0) return [];

  const orParts: string[] = [];
  if (scheduledLessonIds.length > 0) orParts.push(`scheduled_lesson_id.in.(${scheduledLessonIds.join(',')})`);
  if (classIds.length > 0)           orParts.push(`class_id.in.(${classIds.join(',')})`);

  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('status', 'ready')
    .or(orParts.join(','))
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(rowToMeta);
}

/** Deletes a recording row from Supabase (does NOT delete from Google Drive). */
export async function deleteRecordingRow(id: string): Promise<void> {
  const { error } = await (supabase.from('recordings') as any).delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Attempts to delete the file from Google Drive as well. Non-fatal on error. */
export async function deleteFromDrive(
  fileId: string,
  accessToken: string,
): Promise<void> {
  await fetch(`${DRIVE_FILES_API}/${fileId}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function rowToMeta(row: Record<string, unknown>): RecordingMeta {
  return {
    id:                 row.id as string,
    scheduledLessonId:  row.scheduled_lesson_id as string | null,
    classId:            row.class_id as string | null,
    recordedBy:         row.recorded_by as string,
    gdriveFileId:       row.gdrive_file_id as string,
    gdriveViewLink:     row.gdrive_view_link as string | null,
    gdriveFolderId:     row.gdrive_folder_id as string | null,
    title:              row.title as string,
    durationS:          row.duration_s as number | null,
    sizeBytes:          row.size_bytes as number | null,
    mimeType:           row.mime_type as string,
    status:             row.status as RecordingMeta['status'],
    source:             (row.source as 'platform' | 'external') ?? 'platform',
    errorMessage:       row.error_message as string | null,
    createdAt:          row.created_at as string,
    updatedAt:          row.updated_at as string,
  };
}

/** Returns completed scheduled lessons with their class title, used to
 *  populate the lesson selector in the "Registrar gravação externa" modal.
 *  Sorted newest-first and capped at 200 rows. */
export async function listCompletedLessonsWithClassTitle(): Promise<LessonOption[]> {
  const { data, error } = await supabase
    .from('scheduled_lessons')
    .select('id, class_id, scheduled_at, classes(name)')
    .eq('status', 'completed')
    .order('scheduled_at', { ascending: false })
    .limit(200);
  if (error) {
    console.warn('[recording.service] listCompletedLessonsWithClassTitle:', error.message);
    return [];
  }
  return (data ?? []).map((row: any) => ({
    scheduledLessonId: row.id as string,
    classId:           row.class_id as string,
    classTitle:        (row.classes as any)?.name ?? 'Turma',
    scheduledAt:       row.scheduled_at as string,
  }));
}
