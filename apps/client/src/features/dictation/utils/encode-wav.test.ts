import { describe, it, expect } from "vitest";
import { encodeWavPcm16 } from "./encode-wav";

// Contract tests for `encodeWavPcm16` (encode-wav.ts). The dictation feature
// streams microphone audio as mono 16-bit PCM WAV to the STT endpoint, which
// whitelists audio/wav. A regression in the WAV header or PCM16 clamping would
// produce audio the server cannot decode (silence / garbled transcripts), so we
// assert the canonical 44-byte header layout and the sample quantisation rails.

// Read a DataView back out of a Blob. jsdom's Blob does not implement
// `.arrayBuffer()`, so go through FileReader.readAsArrayBuffer instead.
function readView(blob: Blob): Promise<DataView> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new DataView(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function readStr(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe("encodeWavPcm16", () => {
  it("writes the canonical RIFF/WAVE/fmt /data tags", async () => {
    const view = await readView(encodeWavPcm16(new Float32Array(4)));
    expect(readStr(view, 0, 4)).toBe("RIFF");
    expect(readStr(view, 8, 4)).toBe("WAVE");
    expect(readStr(view, 12, 4)).toBe("fmt ");
    expect(readStr(view, 36, 4)).toBe("data");
  });

  it("writes a PCM fmt chunk (size=16, format=1, mono, 16-bit)", async () => {
    const samples = new Float32Array(10);
    const view = await readView(encodeWavPcm16(samples));
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // audioFormat = PCM
    expect(view.getUint16(22, true)).toBe(1); // channels = mono
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("derives byteRate, blockAlign and dataSize from the sample rate and length", async () => {
    const sampleRate = 16000;
    const samples = new Float32Array(10);
    const view = await readView(encodeWavPcm16(samples, sampleRate));
    expect(view.getUint32(28, true)).toBe(sampleRate * 2); // byteRate = sampleRate * 2
    expect(view.getUint16(32, true)).toBe(2); // blockAlign = 2 (mono * 16-bit)
    expect(view.getUint32(40, true)).toBe(samples.length * 2); // dataSize
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2); // RIFF chunk size
  });

  it("defaults the sample rate to 16000 at offset 24", async () => {
    const view = await readView(encodeWavPcm16(new Float32Array(2)));
    expect(view.getUint32(24, true)).toBe(16000);
  });

  it("writes the overridden sample rate at offset 24 (8000 / 48000)", async () => {
    const view8 = await readView(encodeWavPcm16(new Float32Array(2), 8000));
    expect(view8.getUint32(24, true)).toBe(8000);
    expect(view8.getUint32(28, true)).toBe(8000 * 2); // byteRate follows the override

    const view48 = await readView(encodeWavPcm16(new Float32Array(2), 48000));
    expect(view48.getUint32(24, true)).toBe(48000);
    expect(view48.getUint32(28, true)).toBe(48000 * 2);
  });

  it("clamps and quantises PCM16 samples to the asymmetric rails", async () => {
    // +1.0 -> 32767 (clamped>=0 uses *0x7fff), -1.0 -> -32768 (clamped<0 uses *0x8000),
    // 0 -> 0, and out-of-range values are clamped to the rails first.
    const samples = new Float32Array([1.0, -1.0, 0, 1.5, -1.5]);
    const view = await readView(encodeWavPcm16(samples));
    expect(view.getInt16(44 + 0 * 2, true)).toBe(32767); // +1.0
    expect(view.getInt16(44 + 1 * 2, true)).toBe(-32768); // -1.0
    expect(view.getInt16(44 + 2 * 2, true)).toBe(0); // 0
    expect(view.getInt16(44 + 3 * 2, true)).toBe(32767); // +1.5 -> clamped to +1.0
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-32768); // -1.5 -> clamped to -1.0
  });

  it("produces a mono blob of length 44 + samples.length * 2", () => {
    expect(encodeWavPcm16(new Float32Array(0)).size).toBe(44);
    expect(encodeWavPcm16(new Float32Array(100)).size).toBe(44 + 100 * 2);
    expect(encodeWavPcm16(new Float32Array(100)).type).toBe("audio/wav");
  });
});
