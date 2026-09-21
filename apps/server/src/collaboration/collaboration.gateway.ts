import {
  connectedPayload,
  Extension,
  Hocuspocus,
  onConnectPayload,
} from '@hocuspocus/server';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { AuthenticationExtension } from './extensions/authentication.extension';
import { PersistenceExtension } from './extensions/persistence.extension';
import { Injectable } from '@nestjs/common';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
} from '../common/helpers';
import { LoggerExtension } from './extensions/logger.extension';
import {
  RedisSyncExtension,
  SerializedHTTPRequest,
} from './extensions/redis-sync';
import { WsSocketWrapper } from './extensions/redis-sync/ws-socket-wrapper';
import RedisClient from 'ioredis';
import { pack, unpack } from 'msgpackr';
import { nanoid } from 'nanoid';
import * as os from 'node:os';
import { CollabWsAdapter } from './adapter/collab-ws.adapter';
import {
  CollaborationHandler,
  CollabEventHandlers,
} from './collaboration.handler';
import {
  incDocLoad,
  incDocUnload,
  isMetricsEnabled,
  observeCollabConnect,
  registerDocsOpenSource,
} from '../integrations/metrics/metrics.registry';

/**
 * #402 — collab lifecycle metrics as a lightweight hocuspocus extension.
 *
 * - afterLoadDocument / afterUnloadDocument (fire once PER DOCUMENT) drive the
 *   doc load/unload counters.
 * - collab_connect_duration_seconds: I time the onConnect→connected hook pair,
 *   i.e. connection ACCEPTANCE (which includes the auth handshake). This is the
 *   cleanest per-connection correlation hocuspocus exposes: both payloads carry
 *   the SAME `request` IncomingMessage object, so a WeakMap keyed on it gives a
 *   per-connection start with NO leak (the entry is GC'd with the request if a
 *   connection is rejected in onAuthenticate and `connected` never fires).
 *   I deliberately do NOT observe at afterLoadDocument: that hook fires per
 *   DOCUMENT, not per connection, so a second client joining an already-open
 *   doc would be missed. auth/load latencies are their own separate metrics.
 *
 * All helpers are no-ops when METRICS_PORT is unset; these hooks are per
 * connect/load/unload (never per message), so there is no hot-path cost.
 */
class CollabMetricsExtension implements Extension {
  // Keyed by the per-connection request object → connect start time (ms).
  private readonly connectStarts = new WeakMap<object, number>();

  async onConnect(data: onConnectPayload) {
    this.connectStarts.set(data.request, performance.now());
  }

  async connected(data: connectedPayload) {
    const start = this.connectStarts.get(data.request);
    if (start !== undefined) {
      observeCollabConnect((performance.now() - start) / 1000);
      this.connectStarts.delete(data.request);
    }
  }

  async afterLoadDocument() {
    incDocLoad();
  }

  async afterUnloadDocument() {
    incDocUnload();
  }
}

@Injectable()
export class CollaborationGateway {
  private readonly hocuspocus: Hocuspocus;
  private redisConfig: RedisConfig;
  // @ts-ignore
  private readonly redisSync: RedisSyncExtension<CollabEventHandlers> | null =
    null;
  // Source ioredis client that RedisSyncExtension duplicates into its pub/sub
  // pair. The extension's onDestroy only disconnects those duplicates, so we
  // keep a reference here and disconnect the source ourselves on shutdown
  // (otherwise the socket leaks and jest never exits in e2e).
  private redisClient: RedisClient | null = null;
  private readonly withRedis: boolean;

