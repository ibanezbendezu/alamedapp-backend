import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.ts';
import { AuthModule, PrayerGate } from '../http.ts';
import { PrayersService } from './prayers.service.ts';
import { PrayersController } from './prayers.controller.ts';

@Module({imports:[DatabaseModule,AuthModule],controllers:[PrayersController],providers:[PrayersService,PrayerGate]})
export class PrayersModule {}
