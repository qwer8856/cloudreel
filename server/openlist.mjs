import { createHash, randomBytes } from 'node:crypto';
import { AppError, cleanPath, remoteName } from './validation.mjs';

// Driver names and field casing follow OpenList v4.2.6, not rclone backend names.
export const CLOUD_TYPES = ['openlist-115', 'openlist-guangya', 'openlist-123'];
const MODES = {
  'openlist-115': {
    cookie: {
      driver: '115 Cloud',
      fields: ['cookie', 'root_folder_id'],
      required: ['cookie'],
      defaults: { root_folder_id: '0', page_size: 1000, limit_rate: 2, qrcode_source: 'web' },
    },
    oauth: {
      driver: '115 Open',
      fields: ['access_token', 'refresh_token', 'root_folder_id'],
      required: ['access_token', 'refresh_token'],
      defaults: { root_folder_id: '0', page_size: 200, limit_rate: 1 },
    },
  },
  'openlist-123': {
    password: {
      driver: '123Pan',
      fields: ['username', 'password', 'root_folder_id'],
      required: ['username', 'password'],
      defaults: { root_folder_id: '0', UploadThread: 3, platform: 'web' },
    },
    developer: {
      driver: '123 Open',
      fields: ['client_id', 'client_secret', 'root_folder_id'],
      required: ['client_id', 'client_secret'],
      keys: { client_id: 'ClientID', client_secret: 'ClientSecret' },
      defaults: { root_folder_id: '0', UploadThread: 3, use_online_api: false, DirectLink: false },
    },
  },
  'openlist-guangya': {
    sms: {
      driver: 'GuangYaPan',
      fields: [
        'client_id',
        'phone_number',
        'captcha_token',
        'verify_code',
        'root_path',
        'device_id',
        'device_sign',
      ],
      required: ['client_id', 'phone_number'],
      defaults: { root_path: '', page_size: 100, order_by: 3, sort_type: 1 },
    },
    token: {
      driver: 'GuangYaPan',
      fields: [
        'client_id',
        'access_token',
        'refresh_token',
        'root_path',
        'device_id',
        'device_sign',
      ],
      required: ['client_id', 'refresh_token'],
      defaults: { root_path: '', page_size: 100, order_by: 3, sort_type: 1 },
    },
  },
};
const isSecret = (key) => /cookie|password|secret|token|verify_code|device_sign/i.test(key);
const passwordHash = (password) =>
  createHash('sha256').update(`${password}-https://github.com/alist-org/alist`).digest('hex');

function storageWritePersisted(stored, payload, previous, spec, action) {
  if (!stored) return false;
  for (const key of [
    'driver',
    'mount_path',
    'remark',
    'cache_expiration',
    'webdav_policy',
    'disabled',
    'enable_sign',
  ])
    if (stored[key] !== payload[key]) return false;
  let actual, desired, before;
  try {
    actual = JSON.parse(stored.addition);
    desired = JSON.parse(payload.addition);
    before = JSON.parse(previous?.addition || '{}');
  } catch {
    return false;
  }
  if (!actual || typeof actual !== 'object') return false;
  const smsCompleted = Boolean(
    desired.verify_code &&
    actual.access_token &&
    actual.refresh_token &&
    !actual.verify_code &&
    (actual.access_token !== before.access_token || actual.refresh_token !== before.refresh_token),
  );
  for (const key of new Set([
    ...Object.keys(spec.defaults),
    ...spec.fields.map((key) => spec.keys?.[key] || key),
  ])) {
    if (['access_token', 'refresh_token'].includes(key)) {
      // Drivers may rotate tokens in Init. Unchanged tokens can rotate freely;
      // replacement credentials must read back as requested or as newly issued tokens.
      if (smsCompleted || desired[key] === before[key]) continue;
      if (actual[key] === desired[key]) continue;
      if (desired[key] && actual[key] && actual[key] !== before[key]) continue;
      return false;
    }
    if (key === 'verify_code' && smsCompleted) continue;
    if (key === 'device_id' && !desired[key] && actual[key]) continue;
    if (actual[key] !== desired[key]) return false;
  }
  if (action === 'send-code' && desired.send_code !== actual.send_code)
    return (
      actual.send_code === false &&
      Boolean(actual.verification_id) &&
      actual.verification_id !== before.verification_id
    );
  return true;
}

