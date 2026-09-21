import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE } from './audit.service';
import { DatabaseAuditService } from './database-audit.service';

// #496: bind the audit token to a real DB-backed trail (was NoopAuditService,
// which silently dropped every event). Kysely (@Global DatabaseModule) and
// ClsService (@Global ClsModule) are both globally available, so this module
// needs no extra imports.
@Global()
@Module({
  providers: [
    {
      provide: AUDIT_SERVICE,
      useClass: DatabaseAuditService,
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
