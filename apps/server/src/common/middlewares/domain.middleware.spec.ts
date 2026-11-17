import { DomainMiddleware } from './domain.middleware';

describe('DomainMiddleware workspace log injection', () => {
  const makeSut = (opts: {
    selfHosted?: boolean;
    cloud?: boolean;
    workspace?: { id: string } | null;
    assignThrows?: boolean;
  }) => {
    const assign = jest.fn(() => {
      if (opts.assignThrows) throw new Error('out of request scope');
    });
    const workspaceRepo = {
      findFirst: jest.fn().mockResolvedValue(opts.workspace ?? null),
      findByHostname: jest.fn().mockResolvedValue(opts.workspace ?? null),
    };
    const environmentService = {
      isSelfHosted: () => opts.selfHosted ?? false,
      isCloud: () => opts.cloud ?? false,
    };

    const sut = new DomainMiddleware(
      workspaceRepo as any,
      environmentService as any,
      { assign } as any,
    );

    return { sut, assign, workspaceRepo };
  };

  const makeReq = () => ({ headers: { host: 'acme.example.com' } }) as any;

  it('assigns the workspace id when self-hosted and a workspace exists', async () => {
    const { sut, assign } = makeSut({
      selfHosted: true,
      workspace: { id: 'ws-1' },
    });
    const req = makeReq();
    const next = jest.fn();

    await sut.use(req, {} as any, next);

    expect(assign).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    expect(req.workspaceId).toBe('ws-1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('assigns an empty string, not null, when no workspace is found', async () => {
    const { sut, assign } = makeSut({ selfHosted: true, workspace: null });
    const req = makeReq();

    await sut.use(req, {} as any, jest.fn());

    expect(assign).toHaveBeenCalledWith({ workspaceId: '' });
    expect(req.workspaceId).toBeNull();
  });

  it('resolves by hostname in cloud mode', async () => {
    const { sut, assign, workspaceRepo } = makeSut({
      cloud: true,
      workspace: { id: 'ws-cloud' },
    });

    await sut.use(makeReq(), {} as any, jest.fn());

    expect(workspaceRepo.findByHostname).toHaveBeenCalledWith('acme');
    expect(assign).toHaveBeenCalledWith({ workspaceId: 'ws-cloud' });
  });

  it('still calls next() and keeps the request usable when assign throws', async () => {
    const { sut } = makeSut({
      selfHosted: true,
      workspace: { id: 'ws-1' },
      assignThrows: true,
    });
    const req = makeReq();
    const next = jest.fn();

    await expect(sut.use(req, {} as any, next)).resolves.not.toThrow();
    expect(req.workspaceId).toBe('ws-1');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