export function openListUrl(value) {
  if (typeof value !== 'string' || value.length > 2048)
    throw new AppError('OpenList 地址格式不正确。');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('请输入完整的 OpenList 地址。');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError('OpenList 地址只能使用 HTTP / HTTPS，不能包含凭据、参数或片段。');
  return url.href.replace(/\/+$/, '');
}

export function cloudParameters(type, mode, input, previous = {}, action = 'save') {
  const spec = MODES[type]?.[mode];
  if (!spec) throw new AppError('请选择有效的网盘和登录方式。');
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError('网盘配置字段格式不正确。');
  if (
    !['save', 'send-code'].includes(action) ||
    (action === 'send-code' && !(type === 'openlist-guangya' && mode === 'sms'))
  )
    throw new AppError('登录操作不正确。');
  const addition = { ...spec.defaults, ...previous };
  for (const [key, value] of Object.entries(input)) {
    if (
      !spec.fields.includes(key) ||
      typeof value !== 'string' ||
      value.length > 65536 ||
      value.includes('\0')
    )
      throw new AppError('网盘配置包含未知或无效字段。');
    const target = spec.keys?.[key] || key;
    if (isSecret(key) && !value && addition[target]) continue;
    addition[target] = key === 'password' ? value : value.trim();
  }
  for (const key of spec.required)
    if (!addition[spec.keys?.[key] || key]) throw new AppError(`请填写 ${key}。`);
  if (addition.root_folder_id && !/^\d{1,30}$/.test(addition.root_folder_id))
    throw new AppError('根目录 ID 必须为数字，根目录填写 0。');
  if (type === 'openlist-guangya') {
    addition.root_path = cleanPath(addition.root_path || '');
    if (mode === 'sms' && !/^\+?[\d -]{6,24}$/.test(addition.phone_number))
      throw new AppError('请填写有效的手机号，可包含 +86。');
    if (action === 'send-code') {
      addition.access_token = '';
      addition.refresh_token = '';
      addition.verify_code = '';
      addition.verification_id = '';
      addition.send_code = true;
    } else {
      addition.send_code = false;
      if (
        mode === 'sms' &&
        !addition.access_token &&
        !addition.refresh_token &&
        !addition.verify_code
      )
        throw new AppError('请先发送短信，再填写验证码完成登录。');
    }
  }
  // Developer mode never enables the third-party renewal service or paid direct links.
  if (mode === 'developer') Object.assign(addition, { use_online_api: false, DirectLink: false });
  return { spec, addition };
}

class BridgeError extends AppError {
  constructor(code, id) {
    super(
      code === 401 || code === 403
        ? 'OpenList 授权失效或没有管理员权限，请重新连接服务。'
        : code === 402
          ? 'OpenList 需要两步验证码，请在服务设置中重新连接。'
          : 'OpenList 未完成请求，请检查服务、版本和网盘凭据。',
      502,
    );
    this.code = code;
    this.storageId = Number.isSafeInteger(id) && id > 0 ? id : null;
  }
}

