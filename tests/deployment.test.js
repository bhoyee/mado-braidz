import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deployViaCpanel } from '../scripts/ci/deploy-cpanel.js';

const revision = 'a'.repeat(40);
const fixtures = [];
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((path) => {
      if (!resolve(path).startsWith(join(resolve(tmpdir()), 'mado-deploy-')))
        throw new Error('Unexpected fixture cleanup path');
      return rm(path, { recursive: true });
    }),
  );
});

async function fixture({ failed = false, servedRevision = revision } = {}) {
  const artifactDir = await mkdtemp(join(tmpdir(), 'mado-deploy-'));
  fixtures.push(artifactDir);
  await writeFile(join(artifactDir, `${revision}.tar.gz`), 'archive');
  await writeFile(join(artifactDir, `${revision}.tar.gz.sha256`), 'checksum');
  const uploaded = [];
  let loggedOut = false;
  let poll = 0;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/login/') {
      expect(options.redirect).toBe('error');
      return new Response(
        JSON.stringify({ status: 1, security_token: '/cpsess1234' }),
        {
          headers: { 'Set-Cookie': 'cpsession=private; Secure; HttpOnly' },
        },
      );
    }
    if (path.endsWith('/logout/')) {
      loggedOut = true;
      return new Response('');
    }
    if (path === '/health')
      return Response.json({ status: 'ok', revision: servedRevision });
    expect(options.headers.Cookie).toBe('cpsession=private');
    if (path.endsWith('/upload_files')) {
      uploaded.push(options.body.get('file-1').name);
      return Response.json({ status: 1, data: {} });
    }
    if (path.endsWith('/get_file_content')) {
      expect(new URL(url).searchParams.get('to_charset')).toBe('UTF-8');
      expect(new URL(url).searchParams.get('_ci_poll')).toBe(String(poll));
      expect(options.headers['Cache-Control']).toBe('no-cache');
      poll++;
      if (poll === 1) return Response.json({ status: 0 });
      return Response.json({
        status: 1,
        data: {
          content: JSON.stringify({
            state: failed ? 'failed' : 'succeeded',
            revision,
          }),
        },
      });
    }
    throw new Error('Unexpected API operation');
  };
  return {
    options: {
      baseUrl: 'https://cpanel.example.test',
      username: 'owner',
      password: 'private',
      revision,
      requestId: '123-1',
      artifactDir,
      fetchImpl,
      sleep: async () => {},
    },
    uploaded,
    loggedOut: () => loggedOut,
  };
}

describe('HTTPS production deployment', () => {
  it('queues only after both files upload, waits for cron and verifies the served revision', async () => {
    const f = await fixture();
    await deployViaCpanel(f.options);
    expect(f.uploaded).toEqual([
      `${revision}.tar.gz`,
      `${revision}.tar.gz.sha256`,
      `${revision}-123-1.request`,
    ]);
    expect(f.loggedOut()).toBe(true);
  });
  it('reports server deployment failure and closes the hosting session', async () => {
    const f = await fixture({ failed: true });
    await expect(deployViaCpanel(f.options)).rejects.toThrow(
      'Production deployment failed',
    );
    expect(f.loggedOut()).toBe(true);
  });
  it('rejects success when the running process still serves an old revision', async () => {
    const f = await fixture({ servedRevision: 'b'.repeat(40) });
    await expect(deployViaCpanel(f.options)).rejects.toThrow('did not match');
    expect(f.loggedOut()).toBe(true);
  });
  it('rejects insecure hosting URLs before transmitting the password', async () => {
    const f = await fixture();
    await expect(
      deployViaCpanel({ ...f.options, baseUrl: 'http://cpanel.example.test' }),
    ).rejects.toThrow('HTTPS');
    expect(f.uploaded).toEqual([]);
  });
});
