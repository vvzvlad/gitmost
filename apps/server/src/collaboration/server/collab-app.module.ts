import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { SessionModule } from '../../core/session/session.module';
import { MailModule } from '../../integrations/mail/mail.module';
import { AuditModule } from '../../integrations/audit/audit.module';
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
import { PageUpdatedPublisher } from '../page-updated-relay';
import { CollabAccessSubscriber } from '../collab-access-relay';

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    AuditModule,
    SessionModule,
    MailModule.forRootAsync({ imports: [EnvironmentModule] }),
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
  // PageUpdatedPublisher: the collab process's PAGE_UPDATED events reach
  // git-sync in the API process (see page-updated-relay.ts).
  // CollabAccessSubscriber: the API process's access events re-check the open
  // connections held here (see collab-access-relay.ts).
  providers: [AppService, PageUpdatedPublisher, CollabAccessSubscriber],
})
export class CollabAppModule {}
