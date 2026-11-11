import { CopyObjectCommand } from '@aws-sdk/client-s3';
import { S3Driver } from './s3.driver';

describe('S3Driver', () => {
  const createDriver = (extra: Record<string, unknown> = {}) =>
    new S3Driver({
      endpoint: 'http://localhost:9000',
      bucket: 'akasha',
      region: 'us-east-1',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      ...extra,
    } as any);

  const resolveHandlerConfig = (driver: S3Driver) =>
    (driver.getDriver().config.requestHandler as any).configProvider;

  it('raises the socket pool above the SDK default of 50', async () => {
    const config = await resolveHandlerConfig(createDriver());
    expect(config.httpsAgent.maxSockets).toBe(200);
  });

  it('keeps a caller-provided request handler', async () => {
    const config = await resolveHandlerConfig(
      createDriver({ requestHandler: { httpsAgent: { maxSockets: 7 } } }),
    );
    expect(config.httpsAgent.maxSockets).toBe(7);
  });

  it('URL-encodes each segment of the copy source', async () => {
    const driver = createDriver();
    const send = jest
      .spyOn(driver.getDriver(), 'send')
      .mockResolvedValue({} as never);

    await driver.copy('ws/files/中文 附件#1.pdf', 'ws/files/copy.pdf');

    const command = send.mock.calls
      .map(([cmd]) => cmd)
      .find((cmd) => cmd instanceof CopyObjectCommand) as CopyObjectCommand;
    expect(command.input).toEqual({
      Bucket: 'akasha',
      CopySource: `akasha/ws/files/${encodeURIComponent('中文 附件#1.pdf')}`,
      Key: 'ws/files/copy.pdf',
    });
  });
});
