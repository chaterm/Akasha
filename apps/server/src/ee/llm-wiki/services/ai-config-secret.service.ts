import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
// Stable salt: APP_SECRET is the real secret; a fixed salt keeps key
// derivation deterministic so previously stored ciphertext stays decryptable.
const KEY_SALT = 'akasha-ai-model-config';

/**
 * Encrypts AI provider API keys before they are persisted, using a key
 * derived from APP_SECRET. Ciphertext is stored as `iv:authTag:data` in hex.
 */
@Injectable()
export class AiConfigSecretService {
  constructor(private readonly environmentService: EnvironmentService) {}

  private deriveKey(): Buffer {
    const appSecret = this.environmentService.getAppSecret();
    if (!appSecret) {
      throw new Error('APP_SECRET is required to encrypt AI provider secrets.');
    }
    return scryptSync(appSecret, KEY_SALT, KEY_LENGTH);
  }

  encrypt(plaintext: string): string {
    const key = this.deriveKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');
  }

  decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Malformed AI provider secret ciphertext.');
    }
    const [ivHex, authTagHex, dataHex] = parts;
    const key = this.deriveKey();
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }
}
