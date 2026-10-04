import EventEmitter from 'node:events';
import { IncomingHttpHeaders } from 'node:http2';
import RedisClient from 'ioredis';

export type SecondParam<T> = T extends (
  arg1: unknown,
  arg2: infer A,
  ...args: unknown[]
) => unknown
  ? A
  : never;

export type SerializedHTTPRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  socket: { remoteAddress: string };
};

export type RSAMessageProxy = {
  type: 'proxy';
  replyTo: string;
  message: Uint8Array<ArrayBufferLike>;
  serializedHTTPRequest: SerializedHTTPRequest;
};

export type RSAMessageCloseProxy = {
  type: 'closeProxy';
  socketId: string;
};

export type RSAMessageUnload = {
  type: 'unload';
  documentName: string;
};

export type RSAMessageClose = {
  type: 'close';
  code?: number;
  reason?: string;
  socketId: string;
};

export type RSAMessagePing = {
  type: 'ping';
  socketId: string;
  replyTo: string;
};

export type RSAMessagePong = {
  type: 'pong';
  socketId: string;
};

export type RSAMessageSend = {
  type: 'send';
  // @ts-ignore
  message: Uint8Array<ArrayBufferLike>;
  socketId: string;
};

export type RSAMessageCustomEventStart<TName = string, TPayload = unknown> = {
  type: 'customEventStart';
  documentName: string;
  eventName: TName;
  payload: TPayload;
  replyTo: string;
  replyId: number;
};

export type RSAMessageCustomEventComplete = {
  type: 'customEventComplete';
  replyId: number;
  payload: unknown;
  // When the remote handler THREW, the owner sends back the error message here
  // instead of a payload, so the origin can reject its awaiting promise promptly
  // (with the real error) rather than waiting out the customEventTTL timeout.
  error?: string;
};

export type RSAMessage =
  | RSAMessageProxy
  | RSAMessageCloseProxy
  | RSAMessageUnload
  | RSAMessageClose
  | RSAMessagePing
  | RSAMessagePong
  | RSAMessageSend
  | RSAMessageCustomEventStart
  | RSAMessageCustomEventComplete;

// @ts-ignore
export type Pack = (msg: RSAMessage) => string | Buffer<ArrayBufferLike>;

export type Unpack = (
  // @ts-ignore
  packedMessage: Uint8Array | Buffer<ArrayBufferLike>,
) => RSAMessage;

type ServerId = string;
type DocumentName = string;
type CustomEventName = string;

export type CustomEvents = Record<
  CustomEventName,
  (documentName: string, payload: unknown) => Promise<unknown>
>;

export interface Configuration<TCE> {
  redis: RedisClient;
  pack: Pack;
  unpack: Unpack;
  serverId: ServerId;
  lockTTL?: number;
  customEventTTL?: number;
  // #647 refinement C — default per-call timeout for the NON-CLAIMING read probe
  // (`readLiveIfLoaded`). SEPARATE from the 30s write `customEventTTL`, so the hot
  // read path never inherits a 30s stall on a hung owner. Overridable per call.
  readProbeTTL?: number;
  prefix?: string;
  customEvents?: TCE;
}

/**
 * #647 refinement B — bridge-level result of `readLiveIfLoaded`. Distinguishes
 * (contract point 4) a document that is simply NOT LOADED (no owner, or the owner
 * hasn't hydrated it) from an owner that is UNREACHABLE (exists but the short
 * probe timed out / errored) — #654 maps these to different metrics.
 */
export type ReadLiveResult =
  | { loaded: true; content: any; hash: string }
  | { loaded: false }
  | { loaded: false; unreachable: true };

export type BaseWebSocket = EventEmitter & {
  readyState: number;
  close(code?: number, reason?: string): void;
  ping(): void;
  send(message: Uint8Array): void;
};
