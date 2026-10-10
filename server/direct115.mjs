import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import QRCode from 'qrcode';
import { AppError, cleanPath, remoteName } from './validation.mjs';
import { encode115, decode115 } from './115-cipher.mjs';

const UA = 'Mozilla/5.0 115Browser/27.0.5.7';
const xml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
export function cookie115(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\r\n\x00]/.test(value))
    throw new AppError('115 Cookie 格式无效。');
  const entries = new Map(
    value.split(';').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim().toUpperCase(), part.slice(index + 1).trim()];
    }),
  );
  if (
    ['UID', 'CID', 'SEID'].some((key) => !entries.get(key) || !/^[\w.-]+$/.test(entries.get(key)))
  )
    throw new AppError('Cookie 必须包含有效的 UID、CID 和 SEID。');
  return ['UID', 'CID', 'SEID', 'KID']
    .filter((key) => entries.get(key))
    .map((key) => `${key}=${entries.get(key)}`)
    .join('; ');
}
export function downloadHost115(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('115 返回了无效的下载地址。', 502);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    !['115.com', '115cdn.com', 'anxia.com'].some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
    )
  )
    throw new AppError('115 返回了不受信任的下载地址。', 502);
  // Some download endpoints return HTTP URLs; upgrade trusted CDN hosts before sending credentials.
  parsed.protocol = 'https:';
  return parsed;
}

