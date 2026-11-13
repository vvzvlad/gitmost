import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { EnvironmentService } from '../environment/environment.service';
import { EnvironmentModule } from '../environment/environment.module';
import { parseRedisUrl } from '../../common/helpers';
import { THROTTLERS } from './throttler-names';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [EnvironmentModule],
      useFactory: (environmentService: EnvironmentService) => {
        const redisConfig = parseRedisUrl(environmentService.getRedisUrl());

        return {
          throttlers: THROTTLERS,
          errorMessage: 'Too many requests',
          // Pass ioredis options (not a pre-built Redis instance) so
          // ThrottlerStorageRedisService owns the connection and disconnects it
          // in its onModuleDestroy. Passing an instance leaves disconnectRequired
          // false, so the socket would leak on shutdown (e2e jest never exits).
          storage: new ThrottlerStorageRedisService({
            host: redisConfig.host,
            port: redisConfig.port,
            password: redisConfig.password,
            db: redisConfig.db,
            family: redisConfig.family,
            keyPrefix: 'throttle:',
          }),
        };
      },
      inject: [EnvironmentService],
    }),
  ],
})
export class ThrottleModule {}
