import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database.ts';
import { databaseOperation } from '../../server/handlers.ts';
import { sql } from 'drizzle-orm';

@Injectable()
export class HealthService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  health() { return { status: 'ok' }; }
  async ready() { await databaseOperation(async () => {await this.database.get().execute(sql`select 1`);}); return {status: 'ready'}; }
}
