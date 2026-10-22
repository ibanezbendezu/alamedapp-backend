import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database.ts';
import { databaseOperation } from '../../server/handlers.ts';
import { listPrayers, patchPrayer, removePrayer, orderPrayers, prayerDto } from '../../server/prayers.ts';
import type { PrayerChanges } from '../../server/prayers.ts';
import { createPrayerOnce } from '../../server/prayerCreation.ts';
import { HttpError } from '../../server/http.ts';

@Injectable()
export class PrayersService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async list(actor: string, owner: string, cursor: number) {
    const rows = await databaseOperation(() => listPrayers(actor, owner, cursor, this.database.get));
    return {data: {items: rows.slice(0,100).map(prayerDto), nextCursor: rows.length > 100 ? rows[99].id : null}};
  }
  async create(actor: string, changes: PrayerChanges, key: string) {
    return {data: prayerDto(await databaseOperation(() => createPrayerOnce(actor, changes, key, this.database.get)))};
  }
  async patch(actor: string, id: number, changes: PrayerChanges) {
    const row = await databaseOperation(() => patchPrayer(actor,id,changes,this.database.get));
    if (!row) throw new HttpError(404,'PRAYER_NOT_FOUND','Oración no encontrada.');
    return {data: prayerDto(row)};
  }
  async remove(actor: string, id: number) {
    const row = await databaseOperation(() => removePrayer(actor,id,this.database.get));
    if (!row) throw new HttpError(404,'PRAYER_NOT_FOUND','Oración no encontrada.');
    return {data: prayerDto(row)};
  }
  async order(actor: string, ids: number[]) {
    if (!await databaseOperation(() => orderPrayers(actor,ids,this.database.get))) throw new HttpError(409,'ORDER_CONFLICT','El diario cambió. Actualiza e inténtalo de nuevo.');
    return {data:{ok:true}};
  }
}
