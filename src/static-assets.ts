import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { appPath } from './url.js';

/** A fresh versioned URL can stay cached. The query changes when a file in public/ changes. */
export const VERSIONED_ASSET_CACHE = 'public, max-age=31536000, immutable';

/** An unversioned or stale URL can be reused for an hour, then checked again. */
export const SHARED_ASSET_CACHE = 'public, max-age=3600';

const ASSET_ROOTS = ['css', 'brand', 'img', 'js'];

/**
 * Same-origin GET links are fetched on hover.
 * Confirm, new-event, and signup controls open a dialog instead of navigating.
 * Cross-origin links are not eligible unless a rule asks for them.
 */
export const SPECULATION_RULES = {
  prefetch: [
    {
      source: 'document',
      where: {
        and: [
          { href_matches: '/*' },
          { not: { selector_matches: '[data-confirm], [data-open-event], [data-signup]' } },
        ],
      },
      eagerness: 'moderate',
    },
  ],
} as const;

type StampCache = { fingerprint: string; stamp: string };
let stampCache: StampCache | undefined;

/** Bumped so browsers drop the empty images and scripts cached under the first versioned URLs. */
const STAMP_EPOCH = '2';

export function publicDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
}

/** Short token that changes when a stylesheet, font, image, or script changes. */
export function staticAssetStamp(dir: string): string {
  const fingerprint = fingerprintPublic(dir);
  if (stampCache?.fingerprint === fingerprint) return stampCache.stamp;
  const stamp = createHash('sha256').update(`${STAMP_EPOCH}\n${fingerprint}`).digest('base64url').slice(0, 12);
  stampCache = { fingerprint, stamp };
  return stamp;
}

export function assetHref(config: Pick<AppConfig, 'basePath'>, file: string, dir = publicDirectory()): string {
  return `${appPath(config, file)}?v=${staticAssetStamp(dir)}`;
}

export function assetCacheControl(requested: string | undefined, dir: string): string {
  return requested === staticAssetStamp(dir) ? VERSIONED_ASSET_CACHE : SHARED_ASSET_CACHE;
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

/** Read a public file as bytes. Rebuilding the static-file stream dropped image and script bodies. */
export function readPublicFile(publicDir: string, requestPath: string, basePath: string): { body: Buffer; type: string } | undefined {
  const full = resolvePublicFile(publicDir, requestPath, basePath);
  if (!full) return undefined;
  const type = MIME[path.extname(full).toLowerCase()];
  if (!type) return undefined;
  try {
    if (!statSync(full).isFile()) return undefined;
    return { body: readFileSync(full), type };
  } catch {
    return undefined;
  }
}

function resolvePublicFile(publicDir: string, requestPath: string, basePath: string): string | undefined {
  let rel = requestPath;
  if (basePath !== '' && rel.startsWith(basePath)) rel = rel.slice(basePath.length) || '/';
  if (!rel.startsWith('/') || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return undefined;
  const root = path.resolve(publicDir);
  const full = path.resolve(root, `.${rel}`);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return undefined;
  return full;
}

/** Font addresses live inside CSS, so the served sheet carries the same version query as the document. */
export function rewriteCssUrls(css: string, stamp: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (full, quote: string, target: string) => {
    const trimmed = target.trim();
    if (trimmed.startsWith('data:') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('?')) {
      return full;
    }
    return `url(${quote}${trimmed}?v=${stamp}${quote})`;
  });
}

function fingerprintPublic(dir: string): string {
  const lines: string[] = [];
  for (const root of ASSET_ROOTS) collect(path.join(dir, root), root, lines);
  lines.sort();
  return lines.join('\n');
}

function collect(dir: string, rel: string, lines: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) collect(path.join(dir, entry.name), child, lines);
    else if (entry.isFile()) {
      const stat = statSync(path.join(dir, entry.name));
      lines.push(`${child}:${stat.mtimeMs}:${stat.size}`);
    }
  }
}
