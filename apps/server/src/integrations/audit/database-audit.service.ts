import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { ClsService } from 'nestjs-cls';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  AuditContext,
  AUDIT_CONTEXT_KEY,
} from '../../common/middlewares/audit-context.middleware';
import {
  AuditLogPayload,
  ActorType,
  EXCLUDED_AUDIT_EVENTS,
} from '../../common/events/audit-events';
import { AuditLogContext, IAuditService } from './audit.service';

/**
 * Minimal DB-backed audit trail (#496). Replaces NoopAuditService so that
 * decision-bearing events — notably comment.suggestion_applied /
 * comment.suggestion_dismissed, whose subject comment is HARD-DELETED on the
 * childless path — leave a durable record of who decided what. Without this the
 * events were emitted (comment.service / *.controller) but swallowed, so an
 * applied/dismissed suggestion was unrecoverable once the row was gone.
 *
 * Rows land in the pre-existing `audit` table (migration 20260228T223532). The
 * per-request actor/workspace/ip come from the CLS AuditContext populated by
 * AuditContextMiddleware + AuditActorInterceptor; callers that run OUTSIDE a
 * request (queue workers, imports) pass an explicit context via
 * logWithContext / logBatchWithContext.
 *
 * Audit is a side-record: a write failure MUST NOT break the originating
 * request, so every persistence path swallows its error with a warn. Events in
 * EXCLUDED_AUDIT_EVENTS (high-volume/low-signal) are dropped.
 */
@Injectable()
export class DatabaseAuditService implements IAuditService {
  private readonly logger = new Logger(DatabaseAuditService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly cls: ClsService,
  ) {}

  /**
   * Persist a single event using the ambient request-scoped AuditContext. A
   * no-op when there is no workspace in scope (the table's workspace_id is NOT
   * NULL) or the event is excluded. Fire-and-forget: the returned promise is not
   * awaited by hot callers, and its rejection is swallowed here.
   */
  log(payload: AuditLogPayload): void {
    const context = this.cls?.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (!context?.workspaceId) {
      // No workspace in scope — nothing we can attribute the row to. This is
      // expected for events emitted outside an HTTP request; those callers must
      // use logWithContext instead.
      return;
    }
    void this.persist(payload, {
      workspaceId: context.workspaceId,
      actorId: context.actorId ?? undefined,
      actorType: context.actorType,
      ipAddress: context.ipAddress ?? undefined,
      userAgent: context.userAgent ?? undefined,
    });
  }

  /** Persist a single event with an explicit (non-request) context. */
  logWithContext(payload: AuditLogPayload, context: AuditLogContext): void {
    if (!context?.workspaceId) return;
    void this.persist(payload, context);
  }

  /** Persist a batch of events sharing one explicit context (imports). */
  logBatchWithContext(
    payloads: AuditLogPayload[],
    context: AuditLogContext,
  ): void {
    if (!context?.workspaceId || payloads.length === 0) return;
    const rows = payloads
      .filter((p) => !EXCLUDED_AUDIT_EVENTS.has(p.event))
      .map((p) => this.toRow(p, context));
    if (rows.length === 0) return;
    this.db
      .insertInto('audit')
      .values(rows)
      .execute()
      .catch((err: any) =>
        this.logger.warn(`Failed to persist ${rows.length} audit events: ${err?.message}`),
      );
  }

  /** Update the ambient request actor (e.g. after login resolves the user). */
  setActorId(actorId: string): void {
    const context = this.cls?.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context) {
      context.actorId = actorId;
      this.cls.set(AUDIT_CONTEXT_KEY, context);
    }
  }

  /** Update the ambient request actor type (user | system | api_key). */
  setActorType(actorType: ActorType): void {
    const context = this.cls?.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context) {
      context.actorType = actorType;
      this.cls.set(AUDIT_CONTEXT_KEY, context);
    }
  }

  /** Persist a workspace's audit-log retention window (days). */
  async updateRetention(
    workspaceId: string,
    retentionDays: number,
  ): Promise<void> {
    try {
      await this.db
        .updateTable('workspaces')
        .set({ auditRetentionDays: retentionDays })
        .where('id', '=', workspaceId)
        .execute();
    } catch (err: any) {
      this.logger.warn(
        `Failed to update audit retention for workspace ${workspaceId}: ${err?.message}`,
      );
    }
  }

  private async persist(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): Promise<void> {
    if (EXCLUDED_AUDIT_EVENTS.has(payload.event)) return;
    try {
      await this.db
        .insertInto('audit')
        .values(this.toRow(payload, context))
        .execute();
    } catch (err: any) {
      // Audit is a side-record; never let a failed write surface to the caller.
      this.logger.warn(
        `Failed to persist audit event ${payload.event}: ${err?.message}`,
      );
    }
  }

  private toRow(payload: AuditLogPayload, context: AuditLogContext) {
    return {
      workspaceId: context.workspaceId,
      actorId: context.actorId ?? null,
      actorType: context.actorType ?? 'user',
      event: payload.event,
      resourceType: payload.resourceType,
      resourceId: payload.resourceId ?? null,
      spaceId: payload.spaceId ?? null,
      // jsonb columns: node-postgres serializes plain objects to JSON.
      changes: payload.changes ? (payload.changes as any) : null,
      metadata: payload.metadata ? (payload.metadata as any) : null,
      ipAddress: context.ipAddress ?? null,
    };
  }
}
