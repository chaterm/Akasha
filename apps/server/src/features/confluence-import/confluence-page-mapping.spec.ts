import {
  mergeConfluencePageMappings,
  parseConfluencePageId,
} from './confluence-page-mapping';

describe('Confluence page import mappings', () => {
  it('parses numeric and title_pageId Confluence HTML file names', () => {
    expect(parseConfluencePageId('7320321.html')).toBe('7320321');
    expect(parseConfluencePageId('folder/7320321.html')).toBe('7320321');
    expect(parseConfluencePageId('cc_user_tag_58098203.html')).toBe(
      '58098203',
    );
    expect(parseConfluencePageId('DMS_58098251.html')).toBe('58098251');
    expect(parseConfluencePageId('folder/company_split_58098199.html')).toBe(
      '58098199',
    );
    expect(parseConfluencePageId('index.html')).toBeNull();
    expect(parseConfluencePageId('7320321.HTML')).toBeNull();
    expect(parseConfluencePageId('../7320321.html')).toBeNull();
    expect(parseConfluencePageId('7320321-extra.html')).toBeNull();
  });

  it('preserves existing task metadata and adds normalized page mappings', () => {
    expect(
      mergeConfluencePageMappings(
        {
          confluence: { spaceId: '1', spaceKey: 'A' },
          other: true,
        },
        [
          {
            confluencePageId: '10',
            akashaPageId: 'page-1',
            title: ' 标题 ',
          },
        ],
      ),
    ).toEqual({
      confluence: { spaceId: '1', spaceKey: 'A' },
      other: true,
      pageMappings: [
        { confluencePageId: '10', akashaPageId: 'page-1', title: '标题' },
      ],
    });
  });

  it('accepts null metadata and an empty mapping list', () => {
    expect(mergeConfluencePageMappings(null, [])).toEqual({
      pageMappings: [],
    });
  });

  it('rejects invalid or duplicate source and target page IDs', () => {
    expect(() =>
      mergeConfluencePageMappings(null, [
        { confluencePageId: 'x', akashaPageId: 'page-1', title: 'A' },
      ]),
    ).toThrow(/Confluence page ID/i);

    expect(() =>
      mergeConfluencePageMappings(null, [
        { confluencePageId: '10', akashaPageId: 'page-1', title: 'A' },
        { confluencePageId: '10', akashaPageId: 'page-2', title: 'B' },
      ]),
    ).toThrow(/duplicate Confluence page ID: 10/i);

    expect(() =>
      mergeConfluencePageMappings(null, [
        { confluencePageId: '10', akashaPageId: 'page-1', title: 'A' },
        { confluencePageId: '11', akashaPageId: 'page-1', title: 'B' },
      ]),
    ).toThrow(/duplicate Akasha page ID: page-1/i);
  });
});
