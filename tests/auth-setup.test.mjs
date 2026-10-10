import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { createPanel } from '../server/app.mjs';
import { decryptBackup } from '../server/backup.mjs';

const firstPassword = 'synthetic-first-password';
const nextPassword = 'synthetic-replacement-password';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloudreel-auth-'));
  const options = {
    HOST: '0.0.0.0',
    PANEL_PASSWORD: '',
    COOKIE_SECURE: '',
    RCLONE_BIN: '/cloudreel-test-missing-rclone',
    DATA_DIR: path.join(root, 'panel'),
    LOCAL_ROOT: path.join(root, 'files'),
    RCLONE_CONFIG: path.join(root, 'config', 'rclone.conf'),
    ...overrides,
  };
  let panel, server, base;
  async function start() {
    panel = await createPanel(options);
    server = await new Promise((resolve) => {
      const listener = panel.app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}/api`;
  }
  async function close() {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (panel) await panel.close();
    panel = server = null;
  }
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  await start();
  return {
    root,
    options,
    get panel() {
      return panel;
    },
    async restart() {
      await close();
      await start();
    },
    async call(route, method = 'GET', body, cookie = '', extraHeaders = {}) {
      // Fetch controls Host itself; use a real HTTP request to exercise DNS-rebinding protection.
      if (extraHeaders.Host)
        return new Promise((resolve, reject) => {
          const req = request(base + route, { headers: extraHeaders }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
          });
          req.on('error', reject);
          req.end();
        });
      const response = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        data: await response.json(),
        cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
        cookieHeader: response.headers.get('set-cookie'),
      };
    },
  };
}

test('公开部署首次网页设置、改密、会话撤销与重启持久化', async (t) => {
  const f = await fixture(t);
  assert.equal(f.panel.engine.ready, false, '缺少 rclone 也应允许初始化登录');
  assert.deepEqual((await f.call('/session')).data, {
    authenticated: false,
    passwordRequired: true,
    setupRequired: true,
  });
  assert.equal((await f.call('/status')).status, 401);
  assert.equal((await f.call('/settings', 'PUT', {})).status, 401);
  assert.equal((await f.call('/login', 'POST', { password: firstPassword })).status, 401);
  assert.equal((await f.call('/setup', 'POST', { password: 'short' })).status, 400);
  assert.equal(
    (
      await f.call('/setup', 'POST', { password: firstPassword }, '', {
        Origin: 'https://other.example',
      })
    ).status,
    403,
  );
  const created = await f.call('/setup', 'POST', { password: firstPassword });
  assert.equal(created.status, 200);
  assert.deepEqual(created.data, { authenticated: true });
  assert.match(created.cookieHeader, /HttpOnly/);
  assert.match(created.cookieHeader, /SameSite=Strict/);
  assert.doesNotMatch(created.cookieHeader, /; Secure/);
  assert.equal((await f.call('/status', 'GET', undefined, created.cookie)).status, 200);
  assert.equal((await f.call('/setup', 'POST', { password: nextPassword })).status, 409);
  const initial = JSON.parse(await readFile(path.join(f.options.DATA_DIR, 'auth.json'), 'utf8'));
  assert.equal((await stat(path.join(f.options.DATA_DIR, 'auth.json'))).mode & 0o777, 0o600);
  assert.equal(initial.algorithm, 'scrypt');
  assert.ok(!JSON.stringify(initial).includes(firstPassword));
  assert.equal(
    (
      await f.call(
        '/password',
        'PUT',
        { currentPassword: 'wrong', password: nextPassword },
        created.cookie,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        '/password',
        'PUT',
        { currentPassword: firstPassword, password: 'short' },
        created.cookie,
      )
    ).status,
    400,
  );
  const second = await f.call('/login', 'POST', { password: firstPassword });
  assert.equal(second.status, 200);
  const changed = await f.call(
    '/password',
    'PUT',
    { currentPassword: firstPassword, password: nextPassword },
    created.cookie,
  );
  assert.equal(changed.status, 200);
  assert.notEqual(changed.cookie, created.cookie);
  assert.equal((await f.call('/status', 'GET', undefined, changed.cookie)).status, 200);
  for (const cookie of [created.cookie, second.cookie])
    assert.equal((await f.call('/status', 'GET', undefined, cookie)).status, 401);
  const expiredChange = await f.call(
    '/password',
    'PUT',
    { currentPassword: firstPassword, password: nextPassword },
    created.cookie,
  );
  assert.equal(expiredChange.status, 401);
  assert.equal(expiredChange.data.code, 'AUTH_REQUIRED');
  assert.equal((await f.call('/login', 'POST', { password: firstPassword })).status, 401);
  const updated = JSON.parse(await readFile(path.join(f.options.DATA_DIR, 'auth.json'), 'utf8'));
  assert.notEqual(initial.salt, updated.salt);
  const archive = await f.call(
    '/backups/export',
    'POST',
    { passphrase: 'synthetic-backup-passphrase' },
    changed.cookie,
  );
  assert.equal(archive.status, 200, JSON.stringify(archive.data));
  const backup = JSON.stringify(await decryptBackup(archive.data, 'synthetic-backup-passphrase'));
  const settings = JSON.stringify(
    (await f.call('/settings', 'GET', undefined, changed.cookie)).data,
  );
  const state = await readFile(path.join(f.options.DATA_DIR, 'state.json'), 'utf8');
  for (const content of [backup, settings, state])
    for (const secret of [firstPassword, nextPassword, updated.hash, updated.salt])
      assert.ok(!content.includes(secret), '面板认证凭据不能进入配置、响应或完整备份');
  await f.restart();
  assert.deepEqual((await f.call('/session')).data, {
    authenticated: false,
    passwordRequired: true,
    setupRequired: false,
  });
  assert.equal((await f.call('/setup', 'POST', { password: firstPassword })).status, 409);
  assert.equal((await f.call('/login', 'POST', { password: firstPassword })).status, 401);
  assert.equal((await f.call('/login', 'POST', { password: nextPassword })).status, 200);
});

test('并发首次设置只有一个成功，并沿用来源和尝试次数保护', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(
    [firstPassword, nextPassword].map((password) => f.call('/setup', 'POST', { password })),
  );
  assert.deepEqual(responses.map((item) => item.status).sort(), [200, 409]);
  const index = responses.findIndex((item) => item.status === 200);
  const winning = [firstPassword, nextPassword][index];
  assert.equal((await f.call('/login', 'POST', { password: winning })).status, 200);
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal((await f.call('/login', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await f.call('/login', 'POST', { password: winning })).status, 429);
});

test('首次设置错误请求限流且无密码本机开发模式兼容', async (t) => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal((await f.call('/setup', 'POST', { password: 'short' })).status, 400);
  assert.equal((await f.call('/setup', 'POST', { password: firstPassword })).status, 429);
  const local = await fixture(t, { HOST: '127.0.0.1' });
  assert.deepEqual((await local.call('/session')).data, {
    authenticated: true,
    passwordRequired: false,
    setupRequired: false,
  });
  assert.equal((await local.call('/status')).status, 200);
  assert.equal((await local.call('/login', 'POST', { password: '' })).status, 200);
  assert.equal(
    (await local.call('/session', 'GET', undefined, '', { Host: 'other.example' })).status,
    403,
  );
  const setup = await local.call('/setup', 'POST', { password: firstPassword });
  assert.equal(setup.status, 200, '本机免登录模式也能从网页设置首个密码');
  assert.equal((await local.call('/session')).data.passwordRequired, true);
  assert.equal((await local.call('/status')).status, 401);
  assert.equal((await local.call('/status', 'GET', undefined, setup.cookie)).status, 200);
  assert.equal((await local.call('/setup', 'POST', { password: nextPassword })).status, 409);
  await local.restart();
  assert.equal((await local.call('/session')).data.setupRequired, false);
  assert.equal((await local.call('/login', 'POST', { password: firstPassword })).status, 200);
});

test('旧环境密码迁移为哈希后网页改密优先，HTTPS 自动 cookie 与显式配置兼容', async (t) => {
  const f = await fixture(t, { PANEL_PASSWORD: firstPassword });
  assert.equal((await f.call('/session')).data.setupRequired, false);
  const signed = await f.call('/login', 'POST', { password: firstPassword }, '', {
    'X-Forwarded-Proto': 'https',
  });
  assert.equal(signed.status, 200);
  assert.match(signed.cookieHeader, /; Secure/);
  const changed = await f.call(
    '/password',
    'PUT',
    { currentPassword: firstPassword, password: nextPassword },
    signed.cookie,
  );
  assert.equal(changed.status, 200);
  await f.restart();
  assert.equal((await f.call('/login', 'POST', { password: firstPassword })).status, 401);
  assert.equal((await f.call('/login', 'POST', { password: nextPassword })).status, 200);
  for (const setting of ['true', 'false']) {
    const legacy = await fixture(t, { PANEL_PASSWORD: firstPassword, COOKIE_SECURE: setting });
    const result = await legacy.call('/login', 'POST', { password: firstPassword }, '', {
      'X-Forwarded-Proto': 'https',
    });
    assert.equal(result.status, 200);
    assert.equal(result.cookieHeader.includes('; Secure'), setting === 'true');
  }
});
