import {
  loadRuntimeConfiguration,
  shouldIgnoreEnvironmentFile,
} from './consul-config.loader';

describe('shouldIgnoreEnvironmentFile', () => {
  it('ignores environment files in production', () => {
    expect(shouldIgnoreEnvironmentFile({ NODE_ENV: 'production' })).toBe(true);
  });

  it('ignores environment files whenever Consul is selected', () => {
    expect(shouldIgnoreEnvironmentFile({ CONFIG_SOURCE: 'consul' })).toBe(true);
  });

  it('allows environment files for local development', () => {
    expect(shouldIgnoreEnvironmentFile({ NODE_ENV: 'development' })).toBe(
      false,
    );
  });
});

describe('loadRuntimeConfiguration', () => {
  it('skips Consul when it is not the configured source', async () => {
    const fetchImpl = jest.fn();

    await loadRuntimeConfiguration({
      env: { NODE_ENV: 'development' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('loads dotenv content from Consul without overriding container variables', async () => {
    const env: NodeJS.ProcessEnv = {
      CONFIG_SOURCE: 'consul',
      CONSUL_HTTP_ADDR: 'http://consul:8500/',
      CONSUL_HTTP_TOKEN: 'bootstrap-token',
      CONSUL_KV_KEY: 'akasha/production/app env',
      PORT: '3000',
    };
    const fetchImpl = jest.fn(async () =>
      Promise.resolve(
        new Response(
          [
            'APP_URL=https://akasha.example.com',
            'PORT=8080',
            'REDIS_URL="redis://user:p%40ss@redis:6379/0"',
            'LITERAL_VALUE=cost$center',
          ].join('\n'),
          { status: 200 },
        ),
      ),
    );

    await loadRuntimeConfiguration({
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://consul:8500/v1/kv/akasha/production/app%20env?raw',
      expect.objectContaining({
        headers: { 'X-Consul-Token': 'bootstrap-token' },
      }),
    );
    expect(env.APP_URL).toBe('https://akasha.example.com');
    expect(env.PORT).toBe('3000');
    expect(env.REDIS_URL).toBe('redis://user:p%40ss@redis:6379/0');
    expect(env.LITERAL_VALUE).toBe('cost$center');
  });

  it('fails closed when a required Consul bootstrap variable is missing', async () => {
    await expect(
      loadRuntimeConfiguration({
        env: {
          CONFIG_SOURCE: 'consul',
          CONSUL_HTTP_ADDR: 'http://consul:8500',
          CONSUL_KV_KEY: 'akasha/production/env',
        },
        fetchImpl: jest.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow('CONSUL_HTTP_TOKEN');
  });

  it('fails closed when Consul does not return the requested value', async () => {
    const fetchImpl = jest.fn(async () =>
      Promise.resolve(new Response('', { status: 403 })),
    );

    await expect(
      loadRuntimeConfiguration({
        env: {
          CONFIG_SOURCE: 'consul',
          CONSUL_HTTP_ADDR: 'http://consul:8500',
          CONSUL_HTTP_TOKEN: 'bootstrap-token',
          CONSUL_KV_KEY: 'akasha/production/env',
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('status 403');
  });

  it('fails closed when the Consul value has no configuration entries', async () => {
    const fetchImpl = jest.fn(async () =>
      Promise.resolve(new Response('# comment only\n', { status: 200 })),
    );

    await expect(
      loadRuntimeConfiguration({
        env: {
          CONFIG_SOURCE: 'consul',
          CONSUL_HTTP_ADDR: 'http://consul:8500',
          CONSUL_HTTP_TOKEN: 'bootstrap-token',
          CONSUL_KV_KEY: 'akasha/production/env',
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('no configuration entries');
  });
});
