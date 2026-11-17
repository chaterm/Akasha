import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ExportMetadata } from '../../../common/helpers/types/export-metadata.types';

const logger = new Logger('ImportUtils');

export async function buildAttachmentCandidates(
  extractDir: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  async function walk(dir: string) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
      } else {
        if (['.md', '.html'].includes(path.extname(ent.name).toLowerCase())) {
          continue;
        }

        const rel = path.relative(extractDir, abs).split(path.sep).join('/');
        map.set(rel, abs);
      }
    }
  }

  await walk(extractDir);
  return map;
}

export function resolveRelativeAttachmentPath(
  raw: string,
  pageDir: string,
  attachmentCandidates: Map<string, string>,
): string | null {
  let mainRel = raw.replace(/^\.?\/+/, '');
  try {
    mainRel = decodeURIComponent(mainRel);
  } catch (err) {
    logger.warn(
      { path: mainRel },
      'URI malformed for attachment path, falling back to raw path',
    );
  }

  const confluenceStripped = mainRel.replace(
    /^download\/attachments\//,
    'attachments/',
  );

  const fallback = path
    .normalize(path.join(pageDir, mainRel))
    .split(path.sep)
    .join('/');

  if (attachmentCandidates.has(mainRel)) {
    return mainRel;
  }
  if (
    confluenceStripped !== mainRel &&
    attachmentCandidates.has(confluenceStripped)
  ) {
    return confluenceStripped;
  }
  if (attachmentCandidates.has(fallback)) {
    return fallback;
  }

  return null;
}

export async function collectMarkdownAndHtmlFiles(
  dir: string,
): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(current, ent.name);
      if (ent.isDirectory()) {
        await walk(fullPath);
      } else if (
        ['.md', '.html'].includes(path.extname(ent.name).toLowerCase())
      ) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results;
}

export function stripNotionID(fileName: string): string {
  const notionIdPattern = /[ -]?[a-z0-9]{32}$/i;
  const partialIdPattern = / [a-f0-9]{4}-[a-f0-9]{4}$/i;
  return fileName
    .replace(notionIdPattern, '')
    .replace(partialIdPattern, '')
    .trim();
}

export function extractNotionPartialId(
  folderName: string,
): { prefix: string; suffix: string } | null {
  const match = folderName.match(/ ([a-f0-9]{4})-([a-f0-9]{4})$/i);
  if (!match) return null;
  return { prefix: match[1].toLowerCase(), suffix: match[2].toLowerCase() };
}

export function encodeFilePath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export async function readDocmostMetadata(
  extractDir: string,
): Promise<ExportMetadata | null> {
  const metadataPath = path.join(extractDir, 'akasha-metadata.json');
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content) as ExportMetadata;
    if (metadata.source === 'akasha' && metadata.pages) {
      return metadata;
    }
    return null;
  } catch {
    return null;
  }
}
