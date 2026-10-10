import test from 'node:test';
import assert from 'node:assert/strict';
import { Cd2Connector, validateCd2, cd2Url } from '../server/cd2.mjs';
import { mockCd2 } from './helpers/cd2.mjs';

test('CD2 地址和原文目录安全编码，拒绝 URL 凭据及路径穿越', () => {
  const input = {
    name: 'cd2',
    url: 'http://cd2:19798/dav',
    username: 'user',
    rootPath: '/115/电影 100%/海绵宝宝: 电影/',
  };
  const record = validateCd2(input);
  assert.equal(
    cd2Url(record),
    'http://cd2:19798/dav/115/%E7%94%B5%E5%BD%B1%20100%25/%E6%B5%B7%E7%BB%B5%E5%AE%9D%E5%AE%9D%3A%20%E7%94%B5%E5%BD%B1/',
  );
  for (const url of [
    'ftp://cd2/dav',
    'http://u:secret@cd2/dav',
    'http://cd2/dav?token=secret',
    'http://cd2/dav#root',
  ])
    assert.throws(() => validateCd2({ ...input, url }));
  for (const rootPath of ['115/../other', '115/./other', '115\\电影', '115\n电影'])
    assert.throws(() => validateCd2({ ...input, rootPath }));
  for (const username of ['user:secret', {}, 1])
    assert.throws(() => validateCd2({ ...input, username }));
  assert.equal(validateCd2({ ...input, anonymous: true, username: '' }).username, '');
});

test('CD2 测试使用 PROPFIND 验证目录，区分认证、服务和目录错误，不回显密码', async (t) => {
  const dav = await mockCd2();
  t.after(() => dav.close());
  const connector = new Cd2Connector({ state: {} });
  const input = {
    name: 'cd2',
    url: dav.url,
    rootPath: dav.rootPath,
    username: dav.username,
    password: dav.password,
  };
  assert.equal((await connector.test(input)).ok, true);
  assert.equal(dav.requests.at(-1).depth, '0');
  await assert.rejects(
    connector.test({ ...input, password: 'bad-password' }),
    (error) =>
      error.status === 400 &&
      error.message.includes('401') &&
      !error.message.includes(dav.password),
  );
  await assert.rejects(connector.test({ ...input, rootPath: 'not-there' }), /HTTP 404/);
  for (const status of [200, 302, 500, 503]) {
    dav.fail(status);
    await assert.rejects(
      connector.test(input),
      (error) =>
        error.status === 502 &&
        error.message.includes(`HTTP ${status}`) &&
        !error.message.includes(dav.password),
    );
  }
  dav.fail(0);
  dav.fail(207);
  await assert.rejects(
    connector.test(input),
    (error) =>
      error.status === 502 &&
      error.message.includes('未返回可读取') &&
      !error.message.includes(dav.password),
  );
  dav.fail(0);
  dav.anonymous(true);
  assert.equal(
    (await connector.test({ ...input, anonymous: true, username: '', password: '' })).ok,
    true,
  );
});
