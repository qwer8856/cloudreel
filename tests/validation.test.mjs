import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  cleanPath,
  remoteName,
  localPath,
  validateSettings,
  sanitizeRemote,
} from '../server/validation.mjs';

test('拒绝路径穿越、Windows 盘符与控制字符', () => {
  for (const value of ['../secret', 'a/../b', 'a/./b', 'C:/Windows', 'a\\b', 'a\u0000b'])
    assert.throws(() => cleanPath(value));
  assert.equal(cleanPath('/媒体//电影/'), '媒体/电影');
  assert.equal(cleanPath(''), '');
});
test('校验远程名称和运行参数', () => {
  assert.equal(remoteName('cloud-backup_1'), 'cloud-backup_1');
  for (const value of ['local', '--config', 'a:b', '', '__proto__', 'a b'])
    assert.throws(() => remoteName(value));
  assert.deepEqual(
    validateSettings({ transfers: '4', checkers: 8, retries: 3, bandwidth: '10M' }),
    { transfers: 4, checkers: 8, retries: 3, bandwidth: '10M' },
  );
  for (const update of [
    { transfers: 0 },
    { checkers: 129 },
    { retries: 1.5 },
    { bandwidth: '1M;rm' },
  ])
    assert.throws(() => validateSettings({ transfers: 4, checkers: 8, retries: 3, ...update }));
});
test('敏感凭据不会返回浏览器', () => {
  const data = sanitizeRemote(
    'dav',
    {
      type: 'webdav',
      url: 'https://example.com',
      pass: 'obscured-secret',
      bearer_token: 'token',
      user: 'admin',
    },
    { Options: [{ Name: 'pass', IsPassword: true }] },
  );
  assert.equal(data.parameters.url, 'https://example.com');
  assert.equal(data.parameters.user, 'admin');
  assert.deepEqual(data.configuredSecrets, ['pass', 'bearer_token']);
  assert.ok(!JSON.stringify(data).includes('obscured-secret'));
  const url = sanitizeRemote(
    'dav',
    { type: 'webdav', url: 'https://user:password@example.com', application_key: 'app-secret' },
    { Options: [{ Name: 'application_key', Sensitive: true }] },
  );
  assert.ok(!JSON.stringify(url).includes('password@example.com'));
  assert.ok(!JSON.stringify(url).includes('app-secret'));
  assert.deepEqual(url.configuredSecrets, ['url', 'application_key']);
});
test('本地目录拒绝指向根目录外的链接', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'rclone-studio-path-'));
  try {
    const root = path.join(fixture, 'root'),
      outside = path.join(fixture, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(
      outside,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(localPath(root, 'escape/new-file'));
    assert.equal(
      await localPath(root, 'new/subdir'),
      path.join(await realpath(root), 'new', 'subdir'),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
