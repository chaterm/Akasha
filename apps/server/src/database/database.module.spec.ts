import { DatabaseModule } from './database.module';

describe('DatabaseModule lifecycle', () => {
  it('initializes the database before provider module-init hooks can query it', () => {
    const lifecycle = DatabaseModule.prototype as unknown as Record<
      string,
      unknown
    >;

    expect(typeof lifecycle.onModuleInit).toBe('function');
    expect(lifecycle.onApplicationBootstrap).toBeUndefined();
  });
});
