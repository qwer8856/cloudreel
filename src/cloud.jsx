import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  ExternalLink,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { api, providerInfo } from './api.js';
import { Dialog, ProviderBadge, Spinner } from './components.jsx';
import './cloud.css';

const modes = {
  'openlist-115': [
    ['cookie', 'Cookie 登录'],
    ['oauth', '官方授权'],
  ],
  'openlist-guangya': [
    ['sms', '短信登录'],
    ['token', '已有令牌'],
  ],
  'openlist-123': [
    ['password', '账号密码'],
    ['developer', '开发者授权'],
  ],
};
const fields = {
  cookie: ['Cookie', '从已登录的 115 浏览器会话中获取 Cookie。'],
  access_token: ['Access Token', '粘贴授权工具返回的访问令牌。'],
  refresh_token: ['Refresh Token', '用于自动刷新登录；令牌由 OpenList 保存。'],
  username: ['手机号 / 账号', '填写你的 123 网盘账号。'],
  password: ['网盘密码', '在新设备上可能需要先完成 123 官网验证。'],
  client_id: ['Client ID', '光鸭需要有效的 API Client ID；123 使用你自己的开发者 Client ID。'],
  client_secret: ['Client Secret', '填写 123 开放平台提供的开发者密钥。'],
  phone_number: ['手机号', '例如 +86 13800000000。'],
  captcha_token: ['Captcha Token', '可选；服务要求人机验证时，填入验证得到的令牌。'],
  verify_code: ['短信验证码', '先发送短信，再填写收到的验证码。'],
  device_id: ['设备 ID', '可选，留空由 OpenList 自动生成。'],
  device_sign: ['设备签名', '可选，通常由 OpenList 自动生成。'],
  root_folder_id: ['根目录 ID', '根目录填写 0；指定目录时填写该文件夹的 ID。'],
  root_path: ['网盘根目录路径', '可选，留空为整个网盘；例如 media/movies。'],
};
const secret = (key) => /cookie|password|secret|token|verify_code|device_sign/.test(key);

