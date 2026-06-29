// Generic service error handler — replaces firestore-errors.ts.
// Works with any data layer (Supabase, in-memory, etc.).

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export function handleServiceError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ServiceError][${operationType}]${path ? ` @ ${path}` : ''}:`, message);
  // Re-throw as a plain Error so callers don't need double try/catch
  throw error instanceof Error ? error : new Error(message);
}
