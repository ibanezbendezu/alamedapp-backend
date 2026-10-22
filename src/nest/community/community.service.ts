import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database.ts';
import { databaseOperation } from '../../server/handlers.ts';
import { communityOperation } from '../../server/community.ts';

@Injectable()
export class CommunityService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async follow(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'follow', body, query, key, this.database.get))};
  }
  async notifications(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'notifications', body, query, key, this.database.get))};
  }
  async readNotification(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'notification-read', body, query, key, this.database.get))};
  }
  async dismissNotification(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'notification-dismiss', body, query, key, this.database.get))};
  }
}
