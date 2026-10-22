import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.ts';
import { AuthModule } from '../http.ts';
import { HealthService } from './health.service.ts';
import { HealthController } from './health.controller.ts';

@Module({imports:[DatabaseModule,AuthModule],controllers:[HealthController],providers:[HealthService]})
export class HealthModule {}
