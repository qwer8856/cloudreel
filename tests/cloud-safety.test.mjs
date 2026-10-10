import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenListConnector } from '../server/openlist.mjs';
import { Notifications } from '../server/notifications.mjs';

async function cloudFixture(t) {
  const storages = new Map(),
    configs = {},
    users = [];
  let failure = '',
    nextId = 1;
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (data, code = 200) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code, data }));
    };
    if (url.pathname.endsWith('/user/list')) return send({ content: users, total: users.length });
    if (url.pathname.endsWith('/user/create')) {
      users.push(body);
      return send(null);
    }
    if (url.pathname.endsWith('/driver/names')) return send(['115 Cloud', '115 Open']);
    if (url.pathname.endsWith('/driver/info')) return send({ config: {} });
    if (url.pathname.endsWith('/storage/list'))
      return send({ content: [...storages.values()], total: storages.size });
    if (url.pathname.endsWith('/storage/get'))
      return send(storages.get(Number(url.searchParams.get('id'))));
    if (/\/storage\/(create|update)$/.test(url.pathname)) {
      const id = body.id || nextId++;
      if (failure !== 'reject') {
        const addition = JSON.parse(body.addition);
        if (failure === 'rotate') {
          addition.access_token = 'rotated-access';
          addition.refresh_token = 'rotated-refresh';
        }
        storages.set(id, {
          ...body,
          id,
          remark: failure === 'partial' ? 'old remark' : body.remark,
          addition: JSON.stringify(addition),
          status: failure ? 'Init failed' : 'work',
        });
      }
      // Updates can fail without returning an ID even when Init persisted their changes.
      return send(body.id && failure ? null : { id }, failure ? 500 : 200);
    }
    return send(null, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const state = {};
  const cloud = new OpenListConnector({
    state,
    env: {},
    save: async () => {},
    backup: async () => {},
    engine: {
      async call(route, input) {
        if (route === 'config/dump') return configs;
        configs[input.name] = { type: 'webdav', ...input.parameters };
        return {};
      },
    },
  });
  await cloud.configure({
    url: `http://127.0.0.1:${server.address().port}`,
    username: 'admin',
    auth: 'token',
    adminToken: 'synthetic-local-token',
  });
  return { cloud, state, storages, configs, fail: (value) => (failure = value) };
}

const cookieRemote = {
  name: 'source',
  type: 'openlist-115',
  mode: 'cookie',
  parameters: { cookie: 'old-cookie', root_folder_id: '0' },
};

test('OpenList rejects failed updates that leave old credentials or only persist part of the payload', async (t) => {
  const fixture = await cloudFixture(t);
  const before = await fixture.cloud.write(cookieRemote);
  fixture.fail('reject');
  await assert.rejects(
    fixture.cloud.write(
      { parameters: { cookie: 'new-cookie', root_folder_id: '123' }, description: 'new remark' },
      'source',
    ),
    { status: 502 },
  );
  assert.equal(JSON.parse(fixture.storages.get(before.storageId).addition).cookie, 'old-cookie');
  assert.equal(fixture.state.cloudRemotes.source.phase, 'error');
  fixture.fail('partial');
  await assert.rejects(
    fixture.cloud.write(
      { parameters: { cookie: 'new-cookie' }, description: 'new remark' },
      'source',
    ),
    { status: 502 },
  );
});

test('OpenList retains persisted Init failures and their storage ID for credential repair', async (t) => {
  const fixture = await cloudFixture(t);
  fixture.fail('persist');
  const created = await fixture.cloud.write(cookieRemote);
  assert.equal(created.phase, 'error');
  assert.ok(created.storageId > 0);
  const updated = await fixture.cloud.write(
    { parameters: { cookie: 'replacement', root_folder_id: '23' }, description: 'updated' },
    'source',
  );
  assert.equal(updated.phase, 'error');
  assert.equal(updated.storageId, created.storageId);
  assert.equal(updated.parameters.root_folder_id, '23');
  fixture.fail('');
  assert.equal((await fixture.cloud.write({ parameters: {} }, 'source')).phase, 'ready');
  assert.equal(fixture.storages.size, 1);
});

test('OpenList rejects unpersisted creates even if the error response contains a storage ID', async (t) => {
  const fixture = await cloudFixture(t);
  fixture.fail('reject');
  await assert.rejects(fixture.cloud.write(cookieRemote), { status: 502 });
  assert.equal(fixture.storages.size, 0);
  assert.equal(fixture.configs.source, undefined);
  assert.ok(fixture.state.cloudRemotes.source.storageId > 0);
  assert.equal(fixture.state.cloudRemotes.source.phase, 'error');
});

test('OpenList accepts persisted OAuth credentials rotated by the driver', async (t) => {
  const fixture = await cloudFixture(t);
  await fixture.cloud.write({
    name: 'oauth',
    type: 'openlist-115',
    mode: 'oauth',
    parameters: { access_token: 'old-access', refresh_token: 'old-refresh' },
  });
  fixture.fail('rotate');
  const result = await fixture.cloud.write(
    {
      parameters: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        root_folder_id: '23',
      },
    },
    'oauth',
  );
  assert.equal(result.phase, 'error');
  assert.equal(result.parameters.root_folder_id, '23');
  assert.ok(!JSON.stringify(result).includes('rotated-access'));
  fixture.fail('reject');
  await assert.rejects(
    fixture.cloud.write(
      { parameters: { access_token: 'replacement-access', refresh_token: 'replacement-refresh' } },
      'oauth',
    ),
    { status: 502 },
  );
});

test('notification settings preserve pending events for the same recipient and pause while disabled', async (t) => {
  let deliveries = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    deliveries++;
    response.writeHead(200);
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const notifications = new Notifications({ state: {}, save: async () => {} });
  const settings = {
    enabled: true,
    channel: 'webhook',
    events: ['completed'],
    url: `http://127.0.0.1:${server.address().port}/original`,
  };
  notifications.configure(settings);
  await notifications.enqueue('completed', { id: 'job' });
  notifications.configure({ ...settings, url: '', events: ['completed', 'failed'] });
  assert.equal(notifications.view().pending, 1);
  notifications.configure({ ...settings, enabled: false });
  await notifications.tick();
  assert.equal(deliveries, 0);
  assert.equal(notifications.view().pending, 1);
  notifications.configure(settings);
  await notifications.tick();
  assert.equal(deliveries, 1);
  assert.equal(notifications.view().pending, 0);
  await notifications.enqueue('completed', { id: 'another' });
  notifications.configure({ ...settings, url: `${settings.url}/changed` });
  assert.equal(notifications.view().pending, 0);
});

test('Telegram recipient changes clear pending events while unrelated inactive settings preserve them', async () => {
  const notifications = new Notifications({ state: {}, save: async () => {} });
  const settings = {
    enabled: true,
    channel: 'telegram',
    events: ['completed'],
    token: '123:synthetic',
    chatId: '-123',
  };
  notifications.configure(settings);
  await notifications.enqueue('completed', { id: 'one' });
  notifications.configure({ ...settings, url: 'http://127.0.0.1/unused' });
  assert.equal(notifications.view().pending, 1);
  notifications.configure({ ...settings, chatId: '-456' });
  assert.equal(notifications.view().pending, 0);
  await notifications.enqueue('completed', { id: 'two' });
  notifications.configure({ ...settings, chatId: '-456', token: '456:new-synthetic' });
  assert.equal(notifications.view().pending, 0);
});
