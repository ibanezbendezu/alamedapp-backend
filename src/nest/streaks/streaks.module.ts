import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.ts';
import { AuthModule } from '../http.ts';
import { StreaksService } from './streaks.service.ts';
import { StreaksController } from './streaks.controller.ts';

@Module({imports:[DatabaseModule,AuthModule],controllers:[StreaksController],providers:[StreaksService]})
export class StreaksModule {}
