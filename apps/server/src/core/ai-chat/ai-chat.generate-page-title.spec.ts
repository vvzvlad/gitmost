import {
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import { cleanGeneratedTitle } from './ai-chat.service';
import type { Workspace } from '@docmost/db/types/entity.types';

/**
 * Pure post-processing of a model-generated title (#199): trims, strips a single
 * pair of surrounding quotes, drops a trailing period, and hard-caps the length.
 */
describe('cleanGeneratedTitle', () => {
  it('trims surrounding whitespace', () => {
    expect(cleanGeneratedTitle('  Hello world  ')).toBe('Hello world');
  });

  it('strips a single pair of surrounding double quotes', () => {
    expect(cleanGeneratedTitle('"My note"')).toBe('My note');
  });

  it('strips surrounding single quotes', () => {
    expect(cleanGeneratedTitle("'My note'")).toBe('My note');
  });

  it('drops a trailing period', () => {
    expect(cleanGeneratedTitle('A complete sentence.')).toBe(
      'A complete sentence',
    );
  });

  it('caps the result at 255 characters (the page-title column bound)', () => {
    expect(cleanGeneratedTitle('x'.repeat(400))).toHaveLength(255);
  });

  it('returns an empty string for blank/garbage input', () => {
    expect(cleanGeneratedTitle('   ')).toBe('');
    expect(cleanGeneratedTitle('""')).toBe('');
  });
});

/**
 * Wiring spec for the #199 `POST /ai-chat/generate-page-title` endpoint. It must:
 * gate on settings.ai.generative (403 when off), delegate to the service when on,
 * rethrow HttpExceptions verbatim (e.g. AiNotConfiguredException -> 503), and map
 * any other provider/transport fault to a 503. Exercised by instantiating the
 * controller with hand-rolled mocks — no Nest graph, no DB.
 */
describe('AiChatController.generatePageTitle', () => {
  const enabledWorkspace = {
    id: 'ws1',
    settings: { ai: { generative: true } },
  } as unknown as Workspace;

  function makeController(generate: jest.Mock) {
    const aiChatService = { generatePageTitle: generate };
    const controller = new AiChatController(
      aiChatService as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { controller, aiChatService };
  }

  it('forbids when the generative AI flag is off', async () => {
    const generate = jest.fn();
    const { controller } = makeController(generate);
    const disabled = { id: 'ws1', settings: {} } as unknown as Workspace;
    await expect(
      controller.generatePageTitle({ content: 'body' }, disabled),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(generate).not.toHaveBeenCalled();
  });

  it('forbids when settings.ai.generative is anything but exactly true', async () => {
    const generate = jest.fn();
    const { controller } = makeController(generate);
    const ws = {
      id: 'ws1',
      settings: { ai: { generative: 'yes' } },
    } as unknown as Workspace;
    await expect(
      controller.generatePageTitle({ content: 'body' }, ws),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns { title } from the service when enabled', async () => {
    const generate = jest.fn().mockResolvedValue('Generated Title');
    const { controller } = makeController(generate);
    const res = await controller.generatePageTitle(
      { content: 'some markdown body' },
      enabledWorkspace,
    );
    expect(generate).toHaveBeenCalledWith('ws1', 'some markdown body');
    expect(res).toEqual({ title: 'Generated Title' });
  });

  it('rethrows an HttpException from the service verbatim (e.g. 503 not configured)', async () => {
    const notConfigured = new ServiceUnavailableException('AI not configured');
    const generate = jest.fn().mockRejectedValue(notConfigured);
    const { controller } = makeController(generate);
    await expect(
      controller.generatePageTitle({ content: 'body' }, enabledWorkspace),
    ).rejects.toBe(notConfigured);
  });

  it('maps a non-HTTP provider error to a 503', async () => {
    const generate = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const { controller } = makeController(generate);
    // Silence the expected error log.
    jest
      .spyOn((controller as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    const err = await controller
      .generatePageTitle({ content: 'body' }, enabledWorkspace)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err).toBeInstanceOf(HttpException);
  });
});
