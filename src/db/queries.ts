import { initialMedals } from './medalCatalog.ts';
import {db} from './index';
import {users, follows, notifications, transactions, streaks, streakRequests, medals, userMedals, prayers} from './schema';
import {eq, ilike, or, and, ne, sql, desc, asc} from 'drizzle-orm';

export async function transferALMC(data: {
    senderId: string;
    receiverId: string;
    amount: number;
    description?: string;
}) {
    const { senderId, receiverId, amount, description } = data;

    if (senderId === receiverId) throw new Error("No puedes enviarte ALMC a ti mismo");
    if (amount <= 0) throw new Error("El monto debe ser mayor a 0");

    // 1. Obtener datos de ambos usuarios para el historial
    const [sender, receiver] = await Promise.all([
        db.select({ balance: users.balance, username: users.username })
            .from(users).where(eq(users.clerkId, senderId)).limit(1),
        db.select({ username: users.username })
            .from(users).where(eq(users.clerkId, receiverId)).limit(1)
    ]);
    
    if (sender.length === 0) throw new Error("Remitente no encontrado");
    if (receiver.length === 0) throw new Error("Receptor no encontrado");
    if (Number(sender[0].balance) < amount) throw new Error("Saldo insuficiente");

    // 2. Realizar la transferencia (Operaciones secuenciales)
    // Descontar del remitente
    await db.update(users).set({
        balance: sql`${users.balance} - ${amount}`
    }).where(eq(users.clerkId, senderId));

    // Abonar al receptor
    await db.update(users).set({
        balance: sql`${users.balance} + ${amount}`
    }).where(eq(users.clerkId, receiverId));

    // 3. Crear registros de transacción con usernames para mejor visualización
    // Para el remitente (salida)
    await db.insert(transactions).values({
        userId: senderId,
        relatedUserId: receiverId,
        relatedUserUsername: receiver[0].username,
        amount: amount.toString(),
        type: 'out',
        description: description || `Envío a @${receiver[0].username}`
    });

    // Para el receptor (entrada)
    await db.insert(transactions).values({
        userId: receiverId,
        relatedUserId: senderId,
        relatedUserUsername: sender[0].username,
        amount: amount.toString(),
        type: 'in',
        description: description || `Recibido de @${sender[0].username}`
    });

    // 4. Crear notificación para el receptor
    await db.insert(notifications).values({
        recipientId: receiverId,
        actorId: senderId,
        type: 'transfer'
    });

    return { success: true };
}

export async function upsertUser(data: {
    clerkId: string;
    username: string;
    email: string;
    displayName?: string;
    avatarUrl?: string;
}) {
    // Seed medals as part of user setup to ensure they exist in DB
    await seedMedals().catch(e => console.error("Error seeding medals:", e));

    return db.insert(users).values({
        clerkId: data.clerkId,
        username: data.username,
        email: data.email,
        displayName: data.displayName,
        avatarUrl: data.avatarUrl,
        balance: '0',
        securityPin: '123456', // Default PIN for new users
        cardColor: '#1A1A1A',
    }).onConflictDoUpdate({
        target: users.clerkId,
        set: {
            email: data.email,
            avatarUrl: data.avatarUrl,
        }
    }).returning();
}

export async function updateUserFavoriteVerse(userId: string, favoriteVerse: string | null) {
    return db.update(users)
        .set({ favoriteVerse })
        .where(eq(users.clerkId, userId))
        .returning();
}

export async function updateUserBio(userId: string, bio: string | null) {
    return db.update(users)
        .set({ bio })
        .where(eq(users.clerkId, userId))
        .returning();
}

export async function updateUserProfile(userId: string, data: { bio?: string | null, displayName?: string | null }) {
    return db.update(users)
        .set(data)
        .where(eq(users.clerkId, userId))
        .returning();
}

export async function updateUserCardColor(userId: string, cardColor: string) {
    return db.update(users)
        .set({ cardColor })
        .where(eq(users.clerkId, userId))
        .returning();
}

