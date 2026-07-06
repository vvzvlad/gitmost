import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '@docmost/db/database.module';
import { EnvironmentModule } from '../environment/environment.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { PageModule } from '../../core/page/page.module';
import { AuthModule } from '../../core/auth/auth.module';
import { GitmostDataSourceService } from './services/gitmost-datasource.service';
import { GitSyncOrchestrator } from './services/git-sync.orchestrator';
import { SpaceLockService } from './services/space-lock.service';
import { VaultRegistryService } from './services/vault-registry.service';
import { PageChangeListener } from './listeners/page-change.listener';
import { GitSyncController } from './git-sync.controller';
import { GitHttpBackendService } from './http/git-http-backend.service';
import { GitHttpService } from './http/git-http.service';

/**
 * The git-sync control plane. Wires the native datasource, the
 * orchestrator (poll + leader-lock), the per-space vault registry, the
 * event-driven listener, and the admin trigger controller.
 *
 * Imports:
 *   - DatabaseModule (global) — PageRepo / SpaceRepo / KyselyDB for the
 *     datasource + orchestrator queries;
 *   - EnvironmentModule (global) — EnvironmentService config;
 *   - CollaborationModule — exports CollaborationGateway for native body writes;
 *   - PageModule — exports PageService for structural mutations;
 *   - ScheduleModule (NOT forRoot) — so SchedulerRegistry is injectable (the
 *     orchestrator registers a DYNAMIC poll interval in onModuleInit). forRoot()
 *     is already registered globally by TelemetryModule; importing the plain
 *     module here avoids a duplicate scheduler registration.
 *
 * RedisService is provided by the global RedisModule (app.module) and CASL's
 * WorkspaceAbilityFactory by the global CaslModule — both resolve without an
 * explicit import here.
 */
@Module({
  imports: [
    DatabaseModule,
    EnvironmentModule,
    CollaborationModule,
    PageModule,
    // AuthModule exports AuthService (verifyUserCredentials for /git HTTP Basic).
    AuthModule,
    ScheduleModule,
  ],
  controllers: [GitSyncController],
  providers: [
    GitmostDataSourceService,
    GitSyncOrchestrator,
    SpaceLockService,
    VaultRegistryService,
    PageChangeListener,
    // /git smart-HTTP host (the raw Fastify route in main.ts resolves these).
    GitHttpBackendService,
    GitHttpService,
  ],
  // Exported so the raw Fastify route registered in main.ts can resolve the
  // handler from the Nest container (app.get(GitHttpService)).
  exports: [GitHttpService],
})
export class GitSyncModule {}
