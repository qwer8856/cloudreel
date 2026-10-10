import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, PlugZap } from 'lucide-react';
import { api } from './api.js';
import { Dialog, ProviderBadge, Spinner } from './components.jsx';

export function Cd2Form({ remote, onBack, onClose, onDone }) {
  const [form, setForm] = useState({
    name: remote?.name || '115-cd2',
    url: remote?.url || '',
    rootPath: remote?.rootPath || '',
    username: remote?.username || '',
    anonymous: remote?.anonymous || false,
    password: '',
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tested, setTested] = useState(null);
  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setTested(null);
    setError('');
  };
  async function run(action) {
    setBusy(action);
    setError('');
    try {
      const route = remote ? `/cd2/${encodeURIComponent(remote.name)}` : '/cd2';
      const result = await api(action === 'test' ? `${route}/test` : route, {
        method: action === 'test' || !remote ? 'POST' : 'PUT',
        body: form,
      });
      if (action === 'test') setTested(result);
      else onDone('CD2 WebDAV 来源已保存，可在影视传输中选择 Google group');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  return (
    <Dialog
      wide
      title={remote ? '编辑 CD2 WebDAV 来源' : '连接 CD2 WebDAV 来源'}
      subtitle="115 → CD2 WebDAV → CloudReel → Google Drive group"
      onClose={busy ? () => {} : onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run('save');
        }}
      >
        <div className="modal-body cloud-modal">
          <div className="selected-provider">
            <ProviderBadge type="cd2-webdav" />
            <div>
              <strong>CloudDrive2 · 只读来源</strong>
              <small>115 授权由 CD2 管理，Google 上传与额度切换由 CloudReel 管理。</small>
            </div>
          </div>
          <p className="cloud-help">
            先在 CD2 中登录 115 并开启 WebDAV。这里填写 CD2 账号或独立 WebDAV 用户，不是 115 的
            CK。保存后可浏览目录，再选择 Google Drive group 作为传输目标。
          </p>
          <div className="cloud-field-grid">
            <label className="field">
              <span>连接名称</span>
              <input
                required
                disabled={Boolean(remote) || Boolean(busy)}
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
              />
            </label>
            <label className="field">
              <span>WebDAV 服务地址</span>
              <input
                required
                type="url"
                aria-label="WebDAV 服务地址"
                placeholder="http://服务器IP:19798/dav/"
                value={form.url}
                disabled={Boolean(busy)}
                onChange={(event) => update('url', event.target.value)}
              />
              <small>
                填写 CloudReel 容器能访问的地址。同一台服务器的不同容器不能使用 127.0.0.1 互相连接。
              </small>
            </label>
          </div>
          <label className="field">
            <span>CD2 来源根目录（可选）</span>
            <input
              placeholder="例如：115/电影，留空为 WebDAV 根目录"
              aria-label="CD2 来源根目录（可选）"
              value={form.rootPath}
              disabled={Boolean(busy)}
              onChange={(event) => update('rootPath', event.target.value)}
            />
            <small>
              填写 CD2 中显示的目录名称，使用 / 分隔，填写原文字即可，无需 ID 或 URL 编码。若 WebDAV
              用户已限定到 115 根目录，此处可留空。
            </small>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.anonymous}
              disabled={Boolean(busy)}
              onChange={(event) => update('anonymous', event.target.checked)}
            />
            使用 CD2 已开启的匿名访问
          </label>
          {!form.anonymous && (
            <div className="cloud-field-grid">
              <label className="field">
                <span>WebDAV 用户名</span>
                <input
                  required
                  autoComplete="off"
                  value={form.username}
                  disabled={Boolean(busy)}
                  onChange={(event) => update('username', event.target.value)}
                  placeholder="CD2 登录邮箱或独立 WebDAV 用户名"
                />
              </label>
              <label className="field">
                <span>WebDAV 密码</span>
                <input
                  type="password"
                  aria-label="WebDAV 密码"
                  required={!remote?.passwordConfigured}
                  autoComplete="new-password"
                  value={form.password}
                  disabled={Boolean(busy)}
                  onChange={(event) => update('password', event.target.value)}
                  placeholder={
                    remote?.passwordConfigured
                      ? '已保存，留空保留原密码'
                      : 'CD2 或 WebDAV 用户的密码'
                  }
                />
                <small>密码保存在服务器配置中，不会回传到网页。</small>
              </label>
            </div>
          )}
          <div className="ops-toolbar">
            <button
              type="button"
              className="button secondary"
              disabled={Boolean(busy) || !form.url}
              onClick={() => run('test')}
            >
              {busy === 'test' ? <Spinner /> : <PlugZap size={16} />}测试连接
            </button>
            {tested && (
              <span className="cd2-test-success" role="status">
                <CheckCircle2 size={16} />
                目录可读取 · {tested.latency} ms
              </span>
            )}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <p className="cloud-help">
            传输时通过 WebDAV 读取 115，直接上传至 Google。无需在 CloudReel 挂载 CD2
            本地磁盘，也无需把 Google 连接到 CD2。
            <a href="https://www.clouddrive2.com/en/features.html" target="_blank" rel="noreferrer">
              CD2 WebDAV 说明
            </a>
          </p>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={Boolean(busy)}
            onClick={onBack || onClose}
          >
            <ArrowLeft size={15} />
            {onBack ? '返回' : '取消'}
          </button>
          <button type="submit" className="button primary" disabled={Boolean(busy)}>
            {busy === 'save' && <Spinner />}保存连接
          </button>
        </div>
      </form>
    </Dialog>
  );
}
