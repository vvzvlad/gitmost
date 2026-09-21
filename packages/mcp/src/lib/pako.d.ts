// Minimal ambient type declaration for `pako` (no @types/pako is installed and
// pako 2.x ships no bundled .d.ts). We only use the raw-deflate codec to read
// draw.io's compressed `<diagram>` payload, so declare just that surface.
declare module "pako" {
  interface RawOptions {
    /** When "string", the result is returned as a (binary/UTF-8) string. */
    to?: "string";
    /** Raw-deflate window bits; draw.io uses raw deflate (no zlib header). */
    windowBits?: number;
    level?: number;
  }

  /** Raw-inflate (windowBits: -15). `to:"string"` yields a string. */
  export function inflateRaw(
    data: Uint8Array | ArrayBuffer | number[],
    options: RawOptions & { to: "string" },
  ): string;
  export function inflateRaw(
    data: Uint8Array | ArrayBuffer | number[],
    options?: RawOptions,
  ): Uint8Array;

  /** Raw-deflate (windowBits: -15). Used only by tests to build fixtures. */
  export function deflateRaw(
    data: Uint8Array | string,
    options?: RawOptions,
  ): Uint8Array;

  interface InflateStreamOptions {
    to?: "string";
    windowBits?: number;
    /** Raw deflate (no zlib header) — equivalent to windowBits: -15. */
    raw?: boolean;
    chunkSize?: number;
  }

  /**
   * Streaming inflate. We use it to bound the decompressed size: `onData` is
   * invoked per output chunk, letting us abort a decompression bomb before the
   * full output is materialised.
   */
  export class Inflate {
    constructor(options?: InflateStreamOptions);
    onData: (chunk: string | Uint8Array) => void;
    onEnd: (status: number) => void;
    push(
      data: Uint8Array | ArrayBuffer | number[] | string,
      flushMode?: boolean | number,
    ): boolean;
    result: string | Uint8Array;
    err: number;
    msg: string;
  }

  const _default: {
    inflateRaw: typeof inflateRaw;
    deflateRaw: typeof deflateRaw;
    Inflate: typeof Inflate;
  };
  export default _default;
}
