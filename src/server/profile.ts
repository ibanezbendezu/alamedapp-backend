import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import { users } from '../db/schema.ts';

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

export function profileDto(row: Profile) {
  return {
    clerkId: row.clerkId, username: row.username, email: row.email,
    displayName: row.displayName, avatarUrl: row.avatarUrl, balance: row.balance,
    followerCount: row.followerCount, followingCount: row.followingCount,
    favoriteVerse: row.favoriteVerse, bio: row.bio, cardColor: row.cardColor,
    createdAt: row.createdAt.toISOString(),
  };
}
