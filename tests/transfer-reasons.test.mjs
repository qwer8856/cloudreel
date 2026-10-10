import test from 'node:test';
import assert from 'node:assert/strict';
import { Operations } from '../server/operations.mjs';
import { Client115, Direct115 } from '../server/direct115.mjs';
import { stopMessage, wasCancelled } from '../server/transfer-reasons.mjs';
import { safeError } from '../server/validation.mjs';

const ck = 'UID=synthetic-uid; CID=synthetic-cid; SEID=synthetic-seid';
const instant = { requestTimeout: 100, metadataInterval: 0 };
const pendingFetch = async (url, { signal }) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not abort')), 30000);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

test('真实 RC 字段中的 checked 表示检查，失败和多次传输时间分别记录且去重', async () => {
  const items = [
    {
      name: '电影.mkv',
      size: 12,
      checked: true,
      what: 'checking',
      started_at: '2026-10-11T01:00:00Z',
      completed_at: '2026-10-11T01:00:01Z',
    },
    {
      name: '电影.mkv',
      size: 12,
      checked: false,
      what: 'transferring',
      error: '115 下载地址接口返回 HTTP 429。',
      completed_at: '2026-10-11T01:00:02Z',
    },
    {
      name: '电影.mkv',
      size: 12,
      bytes: 12,
      what: 'transferring',
      completed_at: '2026-10-11T01:00:03Z',
    },
  ];
  const operations = new Operations({
    state: { jobs: [] },
    engine: { call: async () => ({ transferred: items }) },
  });
  const job = { attempts: 1, files: [] };
  await operations.details(job);
  await operations.details(job);
  assert.deepEqual(
    job.files.map((file) => file.status),
    ['checked', 'failed', 'completed'],
  );
  assert.match(job.files[0].reason, /不代表跳过/);
  assert.match(job.files[1].reason, /下载地址接口.*429/);
  assert.equal(job.files[2].at, '2026-10-11T01:00:03.000Z');
});

test('用户停止仅把取消记录显示为停止，保留之前真实失败且不触发账号轮换', async () => {
  const token = 'a'.repeat(48);
  const cancelled = `failed to open source object: Get "http://127.0.0.1:12345/${token}/115/电影.mkv": context canceled`;
  const job = {
    attempts: 1,
    status: 'stopped',
    stopping: true,
    stopReason: 'user',
    error: cancelled,
    files: [],
    events: [],
    source: {},
    destination: {},
  };
  const operations = new Operations({
    state: { jobs: [] },
    now: Date.now,
    notify: async () => {},
    driveGroups: { rotate: () => assert.fail('用户停止不轮换账号') },
    engine: {
      call: async () => ({
        transferred: [
          { name: '失败.mkv', what: 'transferring', error: '115 下载地址接口返回 HTTP 503。' },
          { name: '停止.mkv', what: 'transferring', error: cancelled },
        ],
      }),
    },
  });
  await operations.details(job);
  await operations.finished(job, null, { success: false, error: cancelled });
  assert.deepEqual(
    job.files.map((file) => file.status),
    ['failed', 'stopped'],
  );
  assert.equal(job.error, '');
  assert.match(job.reason, /用户已停止/);
  assert.match(job.events.at(-1).message, /另有 1 个文件/);
  assert.doesNotMatch(job.events.at(-1).message, /context canceled/);
  assert.equal(JSON.stringify(job).includes(token), false);
  assert.equal(wasCancelled(cancelled, { stopping: false }), false);
  assert.equal(wasCancelled('HTTP 502; context canceled', job), false);
});

test('历史检查标签与用户取消记录可修正，真实跳过和 115 失败原因保留', () => {
  const job = {
    status: 'stopped',
    stopping: true,
    stopReason: 'user',
    error: 'context canceled',
    files: [
      { key: '1:undefined:movie:checking:', status: 'skipped', path: 'movie' },
      { key: 'media-key', status: 'skipped', path: 'existing', check: 'different' },
      {
        key: 'old-error',
        status: 'failed',
        path: 'fail',
        error: '115 请求超时或接口响应无效，请稍后重试。: 502 Bad Gateway',
      },
      { key: 'old-cancel', status: 'failed', path: 'stop', error: 'context canceled' },
    ],
    events: [{ message: '执行结束：stopped；context canceled' }],
  };
  new Operations({ state: { jobs: [job] } });
  assert.deepEqual(
    job.files.map((file) => file.status),
    ['checked', 'skipped', 'failed', 'stopped'],
  );
  assert.match(job.files[1].reason, /大小或共同哈希不同/);
  assert.match(job.files[2].reason, /旧版本未区分/);
  assert.equal(job.error, '');
  assert.equal(job.events[0].message, stopMessage(job));
  assert.equal(safeError('SEID=synthetic-seid; UID=synthetic-uid'), 'SEID=***; UID=***');
});

