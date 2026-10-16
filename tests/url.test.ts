import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { absoluteUrl, appPath, cookiePath } from '../src/url.js';
import { devEnv } from './env.js';

describe('URL helper', () => {
  const root = loadConfig(devEnv({ BASE_PATH: '' }));
  const mounted = loadConfig(devEnv({ BASE_PATH: '/volunteer' }));

  it('serves health, assets, and mail links at the root', () => {
    expect(absoluteUrl(root, '/healthz')).toBe('http://127.0.0.1:3000/healthz');
    expect(absoluteUrl(root, '/css/app.css')).toBe('http://127.0.0.1:3000/css/app.css');
    expect(absoluteUrl(root, '/brand/tokens.css')).toBe('http://127.0.0.1:3000/brand/tokens.css');
    expect(absoluteUrl(root, '/m/abc')).toBe('http://127.0.0.1:3000/m/abc');
    expect(cookiePath(root)).toBe('/');
  });

  it('prefixes the same paths when the app is mounted at /volunteer', () => {
    expect(appPath(mounted, '/')).toBe('/volunteer');
    expect(appPath(mounted, '/healthz')).toBe('/volunteer/healthz');
    expect(absoluteUrl(mounted, '/healthz')).toBe('http://127.0.0.1:3000/volunteer/healthz');
    expect(absoluteUrl(mounted, '/css/app.css')).toBe('http://127.0.0.1:3000/volunteer/css/app.css');
    expect(absoluteUrl(mounted, '/e/weekly-pantry')).toBe('http://127.0.0.1:3000/volunteer/e/weekly-pantry');
    expect(absoluteUrl(mounted, '/m/abc')).toBe('http://127.0.0.1:3000/volunteer/m/abc');
    expect(cookiePath(mounted)).toBe('/volunteer');
  });

  it('rejects a path that would skip the prefix helper', () => {
    expect(() => appPath(root, 'healthz')).toThrow(/start with/);
  });
});