export function OpenListSetup({ initial, onConnected }) {
  const [config, setConfig] = useState(initial || null);
  const [values, setValues] = useState({
    url: initial?.url || 'http://openlist:5244',
    username: initial?.username || 'admin',
    auth: initial?.tokenSaved ? 'token' : 'password',
    password: '',
    adminToken: '',
    otp: '',
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (initial) return;
    let active = true;
    api('/openlist')
      .then((data) => {
        if (!active) return;
        setConfig(data);
        setValues((old) => ({
          ...old,
          url: data.url || old.url,
          username: data.username || 'admin',
          auth: data.tokenSaved ? 'token' : 'password',
        }));
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [initial]);
  const change = (key, value) => setValues((old) => ({ ...old, [key]: value }));
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await api('/openlist', { method: 'PUT', body: values });
      setConfig(data);
      setValues((old) => ({ ...old, password: '', adminToken: '', otp: '' }));
      setMessage(`已连接，可用网盘驱动 ${data.drivers.length} 个`);
      onConnected?.(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="openlist-setup" onSubmit={submit}>
      <div className="cloud-section-heading">
        <Server size={20} />
        <div>
          <h3>OpenList 网盘服务</h3>
          <p>一次连接，为 115、光鸭和 123 提供统一的传输入口。</p>
        </div>
      </div>
      <div className="cloud-field-grid">
        <label className="field">
          <span>服务地址</span>
          <input
            aria-label="OpenList 服务地址"
            required
            type="url"
            value={values.url}
            disabled={config?.locked || busy}
            onChange={(e) => change('url', e.target.value)}
          />
          <small>Docker 配套服务使用 http://openlist:5244；其他实例填写服务器可访问的地址。</small>
        </label>
        <label className="field">
          <span>管理员授权方式</span>
          <select
            aria-label="OpenList 授权方式"
            value={values.auth}
            disabled={busy}
            onChange={(e) => change('auth', e.target.value)}
          >
            <option value="password">管理员账号密码</option>
            <option value="token">管理员 API Token</option>
          </select>
        </label>
        {values.auth === 'password' ? (
          <>
            <label className="field">
              <span>管理员用户名</span>
              <input
                aria-label="OpenList 管理员用户名"
                required
                autoComplete="off"
                value={values.username}
                onChange={(e) => change('username', e.target.value)}
              />
            </label>
            <label className="field">
              <span>管理员密码</span>
              <input
                aria-label="OpenList 管理员密码"
                required={!config?.passwordSaved}
                type="password"
                autoComplete="new-password"
                value={values.password}
                placeholder={
                  config?.passwordSaved
                    ? '已保存，留空保留'
                    : '部署时设置的 OPENLIST_ADMIN_PASSWORD'
                }
                onChange={(e) => change('password', e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                两步验证码 <small>可选</small>
              </span>
              <input
                aria-label="OpenList 两步验证码"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={values.otp}
                onChange={(e) => change('otp', e.target.value)}
              />
              <small>启用两步验证的实例可改用管理员 API Token，便于长期自动运行。</small>
            </label>
          </>
        ) : (
          <label className="field">
            <span>管理员 API Token</span>
            <input
              aria-label="OpenList API Token"
              type="password"
              autoComplete="new-password"
              required={!config?.tokenSaved}
              value={values.adminToken}
              placeholder={config?.tokenSaved ? '已保存，留空保留' : 'OpenList 管理后台中的 Token'}
              onChange={(e) => change('adminToken', e.target.value)}
            />
          </label>
        )}
      </div>
      <p className="cloud-help">
        保存时创建专用 WebDAV
        账号，权限仅限本面板的挂载目录。已有网盘使用此服务时，需先停用相关计划并停止任务才能修改授权。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="cloud-success" role="status">
          <Check size={16} />
          {message}
        </p>
      )}
      <div className="cloud-setup-actions">
        <a href="https://doc.oplist.org/guide/installation/docker" target="_blank" rel="noreferrer">
          OpenList 部署说明 <ExternalLink size={13} />
        </a>
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner /> : <Check size={16} />}保存并连接
        </button>
      </div>
    </form>
  );
}

export function CloudForm({ type, remote, onBack, onClose, onDone }) {
  const [current, setCurrent] = useState(remote || null);
  const [name, setName] = useState(remote?.name || '');
  const [mode, setMode] = useState(remote?.mode || modes[type][0][0]);
  const [values, setValues] = useState(type === 'openlist-guangya' ? {} : { root_folder_id: '0' });
  const [description, setDescription] = useState(remote?.description || '');
  const [service, setService] = useState(null),
    [setup, setSetup] = useState(false);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [advanced, setAdvanced] = useState(false);
  async function load() {
    setLoading(true);
    setError('');
    try {
      const service = await api('/openlist');
      setService(service);
      setSetup(!service.configured);
      if (remote) {
        const data = await api(`/cloud-remotes/${encodeURIComponent(remote.name)}`);
        setCurrent(data);
        setMode(data.mode);
        setValues(data.parameters);
        setDescription(data.description);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  const keys =
    type === 'openlist-115'
      ? mode === 'cookie'
        ? ['cookie']
        : ['access_token', 'refresh_token']
      : type === 'openlist-123'
        ? mode === 'password'
          ? ['username', 'password']
          : ['client_id', 'client_secret']
        : mode === 'sms'
          ? ['client_id', 'phone_number', 'captcha_token', 'verify_code']
          : ['client_id', 'access_token', 'refresh_token'];
  const required =
    type === 'openlist-115'
      ? keys
      : type === 'openlist-123'
        ? keys
        : mode === 'sms'
          ? ['client_id', 'phone_number']
          : ['client_id', 'refresh_token'];
  function field(key) {
    const saved = current?.configuredSecrets?.includes(key);
    return (
      <label className="field" key={key}>
        <span>
          {fields[key][0]}
          {required.includes(key) && !saved && <em>*</em>}
        </span>
        <input
          aria-label={fields[key][0]}
          type={secret(key) ? 'password' : 'text'}
          autoComplete={key === 'verify_code' ? 'one-time-code' : 'off'}
          spellCheck="false"
          maxLength={65536}
          required={required.includes(key) && !saved}
          value={values[key] || ''}
          placeholder={saved ? '已保存，留空保留' : key === 'root_folder_id' ? '0' : '请输入'}
          onChange={(e) => setValues((old) => ({ ...old, [key]: e.target.value }))}
        />
        <small>{fields[key][1]}</small>
      </label>
    );
  }
  async function write(action) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const extra =
        type === 'openlist-guangya'
          ? ['root_path', 'device_id', 'device_sign']
          : ['root_folder_id'];
      const data = await api(
        current ? `/cloud-remotes/${encodeURIComponent(name)}` : '/cloud-remotes',
        {
          method: current ? 'PUT' : 'POST',
          body: {
            name,
            type,
            mode,
            description,
            parameters: Object.fromEntries(
              Object.entries(values).filter(([key]) => [...keys, ...extra].includes(key)),
            ),
            action,
          },
        },
      );
      setCurrent(data);
      setValues(data.parameters);
      if (data.phase === 'ready') onDone('网盘已连接，可创建互传或每日计划');
      else if (action === 'send-code' && data.smsSent)
        setMessage('短信已发送，请填写验证码，再点击完成登录。');
      else
        setError(
          action === 'send-code'
            ? '短信未发送成功，请检查 Client ID、手机号和人机验证令牌。连接已保留，可重新发送。'
            : '连接已保存，但网盘登录未完成。请检查凭据；123 新设备可能需要先在官网完成验证。',
        );
    } catch (e) {
      setError(e.message);
      if (!current && e.status >= 500) {
        try {
          const saved = await api(`/cloud-remotes/${encodeURIComponent(name)}`);
          setCurrent(saved);
        } catch {
          /* Keep original actionable error. */
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      wide
      title={remote ? '编辑网盘连接' : '连接新的存储'}
      subtitle="登录网盘，再把文件送到你需要的地方。"
      onClose={busy ? () => {} : onClose}
    >
      <div className="modal-body cloud-modal">
        <div className="selected-provider">
          <ProviderBadge type={type} />
          <div>
            <strong>{providerInfo(type).title}</strong>
            <small>支持文件浏览、网盘互传和每日计划</small>
          </div>
          {!current && (
            <button className="text-button" disabled={busy} onClick={onBack}>
              <ArrowLeft size={14} />
              更换类型
            </button>
          )}
        </div>
        {loading ? (
          <p className="cloud-loading">
            <Spinner />
            正在读取连接设置…
          </p>
        ) : (
          <>
            {setup ? (
              <OpenListSetup
                initial={service}
                onConnected={(data) => {
                  setService(data);
                  setSetup(false);
                }}
              />
            ) : (
              <div className="cloud-service-row">
                <span>
                  <Server size={16} />
                  OpenList 服务已配置
                </span>
                <button className="text-button" disabled={busy} onClick={() => setSetup(true)}>
                  连接设置
                </button>
              </div>
            )}
            {!setup && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  write('save');
                }}
              >
                <label className="field">
                  <span>
                    存储名称<em>*</em>
                  </span>
                  <input
                    aria-label="存储名称"
                    required
                    pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}"
                    maxLength={64}
                    value={name}
                    disabled={Boolean(current)}
                    placeholder="例如 pan-115"
                    onChange={(e) => setName(e.target.value)}
                  />
                  <small>支持英文、数字、下划线和连字符。</small>
                </label>
                <div className="cloud-login-tabs" role="group" aria-label="网盘登录方式">
                  {modes[type].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={mode === value}
                      className={mode === value ? 'selected' : ''}
                      disabled={Boolean(current) || busy}
                      onClick={() => {
                        setMode(value);
                        setValues(type === 'openlist-guangya' ? {} : { root_folder_id: '0' });
                        setError('');
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {type === 'openlist-115' && (
                  <p className="cloud-auth-help">
                    {mode === 'oauth' ? (
                      <>
                        在授权工具中选择“115 验证网盘”，完成授权后粘贴两种令牌。
                        <a href="https://api.oplist.org" target="_blank" rel="noreferrer">
                          打开授权工具 <ExternalLink size={13} />
                        </a>
                      </>
                    ) : (
                      <>
                        使用已登录会话的 Cookie，失效时更新即可。
                        <a
                          href="https://doc.oplist.org/guide/drivers/115"
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看 Cookie 获取说明 <ExternalLink size={13} />
                        </a>
                      </>
                    )}
                  </p>
                )}
                {type === 'openlist-123' && mode === 'developer' && (
                  <p className="cloud-auth-help">
                    使用你自己的开放平台密钥，OpenList 自动获取令牌。
                    <a href="https://www.123pan.com/developer" target="_blank" rel="noreferrer">
                      打开开发者平台 <ExternalLink size={13} />
                    </a>
                  </p>
                )}
                <div className="cloud-field-grid">
                  {keys.filter((key) => key !== 'verify_code').map(field)}
                </div>
                {type === 'openlist-guangya' && mode === 'sms' && (
                  <div className="cloud-sms-step">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !name || !values.client_id || !values.phone_number}
                      onClick={() => write('send-code')}
                    >
                      {busy ? <Spinner /> : <RefreshCw size={15} />}
                      {current?.smsSent ? '重新发送短信' : '发送短信验证码'}
                    </button>
                    {field('verify_code')}
                  </div>
                )}
                <div className="cloud-field-grid">
                  {field(type === 'openlist-guangya' ? 'root_path' : 'root_folder_id')}
                  <label className="field">
                    <span>
                      备注 <small>可选</small>
                    </span>
                    <input
                      aria-label="网盘备注"
                      maxLength={1000}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </label>
                </div>
                {type === 'openlist-guangya' && (
                  <>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={advanced}
                        onChange={(e) => setAdvanced(e.target.checked)}
                      />
                      <span>自定义设备参数</span>
                    </label>
                    {advanced && (
                      <div className="cloud-field-grid">
                        {['device_id', 'device_sign'].map(field)}
                      </div>
                    )}
                  </>
                )}
                <div className="callout">
                  <ArrowLeftRight size={18} />
                  <p>
                    网盘互传经由部署服务器读取和上传，会占用服务器带宽。
                    {type === 'openlist-guangya'
                      ? '光鸭作为目标时只复制新文件，已有同名文件会跳过。'
                      : '目标网盘需要具备上传权限。'}
                  </p>
                </div>
                <div className="secure-note">
                  <ShieldCheck size={14} />
                  已保存的 Cookie、密码和令牌不会回填，留空保留。
                </div>
                {message && (
                  <p className="cloud-success" role="status">
                    <Check size={16} />
                    {message}
                  </p>
                )}
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="cloud-form-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={onClose}
                  >
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      (type === 'openlist-guangya' &&
                        mode === 'sms' &&
                        current?.phase !== 'ready' &&
                        !values.verify_code)
                    }
                  >
                    {busy ? <Spinner /> : <Check size={16} />}
                    {type === 'openlist-guangya' && mode === 'sms' && current?.phase !== 'ready'
                      ? '完成登录'
                      : '保存并登录'}
                  </button>
                </div>
              </form>
            )}
            {setup && error && (
              <p className="form-error" role="alert">
                {error}
                <button className="text-button" onClick={load}>
                  重新读取
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

export function TransferHint({ remotes, source, destination }) {
  const target = remotes.find((item) => item.name === destination.remote);
  const origin = remotes.find((item) => item.name === source.remote);
  const throughServer =
    source.remote !== 'local' &&
    destination.remote !== 'local' &&
    origin?.type !== 'local' &&
    target?.type !== 'local';
  if (!throughServer && target?.capabilities?.overwrite !== false) return null;
  return (
    <div className="callout cloud-transfer-hint">
      <ArrowLeftRight size={18} />
      <p>
        {throughServer &&
          '网盘互传会经由部署服务器读取和上传，占用服务器带宽，可在运行设置中限速。'}
        {target?.capabilities?.overwrite === false &&
          ' 光鸭作为目标时请选择复制；已有同名文件自动跳过。'}
      </p>
    </div>
  );
}
