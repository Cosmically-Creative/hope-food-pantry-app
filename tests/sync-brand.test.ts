import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncBrand } from '../scripts/sync-brand.mjs';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hope-brand-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('syncBrand', () => {
  it('keeps the bundled tokens when the source is missing', () => {
    const dest = makeDir();
    const tokens = path.join(dest, 'tokens.css');
    writeFileSync(tokens, 'keep-me\n');
    writeFileSync(path.join(dest, 'keep.txt'), 'unrelated\n');
    const result = syncBrand({
      source: path.join(dest, 'missing-brand'),
      dest,
      syncedAt: '2026-10-14T12:00:00.000Z',
    });
    expect(result.copied).toBe(false);
    expect(result.warnings[0]).toMatch(/not found/);
    expect(readFileSync(tokens, 'utf8')).toBe('keep-me\n');
    expect(readFileSync(path.join(dest, 'keep.txt'), 'utf8')).toBe('unrelated\n');
  });

  it('copies tokens and font bytes without prepending text to the font', () => {
    const source = makeDir();
    const dest = makeDir();
    mkdirSync(path.join(source, 'fonts'), { recursive: true });
    writeFileSync(
      path.join(source, 'tokens.css'),
      '/* License: keep this */\n:root { --hope-ink:#222; }\n',
    );
    const font = Buffer.from([0, 1, 2, 3, 255, 10]);
    writeFileSync(path.join(source, 'fonts', 'Lexend.woff2'), font);
    writeFileSync(path.join(source, 'OFL.txt'), 'SIL Open Font License\n');
    writeFileSync(path.join(dest, 'keep.txt'), 'unrelated\n');

    const once = syncBrand({ source, dest, syncedAt: '2026-10-14T12:00:00.000Z' });
    expect(once.copied).toBe(true);
    const css = readFileSync(path.join(dest, 'tokens.css'), 'utf8');
    expect(css).toContain('Source: ');
    expect(css).toContain('Synced: 2026-10-14T12:00:00.000Z');
    expect(css).toContain('/* License: keep this */');
    expect(css.match(/Hope Volunteer brand tokens/g)).toHaveLength(1);
    const copied = readFileSync(path.join(dest, 'fonts', 'Lexend.woff2'));
    expect(Buffer.compare(copied, font)).toBe(0);
    expect(copied.subarray(0, 2).toString()).not.toBe('/*');
    expect(readFileSync(path.join(dest, 'OFL.txt'), 'utf8')).toContain('SIL Open Font License');
    expect(readFileSync(path.join(dest, 'keep.txt'), 'utf8')).toBe('unrelated\n');
    const manifest = JSON.parse(readFileSync(path.join(dest, 'fonts.manifest.json'), 'utf8')) as {
      fonts: { file: string; sha256: string }[];
    };
    expect(manifest.fonts[0]?.sha256).toBe(createHash('sha256').update(font).digest('hex'));

    syncBrand({ source, dest, syncedAt: '2026-10-15T12:00:00.000Z' });
    const twice = readFileSync(path.join(dest, 'tokens.css'), 'utf8');
    expect(twice.match(/Hope Volunteer brand tokens/g)).toHaveLength(1);
    expect(twice).toContain('Synced: 2026-10-15T12:00:00.000Z');
  });
});

describe('bundled brand', () => {
  it('uses the specification tokens and does not call Google Fonts', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const tokens = readFileSync(path.join(root, 'public/brand/tokens.css'), 'utf8');
    const app = readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
    expect(tokens).toContain('--hope-ink:#222');
    expect(tokens).toContain('--hope-yellow:#f9e194');
    expect(tokens).toContain('--font-body:"Lexend",system-ui,sans-serif');
    expect(tokens).not.toContain('fonts.googleapis.com');
    expect(app).toContain('var(--hope-ink)');
    expect(app).toContain('var(--font-body)');
    expect(app).not.toContain('fonts.googleapis.com');
  });
});
