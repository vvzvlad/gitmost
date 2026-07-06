import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import type { Settings } from '@docmost/git-sync';
import { loadGitSync } from '../git-sync.loader';
import { EnvironmentService } from '../../environment/environment.service';
import { GitmostDataSourceService } from './gitmost-datasource.service';
import { VaultRegistryService } from './vault-registry.service';
import { SpaceLockService } from './space-lock.service';
import {
  GIT_SYNC_PUSH_LOCK_RETRY_BASE_MS,
  GIT_SYNC_PUSH_LOCK_RETRY_MAX_MS,
  GIT_SYNC_PUSH_LOCK_RETRY_TOTAL_MS,
} from '../git-sync.constants';

/** A space the poll loop should reconcile: its id + the workspace it lives in. */
interface EnabledSpace {
  spaceId: string;
  workspaceId: string;
}

/**
 * Thrown by `ingestExternalPush` when the per-space lock cannot be acquired (a
 * poll cycle is mid-flight on this or another replica). The /git HTTP handler
 * maps it to a 503 so the git client retries rather than racing a cycle's
 * working-tree checkout/merge.
 */
export class GitSyncLockHeldError extends Error {
  constructor(public readonly spaceId: string) {
    super(`git-sync: space ${spaceId} is busy (lock held); retry the push`);
    this.name = 'GitSyncLockHeldError';
  }
}

/** Small status summary returned by `runOnce` (for the admin trigger + logs). */
export interface GitSyncRunStatus {
  spaceId: string;
  ran: boolean;
  /** Why the cycle did not run (lock held elsewhere, busy, disabled, error). */
  skipped?:
    | 'lock-held'
    | 'in-progress'
    | 'disabled'
    | 'no-service-user'
    | 'space-not-enabled'
    | 'merge-in-progress';
  pull?: { written: number; deleted: number; conflict: boolean };
  push?: { mode: string; failures: number };
  /**
   * True when the push REFUSED to fast-forward a divergent `docmost` mirror
   * (invariant §5 broken — `docmost` no longer mirrors what Docmost contains).
   * Surfaced here (not just logged) so /status can report it. No data is lost,
   * but it signals an operator-visible drift that needs attention.
   */
  divergentDocmost?: boolean;
  error?: string;
}

/**
 * The git-sync control plane. Drives the vendored engine in
 * process: under a Redis leader lock (single-writer across replicas) plus an
 * in-process per-space mutex (no overlapping cycles on one instance), it runs a
 * PULL (Docmost -> vault) then a PUSH (vault -> Docmost) for a space.
 *
 * Enumeration of enabled spaces: STRICT opt-in. Only spaces whose
 * per-space flag `space.settings.gitSync.enabled === true` (written by the Phase-C
 * UI) are reconciled. There is intentionally NO all-spaces fallback: when no space
 * carries the flag, git-sync does NOTHING (an empty list) — flagging every space
 * the moment GIT_SYNC_ENABLED flips on is a safety hazard (it could mass-sync large
 * spaces). The whole loop is still gated on the GIT_SYNC_ENABLED master switch
 * first; per-space opt-in is now REQUIRED on top of it.
 */
