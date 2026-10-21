import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import { users, medals, userMedals } from '../db/schema.ts';
import { HttpError } from './http.ts';

// Selección explícita: getUserData/getUserProfile legacy incluyen el PIN.
export const profileSelection = {
  clerkId: users.clerkId, username: users.username, email: users.email,
  displayName: users.displayName, avatarUrl: users.avatarUrl, balance: users.balance,
  followerCount: users.followerCount, followingCount: users.followingCount,
  favoriteVerse: users.favoriteVerse, bio: users.bio, cardColor: users.cardColor,
  createdAt: users.createdAt,
};
export type Profile = Pick<typeof users.$inferSelect, keyof typeof profileSelection>;
export async function findOwnProfile(subject: string): Promise<Profile | undefined> {
  const rows = await getDb().select(profileSelection).from(users).where(eq(users.clerkId, subject)).limit(1);
  return rows[0];
}

export type ProfilePatch = { displayName?: string | null; bio?: string | null; favoriteVerse?: string | null };
export function validateProfilePatch(value: unknown): ProfilePatch {
  const invalid = () => new HttpError(400, 'INVALID_PROFILE', 'Los datos del perfil no son válidos.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  const limits: Record<string, number> = { displayName: 50, bio: 160, favoriteVerse: 5000 };
  if (!Object.keys(row).length) throw invalid();
  for (const [key, field] of Object.entries(row)) {
    if (!Object.hasOwn(limits, key) || (field !== null && (typeof field !== 'string' || field.length > limits[key]))) throw invalid();
    if (key === 'favoriteVerse' && typeof field === 'string') {
      let verse;
      try { verse = JSON.parse(field); } catch { throw invalid(); }
      if (!verse || typeof verse !== 'object' || Array.isArray(verse)
        || typeof verse.book !== 'string' || !verse.book.trim() || typeof verse.text !== 'string' || !verse.text.trim()
        || !Number.isInteger(verse.chapter) || verse.chapter < 1 || !Number.isInteger(verse.verse) || verse.verse < 1
        || Object.keys(verse).some(key => !['book', 'chapter', 'verse', 'text'].includes(key))) throw invalid();
    }
  }
  return row as ProfilePatch;
}
export async function patchOwnProfile(subject: string, patch: ProfilePatch) {
  const [row] = await getDb().update(users).set(patch).where(eq(users.clerkId, subject)).returning(profileSelection);
  return row;
}
const medalSelection = { id: medals.id, title: medals.title, description: medals.description,
  color: medals.color, iconName: medals.iconName, category: medals.category };
export async function findMedals(subject?: string) {
  if (subject === undefined) return getDb().select(medalSelection).from(medals).orderBy(medals.id);
  const rows = await getDb().select({ ...medalSelection, earnedAt: userMedals.earnedAt }).from(userMedals)
    .innerJoin(medals, eq(medals.id, userMedals.medalId)).where(eq(userMedals.userId, subject)).orderBy(desc(userMedals.earnedAt));
  return rows.map(row => ({ ...row, earnedAt: row.earnedAt.toISOString() }));
}

export function profileDto(row: Profile) {
  return {
    clerkId: row.clerkId, username: row.username, email: row.email,
    displayName: row.displayName, avatarUrl: row.avatarUrl, balance: row.balance,
    followerCount: row.followerCount, followingCount: row.followingCount,
    favoriteVerse: row.favoriteVerse, bio: row.bio, cardColor: row.cardColor,
    createdAt: row.createdAt.toISOString(),
  };
}
