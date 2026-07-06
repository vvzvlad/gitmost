// Source https://github.com/ueberdosis/hocuspocus/pull/1008 - MIT
import {
  Extension,
  Hocuspocus,
  IncomingMessage,
  afterUnloadDocumentPayload,
  onConfigurePayload,
  onLoadDocumentPayload,
} from '@hocuspocus/server';
import RedisClient from 'ioredis';
import { readVarString } from 'lib0/decoding.js';
import { CollabProxySocket } from './collab-proxy-socket';
import {
  BaseWebSocket,
  Configuration,
  CustomEvents,
  Pack,
  RSAMessage,
  RSAMessageCloseProxy,
  RSAMessageCustomEventComplete,
  RSAMessageCustomEventStart,
  RSAMessagePong,
  RSAMessageProxy,
  RSAMessageUnload,
  ReadLiveResult,
  SerializedHTTPRequest,
  Unpack,
} from './redis-sync.types';

export type { Pack, SerializedHTTPRequest } from './redis-sync.types';

type ServerId = string;
type DocumentName = string;
type SocketId = string;

export class RedisSyncExtension<TCE extends CustomEvents> implements Extension {
  priority = 1000;
  private readonly pub: RedisClient;
  private sub: RedisClient;
  private readonly pack: Pack;
  private readonly unpack: Unpack;
  private originSockets: Record<SocketId, BaseWebSocket> = {};
  private locks: Record<DocumentName, NodeJS.Timeout> = {};
  private lockPromises: Record<DocumentName, Promise<ServerId | null>> = {};
  private proxySockets: Record<SocketId, CollabProxySocket> = {};
  private readonly prefix: string;
  private readonly lockPrefix: string;
  private readonly msgChannel: string;
  private readonly serverId: ServerId;
  private readonly customEventTTL: number;
  // #647 refinement C — short per-call timeout for the read probe, separate from
  // the 30s write `customEventTTL`.
  private readonly readProbeTTL: number;
  private readonly lockTTL: number;
  private instance!: Hocuspocus;
  private readonly customEvents: TCE;
  private replyIdCounter: number = 0;
  private pendingReplies: Record<
    number,
    {
      // @ts-ignore
      resolve: PromiseWithResolvers<any>['resolve'];
      // @ts-ignore
      reject: PromiseWithResolvers<any>['reject'];
    }
  > = {};

  constructor(configuration: Configuration<TCE>) {
    const {
      redis,
      pack,
      unpack,
      serverId,
      lockTTL,
      prefix,
      customEvents,
      customEventTTL,
      readProbeTTL,
    } = configuration;
    this.pub = redis.duplicate();
    this.sub = redis.duplicate();
    this.pack = pack;
    this.unpack = unpack;
    this.serverId = serverId;
    this.lockTTL = lockTTL ?? 10_000;
    this.customEventTTL = customEventTTL ?? 30_000;
    this.readProbeTTL = readProbeTTL ?? 1_500;
    this.prefix = prefix ?? 'collab';
    this.lockPrefix = `${this.prefix}Lock`;
    this.msgChannel = `${this.prefix}Msg`;
    this.customEvents = (customEvents as any) ?? ({} as any as CustomEvents);
    this.sub.subscribe(this.msgChannel, `${this.msgChannel}:${this.serverId}`);
    this.sub.on('messageBuffer', this.handleRedisMessage);
    this.pub.on('error', () => {});
    this.sub.on('error', () => {});
  }
  private getKey(documentName: string) {
    return `${this.lockPrefix}:${documentName}`;
  }

  private closeProxy(socketId: string) {
    const proxySocket = this.proxySockets[socketId];
    if (proxySocket) {
      proxySocket.emit(
        'close',
        1000,
        Buffer.from('provider_initiated', 'utf-8'),
      );
      delete this.proxySockets[socketId];
    }
  }

  private pongProxy(socketId: string) {
    this.proxySockets[socketId]?.emit('pong');
  }

  private handleProxyMessage(
    msg: Pick<RSAMessageProxy, 'replyTo' | 'message' | 'serializedHTTPRequest'>,
  ) {
    const { replyTo, message, serializedHTTPRequest } = msg;
    const { headers } = serializedHTTPRequest;
    const socketId = headers['sec-websocket-key']!;
    let socket = this.proxySockets[socketId];
    if (!socket) {
      socket = new CollabProxySocket(
        this.pub,
        this.pack,
        replyTo,
        `${this.msgChannel}:${this.serverId}`,
        socketId,
      );
      this.proxySockets[socketId] = socket;
      this.instance.handleConnection(
        socket as any,
        serializedHTTPRequest as any,
        {},
      );
    }
    socket.emit('message', message);
  }

