import { safeError } from './validation.mjs';

export function stopMessage(job) {
  return (
    {
      user: '用户已停止任务；当前请求已取消，已完成文件保留。',
      pause: '用户已暂停任务；当前请求已取消，恢复时重新检查未完成文件。',
      shutdown: '服务关闭，任务已中断；已完成文件保留。',
      rollover: '运行日期已切换，当前请求已取消，等待下一次执行。',
      quota_rollover: '额度周期已切换，当前请求已取消，等待重新分配额度。',
    }[job.stopReason] || '任务已停止；当前请求已取消，已完成文件保留。'
  );
}

export function wasCancelled(error, job) {
  return Boolean(
    job.stopping &&
    /context cancel(?:ed|led)|operation (?:was )?(?:cancelled|canceled|aborted)|\babort(?:error|ed)\b|操作已停止|扫描已取消/i.test(
      error,
    ) &&
    !/\b(?:401|403|429|50\d)\b|请求超时|接口拒绝|下载失败/i.test(error),
  );
}

export function transferError(error) {
  const raw = safeError(error || '文件传输失败。');
  if (/115 请求超时或接口响应无效/.test(raw))
    return '115 来源读取失败；旧版本未区分请求超时和响应解析错误。请更新后重试以记录具体原因。';
  return raw;
}

export function skipMessage(check) {
  return (
    {
      directory: '目标同名路径是目录，已保留目标，跳过当前文件。',
      different: '目标已有同名文件，但大小或共同哈希不同；按保留目标规则跳过。',
      hash_match: '目标已有同名文件，大小和共同哈希一致；按保留目标规则跳过。',
      same_size: '目标已有同名文件，大小一致；双方没有共同哈希，按保留目标规则跳过。',
    }[check] || '已跳过；此旧记录未保存单文件判断原因。'
  );
}

export const CHECK_REASON = '已完成源/目标比较检查；此记录不代表跳过，后续传输结果以传输记录为准。';