@Injectable()
export class GitSyncOrchestrator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GitSyncOrchestrator.name);
  /** The registered poll-interval name, or null when none is registered. */
  private pollIntervalName: string | null = null;

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly dataSource: GitmostDataSourceService,
    private readonly vaultRegistry: VaultRegistryService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly spaceLock: SpaceLockService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  // --- enabled-space enumeration --------------------------------

  /**
   * Enumerate the spaces the poll loop should reconcile. STRICT opt-in: ONLY
   * spaces carrying the Phase-C per-space flag (`settings->'gitSync'->>'enabled'
   * = 'true'`, written by the Phase-C UI) are returned. There is intentionally NO
   * fallback to "all live spaces" — when no space is flagged this returns an empty
   * list and git-sync does nothing (correct opt-in behavior). The GIT_SYNC_ENABLED
   * master switch gates whether the loop runs at all; this flag gates which spaces.
   */
  private async enabledSpaces(): Promise<EnabledSpace[]> {
    return this.db
      .selectFrom('spaces')
      .select(['id as spaceId', 'workspaceId'])
      .where('deletedAt', 'is', null)
      .where(sql<boolean>`settings->'gitSync'->>'enabled' = 'true'`)
      .execute();
  }

  /**
   * Authoritative per-space opt-in check used by the EVENT path (runOnce), which
   * — unlike the poll path — is not pre-filtered by enabledSpaces(). Same STRICT
   * `settings.gitSync.enabled === 'true'` semantics; a missing/soft-deleted space
   * or any non-'true' value returns false (review #3).
   */
  private async isSpaceGitSyncEnabled(spaceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('spaces')
      .select(
        sql<boolean>`settings->'gitSync'->>'enabled' = 'true'`.as('enabled'),
      )
      .where('id', '=', spaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return row?.enabled ?? false;
  }

  // --- one sync cycle for a space -------------------------------

  /**
   * Build the engine `Settings` for a space. The datasource writes in-process,
   * so only `vaultPath`, `docmostSpaceId` and the tunables are load-bearing; the
   * dead REST-era fields (docmostApiUrl/email/password) were removed (review).
   *
   * `gitRemote` is NOT yet consumed: the vendored engine has no remote-push path
   * (see engine/git.ts, engine/pull.ts, SPEC §7 — remote push is deferred), so
   * the GIT_SYNC_REMOTE_TEMPLATE env -> validation -> getter -> this field chain
   * is inert SCAFFOLDING kept in place for the future remote-push feature. It is
   * harmless (the engine ignores it) and removing it would only churn; we still
   * populate it so the wiring is ready when the engine grows a push path.
   */
  private async buildSettings(spaceId: string): Promise<Settings> {
    // Scaffolding for the deferred remote-push feature — the engine does not read
    // `gitRemote` yet (see the docstring above). Substitute {spaceId} per-space so
    // the value is correct the moment the engine starts consuming it.
    const remoteTemplate = this.environmentService.getGitSyncRemoteTemplate();
    const gitRemote = remoteTemplate
      ? remoteTemplate.replace(/\{spaceId\}/g, spaceId)
      : undefined;
    // Per-space PUSH policy for still-conflicted page bodies (SPEC §9): read the
    // `gitSync.autoMergeConflicts` flag from the space's jsonb settings. STRICT
    // opt-in like `enabled` — anything other than the literal 'true' (absent, null,
    // 'false') resolves to the SAFE default (skip a conflicted page, do not push).
    const row = await this.db
      .selectFrom('spaces')
      .select(
        sql<boolean>`settings->'gitSync'->>'autoMergeConflicts' = 'true'`.as(
          'autoMergeConflicts',
        ),
      )
      .where('id', '=', spaceId)
      .executeTakeFirst();
    return {
      docmostSpaceId: spaceId,
      vaultPath: this.vaultRegistry.vaultPath(spaceId),
      gitRemote,
      pollIntervalMs: this.environmentService.getGitSyncPollIntervalMs(),
      debounceMs: this.environmentService.getGitSyncDebounceMs(),
      logLevel: 'info',
      autoMergeConflicts: row?.autoMergeConflicts ?? false,
    };
  }

  /**
   * Run one full PULL + PUSH cycle for a space, under the Redis leader lock and
   * the in-process mutex. Never throws — per-space errors are caught, logged, and
   * returned in the status so a poll interval is never broken by one bad space.
   */
  async runOnce(
    spaceId: string,
    workspaceId: string,
  ): Promise<GitSyncRunStatus> {
    if (!this.environmentService.isGitSyncEnabled()) {
      return { spaceId, ran: false, skipped: 'disabled' };
    }
    const serviceUserId = this.environmentService.getGitSyncServiceUserId();
    if (!serviceUserId) {
      this.logger.error(
        'git-sync: GIT_SYNC_SERVICE_USER_ID is required when GIT_SYNC_ENABLED — skipping',
      );
      return { spaceId, ran: false, skipped: 'no-service-user' };
    }
    // Per-space opt-in gate (review #3). The global GIT_SYNC_ENABLED env switch is
    // NOT sufficient — sync must also be turned on for THIS space
    // (`space.settings.gitSync.enabled === true`). The poll path filters via
    // enabledSpaces(), but the event path (page-change listener) calls runOnce
    // directly; without this check an edit in ANY space would `git init` a vault
    // and export that space's whole history, violating the module's opt-in
    // contract (orchestrator docstring §79-86). STRICT: anything but 'true' skips.
    if (!(await this.isSpaceGitSyncEnabled(spaceId))) {
      return { spaceId, ran: false, skipped: 'space-not-enabled' };
    }

    // Run the full cycle under the per-space lock. withSpaceLock owns the
    // in-process mutex (no overlapping cycles on this instance) AND the Redis
    // leader lock (single writer across replicas), and returns a skip sentinel
    // when it could not enter — surfaced here as the existing skipped:'in-progress'
    // / 'lock-held' status so runOnce's observable behavior is unchanged.
    try {
      const result = await this.spaceLock.withSpaceLock(spaceId, (signal) =>
        this.driveCycle(spaceId, workspaceId, serviceUserId, signal),
      );
      if ('skipped' in result && !('spaceId' in result)) {
        return { spaceId, ran: false, skipped: result.skipped };
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`git-sync: cycle failed for space ${spaceId}: ${message}`);
      return { spaceId, ran: false, error: message };
    }
  }

  /**
   * Ingest a push that arrived over smart-HTTP (the /git host). Under the SAME
   * per-space lock the poll cycle uses, it:
   *   1. runs `runReceivePack()` — the closure that spawns `git http-backend` for
   *      the receive-pack request and finishes streaming the HTTP response to the
   *      client. The client's push result is determined here.
   *   2. THEN — still holding the lock — runs the full Docmost cycle (the same
   *      `driveCycle` body `runOnce` uses) so the freshly received commits on
   *      `main` flow back into Docmost pages.
   *
   * If the cycle body in step 2 throws, it is LOGGED but NOT rethrown: the push
   * already succeeded and the commits are durable on `main`, so the poll-interval
   * backstop will reconcile them on the next tick. The receive-pack itself is the
   * load-bearing step.
   *
   * Lock contention: if the lock cannot be acquired (a poll cycle is mid-flight),
   * this throws a `GitSyncLockHeldError`. The HTTP handler converts that to a 503
   * so git surfaces a retryable error to the user (chosen over blocking the
   * request behind a potentially long cycle). The receive-pack is NOT run when
   * the lock is held — we never write to the working tree concurrently with a
   * cycle.
   *
   * `runReceivePack` receives the per-space lock's lost-lock `AbortSignal`: a
   * receive-pack writes `main`'s working tree (receive.denyCurrentBranch=
   * updateInstead), so if the lock is lost mid-push (a long Redis outage drops the
   * heartbeat CAS) the signal fires and the receive-pack's `git http-backend`
   * child is killed — closing the window where another replica could grab the lock
   * and start a cycle while this child is still writing the working tree.
   */
  async ingestExternalPush(
    spaceId: string,
    workspaceId: string,
    runReceivePack: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (!this.environmentService.isGitSyncEnabled()) {
      // The HTTP gate already checks this, but be defensive: never run a cycle
      // when sync is globally off.
      throw new GitSyncLockHeldError(spaceId);
    }
    const serviceUserId = this.environmentService.getGitSyncServiceUserId();

    const result = await this.spaceLock.withSpaceLock(
      spaceId,
      async (signal) => {
      // 1) Stream the receive-pack to the client (durable commits land on main).
      // Pass the lost-lock signal so the receive-pack child is killed if the lock
      // lapses mid-write (no concurrent working-tree writer across replicas).
      await runReceivePack(signal);

      // 2) Reconcile the new commits into Docmost. A service user is required to
      // attribute the writes; without one we cannot run the cycle — the commits
      // are still durable and the poll backstop will pick them up once configured.
      if (!serviceUserId) {
        this.logger.error(
          'git-sync: GIT_SYNC_SERVICE_USER_ID is required to ingest an external ' +
            'push — the push is durable on main; skipping the immediate cycle.',
        );
        return;
      }
      try {
        await this.driveCycle(spaceId, workspaceId, serviceUserId, signal);
      } catch (err) {
        // Do NOT rethrow: the push succeeded and the commits are durable on main;
        // the poll-interval backstop retries the cycle. Log for visibility.
        this.logger.error(
          `git-sync: post-push cycle failed for space ${spaceId} (push is ` +
            `durable; poll will retry): ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
      return;
      },
      // BOUNDED retry-acquire (push path only): a push that briefly overlaps a
      // poll cycle waits a moment (capped backoff up to the budget) instead of
      // immediately 503-ing — the cycle releases the lock in well under a second
      // for most spaces, so this turns a transient overlap into a SUCCESS rather
      // than a spurious failure. A genuinely long/stuck cycle still skips after
      // the bound -> GitSyncLockHeldError -> 503, and git retries the whole push
      // (the receive-pack only runs once the lock is held, so there is never a
      // half-applied ref on a 503).
      {
        acquireRetry: {
          timeoutMs: GIT_SYNC_PUSH_LOCK_RETRY_TOTAL_MS,
          baseMs: GIT_SYNC_PUSH_LOCK_RETRY_BASE_MS,
          maxMs: GIT_SYNC_PUSH_LOCK_RETRY_MAX_MS,
        },
      },
    );

    // The lock was held (in-progress or another replica) — surface to the caller
    // so the HTTP handler can answer 503 and let git retry.
    if (typeof result === 'object' && result !== null && 'skipped' in result) {
      throw new GitSyncLockHeldError(spaceId);
    }
  }

  /**
   * Serve a git smart-HTTP READ ADVERTISEMENT (`GET info/refs?service=git-upload-pack`
   * or a dumb `GET HEAD`) with the repo's symbolic `HEAD` deterministically pinned
   * to `main` (bug #3). The advertised `HEAD` symref decides a clone's default
   * branch; the engine transiently checks out the read-only `docmost` mirror during
   * a cycle, so an unsynchronized advertisement could route a clone to `docmost`
   * (~1/4 of clones under continuous syncing).
   *
   * Running the pin + the advertisement under the SAME per-space lock the cycle
   * uses guarantees no cycle is mid-flight while we pin (HEAD cannot flap) and that
   * the pin never corrupts a cycle's checkout. The advertisement is cheap (a ref
   * listing, no pack stream), so holding the lock for it is fine. A bounded
   * retry-acquire absorbs a brief overlap with a cycle; if the lock still cannot be
   * taken (a long cycle), we fall back to serving WITHOUT the pin — the cycle's
   * finally-restore leaves HEAD on `main` between cycles, so the advertisement is
   * still almost always correct (degrades only under sustained contention).
   */
  async serveReadAdvertisement(
    spaceId: string,
    serve: () => Promise<void>,
  ): Promise<void> {
    if (!this.environmentService.isGitSyncEnabled()) {
      await serve();
      return;
    }
    const result = await this.spaceLock.withSpaceLock(
      spaceId,
      async () => {
        const vault = await this.vaultRegistry.getVault(spaceId);
        await vault.pinHeadToMain();
        await serve();
      },
      {
        acquireRetry: {
          timeoutMs: GIT_SYNC_PUSH_LOCK_RETRY_TOTAL_MS,
          baseMs: GIT_SYNC_PUSH_LOCK_RETRY_BASE_MS,
          maxMs: GIT_SYNC_PUSH_LOCK_RETRY_MAX_MS,
        },
      },
    );
    // Lock contended for the whole budget (in-progress / another replica): serve
    // anyway. `serve` (backend.run) never ran inside the lock in this case.
    if (typeof result === 'object' && result !== null && 'skipped' in result) {
      await serve();
    }
  }

  /**
   * Drive ONE reconcile cycle for a space. The PULL->PUSH branch choreography
   * lives in the engine's `runCycle` (so it can never drift from the engine it
   * ships with); the orchestrator owns only the lock (its caller) and the
   * service binding. There is no delete cap — deletes apply unconditionally (they
   * are soft/reversible) and every cycle logs what it deleted via `log`.
   */
  private async driveCycle(
    spaceId: string,
    workspaceId: string,
    serviceUserId: string,
    signal?: AbortSignal,
  ): Promise<GitSyncRunStatus> {
    const { runCycle } = await loadGitSync();
    const settings = await this.buildSettings(spaceId);
    const vault = await this.vaultRegistry.getVault(spaceId);
    const client = this.dataSource.bind({
      workspaceId,
      userId: serviceUserId,
      spaceId,
    });

    const result = await runCycle({
      // Cooperative-abort signal from the per-space lock: if a heartbeat refresh
      // cannot confirm the lock, the cycle bails before its next destructive
      // write phase instead of writing blind after a possible lock loss.
      signal,
      spaceId,
      client,
      vault,
      settings,
      // ABSOLUTE-path fs primitives the engine cycle injects (it stays IO-free).
      // `lstat`/`realpath` back the engine's symlink guard: both MUST yield
      // `null` on ENOENT (a not-yet-created file is the normal write case) so the
      // guard can tell "absent" (safe to create) from "is a symlink" (refuse).
      // `lstat` does NOT follow the final link; `realpath` resolves it.
      fs: {
        readFile: (absPath) => readFile(absPath, 'utf8'),
        writeFile: (absPath, text) => writeFile(absPath, text, 'utf8'),
        mkdir: (absDir) => mkdir(absDir, { recursive: true }).then(() => undefined),
        rm: (absPath) => rm(absPath, { force: true }),
        lstat: (absPath) =>
          lstat(absPath).then(
            (st) => ({ isSymbolicLink: st.isSymbolicLink() }),
            (err: NodeJS.ErrnoException) => {
              if (err && err.code === 'ENOENT') return null;
              throw err;
            },
          ),
        realpath: (absPath) =>
          realpath(absPath).then(
            (p) => p,
            (err: NodeJS.ErrnoException) => {
              if (err && err.code === 'ENOENT') return null;
              throw err;
            },
          ),
      },
      // Every cycle logs its full push plan + per-action lines + completion
      // counts (created/updated/deleted/skipped/failures) through this `log`, so
      // what was deleted (and what was not) is always recorded. There is no
      // delete cap: deletes are soft (Trash, reversible), so a blocking limit
      // only got in the way of legitimate deletes; engine correctness (covered by
      // the reconcile/layout tests) is what prevents phantom deletions.
      log: (line: string) => this.logger.log(`git-sync[${spaceId}] ${line}`),
    });

    // §5 invariant breach: the push refused to fast-forward a divergent `docmost`
    // mirror. No data is lost (the refusal is the safety), but the mirror no
    // longer reflects Docmost and the next push will keep refusing until an
    // operator reconciles it — so escalate from the engine's info `log` to a
    // WARN with the spaceId, and surface the flag in the returned status (/status).
    if (result.divergentDocmost) {
      this.logger.warn(
        `git-sync[${spaceId}] push refused to fast-forward a DIVERGENT 'docmost' ` +
          `mirror (invariant §5 broken); manual reconciliation required`,
      );
    }

    return { spaceId, ...result };
  }

  // --- poll-safety interval -------------------------------------

  /** Registered interval name (shared by registration + teardown). */
  private static readonly POLL_INTERVAL_NAME = 'git-sync-poll';

  /**
   * Register the poll-safety interval DYNAMICALLY so it honors the configured
   * GIT_SYNC_POLL_INTERVAL_MS (a static `@Interval` decorator could only hardcode
   * a value at class-eval time, before config is readable — diverging from what
   * `/status` reports). When git-sync is disabled we register nothing.
   *
   * ScheduleModule: forRoot() is registered ONCE globally by TelemetryModule;
   * GitSyncModule imports the plain ScheduleModule so SchedulerRegistry is
   * injectable without a duplicate forRoot.
   *
   * KNOWN MULTI-REPLICA LIMITATION (deferred — do not silently lose this):
   * This is an IN-PROCESS `setInterval` running on EVERY replica. Cross-replica
   * single-writer safety currently rests on the per-space Redis lock
   * (SpaceLockService) plus best-effort abort-on-failed-heartbeat — NOT on true
   * fencing. Under an adversarial schedule (lock TTL lapse during a GC/IO pause)
   * two replicas could still briefly believe they hold a space's lock. The
   * intended future direction is to move this orchestration to a BullMQ queue
   * (one durable, deduplicated job per space instead of N independent interval
   * timers) and add FENCING TOKENS so a stale writer's writes are rejected by the
   * store. The author deferred fencing tokens; this comment is the breadcrumb so
   * the gap is tracked rather than forgotten. See SpaceLockService.liveLocks.
   */
  onModuleInit(): void {
    if (!this.environmentService.isGitSyncEnabled()) return;

    // GIT_SYNC_REMOTE_TEMPLATE is inert scaffolding: the vendored engine has no
    // remote-push path yet (SPEC §7), so setting it does nothing today. Warn once
    // at startup so an operator who configured it isn't left with a silent no-op
    // (review). Remove this warning when the engine grows a remote-push path.
    if (this.environmentService.getGitSyncRemoteTemplate()) {
      this.logger.warn(
        'git-sync: GIT_SYNC_REMOTE_TEMPLATE is set but NOT yet consumed — ' +
          'remote push is deferred (SPEC §7); this value currently has no effect.',
      );
    }

    const ms = this.environmentService.getGitSyncPollIntervalMs();
    const handle = setInterval(() => {
      void this.pollTick();
    }, ms);
    // Do not keep the event loop alive solely for the poll timer.
    handle.unref?.();
    this.schedulerRegistry.addInterval(
      GitSyncOrchestrator.POLL_INTERVAL_NAME,
      handle,
    );
    this.pollIntervalName = GitSyncOrchestrator.POLL_INTERVAL_NAME;
    this.logger.log(`git-sync: poll interval registered (${ms}ms).`);
  }

  /** Tear down the dynamic interval on shutdown (guard against double-delete). */
  onModuleDestroy(): void {
    if (!this.pollIntervalName) return;
    try {
      // deleteInterval clears the timer and removes it from the registry.
      this.schedulerRegistry.deleteInterval(this.pollIntervalName);
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to delete poll interval: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.pollIntervalName = null;
    }
  }

  /** True while a pollTick pass is in flight (re-entrancy guard). */
  private polling = false;

  /**
   * One poll tick: catches events missed by the listener and reconciles after
   * downtime. Gated on GIT_SYNC_ENABLED (defensive — the interval is only
   * registered when enabled). Each enabled space runs under its own lock
   * (overlaps skipped). Never throws (runOnce swallows per-space errors).
   *
   * Re-entrancy guard: a batch of cycles can take LONGER than the poll interval
   * (many spaces, slow pushes), so the next interval tick could fire while this
   * pass is still running. The per-space lock already prevents overlapping cycles
   * for one space, but an overlapping tick still re-runs enabledSpaces() and
   * redundant per-space lock attempts for every space. The `polling` flag skips a
   * tick while one is already in flight; it is in-process only (each replica
   * guards its own ticks — cross-replica overlap is handled by the Redis lock).
   */
  private async pollTick(): Promise<void> {
    if (!this.environmentService.isGitSyncEnabled()) return;
    if (this.polling) return;
    this.polling = true;
    try {
      let spaces: EnabledSpace[];
      try {
        spaces = await this.enabledSpaces();
      } catch (err) {
        this.logger.error(
          `git-sync: failed to enumerate enabled spaces: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      for (const { spaceId, workspaceId } of spaces) {
        // runOnce never throws; a per-space error is logged and returned in status.
        await this.runOnce(spaceId, workspaceId);
      }
    } finally {
      this.polling = false;
    }
  }
}
