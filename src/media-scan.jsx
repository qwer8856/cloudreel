import React, { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { api, bytes } from './api.js';
import { Spinner } from './components.jsx';

const active = (scan) => ['queued', 'running', 'cancelling'].includes(scan?.status);
export function readScanDraft(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
export function useMediaScan({ storageKey, initialId, onResult, onError }) {
  const [scan, setScan] = useState(initialId ? { id: initialId, status: 'queued' } : null);
  const [starting, setStarting] = useState(false);
  const generation = useRef(0),
    handlers = useRef({ onResult, onError });
  handlers.current = { onResult, onError };
  useEffect(() => {
    if (!scan?.id || !active(scan)) return;
    let live = true,
      timer;
    async function poll() {
      try {
        const next = await api(`/media/scans/${scan.id}`);
        if (!live) return;
        setScan(next);
        if (next.status === 'completed') handlers.current.onResult(next.result);
        else if (active(next)) timer = setTimeout(poll, 1000);
      } catch (error) {
        if (!live) return;
        if ([404, 410].includes(error.status)) {
          setScan(null);
          try {
            localStorage.removeItem(storageKey);
          } catch {}
        } else timer = setTimeout(poll, 2500);
        handlers.current.onError(error.message);
      }
    }
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scan?.id, storageKey]);
  async function start(input) {
    const token = ++generation.current;
    setStarting(true);
    try {
      const next = await api('/media/scans', { method: 'POST', body: input });
      if (token !== generation.current) {
        await api(`/media/scans/${next.id}`, { method: 'DELETE', body: {} });
        return;
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify({ id: next.id, input }));
      } catch {}
      setScan(next);
      if (next.status === 'completed') handlers.current.onResult(next.result);
    } finally {
      setStarting(false);
    }
  }
  function reset() {
    generation.current++;
    setScan(null);
    try {
      localStorage.removeItem(storageKey);
    } catch {}
  }
  async function cancel() {
    if (!scan?.id) return;
    try {
      setScan(await api(`/media/scans/${scan.id}`, { method: 'DELETE', body: {} }));
    } catch (error) {
      handlers.current.onError(error.message);
    }
  }
  return { scan, running: starting || active(scan), start, reset, cancel };
}

export function MediaScanProgress({ task }) {
  const { scan, running } = task;
  if (!scan) return null;
  const progress = scan.progress || {};
  const stages = { source: '扫描来源目录', target: '检查目标已有文件', done: '扫描完成' };
  const title =
    scan.status === 'cancelling'
      ? '正在取消扫描…'
      : scan.status === 'cancelled'
        ? '扫描已取消'
        : scan.status === 'failed'
          ? '扫描失败'
          : scan.status === 'interrupted'
            ? '扫描已中断'
            : stages[scan.phase] || '正在连接扫描任务…';
  return (
    <section className="media-scan-progress" aria-live="polite" aria-busy={running}>
      <div className="media-scan-heading">
        <strong>
          {running && <Spinner />}
          {title}
        </strong>
        {running && (
          <button
            type="button"
            className="button secondary"
            disabled={scan.status === 'cancelling'}
            onClick={task.cancel}
          >
            <Square size={14} />
            取消扫描
          </button>
        )}
      </div>
      <p>
        来源目录 {progress.directoriesDone || 0} / {progress.directoriesFound || 0} · 发现{' '}
        {progress.filesFound || 0} 个文件 · {bytes(progress.bytesFound || 0)}
        {scan.elapsedSeconds > 0 && ` · 已用 ${scan.elapsedSeconds} 秒`}
      </p>
      {scan.phase === 'target' && (
        <p>
          符合规则 {progress.matchedFiles || 0} 个文件 · 目标目录{' '}
          {progress.targetDirectoriesDone || 0} / {progress.targetDirectoriesTotal || 0}
        </p>
      )}
      {scan.currentPath && <p className="media-scan-path">当前目录：{scan.currentPath}</p>}
      {scan.error && (
        <p className={scan.status === 'failed' ? 'form-error' : 'muted'}>{scan.error}</p>
      )}
      {running && (
        <small>
          后台按目录分批扫描，可关闭页面，返回后继续查看。来源目录总数会随扫描增加；扫描完成后再确认传输。
        </small>
      )}
      {scan.status === 'completed' && (
        <small>传输将使用本次文件清单，结果有效期 1 小时；来源新增文件需要重新扫描。</small>
      )}
    </section>
  );
}
