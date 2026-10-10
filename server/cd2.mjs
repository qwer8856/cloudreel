import { AppError, remoteName } from './validation.mjs';

// CD2 remains responsible for 115 authorization. Only WebDAV credentials go to rclone.
export function validateCd2(input) {
  const name = remoteName(input.name);
  let url;
  try {
    if (typeof input.url !== 'string' || input.url.length > 2048) throw new Error();
    url = new URL(input.url.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new AppError('请填写 HTTP / HTTPS WebDAV 地址；账号密码请填在独立字段中。');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  const rootPath = input.rootPath ?? '';
  if (typeof rootPath !== 'string' || rootPath.length > 2048 || /[\x00-\x1f\\]/.test(rootPath))
    throw new AppError('CD2 来源目录请使用 / 分隔的目录名称。');
  const parts = rootPath.split('/').filter(Boolean);
  if (parts.some((part) => ['.', '..'].includes(part)))
    throw new AppError('CD2 来源目录不能包含 . 或 ..。');
  if (typeof input.anonymous !== 'boolean' && input.anonymous !== undefined)
    throw new AppError('匿名访问设置无效。');
  const anonymous = input.anonymous === true;
  if (!anonymous && typeof input.username !== 'string')
    throw new AppError('请填写 CD2 账号或独立 WebDAV 用户名。');
  const username = anonymous ? '' : String(input.username ?? '').trim();
  if (!anonymous && (!username || username.length > 256 || /[\x00-\x1f:]/.test(username)))
    throw new AppError('请填写 CD2 账号或独立 WebDAV 用户名。');
  const record = { name, url: url.href, rootPath: parts.join('/'), username, anonymous };
  return record;
}

export function cd2Url(record) {
  const url = new URL(record.url);
  if (record.rootPath)
    url.pathname += record.rootPath.split('/').map(encodeURIComponent).join('/') + '/';
  return url.href;
}

export class Cd2Connector {
  constructor(context) {
    Object.assign(this, context);
    this.state.cd2Remotes ||= {};
  }
  record(name) {
    return Object.hasOwn(this.state.cd2Remotes, name) ? this.state.cd2Remotes[name] : undefined;
  }
  view(record, config) {
    return {
      name: record.name,
      url: record.url,
      rootPath: record.rootPath,
      username: record.username,
      anonymous: record.anonymous,
      type: 'cd2-webdav',
      description: `CD2 WebDAV · ${record.rootPath || 'WebDAV 根目录'}`,
      parameters: {},
      pending: null,
      passwordConfigured: !record.anonymous && Boolean(config?.pass),
      capabilities: { upload: false, overwrite: false, mkdir: false },
    };
  }
  assertConfig(record, config) {
    if (
      config?.type !== 'webdav' ||
      config.url !== cd2Url(record) ||
      (config.user || '') !== record.username
    )
      throw new AppError('CD2 WebDAV 配置与连接记录不匹配，请编辑连接重新保存。', 409);
  }
  async credentials(input, name) {
    const previous = name ? this.record(name) : undefined;
    if (name && !previous) throw new AppError('CD2 连接不存在。', 404);
    const record = validateCd2({ ...input, name: name || input.name });
    const password = input.password ?? '';
    if (typeof password !== 'string' || password.length > 1024 || /[\x00\r\n]/.test(password))
      throw new AppError('CD2 WebDAV 密码格式无效。');
    const config = previous ? (await this.engine.call('config/dump'))[name] : undefined;
    if (previous) this.assertConfig(previous, config);
    if (
      !record.anonymous &&
      !password &&
      !(config?.pass && previous.username === record.username && !previous.anonymous)
    )
      throw new AppError('请填写 CD2 WebDAV 密码；更换账号时需重新填写密码。');
    return { record, password, config };
  }
  async write(input, name) {
    const { record, password } = await this.credentials(input, name);
    const parameters = {
      url: cd2Url(record),
      vendor: 'other',
      user: record.username,
      ...(record.anonymous ? { pass: '' } : password ? { pass: password } : {}),
    };
    await this.backup();
    await this.engine.call(name ? 'config/update' : 'config/create', {
      name: record.name,
      ...(name ? {} : { type: 'webdav' }),
      parameters,
      opt: { nonInteractive: true, obscure: !record.anonymous, noObscure: record.anonymous },
    });
    this.state.cd2Remotes[record.name] = record;
    delete this.state.pending[record.name];
    await this.save();
    const config = (await this.engine.call('config/dump'))[record.name];
    return this.view(record, config);
  }
  async test(input, name) {
    const { record, password } = await this.credentials(input, name);
    // Saved passwords stay in rclone's configuration and are never returned to the browser.
    if (!record.anonymous && !password) {
      if (record.url !== this.record(name).url || record.rootPath !== this.record(name).rootPath)
        throw new AppError('测试修改后的地址或目录时，请重新填写密码；保存后也可测试连接。');
      const started = Date.now();
      await this.engine.call('operations/list', {
        fs: `${name}:`,
        remote: '',
        opt: { dirsOnly: true, noModTime: true, noMimeType: true },
      });
      return { ok: true, latency: Date.now() - started, rootPath: record.rootPath };
    }
    const started = Date.now();
    let response;
    try {
      response = await fetch(cd2Url(record), {
        method: 'PROPFIND',
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: {
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
          ...(record.anonymous
            ? {}
            : {
                Authorization: `Basic ${Buffer.from(`${record.username}:${password}`).toString('base64')}`,
              }),
        },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      });
    } catch (error) {
      throw new AppError(
        error.name === 'TimeoutError'
          ? 'CD2 WebDAV 连接超时，请检查容器到 CD2 的网络和端口。'
          : '无法连接 CD2 WebDAV，请确认地址可从 CloudReel 容器访问。',
        502,
      );
    }
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      throw new AppError(
        `CD2 WebDAV 拒绝访问（HTTP ${response.status}），请检查账号密码、WebDAV 开关和目录权限。`,
      );
    }
    if (response.status !== 207) {
      await response.body?.cancel();
      throw new AppError(
        `CD2 WebDAV 返回 HTTP ${response.status}，请检查 WebDAV 服务地址（通常以 /dav/ 结尾）和来源目录。`,
        502,
      );
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new AppError('CD2 连接测试响应过大，请检查服务地址。', 502);
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CD2 WebDAV 响应中断或超时，请检查 CD2 服务后重试。', 502);
    } finally {
      await reader.cancel();
    }
    const xml = Buffer.concat(chunks).toString();
    if (
      !/<(?:[\w.-]+:)?multistatus(?:\s|>)/i.test(xml) ||
      !/<(?:[\w.-]+:)?collection(?:\s|\/|>)/i.test(xml) ||
      !/HTTP\/\d(?:\.\d)? 200\b/.test(xml)
    )
      throw new AppError('CD2 未返回可读取的 WebDAV 目录，请检查来源目录和访问权限。', 502);
    return { ok: true, latency: Date.now() - started, rootPath: record.rootPath };
  }
}
