import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.ts';
import { AuthModule } from '../http.ts';
import { WalletService } from './wallet.service.ts';
import { WalletController } from './wallet.controller.ts';

@Module({imports:[DatabaseModule,AuthModule],controllers:[WalletController],providers:[WalletService]})
export class WalletModule {}
