import {
  NotificationType,
  DIRECT_NOTIFICATION_TYPES,
  UPDATES_NOTIFICATION_TYPES,
  getTypesForTab,
} from './notification.constants';

// Contract tests for `getTypesForTab` (notification.constants.ts), which maps a
// notification tab to the set of notification types it should contain.
//   - 'direct'  -> a 5-type whitelist (mentions / comments / permission grants)
//   - 'updates' -> exactly [PAGE_UPDATED]
//   - 'all'     -> undefined (no type filter)

describe('getTypesForTab', () => {
  it("returns exactly the 5 whitelisted types for 'direct'", () => {
    expect(getTypesForTab('direct')).toEqual([
      NotificationType.COMMENT_USER_MENTION,
      NotificationType.COMMENT_CREATED,
      NotificationType.COMMENT_RESOLVED,
      NotificationType.PAGE_USER_MENTION,
      NotificationType.PAGE_PERMISSION_GRANTED,
    ]);
    expect(getTypesForTab('direct')).toHaveLength(5);
    expect(getTypesForTab('direct')).toBe(DIRECT_NOTIFICATION_TYPES);
  });

  it("returns [PAGE_UPDATED] for 'updates'", () => {
    expect(getTypesForTab('updates')).toEqual([NotificationType.PAGE_UPDATED]);
    expect(getTypesForTab('updates')).toBe(UPDATES_NOTIFICATION_TYPES);
  });

  it("returns undefined (no filter) for 'all'", () => {
    expect(getTypesForTab('all')).toBeUndefined();
  });
});

// CONTRACT vs the repository query (notification.repo.ts ~line 57):
//   direct  -> WHERE type != PAGE_UPDATED
//   updates -> WHERE type =  PAGE_UPDATED
//
// For 'updates' the whitelist and the SQL agree exactly. For 'direct' they
// DIVERGE: the whitelist is a positive 5-type allow-list, but `type != PAGE_UPDATED`
// returns EVERY non-PAGE_UPDATED type — including verification/approval types that
// are NOT in the whitelist. So the repo would surface notifications the 'direct'
// tab is not supposed to contain. We model the repo predicate and assert it should
// match the whitelist; the 'direct' case genuinely fails today, so it is locked with
// `test.failing` (suite stays green, flips red once repo + whitelist are reconciled).

// What the repo's WHERE clause would actually return, given all known types.
const ALL_TYPES = Object.values(NotificationType);
function repoTypesForTab(tab: 'direct' | 'updates'): string[] {
  if (tab === 'direct') {
    return ALL_TYPES.filter((t) => t !== NotificationType.PAGE_UPDATED);
  }
  return ALL_TYPES.filter((t) => t === NotificationType.PAGE_UPDATED);
}

describe('getTypesForTab vs notification.repo query', () => {
  it("'updates' whitelist matches the repo's `type = PAGE_UPDATED` filter", () => {
    expect(new Set(repoTypesForTab('updates'))).toEqual(
      new Set(getTypesForTab('updates')),
    );
  });

  // BUG LOCK: the 'direct' whitelist (5 types) does not match what the repo's
  // `type != PAGE_UPDATED` filter returns (all non-PAGE_UPDATED types). This SHOULD
  // match; it currently does not. Flips green once the repo filters by the whitelist
  // (e.g. `type IN (DIRECT_NOTIFICATION_TYPES)`).
  test.failing(
    "'direct' whitelist matches the repo's `type != PAGE_UPDATED` filter",
    () => {
      expect(new Set(repoTypesForTab('direct'))).toEqual(
        new Set(getTypesForTab('direct')),
      );
    },
  );
});
