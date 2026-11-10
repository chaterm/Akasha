import { promises as fs } from 'fs';
import * as path from 'path';
import { convert } from '@opendataloader/pdf';
import { PdfImportService } from './pdf-import.service';

jest.mock('@opendataloader/pdf', () => ({ convert: jest.fn() }));
jest.mock('@docmost/editor-ext', () => ({
  markdownToHtml: (markdown: string) => markdown,
}));
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (task: () => Promise<unknown>) => task(),
}));

describe('PDF image imports', () => {
  const convertMock = jest.mocked(convert);
  let markdown: string;
  let outputDir: string;
  let service: PdfImportService;
  let upload: jest.Mock;
  let insertAttachment: jest.Mock;

  beforeEach(() => {
    upload = jest.fn().mockResolvedValue(undefined);
    insertAttachment = jest.fn().mockResolvedValue(undefined);
    service = new PdfImportService(
      { insertAttachment } as never,
      { upload } as never,
    );
    convertMock.mockImplementation(async (_input, options) => {
      outputDir = options!.outputDir!;
      await fs.mkdir(path.join(outputDir, 'document_images'));
      await fs.writeFile(
        path.join(outputDir, 'document_images', 'image (1).png'),
        Buffer.from('image-data'),
      );
      await fs.writeFile(path.join(outputDir, 'document.md'), markdown);
      return '';
    });
  });

  async function importPdf() {
    return service.convertPdfToHtml(
      Buffer.from('pdf'),
      'workspace',
      'space',
      'page',
      'user',
    );
  }

  it('uploads actual loader destinations in angle brackets, preserving alt/title', async () => {
    markdown =
      '![](<document_images/image (1).png>)\n' +
      '![screen](<document_images/image (1).png> "A (screen)")';
    const result = await importPdf();
    const attachment = insertAttachment.mock.calls[0][0];
    const url = `/api/files/${attachment.id}/${attachment.fileName}`;
    expect(result).toBe(`![](<${url}>)\n![screen](<${url}> "A (screen)")`);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][1]).toEqual(Buffer.from('image-data'));
    expect(attachment).toMatchObject({
      mimeType: 'image/png',
      pageId: 'page',
      spaceId: 'space',
      workspaceId: 'workspace',
      creatorId: 'user',
    });
    await expect(fs.stat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports encoded bare URLs and rewrites only image destinations', async () => {
    const source = 'document_images/image%20%281%29.png';
    markdown = `![screen](${source} 'title')\nPlain ${source}\n[download](${source})`;
    const result = await importPdf();
    expect(result).toMatch(/^!\[screen\]\(\/api\/files\/[^)]+ 'title'\)/);
    expect(result).toContain(`Plain ${source}\n[download](${source})`);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('does not load files outside the output directory', async () => {
    markdown = '![](<../document.pdf>)';
    const result = await importPdf();
    expect(upload).not.toHaveBeenCalled();
    expect(result).toBe(markdown);
  });

  it('keeps processing valid images when another image cannot be read', async () => {
    markdown = '![](missing.png)\n![](<document_images/image (1).png>)';
    const result = await importPdf();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(result).toContain('![](missing.png)');
    expect(result).toMatch(/!\[\]\(<\/api\/files\//);
  });
});
