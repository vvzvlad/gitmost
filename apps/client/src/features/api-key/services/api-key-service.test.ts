import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api-client (axios instance). vi.mock replaces the whole module, so
// the real response interceptor — which returns `response.data`, i.e. the
// server envelope { data, success, status } — is bypassed. Our mocked post/get
// therefore resolve to that post-interceptor envelope shape directly, and the
// service under test reads `.data` off it to unwrap the inner payload. This is
// the one bug-prone line the component tests (which fully mock the service)
// never exercise.
const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  default: { post, get },
}));

import {
  createApiKey,
  getApiKeys,
  revealApiKey,
} from "@/features/api-key/services/api-key-service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("api-key-service response-contract unwrap", () => {
  it("createApiKey unwraps the envelope to { token, apiKey }", async () => {
    const payload = {
      token: "gm_secret-abc",
      apiKey: {
        id: "key-1",
        name: "CI token",
        expiresAt: "2027-07-11T12:00:00.000Z",
        createdAt: "2026-07-11T12:00:00.000Z",
      },
    };
    // The server envelope as the interceptor hands it to the service.
    post.mockResolvedValue({ data: payload, success: true, status: 200 });

    const result = await createApiKey({
      name: "CI token",
      expiresAt: "2027-07-11T12:00:00.000Z",
    });

    // The inner payload only — not the { data, success, status } wrapper.
    expect(result).toEqual(payload);
    expect(result.token).toBe("gm_secret-abc");
    expect(result.apiKey).toEqual(payload.apiKey);
    expect(post).toHaveBeenCalledWith("/api-keys/create", {
      name: "CI token",
      expiresAt: "2027-07-11T12:00:00.000Z",
    });
  });

  it("getApiKeys unwraps the envelope to the array of rows", async () => {
    const rows = [
      {
        id: "key-1",
        name: "CI token",
        expiresAt: null,
        lastUsedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "key-2",
        name: "Deploy token",
        expiresAt: "2027-01-01T00:00:00.000Z",
        lastUsedAt: null,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ];
    post.mockResolvedValue({ data: rows, success: true, status: 200 });

    const result = await getApiKeys();

    expect(result).toEqual(rows);
    expect(result).toHaveLength(2);
    expect(post).toHaveBeenCalledWith("/api-keys/list");
  });

  it("revealApiKey unwraps the envelope to the bare token string", async () => {
    const SECRET = "gm_revealed-token";
    post.mockResolvedValue({
      data: { token: SECRET },
      success: true,
      status: 200,
    });

    const result = await revealApiKey({ id: "key-1", password: "pw" });

    // The service returns ONLY the token string (not the { token } wrapper), so
    // the caller can copy it straight to the clipboard.
    expect(result).toBe(SECRET);
    expect(post).toHaveBeenCalledWith("/api-keys/reveal", {
      id: "key-1",
      password: "pw",
    });
  });
});
