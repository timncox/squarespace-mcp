import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ContentSaveClient } from '../content-save/client.js';

function makeSession(crumb: string, subdomain: string) {
  return {
    cookies: [
      { name: 'member-session', value: 'ms-val', domain: `${subdomain}.squarespace.com` },
      { name: 'crumb', value: crumb, domain: `${subdomain}.squarespace.com` },
    ],
  };
}

describe('ContentSaveClient session auto-reload', () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sqsp-session-'));
    sessionPath = join(tmpDir, 'sqsp-session.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reloads cookies when session file changes', async () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession('crumb-v1', 'testsite')));

    const client = new ContentSaveClient('testsite');
    client.loadSessionCookies(sessionPath);
    expect(client.crumbToken).toBe('crumb-v1');

    await new Promise(r => setTimeout(r, 50));
    writeFileSync(sessionPath, JSON.stringify(makeSession('crumb-v2', 'testsite')));

    client.ensureFreshSession(sessionPath);
    expect(client.crumbToken).toBe('crumb-v2');
  });

  it('does not reload when file has not changed', () => {
    writeFileSync(sessionPath, JSON.stringify(makeSession('crumb-v1', 'testsite')));

    const client = new ContentSaveClient('testsite');
    client.loadSessionCookies(sessionPath);

    const originalMtime = client._sessionMtime;
    client.ensureFreshSession(sessionPath);
    expect(client._sessionMtime).toBe(originalMtime);
    expect(client.crumbToken).toBe('crumb-v1');
  });
});
