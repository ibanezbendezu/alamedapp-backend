import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.ts';
import { AuthModule } from '../http.ts';
import { ProfilesService } from './profiles.service.ts';
import { ProfilesController } from './profiles.controller.ts';

@Module({imports:[DatabaseModule,AuthModule],controllers:[ProfilesController],providers:[ProfilesService]})
export class ProfilesModule {}
