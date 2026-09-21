import { applyDecorators } from '@nestjs/common';
import { Matches, ValidationOptions } from 'class-validator';

/**
 * A page identity at the API boundary is EITHER the internal page UUID or the
 * public 10-char slugId (page.repo.findById matches a non-UUID input as a
 * slugId). Both arrive as bare strings, which is exactly how the two got swapped
 * silently (incident family #435). This regex pins the two accepted FORMATS so a
 * malformed / cross-wired identity (a truncated slug, a full URL, an email, an
 * id from another entity kind that isn't even shaped like either) is rejected at
 * the boundary instead of falling through to a confusing 404.
 *
 *   - UUID:    canonical 8-4-4-4-12 hex (version-agnostic — page ids are UUIDv7,
 *              so only the shape/length is enforced, matching the MCP's UUID_RE
 *              and the server's isValidUUID acceptance).
 *   - slugId:  exactly 10 chars over [0-9A-Za-z] (nanoid `generateSlugId`).
 *
 * The two are disjoint (a UUID is 36 chars WITH dashes, a slugId 10 chars
 * WITHOUT), so a value can only satisfy one branch.
 */
export const PAGE_ID_OR_SLUG_ID_REGEX =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-Za-z]{10})$/i;

/**
 * Validate that a DTO string field is a well-formed page identity (page UUID OR
 * 10-char slugId). Composed decorator so the same format rule is applied
 * consistently wherever a DTO accepts a `pageId` that may be either form.
 */
export function IsPageIdOrSlugId(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return applyDecorators(
    Matches(PAGE_ID_OR_SLUG_ID_REGEX, {
      message:
        'pageId must be a page UUID or a 10-character slugId',
      ...validationOptions,
    }),
  );
}
