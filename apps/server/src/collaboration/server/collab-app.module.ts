import { Module } from '@nestjs/common';
import { AppController } from '../../app.controller';
import { AppService } from '../../app.service';
import { EnvironmentModule } from '../../integrations/environment/environment.module';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { CollaborationModule } from '../collaboration.module';
import { DatabaseModule } from '@docmost/db/database.module';
import { QueueModule } from '../../integrations/queue/queue.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HealthModule } from '../../integrations/health/health.module';
import { CollaborationController } from './collaboration.controller';
import { LoggerModule } from '../../common/logger/logger.module';
import { RedisModule } from '@nestjs-labs/nestjs-ioredis';
import { RedisConfigService } from '../../integrations/redis/redis-config.service';
import { CaslModule } from '../../core/casl/casl.module';
// TransclusionModule (via CollaborationModule) registers PageTemplateController,
// whose UserThrottlerGuard needs the throttler options from ThrottleModule. The
// API server's AppModule imports it; the collab process must too or it fails to
// resolve THROTTLER:MODULE_OPTIONS at boot.
import { ThrottleModule } from '../../integrations/throttle/throttle.module';
import { CacheModule } from '@nestjs/cache-manager';
import KeyvRedis from '@keyv/redis';

@Module({
  imports: [
    LoggerModule,
    DatabaseModule,
    EnvironmentModule,
    CaslModule,
    ThrottleModule,
    CollaborationModule,
    QueueModule,
    HealthModule,
    EventEmitterModule.forRoot(),
    RedisModule.forRootAsync({
      useClass: RedisConfigService,
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async (environmentService: EnvironmentService) => {
        const redisUrl = environmentService.getRedisUrl();

        return {
          ttl: 5 * 1000,
          stores: [new KeyvRedis(redisUrl)],
        };
      },
      inject: [EnvironmentService],
    }),
  ],
  controllers: [
    AppController,
    ...(process.env.COLLAB_SHOW_STATS?.toLowerCase() === 'true'
      ? [CollaborationController]
      : []),
  ],
  providers: [AppService],
})
export class CollabAppModule {}
