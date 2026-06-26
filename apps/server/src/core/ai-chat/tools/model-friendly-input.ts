import { jsonSchema, type Schema } from 'ai';
import type { JSONSchema7 } from '@ai-sdk/provider';
import { z } from 'zod';

/**
 * Centralized input-schema wrapper for every in-app AI-chat tool.
 *
 * THE PROBLEM (#190): when the model issues PARALLEL / batch tool calls it
 * sometimes drops an "obvious" repeated required argument (typically `pageId`)
 * from some of the calls. zod v4 correctly rejects the missing value, but the
 * AI SDK forwards zod's RAW message ("Invalid input: expected string, received
 * undefined") straight back to the model, which is not actionable — the model
 * cannot tell WHICH parameter it dropped or that it must re-send it.
 *
 * THE FIX: keep the exact same validation, but replace the raw zod text with a
 * model-friendly message that names every problematic parameter and tells the
 * model to re-issue the call with all required parameters present. We do NOT
 * guess/backfill the value (a silently-assumed "current page" could comment on
 * the wrong page — cf. #159); the model is simply told to retry correctly.
 *
 * HOW IT WORKS: we build the tool's JSON Schema from the zod shape via
 * `z.toJSONSchema(..., { target: 'draft-7' })` (so the advertised contract —
 * `required` / `description` / field constraints — is unchanged) and hand the
 * AI SDK a custom `validate` that runs `z.object(shape).safeParse(value)`. On
 * failure the AI SDK wraps our returned `Error` in `InvalidToolInputError`, so
 * our clear text is what reaches the model as the tool error.
 */
export function modelFriendlyInput<T extends z.ZodRawShape>(
  shape: T,
): Schema<z.output<z.ZodObject<T>>> {
  const objectSchema = z.object(shape);
  // draft-07 keeps required/description/constraints intact, matching what the
  // model already saw — the tool contract does not change.
  const json = z.toJSONSchema(objectSchema, {
    target: 'draft-7',
  }) as JSONSchema7;

  return jsonSchema<z.output<z.ZodObject<T>>>(json, {
    validate: (value) => {
      const result = objectSchema.safeParse(value);
      if (result.success) {
        return { success: true, value: result.data };
      }
      return {
        success: false,
        error: new Error(buildModelFriendlyMessage(result.error, value)),
      };
    },
  });
}

/**
 * Turn a zod validation failure into a clear, model-actionable message naming
 * each problematic parameter (and whether it is missing vs. invalid), plus an
 * explicit reminder not to drop required ids in parallel/batch tool calls.
 */
export function buildModelFriendlyMessage(
  error: z.ZodError,
  value: unknown,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of error.issues) {
    const name = issue.path.length ? issue.path.map(String).join('.') : 'input';
    // A parameter the model omitted entirely reads as `undefined` at its path;
    // anything else is present-but-invalid (wrong type, too short, etc.).
    const missing = valueAtPath(value, issue.path) === undefined;
    const part = `parameter "${name}": ${missing ? 'missing (required)' : 'invalid'}`;
    if (seen.has(part)) continue;
    seen.add(part);
    parts.push(part);
  }
  if (parts.length === 0) {
    // Defensive: a ZodError always has issues, but never emit an empty list.
    parts.push('input: invalid');
  }
  return (
    `Invalid input for this tool — ${parts.join('; ')}. ` +
    'Re-issue the call with EVERY required parameter present and valid. ' +
    "Do not drop ids like pageId, even when making parallel/batch tool calls — " +
    'each tool call must carry its own pageId.'
  );
}

/** Read the value at a zod issue path; returns undefined if any hop is absent. */
function valueAtPath(value: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}
