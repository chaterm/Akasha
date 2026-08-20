import { LegacyLinkService } from './legacy-link.service';

describe('LegacyLinkService', () => {
  it('resolves Confluence pageId mappings to Akasha URLs', async () => {
    const service = new LegacyLinkService(
      createDb({
        targetUrl: 'https://akasha.example.test/s/cf7569422/p/-9YMlDdeMSE',
      }) as never,
    );

    await expect(
      service.resolve({
        source: 'confluence',
        path: '/pages/viewpage.action',
        pageId: '907870364',
      }),
    ).resolves.toEqual({
      hit: true,
      location: 'https://akasha.example.test/s/cf7569422/p/-9YMlDdeMSE',
    });
  });

  it('resolves Confluence display paths to Akasha URLs', async () => {
    const service = new LegacyLinkService(
      createDb({
        targetUrl: 'https://akasha.example.test/s/cf7569422/p/-9YMlDdeMSE',
      }) as never,
    );

    await expect(
      service.resolve({
        source: 'confluence',
        path: '/display/OPEN/Page+Title',
      }),
    ).resolves.toEqual({
      hit: true,
      location: 'https://akasha.example.test/s/cf7569422/p/-9YMlDdeMSE',
    });
  });

  it('returns miss when the mapping is absent', async () => {
    const service = new LegacyLinkService(createDb(null) as never);

    await expect(
      service.resolve({
        source: 'confluence',
        path: '/pages/viewpage.action',
        pageId: '907870364',
      }),
    ).resolves.toEqual({ hit: false });
  });
});

function createDb(row: { targetUrl: string } | null) {
  return {
    selectFrom(table: string) {
      expect(table).toBe('legacyLinkMappings');
      return {
        select(columns: string[]) {
          expect(columns).toEqual(['targetUrl']);
          return this;
        },
        where() {
          return this;
        },
        async executeTakeFirst() {
          return row;
        },
      };
    },
  };
}