  private getOrClaimLock(documentName: string) {
    const lockPromise = this.pub.set(
      this.getKey(documentName),
      this.serverId,
      'PX',
      this.lockTTL,
      'NX',
      'GET',
    );
    this.lockPromises[documentName] = lockPromise;
    // Briefly cache the serverId that claimed the doc to reduce load on redis
    // When the claimant unloads the doc, it will send an unload message to immediately clear this
    // a lockTTL / 2 guarantees stale reads < lockTTL upon server crash
    setTimeout(() => {
      delete this.lockPromises[documentName];
    }, this.lockTTL / 2);
    return lockPromise;
  }

  private getOrClaimLockThrottled(documentName: string) {
    const existingWorkerIdPromise = this.lockPromises[documentName];
    if (existingWorkerIdPromise) return existingWorkerIdPromise;
    return this.getOrClaimLock(documentName);
  }

  private handleRedisMessage = async (
    _channel: Buffer,
    packedMessage: Buffer,
  ) => {
    const msg = this.unpack(packedMessage) as RSAMessage;
    const { type } = msg;
    if (type === 'proxy') {
      this.handleProxyMessage(msg);
      return;
    }
    if (type === 'closeProxy') {
      this.closeProxy(msg.socketId);
      return;
    }
    if (type === 'pong') {
      this.pongProxy(msg.socketId);
      return;
    }
    if (type === 'unload') {
      delete this.lockPromises[msg.documentName];
      return;
    }
    if (type === 'customEventStart') {
      const { documentName, eventName, payload, replyTo, replyId } = msg;
      let reply: RSAMessageCustomEventComplete;
      try {
        const res = await this.handleEventLocally(
          eventName as Extract<keyof TCE, string>,
          documentName,
          payload,
        );
        reply = {
          type: 'customEventComplete',
          replyId,
          payload: res,
        };
      } catch (err) {
        // The remote handler threw (e.g. the markdown->ProseMirror transform in
        // gitSyncWriteBody can throw on a malformed body). Reply with the error on
        // the SAME correlation channel so the origin rejects promptly with the real
        // message instead of waiting out customEventTTL as a generic 'TIMEOUT'.
        // Catching here also keeps the throw from escaping this async messageBuffer
        // listener as an unhandledRejection on the owning instance.
        reply = {
          type: 'customEventComplete',
          replyId,
          payload: undefined,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      this.pub.publish(`${replyTo}`, this.pack(reply));
      return;
    }
    if (type === 'customEventComplete') {
      const { replyId, payload, error } = msg;
      const pending = this.pendingReplies[replyId];
      if (!pending) return;
      delete this.pendingReplies[replyId];
      if (error !== undefined) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(payload);
      }
      return;
    }
    const { socketId } = msg;
    const socket = this.originSockets[socketId];
    if (!socket) {
      // origin socket already cleaned up
      return;
    }
    if (type === 'close') {
      socket.close(msg.code, msg.reason);
    } else if (type === 'ping') {
      // Reply instantly to the proxy socket, without forwarding to client
      // The origin socket handles heartbeat for itself
      const { replyTo, socketId } = msg;
      const reply: RSAMessagePong = {
        type: 'pong',
        socketId,
      };
      this.pub.publish(`${replyTo}`, this.pack(reply));
    } else if (type === 'send') {
      socket.send(msg.message);
    }
  };

  async maintainLock(documentName: string) {
    // #348 — clear any existing timer for this document before installing a new
    // one. Without this, a second maintainLock for the same document (a
    // reload-without-unload) overwrites this.locks[documentName] and leaks the
    // previous interval, which keeps firing SET forever with no way to clear it.
    if (this.locks[documentName]) {
      clearInterval(this.locks[documentName]);
    }
    this.locks[documentName] = setInterval(() => {
      this.pub.set(
        this.getKey(documentName),
        this.serverId,
        'PX',
        this.lockTTL,
      );
    }, this.lockTTL / 2);
  }

  async releaseLock(documentName: string) {
    clearInterval(this.locks[documentName]);
    delete this.locks[documentName];
    return this.pub.del(this.getKey(documentName));
  }

  private async handleEventLocally<TName extends Extract<keyof TCE, string>>(
    eventName: TName,
    documentName: string,
    payload: any,
  ) {
    const handler = this.customEvents[eventName];
    if (!handler) throw new Error(`Invalid eventName: ${eventName}`);
    const result = await handler(documentName, payload);
    return result as Promise<ReturnType<TCE[TName]>>;
  }

  async handleEvent<TName extends Extract<keyof TCE, string>>(
    eventName: TName,
    documentName: string,
    payload: any,
  ) {
    const isDocLoadedOnInstance = this.instance.documents.has(documentName);

    if (isDocLoadedOnInstance) {
      return this.handleEventLocally(eventName, documentName, payload);
    }

    const proxyTo = await this.getOrClaimLockThrottled(documentName);
    if (proxyTo && proxyTo !== this.serverId) {
      ++this.replyIdCounter; // bug in biome thinks this.replyIdCounter is not used if written on the line below
      const replyId = this.replyIdCounter;
      // another server owns the doc
      const proxyMessage: RSAMessageCustomEventStart = {
        eventName,
        documentName,
        payload,
        replyTo: `${this.msgChannel}:${this.serverId}`,
        replyId,
        type: 'customEventStart',
      };
      const msg = this.pack(proxyMessage);
      this.pub.publish(`${this.msgChannel}:${proxyTo}`, msg);
      // Manual deferred (no Promise.withResolvers) so this runs on Node < 22 too.
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.pendingReplies[replyId] = { resolve, reject };
      setTimeout(() => {
        // Fallback for a genuinely lost reply. A handler that threw now rejects
        // promptly via the error-carrying customEventComplete above; this TIMEOUT
        // only fires when no reply ever comes back.
        if (this.pendingReplies[replyId]) {
          delete this.pendingReplies[replyId];
          reject('TIMEOUT');
        }
      }, this.customEventTTL);
      return promise as Promise<ReturnType<TCE[TName]>>;
    }
    // This server owns the document, but hocuspocus hasn't loaded it yet
    return this.handleEventLocally(eventName, documentName, payload);
  }

  /**
   * #647 refinement B — the `readLiveIfLoaded` primitive #654 gates on. Reads the
   * live (fully hydrated) content of a document IF it is already loaded on SOME
   * instance, WITHOUT force-loading it and WITHOUT claiming ownership.
   *
   * Contract (see redis-sync.types `ReadLiveResult` + collaboration.handler
   * `readLiveContent`):
   *  1. Caller passes the resolved `page.<uuid>` documentName (never a slug).
   *  2. No force-load — a not-loaded doc returns `{loaded:false}`, never triggers
   *     a DB hydrate.
   *  3. Non-claiming — routing uses a plain `GET` of the lock key, NEVER the
   *     `SET … NX` claim path (`getOrClaimLock`). A pure read on a non-owner does
   *     not take ownership / cause misrouting.
   *  4. Distinguishes `{loaded:false}` (no owner / not hydrated) from
   *     `{loaded:false, unreachable:true}` (owner exists but the probe timed out).
   *  5. `loaded:true ⇒ content` is the fully hydrated live doc (enforced by the
   *     owner-side handler reading only docs already in `documents`).
   *  6. Its OWN short timeout (`readProbeTTL`, per-call overridable), separate
   *     from the 30s write `customEventTTL`.
   */
  async readLiveIfLoaded(
    documentName: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<ReadLiveResult> {
    // Loaded on THIS instance → read it directly (no lock touched, no load).
    if (this.instance.documents.has(documentName)) {
      return this.handleEventLocally(
        'readLiveContent' as Extract<keyof TCE, string>,
        documentName,
        undefined,
      ) as Promise<ReadLiveResult>;
    }

    // Not loaded here. Probe ownership with a NON-CLAIMING plain GET — never
    // `SET … NX` (that would claim the doc and misroute future writes, #647 B2).
    const owner = await this.pub.get(this.getKey(documentName));

    // No owner recorded, or WE hold the lock but haven't hydrated the doc: it is
    // not loaded anywhere we can read without forcing a load. `{loaded:false}`.
    if (!owner || owner === this.serverId) {
      return { loaded: false };
    }

    // Another instance owns it. Route a `readLiveContent` probe to that instance
    // over the bridge, with the SHORT read timeout (not the 30s write TTL). The
    // remote runs the same non-force-loading handler; a timeout means the owner is
    // UNREACHABLE (distinct from not-loaded — contract point 4).
    const timeoutMs = opts.timeoutMs ?? this.readProbeTTL;
    try {
      const res = await this.sendRemoteEvent(
        'readLiveContent',
        documentName,
        undefined,
        owner,
        timeoutMs,
      );
      return res as ReadLiveResult;
    } catch {
      return { loaded: false, unreachable: true };
    }
  }

  /**
   * #647 — publish a custom event to a specific owner instance and await its
   * reply with a caller-supplied timeout. Factored out of `handleEvent` so the
   * read probe can use its own short TTL instead of the 30s write `customEventTTL`.
   */
  private sendRemoteEvent(
    eventName: string,
    documentName: string,
    payload: unknown,
    proxyTo: ServerId,
    timeoutMs: number,
  ): Promise<unknown> {
    ++this.replyIdCounter;
    const replyId = this.replyIdCounter;
    const proxyMessage: RSAMessageCustomEventStart = {
      eventName,
      documentName,
      payload,
      replyTo: `${this.msgChannel}:${this.serverId}`,
      replyId,
      type: 'customEventStart',
    };
    this.pub.publish(`${this.msgChannel}:${proxyTo}`, this.pack(proxyMessage));
    // Plain `new Promise` (not `Promise.withResolvers`, which is Node 22+) so the
    // read probe is portable across the server's supported runtimes.
    return new Promise<unknown>((resolve, reject) => {
      // `pendingReplies` stores {resolve, reject} (the shared reply handler calls
      // pending.resolve/pending.reject on customEventComplete); mirror that shape
      // here so the #647 read probe uses the same map as handleEvent.
      this.pendingReplies[replyId] = { resolve, reject };
      setTimeout(() => {
        // Drop the pending resolver so a late reply cannot leak or resolve a
        // reused id; the awaiting caller has already gone down the reject path.
        if (this.pendingReplies[replyId]) {
          delete this.pendingReplies[replyId];
          reject(new Error('TIMEOUT'));
        }
      }, timeoutMs);
    });
  }

  async lockDocument(documentName: string) {
    const proxyTo = await this.getOrClaimLockThrottled(documentName);
    if (proxyTo && proxyTo !== this.serverId) {
      throw new Error(`Could not lock document: ${documentName}`);
    }
    this.maintainLock(documentName);
    return () => this.releaseLock(documentName);
  }

  /* WebSocket Server Hooks */
  onSocketOpen(
    ws: BaseWebSocket,
    serializedHTTPRequest: SerializedHTTPRequest,
    context = {},
  ) {
    const socketId = serializedHTTPRequest.headers['sec-websocket-key']!;
    this.originSockets[socketId] = ws;
    this.instance.handleConnection(
      ws as any,
      serializedHTTPRequest as any,
      context,
    );
  }

  async onSocketMessage(
    ws: BaseWebSocket,
    serializedHTTPRequest: SerializedHTTPRequest,
    detachableMsg: ArrayBuffer,
  ) {
    const message = new Uint8Array(detachableMsg.slice());
    const tmpMsg = new IncomingMessage(detachableMsg);
    const documentName = readVarString(tmpMsg.decoder);
    const isDocLoadedOnInstance = this.instance.documents.has(documentName);

    if (isDocLoadedOnInstance) {
      ws.emit('message', message);
      return;
    }

    const proxyTo = await this.getOrClaimLockThrottled(documentName);
    if (proxyTo && proxyTo !== this.serverId) {
      // another server owns the doc
      const proxyMessage: RSAMessageProxy = {
        serializedHTTPRequest: serializedHTTPRequest,
        replyTo: `${this.msgChannel}:${this.serverId}`,
        message,
        type: 'proxy',
      };
      const msg = this.pack(proxyMessage);
      this.pub.publish(`${this.msgChannel}:${proxyTo}`, msg);
      return;
    }
    // This server owns the document, but hocuspocus hasn't loaded it yet
    ws.emit('message', message);
  }

  onSocketClose(socketId: string, code?: number, reason?: ArrayBuffer) {
    const socket = this.originSockets[socketId];
    if (!socket) return;
    // at this point the socket is considered GC'd and we cannot call close
    // The origin socket did not set up any connections for the proxy, so none of the hooks will work if we just emit
    socket?.emit('close', code, reason);
    delete this.originSockets[socketId];
    const msg: RSAMessageCloseProxy = { type: 'closeProxy', socketId };
    this.pub.publish(this.msgChannel, this.pack(msg)).catch(() => {});
  }

  /* Hocuspocus hooks */
  async onConfigure({ instance }: onConfigurePayload) {
    this.instance = instance;
  }

  async onLoadDocument(data: onLoadDocumentPayload) {
    const { documentName } = data;
    // Refresh the lock TTL
    this.maintainLock(documentName);
  }

  async afterUnloadDocument(data: afterUnloadDocumentPayload) {
    const { documentName } = data;
    this.releaseLock(documentName);
    // Broadcast to cluster to immediately remove the cached redis value
    const msg: RSAMessageUnload = { type: 'unload', documentName };
    this.pub.publish(this.msgChannel, this.pack(msg));
  }

  async onDestroy() {
    this.pub.disconnect(false);
    this.sub.disconnect(false);
  }
}
