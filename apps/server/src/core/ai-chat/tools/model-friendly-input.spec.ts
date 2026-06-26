import { z } from 'zod';
import {
  modelFriendlyInput,
  buildModelFriendlyMessage,
} from './model-friendly-input';

/**
 * Unit tests for the centralized in-app tool input wrapper (#190). A dropped or
 * invalid parameter must surface a clear, model-actionable message (naming the
 * parameter and reminding the model not to drop ids in parallel batches), while
 * a valid call validates cleanly and strips unknown keys — and the advertised
 * JSON Schema keeps the unchanged required/description contract.
 */
describe('modelFriendlyInput', () => {
  // Mirrors createComment's shape: pageId is the required id the model drops in
  // parallel batches; selection is optional with a min length.
  const shape = {
    pageId: z.string().describe('The id of the page to comment on.'),
    content: z.string().describe('The comment body as Markdown.'),
    selection: z.string().min(1).max(250).optional(),
  };

  // Loose return type: the AI SDK ValidationResult is a discriminated union, but
  // these tests assert on both branches, so a flat optional shape is simpler.
  async function validate(
    value: unknown,
  ): Promise<{ success: boolean; value?: unknown; error?: Error }> {
    const schema = modelFriendlyInput(shape);
    return await schema.validate!(value);
  }

  it('rejects a dropped required pageId with a clear, actionable message', async () => {
    const result = await validate({
      content: 'Looks off here',
      selection: 'титановый проводник',
    });
    expect(result.success).toBe(false);
    const msg = result.error?.message ?? '';
    // Names the dropped parameter...
    expect(msg).toContain('parameter "pageId": missing (required)');
    // ...and gives an explicit, non-raw instruction (not zod's raw text).
    expect(msg).toContain('parallel/batch tool calls');
    expect(msg).not.toContain('expected string, received undefined');
  });

  it('distinguishes a present-but-invalid parameter from a missing one', async () => {
    // selection is present but too short (invalid), pageId is missing.
    const result = await validate({ content: 'x', selection: '' });
    expect(result.success).toBe(false);
    const msg = result.error?.message ?? '';
    expect(msg).toContain('parameter "pageId": missing (required)');
    expect(msg).toContain('parameter "selection": invalid');
  });

  it('accepts a valid call and strips unknown keys from the validated value', async () => {
    const result = await validate({
      pageId: 'page-1',
      content: 'A comment',
      selection: 'anchor text',
      bogus: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value).toEqual({
      pageId: 'page-1',
      content: 'A comment',
      selection: 'anchor text',
    });
    expect(result.value).not.toHaveProperty('bogus');
  });

  it('preserves the required/description contract in the advertised JSON Schema', async () => {
    const schema = modelFriendlyInput(shape);
    const json = (await schema.jsonSchema) as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };
    // pageId + content stay required; selection stays optional.
    expect(json.required).toEqual(expect.arrayContaining(['pageId', 'content']));
    expect(json.required).not.toContain('selection');
    expect(json.properties?.pageId.description).toBe(
      'The id of the page to comment on.',
    );
  });

  it('handles a no-arg tool (empty shape) without error', async () => {
    const schema = modelFriendlyInput({});
    const result = await schema.validate!({});
    expect(result.success).toBe(true);
  });
});

describe('buildModelFriendlyMessage', () => {
  it('falls back to a generic message when issues carry an empty path', () => {
    // safeParse on a non-object yields a root-level issue (empty path).
    const error = z.object({ a: z.string() }).safeParse('not-an-object');
    if (error.success) throw new Error('expected failure');
    const msg = buildModelFriendlyMessage(error.error, 'not-an-object');
    expect(msg).toContain('parameter "input"');
  });
});
