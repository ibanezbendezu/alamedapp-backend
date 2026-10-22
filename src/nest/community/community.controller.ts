import { CommunityReadMethodGuard } from '../auth.ts';
import { Controller, Inject, UseGuards, Get, HttpCode, Post } from '@nestjs/common';
import { CommunityService } from './community.service.ts';
import { Subject, Input, ClerkGuard } from '../http.ts';
import type { ApiRequest } from '../http.ts';
import { CommunityDtoPipe } from '../dto.ts';

@Controller()
@UseGuards(ClerkGuard)
export class CommunityController {
  constructor(@Inject(CommunityService) private readonly service: CommunityService) {}
  @Post('api/v1/community/follow')
  @HttpCode(200)
  follow(@Subject() actor: string, @Input() request: ApiRequest, @Input(new CommunityDtoPipe(["target","enabled"],true)) body: Record<string,unknown>) { return this.service.follow(actor, body, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Get('api/v1/community/notifications')
  @HttpCode(200)
  @UseGuards(CommunityReadMethodGuard)
  notifications(@Subject() actor: string, @Input() request: ApiRequest) { return this.service.notifications(actor, {}, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Post('api/v1/community/notification-read')
  @HttpCode(200)
  readNotification(@Subject() actor: string, @Input() request: ApiRequest, @Input(new CommunityDtoPipe(["maxId"],false)) body: Record<string,unknown>) { return this.service.readNotification(actor, body, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Post('api/v1/community/notification-dismiss')
  @HttpCode(200)
  dismissNotification(@Subject() actor: string, @Input() request: ApiRequest, @Input(new CommunityDtoPipe(["id"],false)) body: Record<string,unknown>) { return this.service.dismissNotification(actor, body, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
}
