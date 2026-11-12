import * as fs from 'node:fs';
import { ShareSeoController } from './share-seo.controller';

const INDEX_HTML =
  '<html><head><title>Akasha</title><!--meta-tags--></head></html>';

beforeEach(() => {
  jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  jest.spyOn(fs, 'readFileSync').mockReturnValue(INDEX_HTML);
  jest.spyOn(fs, 'createReadStream').mockReturnValue('stream' as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const WORKSPACE_ID = '019a7d00-0000-7000-8000-000000000001';
const SUBPAGE_SLUG = 'subpageslug';

describe('ShareSeoController meta tags', () => {
  const makeController = (shared: unknown) => {
    const shareService = {
      getSharedPage: jest.fn(async () => {
        if (shared instanceof Error) throw shared;
        return shared;
      }),
    };
    const workspaceRepo = {
      findFirst: jest.fn(async () => ({ id: WORKSPACE_ID })),
    };
    const environmentService = { isSelfHosted: jest.fn(() => true) };

    const sent: string[] = [];
    const res = {
      type: jest.fn(() => res),
      send: jest.fn((body: string) => {
        sent.push(body);
        return res;
      }),
      header: jest.fn(() => res),
    };

    const controller = new ShareSeoController(
      shareService as any,
      workspaceRepo as any,
      environmentService as any,
    );

    return { controller, res, sent, shareService };
  };

  const req = { raw: { headers: { host: 'akasha.test' } } } as any;

  it('resolves the requested page through the share tree, without its content', async () => {
    const { controller, res, shareService } = makeController({
      page: { title: 'Subpage title' },
      share: { searchIndexing: true, sharedPage: { title: 'Share root' } },
    });

    await controller.getShare(res as any, req, undefined, SUBPAGE_SLUG);

    expect(shareService.getSharedPage).toHaveBeenCalledWith(
      { pageId: SUBPAGE_SLUG },
      WORKSPACE_ID,
      { includeContent: false },
    );
  });

  it('puts the page title in the title tag and og tags', async () => {
    const { controller, res, sent } = makeController({
      page: { title: 'Subpage title' },
      share: { searchIndexing: true, sharedPage: { title: 'Share root' } },
    });

    await controller.getShare(res as any, req, undefined, SUBPAGE_SLUG);

    const html = sent[0];
    expect(html).toContain('<title>Subpage title</title>');
    expect(html).toContain(
      '<meta property="og:title" content="Subpage title" />',
    );
    expect(html).not.toContain('Share root');
  });

  it('adds noindex when the share disables search indexing', async () => {
    const { controller, res, sent } = makeController({
      page: { title: 'Subpage title' },
      share: { searchIndexing: false },
    });

    await controller.getShare(res as any, req, undefined, SUBPAGE_SLUG);

    expect(sent[0]).toContain('<meta name="robots" content="noindex" />');
  });

  it('omits noindex when indexing is on', async () => {
    const { controller, res, sent } = makeController({
      page: { title: 'Subpage title' },
      share: { searchIndexing: true },
    });

    await controller.getShare(res as any, req, undefined, SUBPAGE_SLUG);

    expect(sent[0]).not.toContain('noindex');
  });

  it('falls back to the plain index when the page is not shared', async () => {
    const { controller, res, sent } = makeController(
      new Error('Shared page not found'),
    );

    await controller.getShare(res as any, req, undefined, SUBPAGE_SLUG);

    expect(sent).toEqual(['stream']);
    expect(res.send).not.toHaveBeenCalledWith(
      expect.stringContaining('og:title'),
    );
  });
});
