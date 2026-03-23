import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('loadSitesConfig mtime tracking', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sqsp-test-'));
    configPath = join(tmpDir, 'sites.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reloads config when file changes on disk', async () => {
    writeFileSync(configPath, JSON.stringify({
      clients: [{ id: 'site-a', site: { adminUrl: 'https://site-a.squarespace.com' } }]
    }));

    const { _loadSitesConfigFromPath } = await import('../session.js');
    const first = _loadSitesConfigFromPath(configPath);
    expect(first.clients).toHaveLength(1);

    await new Promise(r => setTimeout(r, 50));
    writeFileSync(configPath, JSON.stringify({
      clients: [
        { id: 'site-a', site: { adminUrl: 'https://site-a.squarespace.com' } },
        { id: 'site-b', site: { adminUrl: 'https://site-b.squarespace.com' } },
      ]
    }));

    const second = _loadSitesConfigFromPath(configPath);
    expect(second.clients).toHaveLength(2);
  });

  it('returns cached config when file has not changed', async () => {
    writeFileSync(configPath, JSON.stringify({
      clients: [{ id: 'site-a', site: { adminUrl: 'https://site-a.squarespace.com' } }]
    }));

    const { _loadSitesConfigFromPath } = await import('../session.js');
    const first = _loadSitesConfigFromPath(configPath);
    const second = _loadSitesConfigFromPath(configPath);
    expect(first).toBe(second); // Same object reference = cache hit
  });
});
