import { mockOpenList } from './helpers/openlist.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudParameters, openListUrl, OpenListConnector } from '../server/openlist.mjs';

test('网盘登录字段校验、官方开发者参数和凭据保留', () => {
  assert.throws(() => cloudParameters('openlist-115', 'cookie', { cookie: '' }));
  assert.throws(() =>
    cloudParameters('openlist-123', 'developer', {
      client_id: 'id',
      client_secret: 'secret',
      api_url_address: 'https://other.test',
    }),
  );
  assert.throws(() =>
    cloudParameters(
      'openlist-guangya',
      'sms',
      { client_id: 'id', phone_number: 'bad' },
      {},
      'send-code',
    ),
  );
  const result = cloudParameters(
    'openlist-123',
    'developer',
    { client_id: 'developer', client_secret: '', root_folder_id: '123' },
    {
      ClientSecret: 'keep-me',
      AccessToken: 'latest-refreshed',
      use_online_api: true,
      DirectLink: true,
    },
  );
  assert.equal(result.addition.ClientID, 'developer');
  assert.equal(result.addition.ClientSecret, 'keep-me');
  assert.equal(result.addition.AccessToken, 'latest-refreshed');
  assert.equal(result.addition.use_online_api, false);
  assert.equal(result.addition.DirectLink, false);
  const sms = cloudParameters(
    'openlist-guangya',
    'sms',
    { client_id: 'id', phone_number: '+86 13800000000' },
    {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      verify_code: 'old-code',
      verification_id: 'old-id',
    },
    'send-code',
  );
  assert.equal(sms.addition.send_code, true);
  assert.equal(sms.addition.access_token, '');
  assert.equal(sms.addition.refresh_token, '');
  assert.equal(sms.addition.verification_id, '');
  assert.throws(() => openListUrl('https://user:password@example.test'));
  assert.throws(() => openListUrl('file:///etc/passwd'));
  assert.equal(openListUrl('https://example.test/openlist/'), 'https://example.test/openlist');
});

