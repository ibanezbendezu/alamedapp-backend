import { CommunityReadMethodGuard } from '../auth.ts';
import { Controller, Inject, UseGuards, Get, HttpCode, Post } from '@nestjs/common';
import { StreaksService } from './streaks.service.ts';
import { Subject, Input, ClerkGuard } from '../http.ts';
import type { ApiRequest } from '../http.ts';
import { CommunityDtoPipe } from '../dto.ts';

@Controller()
@UseGuards(ClerkGuard)
export class StreaksController {
  constructor(@Inject(StreaksService) private readonly service: StreaksService) {}
  @Get('api/v1/community/streaks')
  @HttpCode(200)
  @UseGuards(CommunityReadMethodGuard)
  list(@Subject() actor: string, @Input() request: ApiRequest) { return this.service.list(actor, {}, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Get('api/v1/community/streak-detail')
  @HttpCode(200)
  @UseGuards(CommunityReadMethodGuard)
  detail(@Subject() actor: string, @Input() request: ApiRequest) { return this.service.detail(actor, {}, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Get('api/v1/community/streak-requests')
  @HttpCode(200)
  @UseGuards(CommunityReadMethodGuard)
  requests(@Subject() actor: string, @Input() request: ApiRequest) { return this.service.requests(actor, {}, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Post('api/v1/community/streak-action')
  @HttpCode(200)
  action(@Subject() actor: string, @Input() request: ApiRequest, @Input(new CommunityDtoPipe(["action","target","id"],false)) body: Record<string,unknown>) { return this.service.action(actor, body, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
}
