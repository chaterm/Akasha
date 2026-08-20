import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { LegacyLinkResolveResult } from './legacy-link.types';

type LegacyLinkLookup = {
  source: string;
  path: string;
  pageId?: string;
  spaceKey?: string;
  title?: string;
  anchor?: string;
};

@Injectable()
export class LegacyLinkService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async resolve(input: LegacyLinkLookup): Promise<LegacyLinkResolveResult> {
    const parsedPath = parseConfluencePath(input.path);
    const pageId = normalizeText(input.pageId);
    const spaceKey = normalizeText(input.spaceKey) ?? parsedPath?.spaceKey;
    const title = normalizeTitle(input.title) ?? parsedPath?.title;
    const anchor = normalizeText(input.anchor);

    if (pageId) {
      const row = await this.db
        .selectFrom('legacyLinkMappings')
        .select(['targetUrl'])
        .where('source', '=', input.source)
        .where('legacyPageId', '=', pageId)
        .executeTakeFirst();
      if (row?.targetUrl) {
        return { hit: true, location: row.targetUrl };
      }
    }

    if (spaceKey && title) {
      const row = await this.db
        .selectFrom('legacyLinkMappings')
        .select(['targetUrl'])
        .where('source', '=', input.source)
        .where('legacySpaceKey', '=', spaceKey)
        .where('legacyTitle', '=', title)
        .executeTakeFirst();
      if (row?.targetUrl) {
        return { hit: true, location: appendAnchor(row.targetUrl, anchor) };
      }
    }

    if (input.path) {
      const row = await this.db
        .selectFrom('legacyLinkMappings')
        .select(['targetUrl'])
        .where('source', '=', input.source)
        .where('legacyPath', '=', input.path)
        .executeTakeFirst();
      if (row?.targetUrl) {
        return { hit: true, location: appendAnchor(row.targetUrl, anchor) };
      }
    }

    return { hit: false };
  }
}

function normalizeText(value?: string): string | undefined {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : undefined;
}

function normalizeTitle(value?: string): string | undefined {
  const text = normalizeText(value);
  if (!text) return undefined;
  return text.replace(/\+/g, ' ').replace(/\s+/g, ' ');
}

function appendAnchor(url: string, anchor?: string): string {
  if (!anchor) return url;
  const clean = anchor.replace(/^#/, '');
  if (!clean) return url;
  return url.includes('#') ? url : `${url}#${clean}`;
}

function parseConfluencePath(
  rawPath?: string,
): { spaceKey: string; title: string } | undefined {
  const path = normalizeText(rawPath);
  if (!path) return undefined;

  const withoutQuery = path.split('?')[0];
  const parts = withoutQuery.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'display') return undefined;

  const spaceKey = decodeConfluencePart(parts[1]);
  const title = decodeConfluencePart(parts.slice(2).join('/'));
  if (!spaceKey || !title) return undefined;

  return {
    spaceKey,
    title: normalizeTitle(title)!,
  };
}

function decodeConfluencePart(value: string): string | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;

  const plusAsSpace = text.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
}
