import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ default: { post } }));

import { transcribeWithRetry } from "./dictation-service";

const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const ok = (text: string) => ({ data: { text } });

describe("transcribeWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a network error and a 5xx, then returns the text", async () => {
    post
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce(ok("hello"));
    const result = transcribeWithRetry(new Blob(), "speech.wav", () => false);
    await vi.advanceTimersByTimeAsync(7000);
    await expect(result).resolves.toBe("hello");
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("gives up after three attempts", async () => {
    post.mockRejectedValue(httpError(502));
    const result = transcribeWithRetry(new Blob(), "speech.wav", () => false);
    const settled = expect(result).rejects.toMatchObject({
      response: { status: 502 },
    });
    await vi.advanceTimersByTimeAsync(7000);
    await settled;
    expect(post).toHaveBeenCalledTimes(3);
  });

  it.each([400, 413, 429])("does not retry a %i", async (status) => {
    post.mockRejectedValue(httpError(status));
    await expect(
      transcribeWithRetry(new Blob(), "speech.wav", () => false),
    ).rejects.toMatchObject({ response: { status } });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the session is stale", async () => {
    post.mockRejectedValue(new Error("Network Error"));
    let stale = false;
    const result = transcribeWithRetry(new Blob(), "speech.wav", () => stale);
    const settled = expect(result).rejects.toThrow("Network Error");
    stale = true;
    await vi.advanceTimersByTimeAsync(2000);
    await settled;
    expect(post).toHaveBeenCalledTimes(1);
  });
});