export class OpenListConnector {
  constructor({ state, save, engine, backup, env }) {
    Object.assign(this, { state, save, engine, backup });
    state.cloudRemotes ||= {};
    state.openlist ||= {
      url: env.OPENLIST_URL ? openListUrl(env.OPENLIST_URL) : '',
      username: env.OPENLIST_ADMIN_USER || 'admin',
      passwordHash: env.OPENLIST_ADMIN_PASSWORD ? passwordHash(env.OPENLIST_ADMIN_PASSWORD) : '',
      adminToken: env.OPENLIST_ADMIN_TOKEN || '',
    };
    this.token = '';
  }
  configView() {
    const c = this.state.openlist;
    return {
      url: c.url,
      username: c.username,
      passwordSaved: Boolean(c.passwordHash),
      tokenSaved: Boolean(c.adminToken),
      configured: Boolean(c.url && (c.passwordHash || c.adminToken)),
      ready: Boolean(c.ready),
      locked: Object.keys(this.state.cloudRemotes).length > 0,
    };
  }
  async raw(route, body, token = this.token, config = this.state.openlist) {
    let response, data;
    try {
      response = await fetch(`${config.url}/api${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      data = await response.json();
    } catch {
      throw new AppError('无法连接 OpenList，请检查地址、网络和服务是否运行。', 502);
    }
    if (!response.ok || data.code !== 200)
      throw new BridgeError(data.code || response.status, data.data?.id);
    return data.data;
  }
  async login(config = this.state.openlist, otp = '') {
    if (!config.url || !(config.passwordHash || config.adminToken))
      throw new AppError('请先连接 OpenList 服务。', 409);
    const token =
      config.adminToken ||
      (
        await this.raw(
          '/auth/login/hash',
          { username: config.username, password: config.passwordHash, otp_code: otp },
          '',
          config,
        )
      )?.token;
    if (typeof token !== 'string' || !token) throw new BridgeError(401);
    this.token = token;
    return token;
  }
  async call(route, body) {
    if (!this.token) await this.login();
    try {
      return await this.raw(route, body);
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 401) throw error;
      this.token = '';
      await this.login();
      return this.raw(route, body);
    }
  }
  async list(kind) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.call(`/admin/${kind}/list?page=${page}&per_page=100`);
      const items = result?.content || [];
      all.push(...items);
      if (!items.length || all.length >= result.total) return all;
    }
    throw new AppError('OpenList 记录过多，请使用单独的服务实例。', 409);
  }
  async ensureUser() {
    const c = this.state.openlist;
    if (!c.namespace) {
      const id = randomBytes(8).toString('hex');
      Object.assign(c, {
        namespace: `/rclone-studio-${id}`,
        davUser: `studio-${id}`,
        davPassword: randomBytes(32).toString('base64url'),
      });
      await this.save(); // Persist ownership and password before creating the upstream user.
    }
    const user = (await this.list('user')).find((item) => item.username === c.davUser);
    if (user) {
      if (
        user.role !== 0 ||
        user.base_path !== c.namespace ||
        user.disabled ||
        (user.permission & 0x3fb) !== 0x3fb
      )
        throw new AppError('OpenList 专用 WebDAV 账号的目录或读写权限已改变，请检查该账号。', 409);
    } else {
      await this.call('/admin/user/create', {
        username: c.davUser,
        password: c.davPassword,
        role: 0,
        base_path: c.namespace,
        permission: 0x3fb,
        disabled: false,
        allow_ldap: false,
      });
    }
    c.ready = true;
    await this.save();
  }
  async configure(input) {
    const previous = this.state.openlist;
    const url = openListUrl(input.url);
    if (url !== previous.url && Object.keys(this.state.cloudRemotes).length)
      throw new AppError('已有网盘使用此 OpenList，请先移除连接后再更换服务地址。', 409);
    const username = typeof input.username === 'string' ? input.username.trim() : previous.username;
    if (!username || username.length > 200) throw new AppError('请填写 OpenList 管理员用户名。');
    const method = input.auth || 'password';
    if (!['password', 'token'].includes(method)) throw new AppError('OpenList 授权方式无效。');
    for (const key of ['password', 'adminToken', 'otp'])
      if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 65536))
        throw new AppError('OpenList 凭据格式不正确。');
    const same = url === previous.url;
    const candidate = {
      ...(same ? previous : {}),
      url,
      username,
      ready: false,
      passwordHash:
        method === 'password'
          ? input.password
            ? passwordHash(input.password)
            : same
              ? previous.passwordHash
              : ''
          : '',
      adminToken: method === 'token' ? input.adminToken || (same ? previous.adminToken : '') : '',
    };
    this.token = '';
    try {
      const token = await this.login(candidate, input.otp || '');
      const names = await this.raw('/admin/driver/names', undefined, token, candidate);
      if (!Array.isArray(names)) throw new BridgeError(502);
      this.state.openlist = candidate;
      await this.save();
      await this.ensureUser();
      await this.rebind();
      return {
        ...this.configView(),
        drivers: names.filter((name) =>
          ['115 Cloud', '115 Open', '123Pan', '123 Open', 'GuangYaPan'].includes(name),
        ),
      };
    } catch (error) {
      this.token = '';
      throw error;
    }
  }
  async check() {
    const names = await this.call('/admin/driver/names');
    return {
      ...this.configView(),
      connected: true,
      drivers: names.filter((name) =>
        ['115 Cloud', '115 Open', '123Pan', '123 Open', 'GuangYaPan'].includes(name),
      ),
    };
  }
  record(name) {
    const record = this.state.cloudRemotes[name];
    if (!record) throw new AppError('网盘连接不存在。', 404);
    return record;
  }
  async storage(record) {
    let storage;
    if (record.storageId) {
      try {
        storage = await this.call(`/admin/storage/get?id=${record.storageId}`);
      } catch (error) {
        // The upstream get endpoint uses code 500 for a missing DB record.
        if (!(error instanceof BridgeError) || ![404, 500].includes(error.code)) throw error;
        const found = (await this.list('storage')).find((item) => item.id === record.storageId);
        if (found) throw error;
        record.storageId = null;
        await this.save();
      }
    } else {
      storage = (await this.list('storage')).find((item) => item.mount_path === record.mountPath);
      if (storage) {
        record.storageId = storage.id;
        await this.save();
      }
    }
    if (storage && (storage.mount_path !== record.mountPath || storage.driver !== record.driver))
      throw new AppError('OpenList 挂载已在外部更改，请恢复原目录和驱动后重试。', 409);
    return storage;
  }
  view(record, storage) {
    const spec = MODES[record.type][record.mode];
    let addition = {};
    try {
      addition = JSON.parse(storage?.addition || '{}');
    } catch {
      /* Treat malformed upstream data as pending. */
    }
    const parameters = {},
      configuredSecrets = [];
    for (const key of spec.fields) {
      const value = addition[spec.keys?.[key] || key];
      if (isSecret(key)) {
        if (value) configuredSecrets.push(key);
      } else if (value !== undefined) parameters[key] = String(value);
    }
    let phase = 'error';
    if (storage && !storage.disabled && String(storage.status).toLowerCase() === 'work')
      phase = 'ready';
    if (record.type === 'openlist-guangya' && !addition.access_token && !addition.refresh_token)
      phase = addition.verification_id && !addition.send_code ? 'sms' : 'error';
    return {
      name: record.name,
      type: record.type,
      mode: record.mode,
      description: record.description || '',
      phase,
      smsSent: Boolean(addition.verification_id && !addition.send_code),
      parameters,
      configuredSecrets,
      storageId: record.storageId,
      capabilities: record.capabilities,
    };
  }
  async read(name) {
    const record = this.record(name);
    const view = this.view(record, await this.storage(record));
    record.phase = view.phase;
    await this.save();
    return view;
  }
  davUrl(record) {
    const c = this.state.openlist;
    return `${c.url}/dav/${record.mountPath.slice(c.namespace.length + 1)}/`;
  }
  assertConfig(record, config) {
    if (
      config &&
      (config.type !== 'webdav' ||
        config.url !== this.davUrl(record) ||
        config.user !== this.state.openlist.davUser)
    )
      throw new AppError('该名称的 rclone 配置已在外部更改，请恢复原连接后重试。', 409);
  }
  async rcloneRemote(record) {
    const c = this.state.openlist;
    const configs = await this.engine.call('config/dump');
    this.assertConfig(record, configs[record.name]);
    await this.backup();
    await this.engine.call(configs[record.name] ? 'config/update' : 'config/create', {
      name: record.name,
      type: 'webdav',
      parameters: {
        url: this.davUrl(record),
        vendor: 'other',
        user: c.davUser,
        pass: c.davPassword,
        description: record.description || '',
        pacer_min_sleep: '500ms',
      },
      opt: { nonInteractive: true, obscure: true },
    });
  }
  async rebind() {
    for (const record of Object.values(this.state.cloudRemotes))
      if (record.storageId) await this.rcloneRemote(record);
  }
  async write(input, name) {
    const existing = name ? this.record(name) : null;
    const type = existing?.type || input.type;
    const mode = existing?.mode || input.mode;
    if (existing && ((input.type && input.type !== type) || (input.mode && input.mode !== mode)))
      throw new AppError('已保存连接的登录方式不能更换，请新建连接。');
    const action = input.action || 'save';
    if (existing)
      this.assertConfig(existing, (await this.engine.call('config/dump'))[existing.name]);
    // Validate before connecting or persisting anything for a new remote.
    if (!existing) cloudParameters(type, mode, input.parameters, {}, action);
    const c = this.state.openlist;
    await this.ensureUser();
    const spec = MODES[type]?.[mode];
    if (!spec) throw new AppError('不支持的网盘登录方式。');
    const info = await this.call(`/admin/driver/info?driver=${encodeURIComponent(spec.driver)}`);
    const record = existing || {
      name: remoteName(input.name),
      type,
      mode,
      driver: spec.driver,
      mountPath: `${c.namespace}/${randomBytes(12).toString('hex')}`,
      phase: 'error',
    };
    const old = existing ? await this.storage(record) : null;
    let previous = {};
    try {
      previous = JSON.parse(old?.addition || '{}');
    } catch {
      throw new AppError('OpenList 存储字段无法读取，请检查服务数据。', 502);
    }
    const { addition } = cloudParameters(type, mode, input.parameters, previous, action);
    const description =
      input.description === undefined ? record.description || '' : input.description;
    if (typeof description !== 'string' || description.length > 1000)
      throw new AppError('备注不能超过 1000 个字符。');
    Object.assign(record, {
      description,
      capabilities: {
        upload: info?.config?.no_upload !== true,
        overwrite: type !== 'openlist-guangya',
      },
    });
    this.state.cloudRemotes[record.name] = record;
    await this.save();
    const payload = {
      ...(old || {}),
      driver: record.driver,
      mount_path: record.mountPath,
      addition: JSON.stringify(addition),
      remark: description,
      cache_expiration: 1,
      webdav_policy: 'native_proxy',
      disabled: false,
      enable_sign: false,
    };
    try {
      let stored;
      try {
        const result = await this.call(
          old ? '/admin/storage/update' : '/admin/storage/create',
          payload,
        );
        if (!old && Number.isSafeInteger(result?.id) && result.id > 0) record.storageId = result.id;
      } catch (error) {
        // An Init failure can occur after persistence, but a DB failure leaves old credentials.
        // Retain the upstream ID for repair and only accept an error after verifying the write.
        if (error instanceof BridgeError && error.storageId) record.storageId = error.storageId;
        await this.save();
        if (!(error instanceof BridgeError && error.code >= 500)) throw error;
        try {
          stored = await this.storage(record);
        } catch {
          throw error;
        }
        if (!storageWritePersisted(stored, payload, old, spec, action)) throw error;
      }
      await this.save();
      stored ||= await this.storage(record);
      if (!stored) throw new AppError('OpenList 尚未创建挂载，请重新保存连接。', 502);
      await this.rcloneRemote(record);
      const view = this.view(record, stored);
      record.phase = view.phase;
      if (action === 'send-code' && !view.smsSent) {
        record.phase = 'error';
        view.phase = 'error';
      }
      await this.save();
      return view;
    } catch (error) {
      record.phase = 'error';
      await this.save();
      throw error;
    }
  }
  remoteView(record) {
    return {
      name: record.name,
      type: record.type,
      mode: record.mode,
      phase: record.phase,
      backendType: 'webdav',
      description: record.description || '',
      parameters: {},
      configuredSecrets: [],
      managed: true,
      pending: record.phase === 'ready' ? null : { cloud: true },
      capabilities: record.capabilities,
    };
  }
  async remove(name) {
    const record = this.record(name);
    const configs = await this.engine.call('config/dump');
    this.assertConfig(record, configs[name]);
    const storage = await this.storage(record);
    if (storage) await this.call(`/admin/storage/delete?id=${storage.id}`, {});
    // A retry after deleting the upstream mount can still remove the local configuration.
    record.storageId = null;
    await this.save();
    if (configs[name]) {
      await this.backup();
      await this.engine.call('config/delete', { name });
    }
    delete this.state.cloudRemotes[name];
    await this.save();
  }
}
