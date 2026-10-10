import test from 'node:test';
import assert from 'node:assert/strict';
import { Client115, Direct115, cookie115, downloadHost115 } from '../server/direct115.mjs';
import { encode115, decode115 } from '../server/115-cipher.mjs';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const ck = 'UID=123_A1; CID=synthetic-cid; SEID=synthetic-seid';
test('CK 只保留115登录字段，拒绝缺失、控制字符和外部下载URL', () => {
  assert.equal(cookie115(`${ck}; unrelated=secret`), ck);
  for (const value of ['', 'UID=123;CID=abc', `${ck}\r\nX-Test: bad`])
    assert.throws(() => cookie115(value));
  assert.equal(downloadHost115('https://cdn.115.com/file').hostname, 'cdn.115.com');
  assert.equal(downloadHost115('http://cdn.115.com/file').protocol, 'https:');
  for (const url of [
    'https://115.com.example.org/',
    'https://127.0.0.1/',
    'http://cdn.115.com:8080/',
    'https://user:pass@115.com/',
  ])
    assert.throws(() => downloadHost115(url));
  assert.equal(Buffer.from(encode115('{"pickcode":"abc123"}').data, 'base64').length, 128);
  assert.throws(() => decode115('invalid', Buffer.alloc(16)));
});

test('115 目录分页映射目录、文件及特殊字符，拒绝同名和目录漂移', async () => {
  let count = 0;
  const client = new Client115(ck, async (url, options) => {
    assert.equal(options.headers.Cookie, ck);
    const offset = Number(new URL(url).searchParams.get('offset'));
    count++;
    return Response.json({
      state: true,
      cid: '0',
      count: 1151,
      data: offset
        ? [
            {
              fid: '12345',
              cid: '0',
              n: '电影 & <标题>.mkv',
              s: '12',
              pc: 'pick123',
              t: '2026-10-10 12:00',
            },
          ]
        : Array.from({ length: 1150 }, (_, i) => ({ cid: `${i + 1}`, n: `目录${i}`, t: '1' })),
    });
  });
  const list = await client.list('0');
  assert.equal(count, 2);
  assert.equal(list[0].isDir, true);
  assert.equal(list.at(-1).size, 12);
  const invalid = new Client115(ck, async () =>
    Response.json({ state: true, cid: 'other', count: 0, data: [] }),
  );
  await assert.rejects(() => invalid.list('0'), /响应无效/);
  const duplicate = new Client115(ck, async () =>
    Response.json({
      state: true,
      cid: '0',
      count: 2,
      data: [
        { cid: '1', n: 'same' },
        { fid: '2', n: 'same', s: 1 },
      ],
    }),
  );
  await assert.rejects(() => duplicate.list('0'), /同名/);
});

test('115 原生桥只监听回环，WebDAV XML编码、范围读取、拒绝写入、凭据不回显', async (t) => {
  const state = {},
    file = {
      id: '2',
      name: '电影 & 字幕.mkv',
      size: 6,
      pickcode: 'pick123',
      isDir: false,
      modified: new Date(0),
    };
  const direct = new Direct115({
    state,
    save: async () => {},
    clientFactory: () => ({
      list: async () => [file],
      download: async (pickcode, range) => {
        assert.equal(pickcode, 'pick123');
        return new Response(range ? 'abc' : 'abcdef', {
          status: range ? 206 : 200,
          headers: range ? { 'Content-Range': 'bytes 0-2/6' } : {},
        });
      },
    }),
  });
  await direct.start();
  t.after(() => direct.close());
  const view = await direct.write({ name: '115-main', cookie: ck });
  assert.equal(JSON.stringify(view).includes('synthetic'), false);
  assert.equal(view.capabilities.upload, false);
  const base = `${direct.base}115-main/`;
  const listing = await fetch(base, { method: 'PROPFIND', headers: { Depth: '1' } });
  assert.equal(listing.status, 207);
  assert.match(await listing.text(), /电影 &amp; 字幕/);
  const download = await fetch(base + encodeURIComponent(file.name), {
    headers: { Range: 'bytes=0-2' },
  });
  assert.equal(download.status, 206);
  assert.equal(await download.text(), 'abc');
  assert.equal((await fetch(base + 'new', { method: 'PUT', body: 'bad' })).status, 405);
  assert.equal((await fetch(base.replace(direct.token, 'wrong'))).status, 404);
  assert.equal(
    (await fetch(base, { method: 'PROPFIND', headers: { Depth: 'infinity' } })).status,
    405,
  );
});

