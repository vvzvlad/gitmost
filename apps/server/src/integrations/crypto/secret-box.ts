import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { EnvironmentService } from '../environment/environment.service';

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 16; // per-record random salt for scrypt key derivation
const IV_LENGTH = 12; // recommended IV length for GCM
const AUTH_TAG_LENGTH = 16; // GCM authentication tag length
const KEY_LENGTH = 32; // 256-bit key for aes-256-gcm

/**
 * Symmetric secret encryption helper (§6.3 / A2 crypto part).
 *
 * Encrypts short secrets (e.g. provider API keys) with AES-256-GCM. The key is
 * derived from APP_SECRET via scrypt using a per-record random salt, so two
 * encryptions of the same plaintext produce different blobs. The output layout
 * is base64( salt | iv | authTag | ciphertext ).
 */
@Injectable()
export class SecretBoxService {
  constructor(private readonly environmentService: EnvironmentService) {}

  private deriveKey(salt: Buffer): Buffer {
    return scryptSync(
      this.environmentService.getAppSecret(),
      salt,
      KEY_LENGTH,
    );
  }

  encryptSecret(plain: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = this.deriveKey(salt);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([salt, iv, authTag, ciphertext]).toString('base64');
  }

  decryptSecret(blob: string): string {
    try {
      const data = Buffer.from(blob, 'base64');

      const salt = data.subarray(0, SALT_LENGTH);
      const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const authTag = data.subarray(
        SALT_LENGTH + IV_LENGTH,
        SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
      );
      const ciphertext = data.subarray(
        SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
      );

      const key = this.deriveKey(salt);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    } catch {
      // decipher.final() throws on tamper / wrong key. Surface a clear,
      // recoverable error instead of crashing the process (§6.3).
      throw new Error(
        'Failed to decrypt secret — APP_SECRET may have changed; re-enter the API key',
      );
    }
  }
}
