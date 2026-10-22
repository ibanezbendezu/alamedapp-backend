import { communityOperation } from '../../server/community.ts';
import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database.ts';
import { databaseOperation } from '../../server/handlers.ts';
import { findOwnProfile, patchOwnProfile, profileDto, findMedals } from '../../server/profile.ts';
import type { ProfilePatch } from '../../server/profile.ts';
import { syncOwnAccount, accountTimeoutMs } from '../../server/account.ts';
import { databaseEnvironment } from '../../server/environment.ts';
import { HttpError } from '../../server/http.ts';

@Injectable()
export class ProfilesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async me(actor: string) {
    const row = await databaseOperation(() => findOwnProfile(actor, this.database.get));
    if (!row) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Perfil no encontrado.');
    return {data: profileDto(row)};
  }
  async patch(actor: string, changes: ProfilePatch) {
    const row = await databaseOperation(() => patchOwnProfile(actor, changes, this.database.get));
    if (!row) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Perfil no encontrado.');
    return {data: profileDto(row)};
  }
  async sync(actor: string) {
    const row = await databaseOperation(() => syncOwnAccount(actor, undefined, this.database.get), accountTimeoutMs + databaseEnvironment().timeoutMs * 3);
    return {data: profileDto(row)};
  }
  async medals(actor?: string) { return {data: await databaseOperation(() => findMedals(actor, this.database.get))}; }
  async profile(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'profile', body, query, key, this.database.get))};
  }
  async search(actor: string, body: Record<string, unknown>, query: URLSearchParams, key: string | null) {
    return {data: await databaseOperation(() => communityOperation(actor, 'search', body, query, key, this.database.get))};
  }
}
