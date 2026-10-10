import path from 'node:path';
import { AppError, cleanPath } from './validation.mjs';

const VIDEO = new Set([
  'mkv',
  'mp4',
  'avi',
  'mov',
  'm4v',
  'ts',
  'm2ts',
  'mts',
  'wmv',
  'flv',
  'webm',
  'mpg',
  'mpeg',
  'iso',
  'vob',
  'rmvb',
]);
const COMPANION = new Set([
  'srt',
  'ass',
  'ssa',
  'sub',
  'idx',
  'vtt',
  'sup',
  'smi',
  'nfo',
  'jpg',
  'jpeg',
  'png',
  'webp',
]);
const TOKENS = new Set(['title', 'year', 'season', 'type', 'folder']);
const MAX_FILES = 100000;

function choice(value, values, fallback, label) {
  const result = value ?? fallback;
  if (!values.includes(result)) throw new AppError(`${label}无效。`);
  return result;
}

function folder(value, fallback) {
  const result = cleanPath(value ?? fallback);
  if (!result) throw new AppError('归档目录不能为空。');
  return result;
}

export function validateMediaOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError('影视传输设置无效。');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    throw new AppError('影视传输开关无效。');
  const rules = input.rules ?? [];
  if (!Array.isArray(rules) || rules.length > 50) throw new AppError('最多设置 50 条归档规则。');
  return {
    enabled: input.enabled ?? false,
    preset: choice(input.preset, ['all', 'videos', 'bundle'], 'all', '文件类型'),
    archive: choice(input.archive, ['preserve', 'type', 'rules'], 'preserve', '归档方式'),
    rename: choice(input.rename, ['preserve', 'clean'], 'preserve', '命名方式'),
    movieFolder: folder(input.movieFolder, '电影'),
    seriesFolder: folder(input.seriesFolder, '剧集'),
    rules: rules.map((rule) => {
      if (!rule || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > 512)
        throw new AppError('归档匹配规则无效。');
      const pattern = cleanPath(rule.pattern);
      if (!pattern) throw new AppError('归档匹配规则不能为空。');
      const target = folder(rule.folder, '');
      for (const token of target.matchAll(/\{([^{}]*)\}/g)) {
        if (!TOKENS.has(token[1])) throw new AppError(`不支持的归档模板：${token[1]}。`);
      }
      if (target.replace(/\{[^{}]*\}/g, '').match(/[{}]/))
        throw new AppError('归档模板格式不正确。');
      return { pattern, folder: target };
    }),
    conflict: choice(input.conflict, ['skip', 'overwrite'], 'skip', '同名文件处理方式'),
  };
}

export function mediaEnabled(input = {}) {
  return Boolean(input.media?.enabled || input.sourcePaths?.length);
}

export function normalizeSourcePaths(input = {}) {
  const requested = input.sourcePaths ?? [];
  if (!Array.isArray(requested) || requested.length > 20)
    throw new AppError('最多选择 20 个来源目录。');
  const roots = requested.map((value) => {
    if (typeof value !== 'string') throw new AppError('来源目录路径无效。');
    return cleanPath(value);
  });
  if (new Set(roots).size !== roots.length) throw new AppError('来源目录不能重复。');
  if (roots.length && input.selections?.length)
    throw new AppError('多个来源目录模式不能同时勾选部分文件，请分别创建任务。');
  if (roots.length && input.mode === 'sync')
    throw new AppError('多个来源目录模式仅支持复制，避免误删目标文件。');
  if (
    roots.some((root, index) =>
      roots.some(
        (other, otherIndex) => index !== otherIndex && (!root || other.startsWith(`${root}/`)),
      ),
    )
  )
    throw new AppError('来源目录不能互相包含，请选择独立目录。');
  const names = roots.map((root) => path.posix.basename(root).toLocaleLowerCase());
  if (roots.length > 1 && (names.some((name) => !name) || new Set(names).size !== names.length))
    throw new AppError('多个来源目录的名称重复或为空，请拆分任务或选择不同目录。');
  return roots;
}

