import React, { useEffect, useState } from 'react';
import { ArrowLeft, FolderOpen, FolderPlus, Home, File, RefreshCw } from 'lucide-react';
import { api, bytes } from './api.js';
import './operations.css';

const join = (...values) => values.filter(Boolean).join('/');
const directoryPath = (value = '') => value.split('/').filter(Boolean).join('/');
function relativeDirectory(root, path) {
  root = directoryPath(root);
  if (!root) return path;
  if (path === root) return '';
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}
export const emptyTransferOptions = {
  filters: { include: [], exclude: [], minSize: 0, maxSize: 0 },
  selections: [],
};
export function TransferControls({
  source,
  destination,
  setSource,
  setDestination,
  value,
  onChange,
  mode = 'copy',
  dailyBytes = 0,
  analysis: suppliedAnalysis,
  onAnalysis,
  acknowledge,
  setAcknowledge,
  showAnalysis = true,
  allowSelections = true,
}) {
  const [browse, setBrowse] = useState(null),
    [items, setItems] = useState([]),
    [loading, setLoading] = useState(false),
    [analyzing, setAnalyzing] = useState(false),
    [creating, setCreating] = useState(false),
    [browseInput, setBrowseInput] = useState(''),
    [newDirectory, setNewDirectory] = useState(''),
    [error, setError] = useState(''),
    [analysis, setAnalysis] = useState(null);
  const endpoint = browse?.side === 'destination' ? destination : source;
  useEffect(() => {
    setBrowse((current) =>
      current ? { ...current, path: directoryPath(endpoint.path) } : current,
    );
  }, [endpoint.remote, endpoint.path]);
  useEffect(() => {
    setBrowseInput(browse?.path || '');
    setNewDirectory('');
  }, [browse?.side, browse?.path]);
  useEffect(() => {
    if (!browse) return;
    let active = true;
    setLoading(true);
    setError('');
    setItems([]);
    api(
      `/files?remote=${encodeURIComponent(endpoint.remote)}&path=${encodeURIComponent(browse.path)}`,
    )
      .then((data) => {
        if (active) {
          setItems(data.items);
          if (data.truncated) setError('目录项较多，只显示前 10000 项。');
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [browse, endpoint.remote]);
  useEffect(() => {
    setAnalysis(null);
  }, [source.remote, source.path, destination.remote, destination.path, dailyBytes, value]);
  const options = { ...emptyTransferOptions, ...value };
  const selectionDirectory = browse ? relativeDirectory(source.path, browse.path) : null;
  const canSelect = browse?.side === 'source' && selectionDirectory !== null;
  const filter = (key, next) =>
    onChange({ ...options, filters: { ...options.filters, [key]: next } });
  const toggle = (item) => {
    if (!canSelect) return;
    const path = join(selectionDirectory, item.Path);
    onChange({
      ...options,
      selections: options.selections.some((value) => value.path === path)
        ? options.selections.filter((value) => value.path !== path)
        : [...options.selections, { path, isDir: item.IsDir }],
    });
  };
  async function analyze() {
    setAnalyzing(true);
    setError('');
    try {
      const result = await api('/transfers/analyze', {
        method: 'POST',
        body: { source, destination, mode, ...options, dailyBytes },
      });
      setAnalysis(result);
      onAnalysis?.(result);
    } catch (error) {
      setError(error.message);
    } finally {
      setAnalyzing(false);
    }
  }
  function openDirectory(side) {
    setBrowse({ side, path: directoryPath((side === 'source' ? source : destination).path) });
  }
  function goToDirectory() {
    setBrowse({ ...browse, path: directoryPath(browseInput) });
  }
  async function createDirectory() {
    if (!newDirectory.trim() || creating) return;
    const target = { remote: destination.remote, path: join(browse.path, newDirectory.trim()) };
    setCreating(true);
    setError('');
    try {
      await api('/files/mkdir', { method: 'POST', body: target });
      setDestination(target);
      setBrowse(null);
    } catch (error) {
      setError(error.message);
    } finally {
      setCreating(false);
    }
  }
  const result = suppliedAnalysis || analysis;
  return (
    <section className="transfer-controls">
      <p className="transfer-directory-note">
        两边的目录可分别手动填写或浏览选择；文件按源目录内的相对路径写入目标目录。
      </p>
      <div className="ops-toolbar">
        <button
          className="button secondary"
          type="button"
          disabled={creating || !source.remote}
          onClick={() => openDirectory('source')}
        >
          <FolderOpen size={16} />
          浏览源目录
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={creating || !destination.remote}
          onClick={() => openDirectory('destination')}
        >
          <FolderOpen size={16} />
          浏览目标目录
        </button>
        {showAnalysis && (
          <button
            className="button secondary"
            type="button"
            disabled={loading || analyzing || creating}
            onClick={analyze}
          >
            <RefreshCw size={15} />
            检查文件与额度
          </button>
        )}
      </div>
      {browse && (
        <div className="file-picker">
          <div className="ops-toolbar">
            <strong>
              {browse.side === 'source' ? '源目录与文件' : '目标目录'}：{endpoint.remote}:/
              {browse.path}
            </strong>
            <button
              className="text-button"
              type="button"
              disabled={creating}
              onClick={() => setBrowse(null)}
            >
              收起
            </button>
          </div>
          <div className="ops-toolbar">
            <button
              type="button"
              className="button secondary"
              disabled={!browse.path || creating}
              onClick={() => setBrowse({ ...browse, path: '' })}
            >
              <Home size={15} />
              存储根目录
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!browse.path || creating}
              onClick={() =>
                setBrowse({ ...browse, path: browse.path.split('/').slice(0, -1).join('/') })
              }
            >
              <ArrowLeft size={15} />
              上一级
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={loading || creating}
              onClick={() => {
                (browse.side === 'source' ? setSource : setDestination)({
                  ...endpoint,
                  path: browse.path,
                });
                if (browse.side === 'source') onChange({ ...options, selections: [] });
                setBrowse(null);
              }}
            >
              {browse.side === 'source' ? '使用此源目录' : '使用此目标目录'}
            </button>
          </div>
          <div className="picker-path-row">
            <label className="field">
              <span>浏览路径（相对于存储根目录）</span>
              <input
                aria-label="目录浏览路径"
                placeholder="输入目录路径，留空为根目录"
                value={browseInput}
                disabled={creating}
                onChange={(event) => setBrowseInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    goToDirectory();
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="button secondary"
              disabled={creating}
              onClick={goToDirectory}
            >
              前往目录
            </button>
          </div>
          {allowSelections && browse.side === 'source' && mode === 'copy' && !canSelect && (
            <p className="muted">
              当前浏览位置在已选源目录之外，请先点击“使用此源目录”，再勾选文件。
            </p>
          )}
          {loading ? (
            <p className="muted">正在读取目录…</p>
          ) : (
            <div className="picker-list">
              {items
                .filter((item) => browse.side === 'source' || item.IsDir)
                .map((item) => (
                  <div className="picker-row" key={item.Path}>
                    {allowSelections && browse.side === 'source' && mode === 'copy' && (
                      <input
                        type="checkbox"
                        aria-label={`选择 ${item.Name}`}
                        disabled={!canSelect}
                        checked={
                          canSelect &&
                          options.selections.some(
                            (value) => value.path === join(selectionDirectory, item.Path),
                          )
                        }
                        onChange={() => toggle(item)}
                      />
                    )}
                    {item.IsDir ? <FolderOpen size={17} /> : <File size={17} />}
                    <button
                      type="button"
                      className="text-button picker-name"
                      disabled={creating || (!item.IsDir && !canSelect)}
                      onClick={() =>
                        item.IsDir
                          ? setBrowse({ ...browse, path: join(browse.path, item.Path) })
                          : allowSelections && mode === 'copy' && toggle(item)
                      }
                    >
                      {item.Name}
                    </button>
                    <small className="muted">{item.IsDir ? '文件夹' : bytes(item.Size)}</small>
                  </div>
                ))}
              {!items.length && <p className="muted">当前目录为空。</p>}
            </div>
          )}
          {browse.side === 'destination' && (
            <div className="picker-create-directory">
              <label className="field">
                <span>新建目标子目录</span>
                <input
                  aria-label="目标子目录名称"
                  placeholder="例如：115备份/2026"
                  value={newDirectory}
                  disabled={creating}
                  onChange={(event) => setNewDirectory(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      createDirectory();
                    }
                  }}
                />
                <small>创建在当前浏览目录下，支持用 / 指定多级子目录。</small>
              </label>
              <button
                type="button"
                className="button secondary"
                disabled={creating || !newDirectory.trim()}
                onClick={createDirectory}
              >
                <FolderPlus size={15} />
                {creating ? '正在创建…' : '创建并选用'}
              </button>
            </div>
          )}
        </div>
      )}
      {allowSelections && (
        <p className="muted">
          {options.selections.length
            ? `已选择 ${options.selections.length} 项，仅复制所选内容。`
            : '未勾选文件时，处理源目录内所有符合筛选规则的文件。'}{' '}
          {options.selections.length > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => onChange({ ...options, selections: [] })}
            >
              清空选择
            </button>
          )}
        </p>
      )}
      <details>
        <summary>文件筛选</summary>
        <div className="ops-grid">
          <label className="field">
            <span>包含规则，每行一条</span>
            <textarea
              rows={3}
              placeholder={'*.mkv\n*.mp4'}
              defaultValue={options.filters.include.join('\n')}
              onChange={(event) =>
                filter('include', event.target.value.split('\n').filter(Boolean))
              }
            />
          </label>
          <label className="field">
            <span>排除规则，每行一条</span>
            <textarea
              rows={3}
              placeholder={'*.tmp\n**/缓存/**'}
              defaultValue={options.filters.exclude.join('\n')}
              onChange={(event) =>
                filter('exclude', event.target.value.split('\n').filter(Boolean))
              }
            />
          </label>
          <label className="field">
            <span>最小大小（MiB，0 不限）</span>
            <input
              type="number"
              min="0"
              step="any"
              value={options.filters.minSize / 1024 ** 2}
              onChange={(event) =>
                filter('minSize', Math.round(Number(event.target.value) * 1024 ** 2))
              }
            />
          </label>
          <label className="field">
            <span>最大大小（MiB，0 不限）</span>
            <input
              type="number"
              min="0"
              step="any"
              value={options.filters.maxSize / 1024 ** 2}
              onChange={(event) =>
                filter('maxSize', Math.round(Number(event.target.value) * 1024 ** 2))
              }
            />
          </label>
        </div>
      </details>
      {result && (
        <div className={result.warning ? 'ops-warning' : 'ops-info'}>
          <strong>
            {result.count} 个文件 · {bytes(result.bytes)} · 最大文件 {bytes(result.largest)}
          </strong>
          {result.warning && (
            <>
              <p>{result.warning}</p>
              {result.oversized.slice(0, 5).map((file) => (
                <small className="block" key={file.path}>
                  {file.path} · {bytes(file.size)}
                </small>
              ))}
              {setAcknowledge && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(event) => setAcknowledge(event.target.checked)}
                  />
                  <span>我已了解，继续使用当前停止方式。</span>
                </label>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
