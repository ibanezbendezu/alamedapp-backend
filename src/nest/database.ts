import { Global, Injectable, Module } from '@nestjs/common';
import { getDb } from '../db/index.ts';

/** Configuration and connection are resolved only when an operation actually uses them. */
@Injectable()
export class DatabaseService {
  readonly get = () => getDb();
}
@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
