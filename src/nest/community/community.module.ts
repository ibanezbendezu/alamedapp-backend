import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.ts';
import { AuthModule } from '../http.ts';
import { CommunityService } from './community.service.ts';
import { CommunityController } from './community.controller.ts';

@Module({imports:[DatabaseModule,AuthModule],controllers:[CommunityController],providers:[CommunityService]})
export class CommunityModule {}
