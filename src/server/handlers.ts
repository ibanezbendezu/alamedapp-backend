import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import { requireSubject } from './auth.ts';
import { databaseEnvironment } from './environment.ts';
import { apiHandler, HttpError, withTimeout } from './http.ts';
import { findOwnProfile, profileDto } from './profile.ts';

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
