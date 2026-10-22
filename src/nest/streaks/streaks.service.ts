import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database.ts';
import { databaseOperation } from '../../server/handlers.ts';
import { communityOperation } from '../../server/community.ts';

@Injectable()
export class StreaksService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async list(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'streaks', body, query, key, this.database.get))};
  }
  async detail(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'streak-detail', body, query, key, this.database.get))};
  }
  async requests(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'streak-requests', body, query, key, this.database.get))};
  }
  async action(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'streak-action', body, query, key, this.database.get))};
  }
}
