import { sql } from 'drizzle-orm';
import { pgTable, varchar, decimal, integer, timestamp, boolean, primaryKey, pgEnum, text, check } from 'drizzle-orm/pg-core';

export const streakStatusEnum = pgEnum('streak_status', ['pending', 'accepted', 'rejected']);
export const transactionTypeEnum = pgEnum('transaction_type', ['in', 'out']);

export const users = pgTable('users', {
  clerkId: varchar('clerk_id', { length: 255 }).primaryKey(),
  username: varchar('username', { length: 255 }).unique().notNull(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  displayName: varchar('display_name', { length: 255 }),
  avatarUrl: text('avatar_url'),
  balance: decimal('balance', { precision: 20, scale: 2 }).default('0').notNull(),
  securityPin: varchar('security_pin', { length: 6 }).default('123456').notNull(),
  followerCount: integer('follower_count').default(0).notNull(),
  followingCount: integer('following_count').default(0).notNull(),
  favoriteVerse: text('favorite_verse'),
  bio: text('bio'),
  cardColor: varchar('card_color', { length: 20 }).default('#1A1A1A').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const medals = pgTable('medals', {
  id: varchar('id', { length: 50 }).primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  color: varchar('color', { length: 20 }).notNull(),
  iconName: varchar('icon_name', { length: 50 }).notNull(),
  category: varchar('category', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const userMedals = pgTable('user_medals', {
  userId: varchar('user_id', { length: 255 }).references(() => users.clerkId, { onDelete: 'cascade' }).notNull(),
  medalId: varchar('medal_id', { length: 50 }).references(() => medals.id, { onDelete: 'cascade' }).notNull(),
  earnedAt: timestamp('earned_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.medalId] }),
}));

export const follows = pgTable('follows', {
  followerId: varchar('follower_id', { length: 255 }).references(() => users.clerkId, { onDelete: 'cascade' }).notNull(),
  followingId: varchar('following_id', { length: 255 }).references(() => users.clerkId, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.followerId, t.followingId] }),
}));

export const notificationTypeEnum = pgEnum('notification_type', ['follow', 'streak_request', 'streak_accepted', 'transfer', 'other']);

export const notifications = pgTable('notifications', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  recipientId: varchar('recipient_id', { length: 255 }).references(() => users.clerkId, { onDelete: 'cascade' }).notNull(),
  actorId: varchar('actor_id', { length: 255 }).references(() => users.clerkId, { onDelete: 'cascade' }).notNull(),
  type: notificationTypeEnum('type').notNull(),
  isRead: boolean('is_read').default(false).notNull(),
  dismissed: boolean('dismissed').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const streakRequests = pgTable('streak_requests', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  senderId: varchar('sender_id', { length: 255 }).references(() => users.clerkId).notNull(),
  receiverId: varchar('receiver_id', { length: 255 }).references(() => users.clerkId).notNull(),
  status: streakStatusEnum('status').default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const streaks = pgTable('streaks', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userAId: varchar('user_a_id', { length: 255 }).references(() => users.clerkId).notNull(),
  userBId: varchar('user_b_id', { length: 255 }).references(() => users.clerkId).notNull(),
  count: integer('count').default(0).notNull(),
  lastInteraction: timestamp('last_interaction').defaultNow().notNull(),
  lastStokedAt: timestamp('last_stoked_at'),
  userAStokeAt: timestamp('user_a_stoke_at'),
  userBStokeAt: timestamp('user_b_stoke_at'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const transactions = pgTable('transactions', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar('user_id', { length: 255 }).references(() => users.clerkId).notNull(),
  relatedUserId: varchar('related_user_id', { length: 255 }).references(() => users.clerkId),
  relatedUserUsername: varchar('related_user_username', { length: 255 }),
  amount: decimal('amount', { precision: 20, scale: 2 }).notNull(),
  type: transactionTypeEnum('type').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const prayers = pgTable('prayers', {
  audience: varchar('audience', { length: 10 }).$type<'friends' | 'public'>().default('friends').notNull(),
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar('user_id', { length: 255 }).references(() => users.clerkId, { onDelete: 'cascade' }).notNull(),
  title: text('title'),
  content: text('content').notNull(),
  color: varchar('color', { length: 20 }).default('#FFFFFF').notNull(),
  position: integer('position').default(0).notNull(),
  isAnswered: boolean('is_answered').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [check('prayers_audience_check', sql`${t.audience} in ('friends', 'public')`)]);
