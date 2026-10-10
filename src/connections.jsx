import React, { useEffect, useState } from 'react';
import { api, time } from './api.js';
import { Dialog, Spinner } from './components.jsx';
import { CloudForm } from './cloud.jsx';
import { Cd2Form } from './cd2.jsx';

export function Login115Form({ remote, onBack, onClose, onDone }) {
  const [choice, setChoice] = useState(
    remote?.type === 'openlist-115' ? 'openlist' : remote?.loginMode || 'qr',
  );
  const [name, setName] = useState(remote?.name || '');
  const [rootId, setRootId] = useState(remote?.parameters?.root_folder_id || '0');
  const [cookie, setCookie] = useState('');
  const [device, setDevice] = useState('web');
  const [qr, setQr] = useState(null),
    [qrStatus, setQrStatus] = useState(0);
  const [qrLoading, setQrLoading] = useState(false),
    [qrImageStatus, setQrImageStatus] = useState('loading'),
    [qrRefresh, setQrRefresh] = useState(0),
    [qrError, setQrError] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (choice !== 'qr' || (remote?.cookieSaved && !qrRefresh)) return;
    let active = true;
    setQr(null);
    setQrStatus(0);
    setQrImageStatus('loading');
    setQrLoading(true);
    setQrError('');
    async function generate() {
      try {
        const session = await api('/direct115/qr', { method: 'POST', body: { device } });
        if (active) setQr(session);
        else api(`/direct115/qr/${session.id}`, { method: 'DELETE', body: {} }).catch(() => {});
      } catch (error) {
        if (active) setQrError(error.message);
      } finally {
        if (active) setQrLoading(false);
      }
    }
    const timer = setTimeout(generate, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [choice, device, qrRefresh, remote?.cookieSaved]);
  useEffect(() => {
    if (!qr) return;
    let active = true,
      timer;
    async function poll() {
      try {
        const result = await api(`/direct115/qr/${qr.id}`);
        if (!active) return;
        setQrStatus(result.status);
        setQrError('');
        if ([2, -1, -2].includes(result.status)) return;
      } catch (error) {
        if (!active) return;
        setQrError(error.message);
        if (error.status === 410) {
          setQrStatus(-1);
          return;
        }
      }
      if (active) timer = setTimeout(poll, 2500);
    }
    timer = setTimeout(poll, 2500);
    return () => {
      active = false;
      clearTimeout(timer);
      api(`/direct115/qr/${qr.id}`, { method: 'DELETE', body: {} }).catch(() => {});
    };
  }, [qr]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(remote ? `/direct115/${encodeURIComponent(name)}` : '/direct115', {
        method: remote ? 'PUT' : 'POST',
        body: {
          name,
          rootId,
          ...(choice === 'qr' && qrStatus === 2 ? { qrSession: qr.id } : {}),
          ...(choice === 'cookie' && cookie ? { cookie } : {}),
        },
      });
      onDone('115 直接连接已保存');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  if (choice === 'cd2')
    return <Cd2Form onBack={() => setChoice('qr')} onClose={onClose} onDone={onDone} />;
  if (choice === 'openlist')
    return (
      <CloudForm
        type="openlist-115"
        remote={remote}
        onBack={() => (remote ? onBack() : setChoice('qr'))}
        onClose={onClose}
        onDone={onDone}
      />
    );
  return (
    <Dialog
      wide
      title={remote ? '编辑 115 直接连接' : '连接 115 网盘'}
      subtitle="选择直接登录、OpenList，或读取 CD2 中已连接的 115。"
      onClose={busy ? () => {} : onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body cloud-modal">
          <div className="cloud-login-modes" role="group" aria-label="115 登录方式">
            {!remote && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setQr(null);
                  setChoice('openlist');
                }}
              >
                OpenList
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className={`button ${choice === 'qr' ? 'primary' : 'secondary'}`}
              onClick={() => {
                setChoice('qr');
                setError('');
              }}
            >
              直接扫码
            </button>
            <button
              type="button"
              disabled={busy}
              className={`button ${choice === 'cookie' ? 'primary' : 'secondary'}`}
              onClick={() => {
                setQr(null);
                setChoice('cookie');
                setError('');
              }}
            >
              直接 CK
            </button>
            {!remote && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setQr(null);
                  setChoice('cd2');
                }}
              >
                CD2 WebDAV
              </button>
            )}
          </div>
          <p className="ops-info">
            直接扫码和 CK 无需 OpenList，支持浏览及从 115 复制文件到其他存储；暂不支持向 115
            上传。凭据保存在服务器，不会在网页中回显。 特殊文件名会转换为可访问的名称（例如冒号变为
            %3A），复制后使用显示名称，115 原文件不改名。
          </p>
          <div className="cloud-field-grid">
            <label className="field">
              <span>连接名称</span>
              <input
                required
                disabled={Boolean(remote) || busy}
                placeholder="115-main"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>根目录 ID</span>
              <input
                required
                disabled={busy}
                pattern="[0-9]+"
                value={rootId}
                onChange={(event) => setRootId(event.target.value)}
              />
              <small>整个网盘填 0；也可指定官网目录链接中的 cid。</small>
            </label>
          </div>
          {choice === 'cookie' ? (
            <label className="field">
              <span>115 Cookie（CK）</span>
              <input
                type="password"
                autoComplete="new-password"
                required={!remote?.cookieSaved}
                disabled={busy}
                placeholder={
                  remote?.cookieSaved ? '已保存，留空保留' : 'UID=...; CID=...; SEID=...; KID=...'
                }
                value={cookie}
                onChange={(event) => setCookie(event.target.value)}
              />
              <small>从你已登录的 115 会话复制完整 Cookie，至少包含 UID、CID、SEID。</small>
            </label>
          ) : (
            <div className="direct115-qr">
              <label className="field">
                <span>登录设备</span>
                <select
                  disabled={busy}
                  value={device}
                  onChange={(event) => setDevice(event.target.value)}
                >
                  <option value="web">网页</option>
                  <option value="android">Android</option>
                  <option value="ios">iOS</option>
                  <option value="tv">电视</option>
                </select>
                <small>用 115 App 扫码并确认；同类设备的已有登录可能被退出。</small>
              </label>
              {(qrLoading || qr) && (
                <>
                  <div
                    className="direct115-qr-image"
                    aria-busy={qrLoading || qrImageStatus === 'loading'}
                  >
                    {qr && (
                      <img
                        key={qr.id}
                        src={qr.image}
                        alt="115 登录二维码"
                        width="240"
                        height="240"
                        hidden={qrImageStatus !== 'ready'}
                        onLoad={() => setQrImageStatus('ready')}
                        onError={() => setQrImageStatus('failed')}
                      />
                    )}
                    {(qrLoading || qrImageStatus === 'loading') && (
                      <span role="status">
                        <Spinner />
                        正在加载二维码…
                      </span>
                    )}
                    {!qrLoading && qrImageStatus === 'failed' && (
                      <span className="form-error" role="alert">
                        二维码图片加载失败，请重新生成。
                      </span>
                    )}
                  </div>
                  {qr && (qrImageStatus === 'ready' || qrStatus !== 0) && (
                    <p role="status">
                      {
                        {
                          0: '等待扫码',
                          1: '已扫描，请在手机确认登录',
                          2: '登录成功，可以保存连接',
                          '-1': '二维码已过期',
                          '-2': '登录已取消',
                        }[qrStatus]
                      }
                    </p>
                  )}
                </>
              )}
              <button
                type="button"
                className="button secondary"
                disabled={busy || qrLoading}
                onClick={() => setQrRefresh((value) => value + 1)}
              >
                {qrLoading && <Spinner />}
                {qrLoading ? '正在生成二维码…' : qr ? '重新生成二维码' : '生成二维码'}
              </button>
              {qrError && (
                <p className="form-error" role="alert">
                  {qrError}
                </p>
              )}
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onBack}>
            返回
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              (choice === 'qr' &&
                (qrLoading || (qrStatus !== 2 && (!remote?.cookieSaved || Boolean(qr)))))
            }
          >
            {busy && <Spinner />}保存连接
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export function DriveGroupForm({ remote, onClose, onDone }) {
  const [remotes, setRemotes] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(remote?.name || '');
  const [members, setMembers] = useState(
    remote?.group?.members.map((member) => ({
      remote: member.remote,
      budgetGB: member.budgetBytes / 1e9,
    })) || [],
  );
  useEffect(() => {
    let active = true;
    api('/remotes')
      .then((data) => {
        if (active) setRemotes(data);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(remote ? `/drive-groups/${encodeURIComponent(name)}` : '/drive-groups', {
        method: remote ? 'PUT' : 'POST',
        body: {
          name,
          members: members.map((member) => ({
            remote: member.remote,
            budgetBytes: Math.round(Number(member.budgetGB) * 1e9),
          })),
        },
      });
      onDone('Google 团队盘 group 已保存');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      wide
      title={remote ? '编辑 Google 团队盘 group' : '创建 Google 团队盘 group'}
      subtitle="先分别授权 Google 账号，再把同一团队盘的连接加入 group。"
      onClose={busy ? () => {} : onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body cloud-modal">
          <label className="field">
            <span>Group 连接名称</span>
            <input
              required
              disabled={Boolean(remote) || busy}
              placeholder="google-team"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <p className="ops-info">
            成员须指向相同的团队盘和根目录，且拥有上传权限。系统会检查真实账号，重复授权不会增加额度。按下方顺序使用账号，额度不足时自动切换；所有账号不足时等待恢复。仅支持复制。
          </p>
          <h3>已授权的 Google 团队盘账号</h3>
          {!remotes.some(
            (item) => item.type === 'drive' && item.teamDriveConfigured && !item.pending,
          ) && (
            <p className="muted">
              请先在“存储连接”中添加 Google Drive，完成各账号的 OAuth 授权并选择同一个团队盘。
            </p>
          )}
          {remotes
            .filter((item) => item.type === 'drive' && item.teamDriveConfigured && !item.pending)
            .map((item) => (
              <label className="group-member-choice" key={item.name}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={members.some((member) => member.remote === item.name)}
                  onChange={(event) =>
                    setMembers((previous) =>
                      event.target.checked
                        ? [...previous, { remote: item.name, budgetGB: 700 }]
                        : previous.filter((member) => member.remote !== item.name),
                    )
                  }
                />
                <span>
                  {item.accountLabel || item.name}
                  <small>已配置团队盘，保存时校验目标目录与账号权限</small>
                </span>
              </label>
            ))}
          {members.map((member, index) => (
            <div className="drive-budget-row" key={member.remote}>
              <strong>
                {index + 1}. {member.remote}
              </strong>
              <label className="field">
                <span>24 小时预算（GB，十进制）</span>
                <input
                  type="number"
                  required
                  min="0.000001"
                  max="750"
                  step="any"
                  disabled={busy}
                  value={member.budgetGB}
                  onChange={(event) =>
                    setMembers((previous) =>
                      previous.map((value) =>
                        value.remote === member.remote
                          ? { ...value, budgetGB: event.target.value }
                          : value,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="button secondary"
                disabled={!index || busy}
                onClick={() =>
                  setMembers((previous) => {
                    const next = [...previous];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    return next;
                  })
                }
              >
                提前
              </button>
            </div>
          ))}
          <p className="muted">
            默认每个账号 700 GB，留出余量。只记录本面板通过 group
            和已入组连接的上传，其他用量不可见；Google 实际拒绝上传时会暂停该账号至少 24 小时。
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || !members.length}>
            {busy && <Spinner />}校验账号并保存 group
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export function DriveGroupSummary({ group }) {
  return (
    <div>
      <p className="muted">
        团队盘 {group.teamDrive} · 根目录 {group.rootId}
      </p>
      {group.members.map((member) => (
        <p key={member.remote}>
          {member.remote} · {member.email} · 最近 24 小时 {(member.usedBytes / 1e9).toFixed(2)} GB /{' '}
          {member.budgetBytes / 1e9} GB
          {member.cooldownUntil ? ` · 冷却至 ${time(member.cooldownUntil)}` : ''}
        </p>
      ))}
    </div>
  );
}