export async function getUserProfile(userId: string, currentUserId: string) {
    const result = await db.select({
        clerkId: users.clerkId,
        username: users.username,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        balance: users.balance,
        securityPin: users.securityPin,
        followerCount: users.followerCount,
        followingCount: users.followingCount,
        favoriteVerse: users.favoriteVerse,
        bio: users.bio,
        cardColor: users.cardColor,
        createdAt: users.createdAt,
        iFollow: sql<boolean>`EXISTS (SELECT 1 FROM ${follows} WHERE ${follows.followerId} = ${currentUserId} AND ${follows.followingId} = ${users.clerkId})`,
        theyFollow: sql<boolean>`EXISTS (SELECT 1 FROM ${follows} WHERE ${follows.followingId} = ${currentUserId} AND ${follows.followerId} = ${users.clerkId})`
    })
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);

    return result[0];
}

export async function getUserData(userId: string) {
    const result = await db.select({
        clerkId: users.clerkId,
        username: users.username,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        balance: users.balance,
        securityPin: users.securityPin,
        followerCount: users.followerCount,
        followingCount: users.followingCount,
        favoriteVerse: users.favoriteVerse,
        bio: users.bio,
        cardColor: users.cardColor,
        createdAt: users.createdAt
    })
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);

    return result[0];
}

export async function getWalletData(userId: string) {
     const [userData, txList] = await Promise.all([
             db.select({ balance: users.balance, cardColor: users.cardColor })
               .from(users)
               .where(eq(users.clerkId, userId))
               .limit(1),

             db.select()
               .from(transactions)
               .where(eq(transactions.userId, userId))
               .orderBy(desc(transactions.createdAt))
               .limit(20)
         ]);

     return {
             balance: userData[0]?.balance || '0',
             cardColor: userData[0]?.cardColor || '#1A1A1A',
             transactions: txList
     };
 }

export async function getAllMedals() {
    return db.select().from(medals).orderBy(medals.id);
}

export async function getUserMedals(userId: string) {
    return db.select({
        id: medals.id,
        title: medals.title,
        description: medals.description,
        color: medals.color,
        iconName: medals.iconName,
        category: medals.category,
        earnedAt: userMedals.earnedAt
    })
    .from(userMedals)
    .innerJoin(medals, eq(medals.id, userMedals.medalId))
    .where(eq(userMedals.userId, userId))
    .orderBy(desc(userMedals.earnedAt));
}

export async function awardMedal(userId: string, medalId: string) {
    const existing = await db.select().from(userMedals)
        .where(and(eq(userMedals.userId, userId), eq(userMedals.medalId, medalId)))
        .limit(1);
    
    if (existing.length > 0) return;

    return db.insert(userMedals).values({
        userId,
        medalId
    }).returning();
}

export async function seedMedals() {
    for (const medal of initialMedals) {
        await db.insert(medals).values(medal).onConflictDoNothing();
    }
}

export async function searchUsers(query: string, currentUserId: string) {
    const queryTerm = `%${query}%`;

    return db.select({
        clerkId: users.clerkId,
        username: users.username,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        balance: users.balance,
        followerCount: users.followerCount,
        followingCount: users.followingCount,
        createdAt: users.createdAt,
        iFollow: sql<boolean>`EXISTS (SELECT 1 FROM ${follows} WHERE ${follows.followerId} = ${currentUserId} AND ${follows.followingId} = ${users.clerkId})`,
        theyFollow: sql<boolean>`EXISTS (SELECT 1 FROM ${follows} WHERE ${follows.followingId} = ${currentUserId} AND ${follows.followerId} = ${users.clerkId})`,
        hasActiveStreak: sql<boolean>`EXISTS (SELECT 1 FROM ${streaks} WHERE ((${streaks.userAId} = ${currentUserId} AND ${streaks.userBId} = ${users.clerkId}) OR (${streaks.userAId} = ${users.clerkId} AND ${streaks.userBId} = ${currentUserId})) AND ${streaks.isActive} = true)`,
        streakRequestId: sql<number>`(SELECT ${streakRequests.id} FROM ${streakRequests} WHERE ((${streakRequests.senderId} = ${currentUserId} AND ${streakRequests.receiverId} = ${users.clerkId}) OR (${streakRequests.senderId} = ${users.clerkId} AND ${streakRequests.receiverId} = ${currentUserId})) AND ${streakRequests.status} = 'pending' LIMIT 1)`,
        streakRequestStatus: sql<string>`(SELECT CASE WHEN ${streakRequests.senderId} = ${currentUserId} THEN 'pending_sent' ELSE 'pending_received' END FROM ${streakRequests} WHERE ((${streakRequests.senderId} = ${currentUserId} AND ${streakRequests.receiverId} = ${users.clerkId}) OR (${streakRequests.senderId} = ${users.clerkId} AND ${streakRequests.receiverId} = ${currentUserId})) AND ${streakRequests.status} = 'pending' LIMIT 1)`
    })
        .from(users)
        .where(
            and(
                ne(users.clerkId, currentUserId),
                or(
                    ilike(users.username, queryTerm),
                    ilike(users.displayName, queryTerm),
                    ilike(users.email, queryTerm)
                )
            )
        )
        .limit(10);
}

