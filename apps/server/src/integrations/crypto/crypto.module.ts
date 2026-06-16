import { Module } from '@nestjs/common';
import { EnvironmentModule } from '../environment/environment.module';
import { SecretBoxService } from './secret-box';

@Module({
  imports: [EnvironmentModule],
  providers: [SecretBoxService],
  exports: [SecretBoxService],
})
export class CryptoModule {}
