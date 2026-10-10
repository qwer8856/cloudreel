import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  Cloud,
  FolderOpen,
  LoaderCircle,
  Plus,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api, bytes, time, providerInfo } from './api.js';
import { ProviderIcon, providerIconInfo } from './provider-icons.jsx';
import { TransferControls, emptyTransferOptions } from './transfer-controls.jsx';
import { CloudForm, TransferHint } from './cloud.jsx';
import { Login115Form, DriveGroupForm } from './connections.jsx';
import { Cd2Form } from './cd2.jsx';

export function Logo({ compact = false }) {
  return (
    <div className="brand">
      <span className="brand-icon">
        <ArrowLeftRight size={22} strokeWidth={2.4} />
      </span>
      {!compact && (
        <span>
          Cloud<span className="brand-studio">Reel</span>
        </span>
      )}
    </div>
  );
}
export function ProviderBadge({ type, small = false }) {
  const info = providerIconInfo(type);
  return (
    <span
      className={`provider-badge ${small ? 'small' : ''}`}
      style={{ color: info.color, backgroundColor: `${info.color}14` }}
      data-provider={type}
    >
      <ProviderIcon type={type} />
    </span>
  );
}
export function Empty({ icon: Icon = Cloud, title, text, action, compact = false }) {
  return (
    <div className={`empty ${compact ? 'compact' : ''}`}>
      <span className="empty-icon">
        <Icon size={28} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Spinner() {
  return <LoaderCircle className="spin" size={17} />;
}
export function Badge({ status, dryRun }) {
  const labels = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
    interrupted: '已中断',
    limited: '已达限制',
    queued: '排队中',
    retry_wait: '等待重试',
    waiting_quota: '等待额度恢复',
    blocked: '等待重新授权',
    paused: '已暂停',
  };
  return (
    <span className={`status-badge ${status}`}>
      <i />
      {labels[status] || status}
      {dryRun ? ' · 预演' : ''}
    </span>
  );
}
export function JobTable({ jobs, onStop, onDetails, compact = false }) {
  if (!jobs.length)
    return (
      <Empty
        compact
        icon={ArrowLeftRight}
        title="传输任务从这里开始"
        text="在存储之间复制文件，或先预演一次同步。"
      />
    );
  return (
    <div className="table-scroll">
      <table className="job-table">
        <thead>
          <tr>
            <th>任务 / 路径</th>
            <th>状态</th>
            <th>传输进度</th>
            {!compact && <th>创建时间</th>}
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const progress =
              job.status === 'completed'
                ? 100
                : Math.min(
                    100,
                    job.stats?.totalBytes
                      ? ((job.stats.completedBytes ?? job.stats.bytes) / job.stats.totalBytes) * 100
                      : 0,
                  );
            return (
              <tr key={job.id}>
                <td>
                  <div className="job-name">
                    <span className="table-icon">
                      <ArrowLeftRight size={16} />
                    </span>
                    <div>
                      {onDetails ? (
                        <button className="text-button" onClick={() => onDetails(job)}>
                          <strong>{job.name}</strong>
                        </button>
                      ) : (
                        <strong>{job.name}</strong>
                      )}
                      <small
                        title={`${job.source.remote}:${job.source.path} → ${job.destination.remote}:${job.destination.path}`}
                      >
                        {job.source.remote}:{job.source.path || '/'} <ArrowRight size={11} />{' '}
                        {job.destination.remote}:{job.destination.path || '/'}
                      </small>
                      {job.error && (
                        <small className="error-text" title={job.error}>
                          {job.error}
                        </small>
                      )}
                      {job.waitReason && <small className="muted">{job.waitReason}</small>}
                      {job.targetRemote && job.targetRemote !== job.destination.remote && (
                        <small className="muted">上传账号：{job.targetRemote}</small>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  <Badge status={job.status} dryRun={job.dryRun} />
                  {job.stats?.conflicts > 0 && (
                    <small className="error-text">{job.stats.conflicts} 个同名冲突</small>
                  )}
                </td>
                <td>
                  <div className="progress-track">
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <small className="muted">
                    {job.dryRun ? '预演模式' : bytes(job.transferredBytes || job.stats?.bytes)}
                    {job.status === 'running' && ` · ${bytes(job.stats?.speed)}/s`}
                  </small>
                </td>
                {!compact && <td className="muted nowrap">{time(job.createdAt)}</td>}
                <td>
                  <div className="job-actions">
                    {onDetails && (
                      <button className="text-button" onClick={() => onDetails(job)}>
                        详情
                      </button>
                    )}
                    {job.status === 'running' && (
                      <button
                        className="text-button danger"
                        disabled={job.stopping}
                        onClick={() => onStop(job)}
                      >
                        {job.stopping ? '停止中' : '停止'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Dialog({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector('input, select, textarea, button')?.focus();
    const handler = (event) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const nodes = [
          ...ref.current.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
          ),
        ].filter((node) => node.getClientRects().length);
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header className="modal-header">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

const labels = {
  url: '服务器地址',
  vendor: '服务类型',
  user: '用户名',
  pass: '密码',
  host: '服务器主机',
  port: '端口',
  provider: 'S3 服务商',
  env_auth: '使用环境凭据',
  access_key_id: 'Access Key ID',
  secret_access_key: 'Secret Access Key',
  region: '区域',
  endpoint: '自定义 Endpoint',
  acl: '访问控制',
  location_constraint: '存储桶区域',
  storage_class: '存储类型',
  client_id: 'OAuth Client ID',
  client_secret: 'OAuth Client Secret',
  token: 'OAuth Token',
  scope: '授权范围',
  key_file: '私钥文件路径',
  key_pem: '私钥内容（PEM）',
  key_file_pass: '私钥密码',
  remote: '指向的存储或路径',
  bearer_token: 'Bearer Token',
  description: '备注',
  service_account_file: '服务账号文件',
  nounc: '禁用 Windows 长路径转换',
};

function applies(rule, provider) {
  if (!rule || !provider) return true;
  const values = rule.replace(/^!/, '').split(',');
  return rule.startsWith('!') ? !values.includes(provider) : values.includes(provider);
}
function OptionField({ option, value, onChange, saved = false, provider }) {
  const examples = (option.examples || []).filter((example) => applies(example.provider, provider));
  const label = labels[option.name] || option.name;
  const placeholder = saved
    ? '已保存，留空保留原值'
    : option.default
      ? `默认：${option.default}`
      : option.name === 'url'
        ? 'https://dav.example.com/dav/'
        : option.name === 'endpoint'
          ? 'https://s3.example.com'
          : '请输入';
  return (
    <label className="field">
      <span>
        {label}
        {option.required && !saved && <em>*</em>}
        <code>{option.name}</code>
      </span>
      {option.type === 'bool' ? (
        <select value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
          <option value="">{saved ? '保留原值' : `默认：${option.default || 'false'}`}</option>
          <option value="true">是 / true</option>
          <option value="false">否 / false</option>
        </select>
      ) : option.exclusive && examples.length ? (
        <select
          value={value ?? ''}
          required={option.required && !saved}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {examples.map((example) => (
            <option value={example.value} key={example.value}>
              {example.value}
              {example.help ? ` · ${example.help.split('\n')[0].slice(0, 55)}` : ''}
            </option>
          ))}
        </select>
      ) : /token|key_pem|credentials/.test(option.name) ? (
        <textarea
          rows={3}
          value={value ?? ''}
          placeholder={placeholder}
          required={option.required && !saved}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck="false"
        />
      ) : (
        <>
          <input
            type={option.password ? 'password' : 'text'}
            value={value ?? ''}
            placeholder={placeholder}
            required={option.required && !saved}
            list={!option.password && examples.length ? `options-${option.name}` : undefined}
            onChange={(event) => onChange(event.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
          {!option.password && examples.length > 0 && (
            <datalist id={`options-${option.name}`}>
              {examples.map((example) => (
                <option key={example.value} value={example.value}>
                  {example.help}
                </option>
              ))}
            </datalist>
          )}
        </>
      )}
      {option.help && (
        <details className="field-help">
          <summary>字段说明</summary>
          <p>{option.help}</p>
        </details>
      )}
    </label>
  );
}

export function RemoteForm({ providers, remote, initialType, onDone, onClose }) {
  const [type, setType] = useState(remote?.type || initialType || '');
  const [step, setStep] = useState(remote || initialType ? 'fields' : 'provider');
  const [name, setName] = useState(remote?.name || '');
  const [values, setValues] = useState(remote?.parameters || {});
  const [advanced, setAdvanced] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(remote?.pending || null);
  const [answer, setAnswer] = useState('');
  const [created, setCreated] = useState(Boolean(remote));
  const provider = providers.find((item) => item.name === type);
  const popular = [
    'openlist-115',
    'cd2-webdav',
    'drive',
    'drive-group',
    'openlist-guangya',
    'openlist-123',
    'webdav',
    's3',
    'sftp',
    'onedrive',
    'local',
  ];
  const list = [...providers].sort(
    (a, b) =>
      (popular.indexOf(a.name) < 0 ? 100 : popular.indexOf(a.name)) -
        (popular.indexOf(b.name) < 0 ? 100 : popular.indexOf(b.name)) ||
      a.name.localeCompare(b.name),
  );
  const fields = (provider?.options || []).filter(
    (option) =>
      (advanced || !option.advanced) &&
      option.name !== 'description' &&
      applies(option.provider, values.provider),
  );
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result;
      if (pending)
        result = await api(`/remotes/${encodeURIComponent(name)}/continue`, {
          method: 'POST',
          body: {
            result:
              answer ||
              (pending.option.name === 'config_is_local' ? 'false' : pending.option.default),
          },
        });
      else {
        const parameters = Object.fromEntries(
          Object.entries(values).filter(
            ([key, value]) => !((remote?.configuredSecrets || []).includes(key) && value === ''),
          ),
        );
        result = await api(created ? `/remotes/${encodeURIComponent(name)}` : '/remotes', {
          method: created ? 'PUT' : 'POST',
          body: { name, type, parameters },
        });
        setCreated(true);
      }
      if (result.pending) {
        setPending(result.pending);
        setAnswer('');
      } else onDone('存储配置已保存');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  if (step === 'fields' && ['openlist-115', 'direct-115'].includes(type))
    return (
      <Login115Form
        remote={remote}
        onBack={() => setStep('provider')}
        onClose={onClose}
        onDone={onDone}
      />
    );
  if (step === 'fields' && type === 'drive-group')
    return <DriveGroupForm remote={remote} onClose={onClose} onDone={onDone} />;
  if (step === 'fields' && type === 'cd2-webdav')
    return (
      <Cd2Form
        remote={remote}
        onBack={remote ? undefined : () => setStep('provider')}
        onClose={onClose}
        onDone={onDone}
      />
    );
  if (step === 'fields' && type.startsWith('openlist-'))
    return (
      <CloudForm
        type={type}
        remote={remote}
        onBack={() => setStep('provider')}
        onClose={onClose}
        onDone={onDone}
      />
    );
  return (
    <Dialog
      wide
      title={remote ? '编辑存储' : '连接新的存储'}
      subtitle="让不同的存储，在同一个地方协作。"
      onClose={busy ? () => {} : onClose}
    >
      <div className="steps">
        <span className={step === 'provider' ? 'active' : 'done'}>
          <b>{step === 'fields' ? <Check size={12} /> : '1'}</b>选择存储类型
        </span>
        <i />
        <span className={step === 'fields' ? 'active' : ''}>
          <b>2</b>配置连接
        </span>
      </div>
      {step === 'provider' ? (
        <div className="modal-body">
          <p className="cloud-help">
            Google Drive、OneDrive、WebDAV、S3 等可直接连接。115 可选择直接扫码、CK 或
            OpenList；也可通过 CD2 WebDAV 读取已在 CD2 登录的 115。光鸭和 123 需要
            OpenList，已有其他网盘服务可选择 WebDAV。
          </p>
          <div className="search-box">
            <Search size={17} />
            <input
              aria-label="搜索存储类型"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`搜索 ${providers.length} 种存储类型…`}
            />
          </div>
          <div className="provider-grid">
            {list
              .filter((item) =>
                `${item.name} ${item.description} ${providerInfo(item.name).title}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((item) => (
                <button
                  className="provider-choice"
                  key={item.name}
                  onClick={() => {
                    setType(item.name);
                    setStep('fields');
                    setValues(item.name === 's3' ? { provider: 'AWS' } : {});
                  }}
                >
                  <ProviderBadge type={item.name} />
                  <strong>{providerInfo(item.name).title}</strong>
                  <small>
                    {popular.includes(item.name)
                      ? providerInfo(item.name).subtitle
                      : item.description}
                  </small>
                  <ArrowRight size={15} className="choice-arrow" />
                </button>
              ))}
          </div>
          {!list.some((item) =>
            `${item.name} ${item.description} ${providerInfo(item.name).title}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          ) && <p className="muted">没有找到匹配的存储类型。</p>}
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="selected-provider">
              <ProviderBadge type={type} />
              <div>
                <strong>{providerInfo(type).title}</strong>
                <small>{provider?.description}</small>
              </div>
              {!created && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setStep('provider');
                    setValues({});
                  }}
                >
                  更换类型
                </button>
              )}
            </div>
            {pending ? (
              <div className="authorization">
                <div className="callout">
                  <ShieldCheck size={19} />
                  <div>
                    <strong>继续完成存储授权</strong>
                    <p>服务器使用远程授权模式。按下方 rclone 说明操作，再提交结果。</p>
                  </div>
                </div>
                {pending.error && <p className="form-error">{pending.error}</p>}
                <pre className="authorization-help">{pending.option.help}</pre>
                {pending.option.name === 'config_is_local' ? (
                  <p className="muted">将使用远程授权（false）。点击继续获取授权步骤。</p>
                ) : (
                  <OptionField option={pending.option} value={answer} onChange={setAnswer} />
                )}
              </div>
            ) : (
              <>
                <label className="field">
                  <span>
                    存储名称<em>*</em>
                  </span>
                  <input
                    aria-label="存储名称"
                    placeholder="例如：my-cloud"
                    pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}"
                    maxLength={64}
                    required
                    value={name}
                    disabled={created}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <small>在任务和文件浏览中使用，支持英文、数字、下划线和连字符。</small>
                </label>
                {type === 'local' && (
                  <div className="callout">
                    <FolderOpen size={18} />
                    <p>
                      本地存储连接服务器的 LOCAL_ROOT 目录。在 Docker 中，默认对应 /data/files。
                    </p>
                  </div>
                )}
                <div className="form-fields">
                  {fields.map((option) => (
                    <OptionField
                      key={option.name}
                      option={option}
                      provider={values.provider}
                      value={values[option.name]}
                      saved={remote?.configuredSecrets?.includes(option.name)}
                      onChange={(value) =>
                        setValues((previous) => ({ ...previous, [option.name]: value }))
                      }
                    />
                  ))}
                </div>
                <label className="field">
                  <span>
                    备注<small>可选</small>
                  </span>
                  <input
                    placeholder="例如：家庭影音库 / 每日备份"
                    value={values.description || ''}
                    onChange={(event) =>
                      setValues((previous) => ({ ...previous, description: event.target.value }))
                    }
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={advanced}
                    onChange={(event) => setAdvanced(event.target.checked)}
                  />
                  <span>显示高级配置</span>
                  <small>
                    {provider?.options.filter((option) => option.advanced).length || 0} 个字段
                  </small>
                </label>
                <div className="secure-note">
                  <ShieldCheck size={14} />
                  已保存的密码不会回填，留空即可保留。
                </div>
              </>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-footer">
            <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button className="button primary" disabled={busy || !provider}>
              {busy ? <Spinner /> : pending ? <ArrowRight size={16} /> : <Check size={16} />}
              {pending ? '继续授权' : '保存存储'}
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}

export function JobForm({ remotes, source: initialSource, onClose, onDone }) {
  const [transferOptions, setTransferOptions] = useState(emptyTransferOptions);
  const [name, setName] = useState('');
  const [mode, setMode] = useState('copy');
  useEffect(() => {
    if (mode === 'sync')
      setTransferOptions((previous) =>
        previous.selections.length ? { ...previous, selections: [] } : previous,
      );
  }, [mode]);
  const [source, setSource] = useState(initialSource || { remote: 'local', path: '' });
  const [destination, setDestination] = useState({
    remote:
      remotes.find(
        (item) =>
          !item.pending &&
          item.capabilities?.upload !== false &&
          item.name !== initialSource?.remote,
      )?.name || 'local',
    path: '',
  });
  const [dryRun, setDryRun] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const storageOptions = [
    { name: 'local', label: '本地文件目录' },
    ...remotes
      .filter((item) => !item.pending)
      .map((item) => ({
        name: item.name,
        upload: item.capabilities?.upload !== false,
        label: `${item.accountLabel || item.name} · ${providerInfo(item.type).title}`,
      })),
  ];
  function endpoint(value, setter, label) {
    return (
      <div className="endpoint-fields">
        <h3>{label}</h3>
        <label className="field">
          <span>存储</span>
          <select
            aria-label={`${label}存储`}
            value={value.remote}
            onChange={(event) => {
              setter({ ...value, remote: event.target.value, path: '' });
              if (label === '源目录')
                setTransferOptions((previous) => ({ ...previous, selections: [] }));
            }}
          >
            {storageOptions
              .filter((item) => label === '源目录' || item.upload !== false)
              .map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>{label}路径（可自定义）</span>
          <input
            aria-label={`${label}路径`}
            placeholder={
              label === '源目录'
                ? '例如：电影/科幻，留空为根目录'
                : '例如：115备份/科幻，留空为根目录'
            }
            value={value.path}
            onChange={(event) => {
              setter({ ...value, path: event.target.value });
              if (label === '源目录')
                setTransferOptions((previous) => ({ ...previous, selections: [] }));
            }}
          />
          <small>
            {label === '源目录'
              ? '填写要读取的文件夹，或点击下方“浏览源目录”选择。'
              : '填写要写入的文件夹，或浏览选择、新建目标目录。'}
            路径相对于所选存储根目录，使用 / 分隔。
          </small>
        </label>
      </div>
    );
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/jobs', {
        method: 'POST',
        body: {
          name,
          mode,
          source,
          destination,
          dryRun,
          confirmDelete: confirmed,
          ...transferOptions,
        },
      });
      onDone(dryRun ? '预演任务已保存' : '传输任务已保存到队列');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      wide
      title="新建传输任务"
      subtitle="选择起点和终点，剩下的交给 rclone。"
      onClose={busy ? () => {} : onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <label className="field">
            <span>
              任务名称<small>可选</small>
            </span>
            <input
              placeholder="例如：影音库备份"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="mode-grid">
            <button
              type="button"
              className={`mode-choice ${mode === 'copy' ? 'selected' : ''}`}
              onClick={() => {
                setMode('copy');
                setConfirmed(false);
              }}
            >
              <span>
                <Plus size={18} />
                复制<small>推荐</small>
              </span>
              <p>复制新增与更新文件，保留目标其他文件。</p>
            </button>
            <button
              type="button"
              className={`mode-choice ${mode === 'sync' ? 'selected' : ''}`}
              onClick={() => {
                setMode('sync');
                setDryRun(true);
                setConfirmed(false);
              }}
            >
              <span>
                <ArrowLeftRight size={18} />
                同步
              </span>
              <p>使目标与源目录一致，删除目标多余文件。</p>
            </button>
          </div>
          <div className="endpoint-grid">
            {endpoint(source, setSource, '源目录')}
            <span className="endpoint-arrow">
              <ArrowRight size={22} />
            </span>
            {endpoint(destination, setDestination, '目标目录')}
          </div>
          <TransferHint remotes={remotes} source={source} destination={destination} />
          <TransferControls
            source={source}
            destination={destination}
            setSource={(value) => {
              setSource(value);
              setTransferOptions((previous) => ({ ...previous, selections: [] }));
            }}
            setDestination={setDestination}
            value={transferOptions}
            onChange={setTransferOptions}
            mode={mode}
          />
          <label className="toggle-row">
            <div>
              <strong>先预演一次</strong>
              <small>检查将执行的操作，预演不会修改文件。</small>
            </div>
            <input
              type="checkbox"
              role="switch"
              checked={dryRun}
              onChange={(event) => setDryRun(event.target.checked)}
            />
          </label>
          {mode === 'sync' && !dryRun && (
            <label className="checkbox warning">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我已确认目标目录，同意删除目标中源目录没有的文件。</span>
            </label>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || (mode === 'sync' && !dryRun && !confirmed)}
          >
            {busy ? <Spinner /> : <ArrowRight size={16} />}
            {dryRun ? '启动预演' : '开始传输'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({ title, text, action, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog title={title} onClose={busy ? () => {} : onClose}>
      <div className="modal-body">
        <p className="confirm-text">{text}</p>
        {error && <p className="form-error">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="button danger-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } catch (error) {
              setError(error.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />}
          {action}
        </button>
      </footer>
    </Dialog>
  );
}
