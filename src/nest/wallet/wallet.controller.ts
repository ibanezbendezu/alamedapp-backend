import { CommunityReadMethodGuard } from '../auth.ts';
import { Controller, Inject, UseGuards, Get, HttpCode, Post } from '@nestjs/common';
import { WalletService } from './wallet.service.ts';
import { Subject, Input, ClerkGuard } from '../http.ts';
import type { ApiRequest } from '../http.ts';
import { CommunityDtoPipe } from '../dto.ts';

@Controller()
@UseGuards(ClerkGuard)
export class WalletController {
  constructor(@Inject(WalletService) private readonly service: WalletService) {}
  @Get('api/v1/community/wallet')
  @HttpCode(200)
  @UseGuards(CommunityReadMethodGuard)
  wallet(@Subject() actor: string, @Input() request: ApiRequest) { return this.service.wallet(actor, {}, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Post('api/v1/community/card-color')
  @HttpCode(200)
  cardColor(@Subject() actor: string, @Input() request: ApiRequest, @Input(new CommunityDtoPipe(["color"],false)) body: Record<string,unknown>) { return this.service.cardColor(actor, body, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Post('api/v1/community/pin')
  @HttpCode(200)
  pin(@Subject() actor: string, @Input() request: ApiRequest, @Input(new CommunityDtoPipe(["pin","previousPin"],false)) body: Record<string,unknown>) { return this.service.pin(actor, body, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
  @Post('api/v1/community/transfer')
  @HttpCode(200)
  transfer(@Subject() actor: string, @Input() request: ApiRequest, @Input(new CommunityDtoPipe(["receiverId","amount","description","pin"],false)) body: Record<string,unknown>) { return this.service.transfer(actor, body, new URL(request.api.url).searchParams, request.api.headers.get('Idempotency-Key')); }
}
