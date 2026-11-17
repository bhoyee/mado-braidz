import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function deployViaCpanel({
  baseUrl,
  username,
  password,
  revision,
  requestId,
  artifactDir = 'artifact',
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 120,
}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password)
    throw new Error(
      'cPanel requires an HTTPS URL without embedded credentials',
    );
  if (!username || !password) throw new Error('Missing hosting login');
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^\d+-\d+$/.test(requestId))
    throw new Error('Invalid deployment revision or request ID');
  const requestName = `${revision}-${requestId}`;
  let token, cookie;
  const request = async (path, options = {}) => {
    const response = await fetchImpl(new URL(path, base), {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok)
      throw new Error(`cPanel request failed: HTTP ${response.status}`);
    return response;
  };
  const api = async (operation, { body, query, allowMissing = false } = {}) => {
    const suffix = query ? '?' + new URLSearchParams(query) : '';
    const response = await request(
      `${token}/execute/Fileman/${operation}${suffix}`,
      {
        method: body ? 'POST' : 'GET',
        headers: { Cookie: cookie, 'Cache-Control': 'no-cache' },
        body,
      },
    );
    const data = await response.json();
    if (data.status !== 1) {
      if (allowMissing) return null;
      throw new Error(`cPanel file operation failed: ${operation}`);
    }
    return data.data;
  };
  const upload = async (name, content) => {
    const body = new FormData();
    body.set('dir', '/home/madoafri/mado-deploy/incoming');
    body.set('overwrite', '1');
    body.set('file-1', new Blob([content]), name);
    await api('upload_files', { body });
  };
  try {
    const login = await request('/login/?login_only=1', {
      method: 'POST',
      body: new URLSearchParams({ user: username, pass: password }),
    });
    const session = await login.json();
    if (session.status !== 1 || !/^\/cpsess\d+$/.test(session.security_token))
      throw new Error('cPanel login failed');
    token = session.security_token;
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    if (!cookie) throw new Error('cPanel did not create a session');
    await upload(
      `${revision}.tar.gz`,
      await readFile(join(artifactDir, `${revision}.tar.gz`)),
    );
    await upload(
      `${revision}.tar.gz.sha256`,
      await readFile(join(artifactDir, `${revision}.tar.gz.sha256`)),
    );
    // Commit the queue marker last so cron never sees a partially uploaded release.
    await upload(
      `${requestName}.request`,
      JSON.stringify({ revision, requestId }),
    );
    console.log(
      'Verified release uploaded over HTTPS; waiting for deployment cron.',
    );
    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await api('get_file_content', {
        query: {
          dir: '/home/madoafri/mado-deploy/status',
          file: `${requestName}.json`,
          from_charset: 'UTF-8',
          to_charset: 'UTF-8',
          _ci_poll: String(attempt),
        },
        allowMissing: true,
      });
      if (result?.content) {
        const status = JSON.parse(result.content);
        if (status.state === 'failed')
          throw new Error(
            'Production deployment failed; inspect the private server deployment log',
          );
        if (status.state === 'succeeded' && status.revision === revision) {
          const health = await fetchImpl(
            'https://madoafricanbraidz.com/health',
            {
              redirect: 'error',
              signal: AbortSignal.timeout(20000),
            },
          );
          const data = await health.json();
          if (!health.ok || data.status !== 'ok' || data.revision !== revision)
            throw new Error(
              'The served production revision did not match the release',
            );
          console.log(`Production verified at revision ${revision}`);
          return;
        }
      }
      await sleep(5000);
    }
    throw new Error('Timed out waiting for production deployment cron');
  } finally {
    if (token && cookie)
      await fetchImpl(new URL(`${token}/logout/`, base), {
        headers: { Cookie: cookie },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  deployViaCpanel({
    baseUrl: process.env.CPANEL_URL,
    username: process.env.SSH_USER,
    password: process.env.DEPLOY_PASSWORD,
    revision: process.env.GITHUB_SHA,
    requestId: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  }).catch(() => {
    // Never print authentication/session responses or secret-bearing URLs.
    console.error(
      'Production deployment failed. Check server queue status and private deployment logs.',
    );
    process.exitCode = 1;
  });
}