test('OpenList 完整登录、短信两阶段、凭据隐藏和失败记录修复', { timeout: 15000 }, async (t) => {
  const mock = await mockOpenList();
  const state = {},
    configs = {},
    history = [];
  const engine = {
    async call(endpoint, input) {
      history.push({ endpoint, input });
      if (endpoint === 'config/dump') return configs;
      if (endpoint === 'config/delete') delete configs[input.name];
      else if (endpoint.startsWith('config/'))
        configs[input.name] = { type: 'webdav', ...input.parameters };
      return {};
    },
  };
  const cloud = new OpenListConnector({
    state,
    engine,
    save: async () => {},
    backup: async () => {},
    env: {},
  });
  try {
    await t.test('管理员登录使用 upstream 哈希协议并创建限定目录的写入账号', async () => {
      const config = await cloud.configure({
        url: mock.url,
        username: 'admin',
        password: 'synthetic-admin-password',
      });
      assert.equal(config.ready, true);
      assert.equal(mock.users.length, 1);
      assert.equal(mock.users[0].base_path, state.openlist.namespace);
      assert.equal(mock.users[0].permission & (1 << 9), 1 << 9);
      assert.ok(!JSON.stringify(config).includes('synthetic-admin-password'));
      assert.ok(!JSON.stringify(config).includes(state.openlist.davPassword));
      assert.equal(state.openlist.password, undefined);
    });
    await t.test('115 Cookie、115 OAuth、123 开发者和账号密码均使用正确驱动', async () => {
      for (const [name, type, mode, parameters, driver] of [
        ['pan115', 'openlist-115', 'cookie', { cookie: 'synthetic-cookie' }, '115 Cloud'],
        [
          'pan115open',
          'openlist-115',
          'oauth',
          { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
          '115 Open',
        ],
        [
          'pan123open',
          'openlist-123',
          'developer',
          { client_id: 'synthetic-client', client_secret: 'synthetic-secret' },
          '123 Open',
        ],
        [
          'pan123',
          'openlist-123',
          'password',
          { username: '13800000000', password: 'synthetic-cloud-password' },
          '123Pan',
        ],
      ]) {
        const view = await cloud.write({ name, type, mode, parameters });
        assert.equal(view.phase, 'ready');
        assert.equal(mock.storages.get(view.storageId).driver, driver);
        const serialized = JSON.stringify(view);
        for (const key of Object.keys(parameters).filter((key) =>
          /cookie|password|secret|token/.test(key),
        ))
          assert.ok(!serialized.includes(parameters[key]));
        assert.equal(configs[name].user, state.openlist.davUser);
        assert.match(configs[name].url, /\/dav\/[a-f0-9]+\/$/);
        assert.ok(!configs[name].url.includes(state.openlist.namespace));
      }
    });
    await t.test('光鸭短信发送不把 work 误认为已登录，验证后保存令牌', async () => {
      const sent = await cloud.write({
        name: 'guangya',
        type: 'openlist-guangya',
        mode: 'sms',
        parameters: { client_id: 'synthetic-client', phone_number: '+86 13800000000' },
        action: 'send-code',
      });
      assert.equal(sent.phase, 'sms');
      assert.equal(sent.smsSent, true);
      assert.ok(!JSON.stringify(sent).includes('synthetic-verification-session'));
      const logged = await cloud.write({ parameters: { verify_code: '123456' } }, 'guangya');
      assert.equal(logged.phase, 'ready');
      assert.equal(logged.capabilities.overwrite, false);
      assert.ok(!JSON.stringify(logged).includes('synthetic-refresh'));
      const tokens = await cloud.write({
        name: 'guangyatoken',
        type: 'openlist-guangya',
        mode: 'token',
        parameters: { client_id: 'client', refresh_token: 'synthetic-refresh' },
      });
      assert.equal(tokens.phase, 'ready');
    });
    await t.test('编辑备注保留 Cookie 和刷新后的令牌，登录方式不可切换', async () => {
      const before = mock.storages.get(state.cloudRemotes.pan115.storageId).addition;
      await cloud.write({ parameters: { cookie: '' }, description: 'changed' }, 'pan115');
      assert.equal(mock.storages.get(state.cloudRemotes.pan115.storageId).addition, before);
      await assert.rejects(cloud.write({ mode: 'oauth', parameters: {} }, 'pan115'));
      assert.equal(mock.users.length, 1);
    });
    await t.test('令牌失效重新登录；上游错误原文和凭据不返回', async () => {
      mock.expire();
      assert.equal((await cloud.check()).connected, true);
      await assert.rejects(
        cloud.configure({ url: mock.url, username: 'admin', password: 'bad' }),
        (error) => !error.message.includes('sensitive'),
      );
      assert.equal((await cloud.check()).connected, true);
    });
    await t.test('OpenList 初始化失败后保留已创建挂载供修复，不能更换已有服务地址', async () => {
      mock.fail(true);
      const failed = await cloud.write({
        name: 'retry',
        type: 'openlist-115',
        mode: 'cookie',
        parameters: { cookie: 'synthetic-cookie' },
      });
      assert.equal(failed.phase, 'error');
      assert.ok(failed.storageId > 0);
      assert.ok(!JSON.stringify(failed).includes('sensitive'));
      await assert.rejects(
        cloud.configure({ url: 'http://127.0.0.1:1', username: 'admin', password: 'test' }),
        { status: 409 },
      );
      mock.fail(false);
      const fixed = await cloud.write({ parameters: { cookie: 'synthetic-new-cookie' } }, 'retry');
      assert.equal(fixed.phase, 'ready');
      assert.equal(fixed.storageId, failed.storageId);
    });
    await t.test('短信发送失败保持待登录，重发可恢复', async () => {
      mock.smsFail(true);
      const sent = await cloud.write({
        name: 'smsfail',
        type: 'openlist-guangya',
        mode: 'sms',
        parameters: { client_id: 'client', phone_number: '13800000000' },
        action: 'send-code',
      });
      assert.equal(sent.smsSent, false);
      assert.equal(sent.phase, 'error');
      mock.smsFail(false);
      assert.equal(
        (await cloud.write({ parameters: {}, action: 'send-code' }, 'smsfail')).smsSent,
        true,
      );
    });
    await t.test('移除连接只删除挂载配置，不调用网盘文件删除接口', async () => {
      const id = state.cloudRemotes.retry.storageId;
      await cloud.remove('retry');
      assert.equal(mock.storages.has(id), false);
      assert.equal(configs.retry, undefined);
      assert.equal(state.cloudRemotes.retry, undefined);
      assert.ok(!mock.requests.some((r) => r.path.startsWith('/api/fs/')));
    });
    await t.test('静态 API Token 可代替管理员密码', async () => {
      const config = await cloud.configure({
        url: mock.url,
        username: 'admin',
        auth: 'token',
        adminToken: 'synthetic-api-token',
      });
      assert.equal(config.tokenSaved, true);
      assert.equal(config.passwordSaved, false);
      assert.ok(!JSON.stringify(config).includes('synthetic-api-token'));
    });
    await t.test('外部改动的同名配置不会被覆盖或删除', async () => {
      const before = { ...configs.pan115 };
      configs.pan115.url = 'https://different.example/dav/';
      const requests = mock.requests.length;
      await assert.rejects(cloud.write({ parameters: { cookie: 'new' } }, 'pan115'), {
        status: 409,
      });
      await assert.rejects(cloud.remove('pan115'), { status: 409 });
      assert.equal(mock.requests.length, requests);
      configs.pan115 = before;
    });
    await t.test('外部移除的挂载可清理本地记录，上游缺失记录的 code 500 不阻塞删除', async () => {
      mock.storages.delete(state.cloudRemotes.pan123open.storageId);
      await cloud.remove('pan123open');
      assert.equal(state.cloudRemotes.pan123open, undefined);
      assert.equal(configs.pan123open, undefined);
    });
  } finally {
    await mock.close();
  }
});
