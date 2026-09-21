import { describe, it, expect, vi, afterEach } from 'vitest';

import { attachMediaPlaceholder } from './media-utils';

/**
 * F3(a): the media placeholder used to be undone ONLY by the success event
 * (`load` / `loadedmetadata`). A 404/403, a deleted attachment, or a
 * `<video preload="metadata">` that never reaches `loadedmetadata` therefore
 * left the node pulsing forever AND permanently non-interactive
 * (`pointer-events: none`) — with no log at all.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function setup(tag: 'img' | 'video') {
  const dom = document.createElement('div');
  const el = document.createElement(tag);
  dom.appendChild(el);
  return { dom, el };
}

describe('attachMediaPlaceholder', () => {
  it('marks the media as loading', () => {
    const { dom, el } = setup('img');
    attachMediaPlaceholder(el, dom, { nodeType: 'image', src: '/api/files/a' });

    expect(el.classList.contains('media-pulse')).toBe(true);
    expect(dom.style.pointerEvents).toBe('none');
  });

  it('settles on success', () => {
    const { dom, el } = setup('img');
    attachMediaPlaceholder(el, dom, { nodeType: 'image', src: '/api/files/a' });

    el.dispatchEvent(new Event('load'));

    expect(el.classList.contains('media-pulse')).toBe(false);
    expect(dom.style.pointerEvents).toBe('');
  });

  it('settles on error and logs the failure with the source', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dom, el } = setup('img');
    attachMediaPlaceholder(el, dom, {
      nodeType: 'image',
      src: '/api/files/missing.png',
    });

    el.dispatchEvent(new Event('error'));

    expect(el.classList.contains('media-pulse')).toBe(false);
    expect(dom.style.pointerEvents).toBe('');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, context] = errorSpy.mock.calls[0];
    expect(String(message)).toContain('image');
    expect(context).toMatchObject({
      nodeType: 'image',
      src: '/api/files/missing.png',
    });
  });

  it('honours a custom ready event (video metadata)', () => {
    const { dom, el } = setup('video');
    attachMediaPlaceholder(el, dom, {
      nodeType: 'video',
      src: '/api/files/v.mp4',
      readyEvent: 'loadedmetadata',
    });

    el.dispatchEvent(new Event('load'));
    expect(el.classList.contains('media-pulse')).toBe(true);

    el.dispatchEvent(new Event('loadedmetadata'));
    expect(el.classList.contains('media-pulse')).toBe(false);
    expect(dom.style.pointerEvents).toBe('');
  });

  it('settles immediately for an image that already finished loading', () => {
    const { dom, el } = setup('img');
    Object.defineProperty(el, 'src', { value: '/api/files/a.png' });
    Object.defineProperty(el, 'complete', { value: true });

    attachMediaPlaceholder(el, dom, { nodeType: 'image', src: '/api/files/a.png' });

    // Neither `load` nor `error` would ever fire again, so the placeholder
    // must never have been put on in the first place.
    expect(el.classList.contains('media-pulse')).toBe(false);
    expect(dom.style.pointerEvents).toBe('');
  });

  it('does not cry wolf over a completed image with zero intrinsic width', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dom, el } = setup('img');
    // A valid SVG carrying only a `viewBox` (draw.io exports these) reports
    // naturalWidth === 0, so it must not be treated as a failure.
    Object.defineProperty(el, 'src', { value: '/api/files/diagram.svg' });
    Object.defineProperty(el, 'complete', { value: true });
    Object.defineProperty(el, 'naturalWidth', { value: 0 });

    attachMediaPlaceholder(el, dom, {
      nodeType: 'image',
      src: '/api/files/diagram.svg',
    });

    expect(el.classList.contains('media-pulse')).toBe(false);
    expect(dom.style.pointerEvents).toBe('');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('settles and logs a late attach to an already-errored video', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dom, el } = setup('video');
    // MediaError is attributable, unlike a past `error` event on an <img>.
    Object.defineProperty(el, 'error', {
      value: { code: 4, message: 'MEDIA_ELEMENT_ERROR' },
    });

    attachMediaPlaceholder(el, dom, {
      nodeType: 'video',
      src: '/api/files/gone.mp4',
      readyEvent: 'loadedmetadata',
    });

    expect(el.classList.contains('media-pulse')).toBe(false);
    expect(dom.style.pointerEvents).toBe('');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toMatchObject({
      mediaErrorCode: 4,
      mediaErrorMessage: 'MEDIA_ELEMENT_ERROR',
    });
  });

  it('settles immediately for a video that already has metadata', () => {
    const { dom, el } = setup('video');
    Object.defineProperty(el, 'readyState', { value: 1 });

    attachMediaPlaceholder(el, dom, {
      nodeType: 'video',
      src: '/api/files/v.mp4',
      readyEvent: 'loadedmetadata',
    });

    expect(el.classList.contains('media-pulse')).toBe(false);
    expect(dom.style.pointerEvents).toBe('');
  });

  it('settles a video that errors before any metadata arrives', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dom, el } = setup('video');
    attachMediaPlaceholder(el, dom, {
      nodeType: 'video',
      src: '/api/files/v.mp4',
      readyEvent: 'loadedmetadata',
    });

    el.dispatchEvent(new Event('error'));

    expect(el.classList.contains('media-pulse')).toBe(false);
    expect(dom.style.pointerEvents).toBe('');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
