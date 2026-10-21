import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import { requireSubject } from './auth.ts';
import { databaseEnvironment } from './environment.ts';
import { apiHandler, HttpError, withTimeout } from './http.ts';
import { findOwnProfile, profileDto, patchOwnProfile, validateProfilePatch, findMedals } from './profile.ts';
import { accountTimeoutMs, syncOwnAccount } from './account.ts';

export async function databaseOperation<T>(operation: () => Promise<T>, timeoutMs?: number): Promise<T> {
  try { return await withTimeout(operation, timeoutMs ?? databaseEnvironment().timeoutMs); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'Servicio temporalmente no disponible.');
  }
}

export async function readBody(request: Request, limit = 32768) {
  const tooLarge = () => new HttpError(413, 'BODY_TOO_LARGE', 'La solicitud es demasiado grande.');
  if (Number(request.headers.get('content-length')) > limit) throw tooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw tooLarge(); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export function createSyncHandler(authenticate = requireSubject, sync = syncOwnAccount) {
  return apiHandler(async request => {
    const subject = await authenticate(request);
    // El endpoint no acepta identidad ni metadata del cliente.
    const body = await readBody(request);
    if (body.trim()) {
      let value;
      try { value = JSON.parse(body); } catch { throw new HttpError(400, 'INVALID_BODY', 'La solicitud debe estar vacía.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) {
        throw new HttpError(400, 'INVALID_BODY', 'La solicitud debe estar vacía.');
      }
    }
    // Clerk dispone de su presupuesto; Neon puede intentar username + fallback + catálogo.
    const row = await databaseOperation(() => sync(subject), accountTimeoutMs + databaseEnvironment().timeoutMs * 3);
    return { data: profileDto(row) };
  });
}
export function createPatchMeHandler(authenticate = requireSubject, patch = patchOwnProfile) {
  return apiHandler(async request => {
    const subject = await authenticate(request);
    let body;
    const text = await readBody(request);
    try { body = JSON.parse(text); } catch { throw new HttpError(400, 'INVALID_JSON', 'JSON no válido.'); }
    const changes = validateProfilePatch(body);
    const row = await databaseOperation(() => patch(subject, changes));
    if (!row) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Perfil no encontrado.');
    return { data: profileDto(row) };
  });
}
export function createMedalsHandler(own: boolean, authenticate = requireSubject, find = findMedals) {
  return apiHandler(async request => {
    const subject = await authenticate(request);
    return { data: await databaseOperation(() => find(own ? subject : undefined)) };
  });
}

export function createMeHandler(authenticate = requireSubject, find = findOwnProfile) {
  return apiHandler(async (request) => {
    const subject = await authenticate(request);
    let row;
    try { row = await find(subject); }
    catch { throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'Servicio temporalmente no disponible.'); }
    if (!row) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Perfil no encontrado.');
    return { data: profileDto(row) };
  });
}

export const healthHandler = apiHandler(() => ({ status: 'ok' }));
export function createReadyHandler(probe = async () => { await getDb().execute(sql`select 1`); }, timeout = () => databaseEnvironment().timeoutMs) {
  return apiHandler(async () => {
    try { await withTimeout(probe, timeout()); }
    catch { throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'Servicio temporalmente no disponible.'); }
    return { status: 'ready' };
  });
}
