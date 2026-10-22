import { Controller, Inject, Get, HttpCode } from '@nestjs/common';
import { HealthService } from './health.service.ts';


@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly service: HealthService) {}
  @Get('api/health')
  @HttpCode(200)
  health() { return this.service.health(); }
  @Get('api/ready')
  @HttpCode(200)
  ready() { return this.service.ready(); }
}
