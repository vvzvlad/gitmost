import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { EnvironmentService } from '../environment/environment.service';
import { EnvironmentModule } from '../environment/environment.module';
import { parseRedisUrl } from '../../common/helpers';
import {
  AUTH_THROTTLER,
  AI_CHAT_THROTTLER,
  PAGE_TEMPLATE_THROTTLER,
  PUBLIC_SHARE_AI_THROTTLER,
} from './throttler-names';
import Redis from 'ioredis';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [EnvironmentModule],
      useFactory: (environmentService: EnvironmentService) => {
        const redisConfig = parseRedisUrl(environmentService.getRedisUrl());

        return {
          throttlers: [
            { name: AUTH_THROTTLER, ttl: 60_000, limit: 10 },
            { name: AI_CHAT_THROTTLER, ttl: 60_000, limit: 25 },
            // Whole-page template lookup returns full ProseMirror docs for up
            // to 50 ids per call and the embed depth cap is client-side only, so
            // a scripted client could drive heavy content fan-out. 30 req/min
            // per user is plenty for legitimate render-time batched lookups.
            { name: PAGE_TEMPLATE_THROTTLER, ttl: 60_000, limit: 30 },
            // Anonymous public-share assistant: ~5 req/min per IP.
            { name: PUBLIC_SHARE_AI_THROTTLER, ttl: 60_000, limit: 5 },
          ],
          errorMessage: 'Too many requests',
          storage: new ThrottlerStorageRedisService(
            new Redis({
              host: redisConfig.host,
              port: redisConfig.port,
              password: redisConfig.password,
              db: redisConfig.db,
              family: redisConfig.family,
              keyPrefix: 'throttle:',
            }),
          ),
        };
      },
      inject: [EnvironmentService],
    }),
  ],
})
export class ThrottleModule {}