  constructor(
    private authenticationExtension: AuthenticationExtension,
    private persistenceExtension: PersistenceExtension,
    private loggerExtension: LoggerExtension,
    private environmentService: EnvironmentService,
    private collabEventsService: CollaborationHandler,
  ) {
    this.redisConfig = parseRedisUrl(this.environmentService.getRedisUrl());
    this.withRedis = !this.environmentService.isCollabDisableRedis();

    this.hocuspocus = new Hocuspocus({
      debounce: 10000,
      maxDebounce: 45000,
      unloadImmediately: false,
      extensions: [
        this.authenticationExtension,
        this.persistenceExtension,
        this.loggerExtension,
        // #402 collab lifecycle + connect-duration metrics (no-op when off).
        new CollabMetricsExtension(),
      ],
    });

    // #402 — read-on-scrape source for collab_docs_open. Wire ONCE, gated, so
    // nothing runs when metrics are disabled. The gauge's collect() pulls the
    // live count from the hocuspocus instance on each scrape (no inc/dec drift).
    if (isMetricsEnabled()) {
      registerDocsOpenSource(() => this.hocuspocus.getDocumentsCount());
    }

    if (this.withRedis) {
      this.redisClient = new RedisClient({
        host: this.redisConfig.host,
        port: this.redisConfig.port,
        password: this.redisConfig.password,
        db: this.redisConfig.db,
        family: this.redisConfig.family,
        retryStrategy: createRetryStrategy(),
      });
      // @ts-ignore
      this.redisSync = new RedisSyncExtension({
        redis: this.redisClient,
        serverId: `collab-${os?.hostname()}-${nanoid(10)}`,
        prefix: 'collab',
        pack,
        unpack,
        // @ts-ignore
        customEvents: this.collabEventsService.getHandlers(this.hocuspocus),
      });
      this.hocuspocus.configuration.extensions.push(this.redisSync);
      // @ts-ignore
      this.redisSync.onConfigure({ instance: this.hocuspocus });
    }
  }

  private serializeRequest(request: IncomingMessage): SerializedHTTPRequest {
    return {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: {
        'sec-websocket-key': request.headers['sec-websocket-key'] ?? '',
        'sec-websocket-protocol':
          request.headers['sec-websocket-protocol'] ?? '',
      },
      socket: { remoteAddress: request.socket?.remoteAddress ?? '' },
    };
  }

  handleConnection(client: WebSocket, request: IncomingMessage): any {
    if (this.redisSync) {
      const serializedHTTPRequest = this.serializeRequest(request);
      const socketId = serializedHTTPRequest.headers['sec-websocket-key'];

      // Create wrapper socket that only receives events via emit()
      // This prevents double-handling since Hocuspocus won't listen to raw WebSocket events
      const wrappedSocket = new WsSocketWrapper(client);

      // Route through RedisSync extension (this calls handleConnection internally)
      this.redisSync.onSocketOpen(wrappedSocket as any, serializedHTTPRequest);

      // Forward raw WebSocket messages to the extension
      client.on('message', (data: ArrayBuffer) => {
        this.redisSync!.onSocketMessage(
          wrappedSocket as any,
          serializedHTTPRequest,
          data,
        );
      });

      // Forward close events
      client.on('close', (code: number, reason: Buffer) => {
        this.redisSync!.onSocketClose(socketId, code, reason.buffer as ArrayBuffer);
      });

      // Forward pong events for keepalive
      client.on('pong', (data: Buffer) => {
        wrappedSocket.emit('pong', data);
      });
    } else {
      // Fallback to direct Hocuspocus connection
      this.hocuspocus.handleConnection(client, request);
    }
  }

  getConnectionCount() {
    return this.hocuspocus.getConnectionsCount();
  }

  getDocumentCount() {
    return this.hocuspocus.getDocumentsCount();
  }

