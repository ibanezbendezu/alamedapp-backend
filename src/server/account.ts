import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { getDb } from '../db/index.ts';
import { users, medals } from '../db/schema.ts';
import { HttpError, withTimeout } from './http.ts';
import { profileSelection } from './profile.ts';
import { initialMedals } from '../db/medalCatalog.ts';

const loadClerk = createRequire(import.meta.url);
export const accountTimeoutMs = 5000;
type ProviderUser = {
  primaryEmailAddressId: string | null;
  emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[];
  username: string | null; firstName: string | null; lastName: string | null; imageUrl: string;
};
export async function readClerkAccount(subject: string): Promise<ProviderUser> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new HttpError(503, 'ACCOUNT_UNAVAILABLE', 'Servicio temporalmente no disponible.');
  try {
    const { createClerkClient } = loadClerk('@clerk/nextjs/server') as typeof import('@clerk/nextjs/server');
    return await withTimeout(() => createClerkClient({ secretKey }).users.getUser(subject), accountTimeoutMs);
  } catch { throw new HttpError(503, 'ACCOUNT_UNAVAILABLE', 'Servicio temporalmente no disponible.'); }
}

function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export async function syncOwnAccount(subject: string, read = readClerkAccount) {
  const account = await read(subject);
  const primary = account.emailAddresses.find(email => email.id === account.primaryEmailAddressId);
  if (!primary || primary.verification?.status !== 'verified' || !primary.emailAddress || primary.emailAddress.length > 255) {
    throw new HttpError(409, 'VERIFIED_EMAIL_REQUIRED', 'Se requiere un correo principal verificado.');
  }
  const email = primary.emailAddress;
  const preferred = (account.username || email.split('@')[0] || 'usuario').slice(0, 230);
  const suffix = createHash('sha256').update(subject).digest('hex').slice(0, 20);
  const candidates = [preferred, `${preferred}_${suffix}`];
  for (const username of candidates) {
    try {
      const [row] = await getDb().insert(users).values({
        clerkId: subject, username, email,
        displayName: [account.firstName, account.lastName].filter(Boolean).join(' ') || null,
        avatarUrl: account.imageUrl || null,
      }).onConflictDoUpdate({ target: users.clerkId, set: { email, avatarUrl: account.imageUrl || null } })
        .returning(profileSelection);
      // Sólo catálogo; nunca asignar medallas durante la preparación.
      await getDb().insert(medals).values(initialMedals).onConflictDoNothing();
      return row;
    } catch (error) {
      if (uniqueViolation(error)) continue;
      throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'Servicio temporalmente no disponible.');
    }
  }
  throw new HttpError(409, 'ACCOUNT_CONFLICT', 'Los datos de la cuenta están en conflicto.');
}
