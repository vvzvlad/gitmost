import { resolveAudioFormat } from './ai-chat.controller';

/**
 * Unit tests for resolveAudioFormat — the transcribe-endpoint mime whitelist.
 * It splits the base mime off any MediaRecorder parameters, lowercases/trims it,
 * checks it against the whitelist, and maps it to the STT container-format hint.
 * A non-whitelisted container yields { ok: false } (the controller then throws
 * BadRequestException).
 */
describe('resolveAudioFormat', () => {
  it('strips MediaRecorder parameters to the base mime (audio/webm;codecs=opus)', () => {
    const res = resolveAudioFormat('audio/webm;codecs=opus');
    expect(res).toEqual({ ok: true, baseMime: 'audio/webm', format: 'webm' });
  });

  it('normalizes uppercase / surrounding whitespace', () => {
    const res = resolveAudioFormat('  AUDIO/MP4 ; codecs=mp4a  ');
    expect(res).toEqual({ ok: true, baseMime: 'audio/mp4', format: 'mp4' });
  });

  it('handles the Safari/iOS audio/x-m4a container', () => {
    expect(resolveAudioFormat('audio/x-m4a')).toEqual({
      ok: true,
      baseMime: 'audio/x-m4a',
      format: 'm4a',
    });
  });

  it('rejects a disallowed container (audio/aiff)', () => {
    expect(resolveAudioFormat('audio/aiff')).toEqual({ ok: false });
  });

  it('maps every whitelisted container to its STT format hint', () => {
    const cases: Array<[string, string]> = [
      ['audio/webm', 'webm'],
      ['audio/ogg', 'ogg'],
      ['audio/mp4', 'mp4'],
      ['audio/mpeg', 'mp3'],
      ['audio/wav', 'wav'],
      ['audio/x-wav', 'wav'],
      ['audio/wave', 'wav'],
      ['audio/m4a', 'm4a'],
      ['audio/x-m4a', 'm4a'],
    ];
    for (const [mime, format] of cases) {
      expect(resolveAudioFormat(mime)).toEqual({
        ok: true,
        baseMime: mime,
        format,
      });
    }
  });
});
