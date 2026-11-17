import { getAttachmentIds, extractAttachmentIdFromUrl } from './utils';

const ID = '019eaf5b-5e81-744c-8438-f8c53ef34658';

function doc(...content: any[]) {
  return { type: 'doc', content };
}

describe('extractAttachmentIdFromUrl', () => {
  it('parses /api/files/<uuid>/<name>', () => {
    expect(extractAttachmentIdFromUrl(`/api/files/${ID}/pic.png`)).toBe(ID);
  });

  it('parses /files/<uuid>/<name>', () => {
    expect(extractAttachmentIdFromUrl(`/files/${ID}/pic.png`)).toBe(ID);
  });

  it('returns null for external urls', () => {
    expect(
      extractAttachmentIdFromUrl('https://example.com/img/pic.png'),
    ).toBeNull();
  });

  it('returns null for a non-uuid path segment', () => {
    expect(
      extractAttachmentIdFromUrl('/api/files/not-a-uuid/pic.png'),
    ).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(extractAttachmentIdFromUrl(undefined)).toBeNull();
    expect(extractAttachmentIdFromUrl(null)).toBeNull();
  });
});

describe('getAttachmentIds', () => {
  it('collects id from src when attachmentId attr is missing', () => {
    const node = {
      type: 'image',
      attrs: {
        alt: 'image',
        src: `/api/files/${ID}/019eaf5b-5e81-744c-8438-f4a703198471.png`,
        align: 'center',
        width: null,
      },
    };
    expect(getAttachmentIds(doc(node))).toContain(ID);
  });

  it('prefers the explicit attachmentId attribute', () => {
    const node = {
      type: 'image',
      attrs: { src: `/api/files/${ID}/pic.png`, attachmentId: ID },
    };
    expect(getAttachmentIds(doc(node))).toEqual([ID]);
  });

  it('does not collect external image urls', () => {
    const node = {
      type: 'image',
      attrs: { src: 'https://example.com/pic.png' },
    };
    expect(getAttachmentIds(doc(node))).toEqual([]);
  });

  it('de-duplicates repeated attachment references', () => {
    const node = {
      type: 'image',
      attrs: { src: `/api/files/${ID}/pic.png` },
    };
    expect(getAttachmentIds(doc(node, node))).toEqual([ID]);
  });
});