export async function followUser(followerId: string, followingId: string) {
    if (followerId === followingId) throw new Error("No puedes seguirte a ti mismo");

    const existing = await db.select().from(follows)
        .where(and(eq(follows.followerId, followerId), eq(follows.followingId, followingId)))
        .limit(1);

    if (existing.length > 0) return;

    await db.insert(follows).values({ followerId, followingId });

    await db.update(users).set({
        followingCount: sql`${users.followingCount} + 1`
    }).where(eq(users.clerkId, followerId));

    await db.update(users).set({
        followerCount: sql`${users.followerCount} + 1`
    }).where(eq(users.clerkId, followingId));

    await db.insert(notifications).values({
        recipientId: followingId,
        actorId: followerId,
        type: 'follow'
    });
}

export async function unfollowUser(followerId: string, followingId: string) {
    const result = await db.delete(follows)
        .where(and(
            eq(follows.followerId, followerId),
            eq(follows.followingId, followingId)
        )).returning();

    if (result.length === 0) return;

    // Realizar operaciones secuencialmente
    await db.update(users).set({
        followingCount: sql`${users.followingCount} - 1`
    }).where(eq(users.clerkId, followerId));

    await db.update(users).set({
        followerCount: sql`${users.followerCount} - 1`
    }).where(eq(users.clerkId, followingId));

    // Deactivate streak if it exists
    await db.update(streaks).set({
        isActive: false
    }).where(
        or(
            and(eq(streaks.userAId, followerId), eq(streaks.userBId, followingId)),
            and(eq(streaks.userAId, followingId), eq(streaks.userBId, followerId))
        )
    );
}

export async function sendStreakRequest(senderId: string, receiverId: string) {
    // 1. Check if they follow each other
    const [followA, followB] = await Promise.all([
        db.select().from(follows).where(and(eq(follows.followerId, senderId), eq(follows.followingId, receiverId))).limit(1),
        db.select().from(follows).where(and(eq(follows.followerId, receiverId), eq(follows.followingId, senderId))).limit(1)
    ]);

    if (followA.length === 0 || followB.length === 0) {
        throw new Error("Ambos usuarios deben seguirse para iniciar una racha");
    }

    // 2. Check if there's already a pending request
    const existingRequest = await db.select().from(streakRequests).where(
        and(
            eq(streakRequests.senderId, senderId),
            eq(streakRequests.receiverId, receiverId),
            eq(streakRequests.status, 'pending')
        )
    ).limit(1);

    if (existingRequest.length > 0) return { success: true, alreadySent: true };

    // 3. Create request
    const request = await db.insert(streakRequests).values({
        senderId,
        receiverId,
        status: 'pending'
    }).returning();

    // 4. Create notification
    await db.insert(notifications).values({
        recipientId: receiverId,
        actorId: senderId,
        type: 'streak_request'
    });

    return { success: true, requestId: request[0].id };
}

