import type { PipeTransform } from '@nestjs/common';
import { JsonDtoPipe } from './http.ts';
import type { ApiRequest } from './http.ts';
import { HttpError } from '../server/http.ts';
import { validateProfilePatch } from '../server/profile.ts';
import { validateOrder, validatePrayer, prayerId } from '../server/prayers.ts';
import { creationKey } from '../server/prayerCreation.ts';
const invalidPrayer = () => new HttpError(400,'INVALID_PRAYER','Datos de oración no válidos.');
export const profilePipe = new JsonDtoPipe(validateProfilePatch, () => new HttpError(400,'INVALID_JSON','JSON no válido.'));
export class PrayerInputPipe implements PipeTransform {
  constructor(private readonly action: 'list'|'create'|'patch'|'delete'|'order') {}
  async transform(request: ApiRequest) {
    if (this.action === 'list') {
      const owner = String(request.params.id ?? request.subject);
      const query = new URL(request.api.url).searchParams;
      const raw = query.get('cursor') ?? '0';
      if (!owner || owner.length > 255 || !/^[\w-]+$/.test(owner) || [...query.keys()].some(k => k !== 'cursor') || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647) throw invalidPrayer();
      return {owner, cursor: Number(raw)};
    }
    if (this.action === 'order') return {ids: await new JsonDtoPipe(validateOrder,invalidPrayer,65536).transform(request)};
    const id = this.action === 'create' ? undefined : prayerId(String(request.params.id ?? ''));
    if (this.action === 'delete') return {id};
    const changes = await new JsonDtoPipe(value => validatePrayer(value,this.action === 'create'),invalidPrayer).transform(request);
    return {id,changes,key:this.action === 'create' ? creationKey(request.api.headers.get('Idempotency-Key')) : undefined};
  }
}
export class CommunityDtoPipe implements PipeTransform {
  constructor(private readonly fields: string[], private readonly follow = false) {}
  transform(request: ApiRequest) {
    return new JsonDtoPipe(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !this.fields.includes(k))) throw new HttpError(400,'INVALID_BODY','Campos inválidos.');
      const body = value as Record<string,unknown>;
      if (this.follow && typeof body.enabled !== 'boolean') throw new HttpError(400,'INVALID_BODY','enabled debe ser booleano.');
      return body;
    }, () => new HttpError(400,'INVALID_BODY','JSON inválido.')).transform(request);
  }
}