export class Client115 {
  constructor(cookie, fetcher = fetch) {
    this.cookie = cookie;
    this.fetch = fetcher;
    this.queue = Promise.resolve();
  }
  async request(url, form, authenticated = true) {
    // Keep metadata traffic sequential per connection; large recursive scans otherwise trigger throttling.
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const response = await this.fetch(url, {
        method: form ? 'POST' : 'GET',
        headers: { 'User-Agent': UA, ...(authenticated ? { Cookie: this.cookie } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      if (!response.ok) throw new AppError(`115 请求失败（HTTP ${response.status}）。`, 502);
      const data = await response.json();
      if (data.state === false || (data.errno && Number(data.errno) !== 0)) {
        const code = Number(data.errno || data.code);
        throw new AppError(
          [99, 911, 40101032].includes(code)
            ? '115 登录失效或需要在官方客户端完成验证。'
            : `115 接口拒绝请求（${code || '未知错误'}）。`,
          502,
        );
      }
      return {
        data,
        cookies: response.headers
          .getSetCookie()
          .map((v) => v.split(';')[0])
          .join('; '),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('115 请求超时或接口响应无效，请稍后重试。', 502);
    } finally {
      setTimeout(release, 400).unref?.();
    }
  }
  async list(cid) {
    const files = [];
    for (let offset = 0; ;) {
      const query = new URLSearchParams({
        aid: '1',
        cid,
        o: 'file_name',
        asc: '1',
        offset: String(offset),
        limit: '1150',
        show_dir: '1',
        snap: '0',
        natsort: '0',
        format: 'json',
        fc_mix: '0',
      });
      const { data } = await this.request(`https://webapi.115.com/files?${query}`);
      if (
        !Array.isArray(data.data) ||
        String(data.cid) !== cid ||
        !Number.isSafeInteger(Number(data.count)) ||
        Number(data.count) < 0 ||
        (data.offset !== undefined && Number(data.offset) !== offset)
      )
        throw new AppError('115 目录响应无效。', 502);
      if (Number(data.count) > 100000)
        throw new AppError('115 单个目录超过 100000 项，请缩小根目录。');
      for (const item of data.data) {
        if (
          typeof item.n !== 'string' ||
          !item.n ||
          /[\/\\:\x00-\x1f]/.test(item.n) ||
          ['.', '..'].includes(item.n)
        )
          throw new AppError('115 目录含无法安全映射的文件名，请在官网重命名。');
        const isDir = !item.fid;
        const id = String(isDir ? item.cid : item.fid),
          size = isDir ? 0 : Number(item.s);
        if (!/^\d{1,30}$/.test(id) || !Number.isSafeInteger(size) || size < 0)
          throw new AppError('115 文件信息响应无效。', 502);
        files.push({
          id,
          name: item.n,
          isDir,
          size,
          pickcode: item.pc,
          modified: /^\d+$/.test(item.t)
            ? new Date(Number(item.t) * 1000)
            : new Date(`${item.t?.replace(' ', 'T')}:00+08:00`),
        });
      }
      if (files.length > 100000) throw new AppError('115 目录过大。');
      if (offset + data.data.length >= Number(data.count)) break;
      if (!data.data.length) throw new AppError('115 目录分页异常，请重试。', 502);
      offset += data.data.length;
    }
    if (new Set(files.map((file) => file.name)).size !== files.length)
      throw new AppError('115 目录有同名项目，请在官网重命名后重试。');
    return files;
  }
  async download(pickcode, range, signal) {
    if (!/^[a-z0-9]{6,64}$/i.test(pickcode || '')) throw new AppError('115 文件缺少下载标识。');
    const encoded = encode115(JSON.stringify({ pickcode }));
    const { data, cookies } = await this.request(
      `https://proapi.115.com/app/chrome/downurl?t=${Math.floor(Date.now() / 1000)}`,
      {
        data: encoded.data,
      },
    );
    let url;
    try {
      url = Object.values(JSON.parse(decode115(data.data, encoded.key)))[0]?.url?.url;
    } catch {
      throw new AppError('115 下载响应无法解析。', 502);
    }
    let target = downloadHost115(url);
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.fetch(target, {
        headers: {
          'User-Agent': UA,
          Cookie: `${this.cookie}${cookies ? `; ${cookies}` : ''}`,
          ...(range ? { Range: range } : {}),
        },
        redirect: 'manual',
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        target = downloadHost115(new URL(response.headers.get('location'), target));
        continue;
      }
      if (![200, 206, 416].includes(response.status)) {
        await response.body?.cancel();
        throw new AppError(`115 下载失败（HTTP ${response.status}）。`, 502);
      }
      return response;
    }
    throw new AppError('115 下载重定向次数过多。', 502);
  }
}

export class Direct115 {
  constructor({ state, save, now = Date.now, fetcher = fetch, clientFactory }) {
    Object.assign(this, { state, save, now, fetcher });
    state.direct115Remotes ||= {};
    this.clientFactory = clientFactory || ((cookie) => new Client115(cookie, fetcher));
    this.clients = new Map();
    this.qr = new Map();
    this.paths = new Map();
    this.token = randomBytes(24).toString('hex');
  }
  record(name) {
    return Object.hasOwn(this.state.direct115Remotes || {}, name)
      ? this.state.direct115Remotes[name]
      : undefined;
  }
  view(record) {
    return {
      name: record.name,
      type: 'direct-115',
      managed: true,
      phase: 'ready',
      pending: null,
      parameters: { root_folder_id: record.rootId },
      cookieSaved: true,
      loginMode: record.loginMode,
      capabilities: { upload: false, read: true },
    };
  }
  client(record) {
    let entry = this.clients.get(record.name);
    if (!entry || entry.cookie !== record.cookie) {
      entry = { cookie: record.cookie, client: this.clientFactory(record.cookie) };
      this.clients.set(record.name, entry);
      this.paths.clear();
    }
    return entry.client;
  }
  async write(input, existingName) {
    const name = remoteName(existingName || input.name),
      old = this.record(name);
    if (existingName && !old) throw new AppError('115 连接不存在。', 404);
    const rootId = String(input.rootId || '0');
    if (!/^\d{1,30}$/.test(rootId)) throw new AppError('115 根目录 ID 必须是数字。');
    let cookie = input.cookie ? cookie115(input.cookie) : old?.cookie;
    let loginMode = old?.loginMode || 'cookie';
    if (input.qrSession) {
      const session = this.session(input.qrSession);
      if (!session.cookie) throw new AppError('请先完成扫码确认。');
      cookie = session.cookie;
      loginMode = 'qr';
    } else if (input.cookie) loginMode = 'cookie';
    if (!cookie) throw new AppError('请粘贴 CK 或完成扫码登录。');
    const record = { name, cookie, rootId, loginMode };
    await this.clientFactory(cookie).list(rootId); // Verify before committing credentials.
    this.state.direct115Remotes[name] = record;
    this.clients.delete(name);
    this.paths.clear();
    if (input.qrSession) this.qr.delete(input.qrSession);
    await this.save();
    return this.view(record);
  }
  session(id) {
    const session = this.qr.get(id);
    if (!session || session.expires <= this.now()) {
      this.qr.delete(id);
      throw new AppError('二维码已过期，请重新生成。', 410);
    }
    return session;
  }
  async startQr(device = 'web') {
    if (!['web', 'android', 'ios', 'tv'].includes(device)) throw new AppError('扫码设备类型无效。');
    for (const [id, session] of this.qr) if (session.expires <= this.now()) this.qr.delete(id);
    if (this.qr.size >= 20) throw new AppError('扫码会话过多，请等待旧二维码过期。', 429);
    const client = new Client115('', this.fetcher);
    const { data } = await client.request(
      'https://qrcodeapi.115.com/api/1.0/web/1.0/token',
      null,
      false,
    );
    const token = data.data;
    if (
      !token?.uid ||
      !token.sign ||
      !token.time ||
      typeof token.qrcode !== 'string' ||
      !token.qrcode.trim() ||
      token.qrcode.length > 2048
    )
      throw new AppError('二维码响应无效。', 502);
    // Render the login payload locally; the separate 115 image endpoint is unnecessary.
    let image;
    try {
      image = await QRCode.toBuffer(token.qrcode, { type: 'png', width: 240, margin: 4 });
    } catch {
      throw new AppError('二维码生成失败，请重新生成。', 502);
    }
    const id = randomBytes(20).toString('hex'),
      expires = this.now() + 180000;
    this.qr.set(id, { ...token, image, device, expires, client, status: 0 });
    return { id, expires, image: `/api/direct115/qr/${id}/image` };
  }
  async qrImage(id) {
    const session = this.session(id);
    return { body: session.image, type: 'image/png' };
  }
  async qrStatus(id) {
    const session = this.session(id);
    if (session.cookie) return { status: 2, ready: true };
    if (session.poll) return session.poll;
    session.poll = (async () => {
      const query = new URLSearchParams({
        uid: session.uid,
        time: String(session.time),
        sign: session.sign,
        _: String(Math.floor(this.now() / 1000)),
      });
      const { data } = await session.client.request(
        `https://qrcodeapi.115.com/get/status/?${query}`,
        null,
        false,
      );
      const status = Number(data.data?.status);
      if (![0, 1, 2, -1, -2].includes(status)) throw new AppError('二维码状态响应无效。', 502);
      if (status === 2) {
        const result = await session.client.request(
          `https://passportapi.115.com/app/1.0/${session.device}/1.0/login/qrcode`,
          { account: session.uid, app: session.device },
          false,
        );
        const credentials = result.data.data?.cookie;
        session.cookie = cookie115(
          Object.entries(credentials || {})
            .map(([key, value]) => `${key}=${value}`)
            .join('; '),
        );
      }
      session.status = status;
      return { status, ready: Boolean(session.cookie) };
    })();
    try {
      return await session.poll;
    } finally {
      session.poll = null;
    }
  }
  async start() {
    this.server = http.createServer((req, res) =>
      this.serve(req, res).catch((error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(error.status === 404 ? 404 : error.status === 405 ? 405 : 502, {
          'Content-Type': 'text/plain',
        });
        res.end(error instanceof AppError ? error.message : '115 读取失败，请重试。');
      }),
    );
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}/${this.token}/`;
  }
  fs(name, relative) {
    if (!this.record(name)) throw new AppError('115 连接不存在。', 404);
    return `:webdav,url='${this.base}${encodeURIComponent(name)}/',vendor=other:${cleanPath(relative)}`;
  }
  async list(record, id) {
    const key = `${record.name}:${id}`,
      cached = this.paths.get(key);
    if (cached && cached.until > this.now()) return cached.value;
    const value = await this.client(record).list(id);
    if (this.paths.size >= 500) this.paths.clear();
    this.paths.set(key, { value, until: this.now() + 15000 });
    return value;
  }
  async lookup(record, relative) {
    let item = { id: record.rootId, name: '', isDir: true, size: 0 };
    for (const segment of cleanPath(relative).split('/').filter(Boolean)) {
      if (!item.isDir) throw new AppError('文件不存在。', 404);
      const items = await this.list(record, item.id);
      item = items.find((value) => value.name === segment);
      if (!item) throw new AppError('文件不存在。', 404);
    }
    return item;
  }
  async serve(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const parts = pathname.split('/').slice(1);
    if (parts.shift() !== this.token) throw new AppError('文件不存在。', 404);
    const name = decodeURIComponent(parts.shift() || ''),
      record = this.record(name);
    if (!record) throw new AppError('文件不存在。', 404);
    const relative = cleanPath(parts.map(decodeURIComponent).join('/'));
    if (!['PROPFIND', 'GET', 'HEAD', 'OPTIONS'].includes(req.method))
      throw new AppError('115 直接连接仅支持读取。', 405);
    if (req.method === 'OPTIONS') {
      res.writeHead(200, { DAV: '1', Allow: 'OPTIONS, PROPFIND, HEAD, GET' });
      res.end();
      return;
    }
    const item = await this.lookup(record, relative);
    if (req.method === 'PROPFIND') {
      if (!['0', '1', undefined].includes(req.headers.depth))
        throw new AppError('不支持的目录深度。', 405);
      const entries = [{ ...item, relative }];
      if (item.isDir && req.headers.depth !== '0')
        entries.push(
          ...(await this.list(record, item.id)).map((file) => ({
            ...file,
            relative: [relative, file.name].filter(Boolean).join('/'),
          })),
        );
      const prefix = `/${this.token}/${encodeURIComponent(name)}/`;
      const responses = entries.map((file) => {
        const href =
          prefix +
          file.relative.split('/').map(encodeURIComponent).join('/') +
          (file.isDir && file.relative ? '/' : '');
        const time =
          file.modified instanceof Date && Number.isFinite(file.modified.getTime())
            ? file.modified.toUTCString()
            : new Date(0).toUTCString();
        return `<d:response><d:href>${xml(href)}</d:href><d:propstat><d:prop><d:displayname>${xml(file.name)}</d:displayname><d:resourcetype>${file.isDir ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${file.size || 0}</d:getcontentlength><d:getlastmodified>${time}</d:getlastmodified><d:getcontenttype>${file.isDir ? 'httpd/unix-directory' : 'application/octet-stream'}</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      });
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`,
      );
      return;
    }
    if (item.isDir) throw new AppError('目录不支持下载。', 405);
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': item.size, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range))
      throw new AppError('无效的文件范围。');
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const response = await this.client(record).download(
      item.pickcode,
      req.headers.range,
      AbortSignal.any([controller.signal, AbortSignal.timeout(12 * 3600000)]),
    );
    const headers = {};
    for (const key of ['content-length', 'content-range', 'accept-ranges', 'content-type'])
      if (response.headers.has(key)) headers[key] = response.headers.get(key);
    res.writeHead(response.status, headers);
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  }
  reset() {
    this.clients.clear();
    this.paths.clear();
    this.qr.clear();
    this.state.direct115Remotes ||= {};
  }
  async close() {
    this.reset();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