// Match wildcard segments without evaluating user supplied regular expressions.
function segmentMatch(pattern, value) {
  let p = 0,
    v = 0,
    star = -1,
    retry = 0;
  while (v < value.length) {
    if (pattern[p] === '?' || pattern[p] === value[v]) {
      p++;
      v++;
    } else if (pattern[p] === '*') {
      star = p++;
      retry = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++retry;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function globMatch(pattern, value) {
  const patterns = pattern.toLocaleLowerCase().split('/');
  const segments = value.toLocaleLowerCase().split('/');
  let matches = new Uint8Array(segments.length + 1);
  matches[0] = 1;
  for (const part of patterns) {
    const next = new Uint8Array(segments.length + 1);
    if (part === '**') {
      next[0] = matches[0];
      for (let i = 1; i <= segments.length; i++) next[i] = matches[i] || next[i - 1];
    } else {
      for (let i = 1; i <= segments.length; i++)
        next[i] = matches[i - 1] && segmentMatch(part, segments[i - 1]);
    }
    matches = next;
  }
  return Boolean(matches[segments.length]);
}

function extension(file) {
  return path.posix.extname(file).slice(1).toLowerCase();
}
function stem(file) {
  return path.posix.basename(file, path.posix.extname(file));
}
function component(value, fallback) {
  const result = String(value).replace(/[{}]/g, '').trim();
  if (!result || result === '.' || result === '..') return fallback;
  // Template replacements cannot add another directory segment.
  if (result.includes('/')) throw new AppError('归档模板包含非法目录名。');
  return cleanPath(result);
}

function metadata(file, root, options) {
  const name = stem(file);
  const parent = path.posix.dirname(file);
  const context = `${parent}/${root}`;
  const episode =
    /(?:^|[^a-z\d])S(\d{1,2})[ ._-]*E(\d{1,3})((?:[ ._-]*E\d{1,3})*)/i.exec(name) ||
    /(?:^|[^a-z\d])(\d{1,2})x(\d{1,3})\b/i.exec(name);
  const seasonHint =
    /(?:(?:^|[^a-z\d])Season[ ._-]*(\d{1,2})\b|(?:^|[^a-z\d])S(\d{1,2})\b|第\s*(\d{1,2})\s*季)/i.exec(
      context,
    );
  const year = /(?:^|[^\d])((?:19|20)\d{2})(?=[^\d]|$)/.exec(name);
  const release =
    /(?:^|[ ._\[(-])(?:2160p|1080[pi]|720p|480p|4k|8k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web[ ._-]?dl|hdtv|dvdrip|remux|x26[45]|h[ ._-]?26[45]|hevc|av1|aac|dts|ddp?|truehd|atmos|hdr10?|dolby[ ._-]?vision)\b/i.exec(
      name,
    );
  const cuts = [year && year.index, episode && episode.index, release && release.index].filter(
    (value) => value !== null && value !== false,
  );
  let title = name
    .slice(0, cuts.length ? Math.min(...cuts) : undefined)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/[\s([\-]+$/g, '')
    .trim();
  if (!title) {
    const parentParts = (parent === '.' ? root : parent).split('/').filter(Boolean);
    title =
      parentParts
        .reverse()
        .find((part) => !/^(?:season[ ._-]*\d+|s\d+|第\s*\d+\s*季)$/i.test(part)) || '未命名';
  }
  title = component(title, '未命名');
  const seasonNumber = episode?.[1] || seasonHint?.slice(1).find(Boolean);
  const series = Boolean(episode || seasonHint);
  return {
    title,
    year: year?.[1] || '未知年份',
    season: seasonNumber ? `Season ${String(Number(seasonNumber)).padStart(2, '0')}` : '未分季',
    type: series ? options.seriesFolder : options.movieFolder,
    folder: component(path.posix.basename(parent === '.' ? root : parent), '根目录'),
    cleanStem: `${title}${year ? ` (${year[1]})` : ''}${episode ? ` S${String(Number(episode[1])).padStart(2, '0')}E${String(Number(episode[2])).padStart(2, '0')}${(episode[3] || '').replace(/[ ._-]/g, '').replace(/E(\d+)/gi, (_, number) => `E${String(Number(number)).padStart(2, '0')}`)}` : ''}`,
  };
}

function associate(file, videosByFolder) {
  if (!COMPANION.has(extension(file))) return null;
  const group = videosByFolder.get(path.posix.dirname(file));
  if (!group) return null;
  const name = stem(file).toLocaleLowerCase();
  let candidate = name;
  while (candidate) {
    if (group.stems.has(candidate)) return group.stems.get(candidate);
    const delimiter = Math.max(
      candidate.lastIndexOf('.'),
      candidate.lastIndexOf(' '),
      candidate.lastIndexOf('_'),
      candidate.lastIndexOf('-'),
    );
    if (delimiter < 0) break;
    candidate = candidate.slice(0, delimiter);
  }
  if (
    group.commonMetadata &&
    /^(?:poster|fanart|folder|cover|movie|tvshow|season\d+-poster)$/i.test(stem(file))
  )
    return group.videos[0];
  return null;
}

function targetFor(file, root, prefix, options, videosByFolder) {
  const related = associate(file, videosByFolder);
  const info = metadata(related || file, root, options);
  let filename = path.posix.basename(file);
  if (options.rename === 'clean' && (VIDEO.has(extension(file)) || related)) {
    if (!related) filename = `${info.cleanStem}${path.posix.extname(file)}`;
    else if (stem(file).toLocaleLowerCase().startsWith(stem(related).toLocaleLowerCase())) {
      filename = `${info.cleanStem}${stem(file).slice(stem(related).length)}${path.posix.extname(file)}`;
    }
  }
  let directory = path.posix.dirname(file);
  if (directory === '.') directory = '';
  if (options.archive === 'type') directory = [info.type, directory].filter(Boolean).join('/');
  if (options.archive === 'rules') {
    const rule = options.rules.find(
      (item) => globMatch(item.pattern, file) || (related && globMatch(item.pattern, related)),
    );
    if (rule)
      directory = cleanPath(rule.folder.replace(/\{([^{}]*)\}/g, (_, token) => info[token]));
  }
  return cleanPath([prefix, directory, filename].filter(Boolean).join('/'));
}

export async function planMediaTransfer(input, { listFiles, resolveFs }) {
  const configured = validateMediaOptions(input.media);
  const options = configured.enabled
    ? configured
    : { ...configured, preset: 'all', archive: 'preserve', rename: 'preserve' };
  if (!input.source || typeof input.source.remote !== 'string')
    throw new AppError('请选择来源网盘。');
  cleanPath(input.destination?.path ?? '');
  const requested = normalizeSourcePaths(input);
  const roots = requested.length ? requested : [cleanPath(input.source.path)];
  const multiple = roots.length > 1;
  const prefixes = roots.map((root) => (multiple ? path.posix.basename(root) : ''));
  const files = [],
    targets = new Set();
  let skippedByFilter = 0,
    scanned = 0,
    totalBytes = 0;
  for (let index = 0; index < roots.length; index++) {
    const source = { remote: input.source.remote, path: roots[index] };
    await resolveFs(source);
    const listed = await listFiles({ ...input, source });
    if (!Array.isArray(listed)) throw new AppError('来源文件列表无效。');
    const regular = listed.filter((file) => !file.IsDir);
    scanned += regular.length;
    if (scanned > MAX_FILES) throw new AppError('来源目录超过 100000 个文件，请拆分传输任务。');
    const normalized = regular.map((file) => {
      const relative = cleanPath(file.Path);
      if (!relative || file.Path.startsWith('/')) throw new AppError('来源文件路径无效。');
      const size = Number(file.Size ?? 0);
      if (!Number.isSafeInteger(size) || size < 0) throw new AppError('来源文件大小无效。');
      return { file, relative, size };
    });
    const videosByFolder = new Map();
    for (const { relative } of normalized) {
      if (!VIDEO.has(extension(relative))) continue;
      const directory = path.posix.dirname(relative);
      if (!videosByFolder.has(directory))
        videosByFolder.set(directory, {
          videos: [],
          stems: new Map(),
          commonMetadata: true,
          fingerprint: '',
        });
      const group = videosByFolder.get(directory);
      group.videos.push(relative);
      const key = stem(relative).toLocaleLowerCase();
      group.stems.set(key, group.stems.has(key) ? null : relative);
      const info = metadata(relative, roots[index], options);
      const fingerprint = JSON.stringify([info.title, info.year, info.season, info.type]);
      if (group.fingerprint && group.fingerprint !== fingerprint) group.commonMetadata = false;
      group.fingerprint = fingerprint;
    }
    for (const { file, relative, size } of normalized) {
      const ext = extension(relative);
      if (
        (options.preset === 'videos' && !VIDEO.has(ext)) ||
        (options.preset === 'bundle' && !VIDEO.has(ext) && !COMPANION.has(ext))
      ) {
        skippedByFilter++;
        continue;
      }
      const targetFile = targetFor(
        relative,
        roots[index],
        prefixes[index],
        options,
        videosByFolder,
      );
      if (targets.has(targetFile.toLocaleLowerCase()))
        throw new AppError(`归档后文件路径冲突：${targetFile}，请调整命名或归档规则。`);
      targets.add(targetFile.toLocaleLowerCase());
      totalBytes += size;
      if (!Number.isSafeInteger(totalBytes)) throw new AppError('来源文件总大小超出允许范围。');
      files.push({
        path: cleanPath([prefixes[index], relative].filter(Boolean).join('/')),
        source,
        sourceFile: file.Path,
        targetFile,
        size,
        hashes: file.Hashes || {},
      });
    }
  }
  return { files, totalBytes, totalFiles: files.length, skippedByFilter };
}