  handleYjsEvent<TName extends keyof CollabEventHandlers>(
    eventName: TName,
    documentName: string,
    payload: Parameters<CollabEventHandlers[TName]>[1],
  ): ReturnType<CollabEventHandlers[TName]> {
    if (this.redisSync) {
      // Normal path: the Redis bridge routes the event to the instance that owns
      // the document (local or another worker) and carries the handler's return
      // value back to us (customEventComplete + replyId).
      return this.redisSync.handleEvent(
        eventName,
        documentName,
        payload,
      ) as ReturnType<CollabEventHandlers[TName]>;
    }

    // COLLAB_DISABLE_REDIS: there is no cross-process bridge, so a single local
    // hocuspocus instance owns every document. Invoke the handler directly
    // against it instead of returning undefined — otherwise doc-mutation events
    // (setCommentMark / resolveCommentMark / applyCommentSuggestion) would
    // silently no-op and, for suggestions, the caller could never learn the
    // verdict. openDirectConnection loads the doc via the persistence extension
    // if it is not already in memory.
    if (this.hocuspocus) {
      const handlers = this.collabEventsService.getHandlers(this.hocuspocus);
      const handler = handlers[eventName] as (
        documentName: string,
        payload: unknown,
      ) => ReturnType<CollabEventHandlers[TName]>;
      return handler(documentName, payload);
    }

    // Collaboration was never initialized (no live instance). Fail loudly rather
    // than silently dropping a mutation; phase 4's caller maps this to a 5xx.
    throw new Error(
      `Cannot handle collaboration event "${String(
        eventName,
      )}": requires a live collaboration instance`,
    );
  }

  openDirectConnection(documentName: string, context?: any) {
    return this.hocuspocus.openDirectConnection(documentName, context);
  }

  /**
   * #647 refinement B — the `readLiveIfLoaded` primitive (#654's gating
   * deliverable). NON-CLAIMING, NON-FORCE-LOADING read of a document's live
   * content: returns `{loaded:true, content, hash}` only if the doc is already
   * hydrated on some instance, else `{loaded:false}` (or `{loaded:false,
   * unreachable:true}` when the owner exists but the short probe timed out). See
   * RedisSyncExtension.readLiveIfLoaded for the full 6-property contract.
   */
  async readLiveIfLoaded(
    documentName: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<
    | { loaded: true; content: any; hash: string }
    | { loaded: false; unreachable?: boolean }
  > {
    if (this.redisSync) {
      return this.redisSync.readLiveIfLoaded(documentName, opts);
    }

    // COLLAB_DISABLE_REDIS: one local instance owns every document, so read it
    // directly through the same non-force-loading handler (it only reads docs
    // already in `hocuspocus.documents`; a missing doc → {loaded:false}).
    if (this.hocuspocus) {
      const handlers = this.collabEventsService.getHandlers(this.hocuspocus);
      return handlers.readLiveContent(documentName);
    }

    // Collaboration was never initialized: nothing is loaded anywhere.
    return { loaded: false };
  }

  /*
   *Can be used before calling openDirectConnection directly
   */
  async lockDocument(documentName: string) {
    return this.redisSync.lockDocument(documentName);
  }

  /*
   *Releases a document lock and stops the interval that maintains it.
   */
  async releaseLock(documentName: string) {
    return this.redisSync.releaseLock(documentName);
  }

  async destroy(collabWsAdapter: CollabWsAdapter): Promise<void> {
    // eslint-disable-next-line no-async-promise-executor
    await new Promise(async (resolve) => {
      try {
        // Wait for all documents to unload
        this.hocuspocus.configuration.extensions.push({
          async afterUnloadDocument({ instance }) {
            if (instance.getDocumentsCount() === 0) resolve('');
          },
        });

        collabWsAdapter?.close();

        if (this.hocuspocus.getDocumentsCount() === 0) resolve('');
        this.hocuspocus.closeConnections();
      } catch (error) {
        console.error(error);
      }
    });

    await this.hocuspocus.hooks('onDestroy', { instance: this.hocuspocus });

    // RedisSyncExtension.onDestroy (run via the hook above) disconnects only the
    // duplicated pub/sub clients; the source client created here is ours to close.
    this.redisClient?.disconnect();
    this.redisClient = null;
  }
}
