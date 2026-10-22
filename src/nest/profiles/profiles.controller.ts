import { CommunityReadMethodGuard } from '../auth.ts';
import { Controller, Inject, UseGuards, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ProfilesService } from './profiles.service.ts';
import type { ApiRequest } from '../http.ts';
import { Subject, Input, ClerkGuard, SyncDtoPipe } from '../http.ts';
import { profilePipe } from '../dto.ts';
import type { ProfilePatch } from '../../server/profile.ts';

@Controller()
@UseGuards(ClerkGuard)
export class ProfilesController {
  constructor(@Inject(ProfilesService) private readonly service: ProfilesService) {}
  @Get('api/v1/me')
  @HttpCode(200)
  me(@Subject() actor: string) { return this.service.me(actor); }
  @Patch('api/v1/me')
  @HttpCode(200)
  patch(@Subject() actor: string, @Input(profilePipe) body: ProfilePatch) { return this.service.patch(actor,body); }
  @Post('api/v1/me/sync')
  @HttpCode(200)
  sync(@Subject() actor: string, @Input(new SyncDtoPipe()) _body: Record<string,never>) { void _body; return this.service.sync(actor); }
  @Get('api/v1/me/medals')
  @HttpCode(200)
  ownMedals(@Subject() actor: string) { return this.service.medals(actor); }
  @Get('api/v1/medals')
  @HttpCode(200)
  medals() { return this.service.medals(); }
  @Get('api/v1/community/profile')
  @HttpCode(200)
  @UseGuards(CommunityReadMethodGuard)
  profile(@Subject() actor: string, @Input() request: ApiRequest) { return this.service.profile(actor, {}, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Get('api/v1/community/search')
  @HttpCode(200)
  @UseGuards(CommunityReadMethodGuard)
  search(@Subject() actor: string, @Input() request: ApiRequest) { return this.service.search(actor, {}, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
}