test('扫码从生成、扫描、确认到保存，服务端换取Cookie，失效和重复保存被拒绝', async () => {
  let now = 10000,
    status = 0,
    confirmed = 0;
  const direct = new Direct115({
    state: {},
    now: () => now,
    save: async () => {},
    clientFactory: () => ({ list: async () => [] }),
    fetcher: async (url) => {
      if (String(url).includes('/token'))
        return Response.json({
          state: true,
          data: {
            uid: 'uid',
            sign: 'sign',
            time: 10,
            qrcode: 'http://115.com/scan/dg-synthetic-test',
          },
        });
      if (String(url).includes('/get/status/'))
        return Response.json({ state: true, data: { status } });
      if (String(url).includes('/login/qrcode')) {
        confirmed++;
        return Response.json({
          state: true,
          data: { cookie: { UID: '123_A1', CID: 'synthetic-cid', SEID: 'synthetic-seid' } },
        });
      }
      throw new Error('unexpected request');
    },
  });
  const session = await direct.startQr('web');
  assert.equal((await direct.qrStatus(session.id)).status, 0);
  status = 1;
  assert.equal((await direct.qrStatus(session.id)).status, 1);
  status = 2;
  const results = await Promise.all([direct.qrStatus(session.id), direct.qrStatus(session.id)]);
  assert.equal(results[0].ready, true);
  assert.equal(confirmed, 1);
  assert.equal(JSON.stringify(results).includes('synthetic'), false);
  const view = await direct.write({ name: 'scan', qrSession: session.id });
  assert.equal(view.loginMode, 'qr');
  await assert.rejects(() => direct.write({ name: 'again', qrSession: session.id }), /过期/);
  const expired = await direct.startQr();
  now += 180001;
  await assert.rejects(() => direct.qrStatus(expired.id), /过期/);
});

test('115 登录码在本地生成可读取的 PNG，图片读取无需请求远端且过期不可读取', async () => {
  let now = 10000,
    requests = 0;
  const direct = new Direct115({
    state: {},
    save: async () => {},
    now: () => now,
    fetcher: async (url) => {
      requests++;
      assert.equal(String(url), 'https://qrcodeapi.115.com/api/1.0/web/1.0/token');
      return Response.json({
        state: 1,
        data: {
          uid: 'synthetic-uid',
          sign: 'synthetic-sign',
          time: 10,
          qrcode: 'http://115.com/scan/dg-synthetic-test',
        },
      });
    },
  });
  const session = await direct.startQr();
  assert.equal(JSON.stringify(session).includes('synthetic'), false);
  const image = await direct.qrImage(session.id);
  assert.equal(image.type, 'image/png');
  const png = PNG.sync.read(image.body);
  assert.equal(png.width, 240);
  assert.equal(png.height, 240);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(decoded?.data, 'http://115.com/scan/dg-synthetic-test');
  assert.ok(
    png.data.some((value, index) => index % 4 !== 3 && value === 0),
    '有黑色二维码模块',
  );
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 255, 255, 255], '保留白色静区');
  assert.deepEqual(await direct.qrImage(session.id), image);
  assert.equal(requests, 1, '图片读取不再依赖远端图片服务');
  now += 180001;
  await assert.rejects(() => direct.qrImage(session.id), { status: 410 });
});

test('缺失或异常扫码内容与上游网络故障返回可操作错误，不创建空白二维码会话', async () => {
  for (const qrcode of [undefined, null, '', ' ', 42, 'x'.repeat(2049)]) {
    const direct = new Direct115({
      state: {},
      save: async () => {},
      fetcher: async () =>
        Response.json({ state: 1, data: { uid: 'uid', sign: 'sign', time: 10, qrcode } }),
    });
    await assert.rejects(() => direct.startQr(), { status: 502, message: '二维码响应无效。' });
    assert.equal(direct.qr.size, 0);
  }
  const direct = new Direct115({
    state: {},
    save: async () => {},
    fetcher: async () => {
      throw new Error('synthetic network error');
    },
  });
  await assert.rejects(() => direct.startQr(), {
    status: 502,
    message: '115 请求超时或接口响应无效，请稍后重试。',
  });
});