export async function acceptStreakRequest(requestId: number) {
    const request = await db.select().from(streakRequests).where(eq(streakRequests.id, requestId)).limit(1);
    if (request.length === 0) throw new Error("Solicitud no encontrada");
    if (request[0].status !== 'pending') return { success: true, alreadyProcessed: true };

    // 1. Update request status
    await db.update(streakRequests).set({
        status: 'accepted'
    }).where(eq(streakRequests.id, requestId));

    const { senderId, receiverId } = request[0];

    // 2. Check if streak already exists
    const existingStreak = await db.select().from(streaks).where(
        or(
            and(eq(streaks.userAId, senderId), eq(streaks.userBId, receiverId)),
            and(eq(streaks.userAId, receiverId), eq(streaks.userBId, senderId))
        )
    ).limit(1);

    if (existingStreak.length > 0) {
        await db.update(streaks).set({
            isActive: true,
            count: 1, // Start at 1
            lastInteraction: new Date()
        }).where(eq(streaks.id, existingStreak[0].id));
    } else {
        await db.insert(streaks).values({
            userAId: senderId,
            userBId: receiverId,
            count: 1,
            isActive: true,
            lastInteraction: new Date()
        });
    }

    // 3. Create notification for sender
    await db.insert(notifications).values({
        recipientId: senderId,
        actorId: receiverId,
        type: 'streak_accepted'
    });

    return { success: true };
}

export async function rejectStreakRequest(requestId: number) {
    await db.update(streakRequests).set({
        status: 'rejected'
    }).where(eq(streakRequests.id, requestId));

    return { success: true };
}

export async function getStreakStatus(userAId: string, userBId: string) {
    const [streak, pendingRequest] = await Promise.all([
        db.select().from(streaks).where(
            or(
                and(eq(streaks.userAId, userAId), eq(streaks.userBId, userBId)),
                and(eq(streaks.userAId, userBId), eq(streaks.userBId, userAId))
            )
        ).limit(1),
        db.select().from(streakRequests).where(
            and(
                or(
                    and(eq(streakRequests.senderId, userAId), eq(streakRequests.receiverId, userBId)),
                    and(eq(streakRequests.senderId, userBId), eq(streakRequests.receiverId, userAId))
                ),
                eq(streakRequests.status, 'pending')
            )
        ).limit(1)
    ]);

    return {
        streak: streak[0] || null,
        pendingRequest: pendingRequest[0] || null
    };
}

export async function getNotifications(userId: string) {
    return db.select({
        id: notifications.id,
        type: notifications.type,
        isRead: notifications.isRead,
        createdAt: notifications.createdAt,
        actor: {
            clerkId: users.clerkId,
            username: users.username,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
            iFollow: sql<boolean>`EXISTS (SELECT 1 FROM ${follows} WHERE ${follows.followerId} = ${userId} AND ${follows.followingId} = ${users.clerkId})`
        }
    })
    .from(notifications)
    .innerJoin(users, eq(users.clerkId, notifications.actorId))
    .where(and(eq(notifications.recipientId, userId), eq(notifications.dismissed, false)))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
}

export async function markNotificationsAsRead(userId: string) {
    return db.update(notifications)
        .set({ isRead: true })
        .where(and(eq(notifications.recipientId, userId), eq(notifications.isRead, false)));
}

export async function dismissNotification(notificationId: number) {
    return db.update(notifications)
        .set({ dismissed: true })
        .where(eq(notifications.id, notificationId));
}

export async function deleteNotification(notificationId: number) {
    return db.delete(notifications).where(eq(notifications.id, notificationId));
}

export async function updateStokeStatus(streakId: number, userId: string, isStoking: boolean) {
    const streak = await db.select().from(streaks).where(eq(streaks.id, streakId)).limit(1);
    if (streak.length === 0) return;

    const column = streak[0].userAId === userId ? 'userAStokeAt' : 'userBStokeAt';
    
    return db.update(streaks)
        .set({ [column]: isStoking ? new Date() : null })
        .where(eq(streaks.id, streakId));
}

