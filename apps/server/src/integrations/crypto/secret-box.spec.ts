import { SecretBoxService } from './secret-box';
import { EnvironmentService } from '../environment/environment.service';

/**
 * Unit tests for SecretBoxService: the AES-256-GCM helper that protects provider
 * API keys at rest. The contract is: encrypt -> decrypt round-trips the input;
 * two encryptions of the same input yield different blobs (random salt+iv) yet
 * both decrypt; a tampered blob or a different APP_SECRET fails decryption with
 * the recoverable "APP_SECRET may have changed" message the UI relies on.
 */
describe('SecretBoxService', () => {
  // Construct a SecretBoxService whose EnvironmentService.getAppSecret returns a
  // fixed 64-hex secret. Only getAppSecret is exercised, so a thin fake suffices.
  function makeBox(appSecret: string): SecretBoxService {
    const env = {
      getAppSecret: () => appSecret,
    } as unknown as EnvironmentService;
    return new SecretBoxService(env);
  }

  const SECRET_A =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const SECRET_B =
    'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

  it('round-trips: decrypt(encrypt(x)) === x', () => {
    const box = makeBox(SECRET_A);
    const plain = 'sk-super-secret-provider-key-12345';
    const blob = box.encryptSecret(plain);
    expect(box.decryptSecret(blob)).toBe(plain);
  });

  it('produces a different blob each time, both of which decrypt', () => {
    const box = makeBox(SECRET_A);
    const plain = 'identical-input';
    const blob1 = box.encryptSecret(plain);
    const blob2 = box.encryptSecret(plain);
    // Random per-record salt + iv => the ciphertext blobs must differ.
    expect(blob1).not.toBe(blob2);
    expect(box.decryptSecret(blob1)).toBe(plain);
    expect(box.decryptSecret(blob2)).toBe(plain);
  });

  it('throws the recoverable error on a tampered auth tag', () => {
    const box = makeBox(SECRET_A);
    const blob = box.encryptSecret('tamper-me');

    // Layout: base64( salt[16] | iv[12] | authTag[16] | ciphertext ). Flip a bit
    // in the auth-tag region so GCM verification (decipher.final) rejects it.
    const data = Buffer.from(blob, 'base64');
    const authTagByteIndex = 16 + 12; // first byte of the auth tag
    data[authTagByteIndex] = data[authTagByteIndex] ^ 0xff;
    const tampered = data.toString('base64');

    expect(() => box.decryptSecret(tampered)).toThrow(/APP_SECRET may have changed/);
  });

  it('throws the recoverable error on a tampered ciphertext byte', () => {
    const box = makeBox(SECRET_A);
    const blob = box.encryptSecret('tamper-the-body');

    const data = Buffer.from(blob, 'base64');
    // Last byte is part of the ciphertext; flipping it must fail GCM auth.
    data[data.length - 1] = data[data.length - 1] ^ 0xff;
    const tampered = data.toString('base64');

    expect(() => box.decryptSecret(tampered)).toThrow(/APP_SECRET may have changed/);
  });

  it('throws when decrypting under a different APP_SECRET', () => {
    const boxA = makeBox(SECRET_A);
    const boxB = makeBox(SECRET_B);
    const blob = boxA.encryptSecret('rotate-me');
    // A different APP_SECRET derives a different scrypt key => GCM auth fails.
    expect(() => boxB.decryptSecret(blob)).toThrow(/APP_SECRET may have changed/);
  });
});