test('115 分别报告 HTTP、非 JSON、格式、接口错误码及 DNS 原因，并隐藏凭据', async () => {
  const cases = [
    [() => new Response('busy', { status: 429 }), /下载地址接口返回 HTTP 429.*请求过于频繁/],
    [() => new Response('gateway', { status: 503 }), /下载地址接口返回 HTTP 503/],
    [
      () => new Response('<html>bad</html>', { headers: { 'Content-Type': 'text/html' } }),
      /非 JSON.*HTTP 200，text\/html/,
    ],
    [() => Response.json(null), /响应格式无效/],
    [
      () => Response.json({ state: 0, code: 12345, message: `真实拒绝原因 ${ck}` }),
      /错误码 12345.*真实拒绝原因/,
    ],
    [
      () => Response.json({ state: false, errno: 911, message: '请验证账号' }),
      /错误码 911.*官方客户端完成验证.*请验证账号/,
    ],
    [
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      },
      /DNS 解析失败（ENOTFOUND）/,
    ],
    [
      () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      },
      /连接被重置（ECONNRESET）/,
    ],
  ];
  for (const [fetcher, pattern] of cases) {
    const client = new Client115(ck, fetcher, instant);
    await assert.rejects(
      client.request('https://proapi.115.com/app/chrome/downurl', {}),
      (error) => {
        assert.equal(error.status, 502);
        assert.match(error.message, pattern);
        assert.equal(error.message.includes('synthetic'), false);
        return true;
      },
    );
  }
});

test('115 超时与用户取消分开，取得下载地址时也能立即取消', async () => {
  const client = new Client115(ck, pendingFetch, { ...instant, requestTimeout: 20 });
  await assert.rejects(
    client.request('https://webapi.115.com/files'),
    /目录列表接口请求超时（超过 0.02 秒）/,
  );
  const controller = new AbortController();
  const long = new Client115(ck, pendingFetch, { ...instant, requestTimeout: 20000 });
  const start = Date.now();
  const promise = long.download('pick123', undefined, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { name: 'AbortError' });
  assert.ok(Date.now() - start < 1000);
});

test('115 排队中的取消不发送接口请求，也不打断前后请求顺序', async () => {
  let finishFirst;
  const calls = [];
  const client = new Client115(
    ck,
    async (url) => {
      calls.push(String(url));
      if (calls.length === 1)
        await new Promise((resolve) => {
          finishFirst = resolve;
        });
      return Response.json({ state: true });
    },
    instant,
  );
  const first = client.request('https://webapi.115.com/first');
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = client.request(
    'https://webapi.115.com/cancelled',
    undefined,
    true,
    controller.signal,
  );
  const third = client.request('https://webapi.115.com/third');
  controller.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(calls.length, 1);
  finishFirst();
  await Promise.all([first, third]);
  assert.deepEqual(calls, ['https://webapi.115.com/first', 'https://webapi.115.com/third']);
});

test('115 文件下载阶段显示 CDN 的 HTTP 和网络错误，重定向不泄露 Cookie', async () => {
  const client = new Client115(ck, async () => new Response('forbidden', { status: 403 }), instant);
  await assert.rejects(
    client.downloadResponse('https://cdn.115.com/file', '', undefined),
    /文件下载服务器返回 HTTP 403/,
  );
  const reset = new Client115(
    ck,
    async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    },
    instant,
  );
  await assert.rejects(
    reset.downloadResponse('https://cdn.115.com/file', '', undefined),
    /文件下载连接被重置/,
  );
  const redirect = new Client115(
    ck,
    async () => new Response(null, { status: 302, headers: { Location: 'https://example.org/' } }),
    instant,
  );
  await assert.rejects(
    redirect.downloadResponse('https://cdn.115.com/file', '', undefined),
    /不受信任/,
  );
});

test('取消 WebDAV 目录读取会终止底层 115 请求', async (t) => {
  let listing = false,
    underlyingAborted = false;
  const direct = new Direct115({
    state: {},
    save: async () => {},
    clientFactory: () => ({
      list: async (id, signal) => {
        if (!signal) return [];
        listing = true;
        return new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              underlyingAborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    }),
  });
  await direct.start();
  t.after(() => direct.close());
  await direct.write({ name: 'cancel115', cookie: ck });
  const controller = new AbortController();
  const promise = fetch(`${direct.base}cancel115/`, {
    method: 'PROPFIND',
    headers: { Depth: '1' },
    signal: controller.signal,
  });
  const rejected = assert.rejects(promise, { name: 'AbortError' });
  for (let i = 0; i < 100 && !listing; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(listing, true);
  controller.abort();
  await rejected;
  for (let i = 0; i < 100 && !underlyingAborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(underlyingAborted, true);
});
