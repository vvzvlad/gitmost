// #370 Stage B — the share publication mode union + its default, shared across
// the DTO and the service (mirrors the PageHistoryKind pattern in
// collaboration/constants.ts). The client mirrors this union separately since
// it cannot import server code.
export type PublishedMode = 'live' | 'approved';
export const DEFAULT_PUBLISHED_MODE: PublishedMode = 'live';
