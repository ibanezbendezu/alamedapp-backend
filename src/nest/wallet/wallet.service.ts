import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database.ts';
import { databaseOperation } from '../../server/handlers.ts';
import { communityOperation } from '../../server/community.ts';

@Injectable()
export class WalletService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async wallet(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'wallet', body, query, key, this.database.get))};
  }
  async cardColor(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'card-color', body, query, key, this.database.get))};
  }
  async pin(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'pin', body, query, key, this.database.get))};
  }
  async transfer(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'transfer', body, query, key, this.database.get))};
  }
}
