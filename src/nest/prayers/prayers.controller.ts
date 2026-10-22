import { Controller, Inject, UseGuards, Get, HttpCode, Post, Patch, Delete, Put } from '@nestjs/common';
import { PrayersService } from './prayers.service.ts';
import { Subject, Input, ClerkGuard, PrayerGate } from '../http.ts';
import { PrayerInputPipe } from '../dto.ts';
import type { PrayerChanges } from '../../server/prayers.ts';
type PrayerDto = {owner: string; cursor: number; id: number; changes: PrayerChanges; key: string; ids: number[]};

@Controller()
@UseGuards(ClerkGuard, PrayerGate)
export class PrayersController {
  constructor(@Inject(PrayersService) private readonly service: PrayersService) {}
  @Get('api/v1/prayers')
  @HttpCode(200)
  list(@Subject() actor: string, @Input(new PrayerInputPipe('list')) dto: PrayerDto) { return this.service.list(actor,dto.owner,dto.cursor); }
  @Get('api/v1/users/:id/prayers')
  @HttpCode(200)
  userList(@Subject() actor: string, @Input(new PrayerInputPipe('list')) dto: PrayerDto) { return this.service.list(actor,dto.owner,dto.cursor); }
  @Post('api/v1/prayers')
  @HttpCode(200)
  create(@Subject() actor: string, @Input(new PrayerInputPipe('create')) dto: PrayerDto) { return this.service.create(actor,dto.changes,dto.key); }
  @Patch('api/v1/prayers/:id')
  @HttpCode(200)
  patch(@Subject() actor: string, @Input(new PrayerInputPipe('patch')) dto: PrayerDto) { return this.service.patch(actor,dto.id,dto.changes); }
  @Delete('api/v1/prayers/:id')
  @HttpCode(200)
  remove(@Subject() actor: string, @Input(new PrayerInputPipe('delete')) dto: PrayerDto) { return this.service.remove(actor,dto.id); }
  @Put('api/v1/prayers/order')
  @HttpCode(200)
  order(@Subject() actor: string, @Input(new PrayerInputPipe('order')) dto: PrayerDto) { return this.service.order(actor,dto.ids); }
}