export async function checkStokeSync(streakId: number, currentUserId: string) {
    const streakResult = await db.select().from(streaks).where(eq(streaks.id, streakId)).limit(1);
    if (streakResult.length === 0) return { sync: false };

    const streak = streakResult[0];

    // Check if already stoked today
    if (streak.lastStokedAt) {
        const lastStoke = new Date(streak.lastStokedAt);
        const today = new Date();
        if (lastStoke.toDateString() === today.toDateString()) {
            return { sync: false, alreadyStokedToday: true };
        }
    }

    const now = new Date().getTime();
    const threshold = 5000; // 5 seconds for much tighter response

    const userAActive = streak.userAStokeAt && (now - new Date(streak.userAStokeAt).getTime() < threshold);
    const userBActive = streak.userBStokeAt && (now - new Date(streak.userBStokeAt).getTime() < threshold);

    if (userAActive && userBActive) {
        // Both are active! Attempt atomic increment
        const updated = await db.update(streaks).set({
            count: sql`${streaks.count} + 1`,
            lastInteraction: new Date(),
            lastStokedAt: new Date(),
            userAStokeAt: null,
            userBStokeAt: null,
            isActive: true
        }).where(and(
            eq(streaks.id, streakId),
            sql`${streaks.userAStokeAt} IS NOT NULL`,
            sql`${streaks.userBStokeAt} IS NOT NULL`
        )).returning();
        
        if (updated.length > 0) {
            return { sync: true, newCount: updated[0].count };
        } else {
            const freshStreak = await db.select().from(streaks).where(eq(streaks.id, streakId)).limit(1);
            return { sync: true, newCount: freshStreak[0]?.count };
        }
    }

    // Keep current user's timestamp fresh
    const column = streak.userAId === currentUserId ? 'userAStokeAt' : 'userBStokeAt';
    await db.update(streaks).set({ [column]: new Date() }).where(eq(streaks.id, streakId));

    return { sync: false, otherUserActive: streak.userAId === currentUserId ? userBActive : userAActive };
}

export async function checkAndExpireStreaks() {
    const now = new Date();
    // A streak expires if its lastInteraction was NOT today AND it's past 23:59
    // Since we call this during user interaction, we check if lastStokedAt was before today
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return db.update(streaks)
        .set({ isActive: false, count: 0 })
        .where(and(
            eq(streaks.isActive, true),
            or(
                sql`${streaks.lastStokedAt} < ${today}`,
                sql`${streaks.lastStokedAt} IS NULL AND ${streaks.lastInteraction} < ${today}`
            )
        ));
}

export async function getStreakDetail(streakId: number, currentUserId: string) {
    const results = await db.select({
        id: streaks.id,
        count: streaks.count,
        lastInteraction: streaks.lastInteraction,
        lastStokedAt: streaks.lastStokedAt,
        createdAt: streaks.createdAt,
        friendName: users.displayName,
        friendUsername: users.username,
        friendAvatar: users.avatarUrl
    })
    .from(streaks)
    .innerJoin(users, eq(users.clerkId, sql`case when ${streaks.userAId} = ${currentUserId} then ${streaks.userBId} else ${streaks.userAId} end`))
    .where(eq(streaks.id, streakId))
    .limit(1);

    if (results.length === 0) return null;

    const data = results[0];
    const lastStoke = data.lastStokedAt ? new Date(data.lastStokedAt) : null;
    const today = new Date().toDateString();
    
    return {
        ...data,
        isAlreadyStokedToday: lastStoke?.toDateString() === today
    };
}

// Prayer Journal Queries

export async function getPrayers(userId: string) {
    return db.select()
        .from(prayers)
        .where(eq(prayers.userId, userId))
        .orderBy(asc(prayers.position), desc(prayers.createdAt));
}

export async function createPrayer(userId: string, content: string, title: string | null = null, color: string = '#FFFFFF') {
    // Get the highest position to append
    const lastPrayer = await db.select({ position: prayers.position })
        .from(prayers)
        .where(eq(prayers.userId, userId))
        .orderBy(desc(prayers.position))
        .limit(1);
    
    const nextPosition = (lastPrayer[0]?.position ?? -1) + 1;

    return db.insert(prayers).values({
        userId,
        title,
        content,
        color,
        position: nextPosition
    }).returning();
}

export async function updatePrayer(id: number, userId: string, data: { title?: string | null, content?: string, color?: string, isAnswered?: boolean }) {
    return db.update(prayers)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(prayers.id, id), eq(prayers.userId, userId)))
        .returning();
}

export async function deletePrayer(id: number, userId: string) {
    return db.delete(prayers)
        .where(and(eq(prayers.id, id), eq(prayers.userId, userId)))
        .returning();
}

export async function reorderPrayers(userId: string, orderedIds: number[]) {
    const updatePromises = orderedIds.map((prayerId, index) => {
        return db.update(prayers)
            .set({ position: index, updatedAt: new Date() })
            .where(
                and(
                    eq(prayers.id, prayerId),
                    eq(prayers.userId, userId)
                )
            );
    });

    await Promise.all(updatePromises);
}

