import type { AppConfig } from './config.js';

/** Prefix an app path with BASE_PATH. The path must start with /. */
export function appPath(config: Pick<AppConfig, 'basePath'>, pathname: string): string {
  if (!pathname.startsWith('/')) {
    throw new Error(`App paths must start with /. Received ${pathname}.`);
  }
  if (pathname === '/') return config.basePath === '' ? '/' : config.basePath;
  return `${config.basePath}${pathname}`;
}

/** Absolute public URL for redirects, assets, cookies' companion links, and mail. */
export function absoluteUrl(config: Pick<AppConfig, 'baseUrl' | 'basePath'>, pathname: string): string {
  return `${config.baseUrl}${appPath(config, pathname)}`;
}

/** Cookie Path attribute. An empty mount prefix uses the site root. */
export function cookiePath(config: Pick<AppConfig, 'basePath'>): string {
  return config.basePath === '' ? '/' : config.basePath;
}
