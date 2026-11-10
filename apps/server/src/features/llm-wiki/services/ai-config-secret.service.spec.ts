import { AiConfigSecretService } from './ai-config-secret.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

function makeService(appSecret: string | undefined): AiConfigSecretService {
  const env = {
    getAppSecret: () => appSecret,
  } as unknown as EnvironmentService;
  return new AiConfigSecretService(env);
}

describe('AiConfigSecretService', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const service = makeService('a-very-long-app-secret-of-32+chars!!');
    const secret = 'sk-1234567890abcdef';

    const ciphertext = service.encrypt(secret);

    expect(ciphertext).not.toContain(secret);
    expect(service.decrypt(ciphertext)).toBe(secret);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const service = makeService('a-very-long-app-secret-of-32+chars!!');

    const first = service.encrypt('same-value');
    const second = service.encrypt('same-value');

    expect(first).not.toBe(second);
    expect(service.decrypt(first)).toBe('same-value');
    expect(service.decrypt(second)).toBe('same-value');
  });

  it('fails to decrypt tampered ciphertext (auth tag mismatch)', () => {
    const service = makeService('a-very-long-app-secret-of-32+chars!!');
    const ciphertext = service.encrypt('secret');
    const [iv, authTag, data] = ciphertext.split(':');
    const tampered = [iv, authTag, data.replace(/.$/, (c) => (c === '0' ? '1' : '0'))].join(
      ':',
    );

    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('throws when APP_SECRET is missing', () => {
    const service = makeService(undefined);

    expect(() => service.encrypt('secret')).toThrow(/APP_SECRET/);
  });

  it('rejects malformed ciphertext', () => {
    const service = makeService('a-very-long-app-secret-of-32+chars!!');

    expect(() => service.decrypt('not-valid')).toThrow(/Malformed/);
  });
});
