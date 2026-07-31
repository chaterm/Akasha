import { StorageService } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(() => {
    service = new StorageService({} as never);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('bounds reads to 30 seconds and forwards the combined AbortSignal', async () => {
    const driver = { read: jest.fn().mockResolvedValue(Buffer.from('file')) };
    const boundedService = new StorageService(driver as never);
    const parent = new AbortController();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');

    await expect(
      boundedService.read('workspace/file.png', {
        abortSignal: parent.signal,
      }),
    ).resolves.toEqual(Buffer.from('file'));

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(driver.read).toHaveBeenCalledWith('workspace/file.png', {
      abortSignal: expect.any(AbortSignal),
    });
    timeoutSpy.mockRestore();
  });
});
