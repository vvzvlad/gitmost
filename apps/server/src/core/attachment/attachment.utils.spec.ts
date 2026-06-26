import {
  getAttachmentFolderPath,
  validateFileType,
} from './attachment.utils';
import { AttachmentType } from './attachment.constants';

// Pins where each AttachmentType is stored and the file-type allow-list.
// A wrong folder mapping would scatter uploads (e.g. avatars landing in /files),
// and a broken validateFileType would let disallowed extensions bypass the
// check, so we assert the exact path per type and the throw/no-throw behaviour.

const WORKSPACE = 'ws-123';

describe('getAttachmentFolderPath', () => {
  it('maps Avatar to <workspaceId>/avatars', () => {
    expect(getAttachmentFolderPath(AttachmentType.Avatar, WORKSPACE)).toBe(
      `${WORKSPACE}/avatars`,
    );
  });

  it('maps WorkspaceIcon to <workspaceId>/workspace-logos', () => {
    expect(
      getAttachmentFolderPath(AttachmentType.WorkspaceIcon, WORKSPACE),
    ).toBe(`${WORKSPACE}/workspace-logos`);
  });

  it('maps SpaceIcon to <workspaceId>/space-logos', () => {
    expect(getAttachmentFolderPath(AttachmentType.SpaceIcon, WORKSPACE)).toBe(
      `${WORKSPACE}/space-logos`,
    );
  });

  it('maps File to <workspaceId>/files', () => {
    expect(getAttachmentFolderPath(AttachmentType.File, WORKSPACE)).toBe(
      `${WORKSPACE}/files`,
    );
  });

  it('maps Chat to <workspaceId>/chat-files', () => {
    expect(getAttachmentFolderPath(AttachmentType.Chat, WORKSPACE)).toBe(
      `${WORKSPACE}/chat-files`,
    );
  });

  it('falls back to <workspaceId>/files for an unknown type', () => {
    expect(
      getAttachmentFolderPath('totally-unknown' as AttachmentType, WORKSPACE),
    ).toBe(`${WORKSPACE}/files`);
  });

  it('covers every AttachmentType enum value with a non-fallback folder except File', () => {
    // Guards against a new AttachmentType silently inheriting the /files default.
    const expected: Record<AttachmentType, string> = {
      [AttachmentType.Avatar]: `${WORKSPACE}/avatars`,
      [AttachmentType.WorkspaceIcon]: `${WORKSPACE}/workspace-logos`,
      [AttachmentType.SpaceIcon]: `${WORKSPACE}/space-logos`,
      [AttachmentType.File]: `${WORKSPACE}/files`,
      [AttachmentType.Chat]: `${WORKSPACE}/chat-files`,
    };

    for (const type of Object.values(AttachmentType)) {
      expect(getAttachmentFolderPath(type, WORKSPACE)).toBe(expected[type]);
    }
  });
});

describe('validateFileType', () => {
  const allowed = ['.png', '.jpg', '.jpeg'];

  it('does not throw when the extension is in the allow-list', () => {
    expect(() => validateFileType('.png', allowed)).not.toThrow();
  });

  it('throws "Invalid file type" when the extension is not allowed', () => {
    expect(() => validateFileType('.exe', allowed)).toThrow('Invalid file type');
  });

  it('is case-sensitive on the extension (uppercase is rejected)', () => {
    // The check uses Array.includes with no normalization, so ".PNG" !== ".png".
    expect(() => validateFileType('.PNG', allowed)).toThrow('Invalid file type');
  });

  it('throws against an empty allow-list', () => {
    expect(() => validateFileType('.png', [])).toThrow('Invalid file type');
  });
});
