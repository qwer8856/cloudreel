import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMediaOptions,
  mediaEnabled,
  normalizeSourcePaths,
  planMediaTransfer,
} from '../server/media.mjs';

function fixture(list, updates = {}) {
  const input = {
    source: { remote: '115', path: '影视' },
    destination: { remote: 'google', path: '媒体库' },
    ...updates,
  };
  const calls = [];
  return {
    input,
    calls,
    dependencies: {
      resolveFs: async (source) => {
        calls.push({ resolved: source });
        return {};
      },
      listFiles: async (request) => {
        calls.push({ listed: request });
        return typeof list === 'function' ? list(request) : list;
      },
    },
  };
}
function file(Path, Size = 100) {
  return { Path, Size, Hashes: { sha1: 'example' } };
}
async function plan(list, updates) {
  const { input, dependencies } = fixture(list, updates);
  return planMediaTransfer(input, dependencies);
}

test('影视默认保留文件、名称和来源，不修改传入列表', async () => {
  const list = [
    file('电影/流浪地球.2019.1080p.mkv'),
    file('电影/说明.txt', 10),
    { Path: '空目录', IsDir: true },
  ];
  const before = structuredClone(list);
  const result = await plan(list);
  assert.equal(result.totalFiles, 2);
  assert.equal(result.totalBytes, 110);
  assert.equal(result.files[0].targetFile, list[0].Path);
  assert.equal(result.files[0].sourceFile, list[0].Path);
  assert.deepEqual(result.files[0].source, { remote: '115', path: '影视' });
  assert.deepEqual(result.files[0].hashes, { sha1: 'example' });
  assert.deepEqual(list, before);
  assert.deepEqual(validateMediaOptions(), {
    enabled: false,
    preset: 'all',
    archive: 'preserve',
    rename: 'preserve',
    movieFolder: '电影',
    seriesFolder: '剧集',
    rules: [],
    conflict: 'skip',
  });
  assert.equal(mediaEnabled({ media: { enabled: true } }), true);
  assert.equal(mediaEnabled({ sourcePaths: ['电影'] }), true);
  assert.equal(mediaEnabled({ media: { enabled: false }, sourcePaths: [] }), false);
});

test('影视预设包含视频、字幕、海报、NFO并忽略扩展名大小写', async () => {
  const list = [
    '片名.MKV',
    '片名.SRT',
    '片名.ASS',
    '片名.NFO',
    'poster.JPG',
    'fanart.PNG',
    '说明.txt',
  ].map((name) => file(name));
  const bundle = await plan(list, { media: { enabled: true, preset: 'bundle' } });
  assert.equal(bundle.totalFiles, 6);
  assert.equal(bundle.skippedByFilter, 1);
  const videos = await plan(list, { media: { enabled: true, preset: 'videos' } });
  assert.equal(videos.totalFiles, 1);
  assert.equal(videos.skippedByFilter, 6);
});

test('关闭影视处理时多个来源保留所有文件与原名称目录，保留显式冲突策略', async () => {
  const list = [
    file('子目录/片名.2024.1080p.mkv'),
    file('子目录/片名.2024.1080p.srt'),
    file('说明.txt'),
  ];
  for (const [preset, archive] of [
    ['videos', 'type'],
    ['bundle', 'rules'],
  ]) {
    const media = {
      enabled: false,
      preset,
      archive,
      rename: 'clean',
      rules: [{ pattern: '**/*.mkv', folder: '整理/{title}' }],
      conflict: 'overwrite',
    };
    const result = await plan(list, { sourcePaths: ['资源/电影', '资源/剧集'], media });
    assert.equal(result.totalFiles, 6);
    assert.equal(result.skippedByFilter, 0);
    assert.deepEqual(
      result.files.map((item) => item.targetFile),
      [
        '电影/子目录/片名.2024.1080p.mkv',
        '电影/子目录/片名.2024.1080p.srt',
        '电影/说明.txt',
        '剧集/子目录/片名.2024.1080p.mkv',
        '剧集/子目录/片名.2024.1080p.srt',
        '剧集/说明.txt',
      ],
    );
    assert.equal(validateMediaOptions(media).conflict, 'overwrite');
    assert.equal(media.rename, 'clean');
  }
});

test('电影和剧集分类保留原目录并支持中文来源', async () => {
  const result = await plan(
    [
      file('科幻/流浪地球.2019.mkv'),
      file('三体/三体.S01E02.mkv'),
      file('三体/Season 01/poster.jpg'),
      file('三体/第2季/第1集.mp4'),
    ],
    { media: { enabled: true, archive: 'type' } },
  );
  assert.deepEqual(
    result.files.map((item) => item.targetFile),
    [
      '电影/科幻/流浪地球.2019.mkv',
      '剧集/三体/三体.S01E02.mkv',
      '剧集/三体/Season 01/poster.jpg',
      '剧集/三体/第2季/第1集.mp4',
    ],
  );
});

test('命名整理保留视频与字幕、NFO的主名关系', async () => {
  const result = await plan(
    [
      file('星际穿越.2014.1080p.BluRay.x264-GROUP.MKV'),
      file('星际穿越.2014.1080p.BluRay.x264-GROUP.zh-CN.srt'),
      file('星际穿越.2014.1080p.BluRay.x264-GROUP.nfo'),
      file('poster.jpg'),
      file('说明.txt'),
      file('三体.S1E2.2160p.WEB-DL.mp4'),
    ],
    { media: { enabled: true, rename: 'clean' } },
  );
  assert.deepEqual(
    result.files.map((item) => item.targetFile),
    [
      '星际穿越 (2014).MKV',
      '星际穿越 (2014).zh-CN.srt',
      '星际穿越 (2014).nfo',
      'poster.jpg',
      '说明.txt',
      '三体 S01E02.mp4',
    ],
  );
});

test('下划线剧集命名和多集文件保留集数范围', async () => {
  const result = await plan(
    [
      file('三体_S1E2_1080p.mkv'),
      file('三体_S1E2_1080p.zh.srt'),
      file('三体.S01E03-E04.1080p.mkv'),
    ],
    { media: { enabled: true, archive: 'type', rename: 'clean' } },
  );
  assert.deepEqual(
    result.files.map((file) => file.targetFile),
    ['剧集/三体 S01E02.mkv', '剧集/三体 S01E02.zh.srt', '剧集/三体 S01E03E04.mkv'],
  );
});

test('安全规则模板匹配目录并将影视配套文件归入同一个目录', async () => {
  const result = await plan(
    [
      file('国内/三体.2023.S01E02.WEB-DL.mkv'),
      file('国内/三体.2023.S01E02.WEB-DL.zh.ass'),
      file('国内/三体.2023.S01E02.WEB-DL.nfo'),
      file('外语/Arrival.2016.1080p.mp4'),
      file('未分类/说明.txt'),
    ],
    {
      media: {
        enabled: true,
        archive: 'rules',
        rename: 'clean',
        rules: [
          { pattern: '国内/**/*.mkv', folder: '{type}/{title}/{year}/{season}' },
          { pattern: '**/*.mp4', folder: '{type}/{folder}/{title} ({year})' },
        ],
      },
    },
  );
  assert.deepEqual(
    result.files.map((item) => item.targetFile),
    [
      '剧集/三体/2023/Season 01/三体 (2023) S01E02.mkv',
      '剧集/三体/2023/Season 01/三体 (2023) S01E02.zh.ass',
      '剧集/三体/2023/Season 01/三体 (2023) S01E02.nfo',
      '电影/外语/Arrival (2016)/Arrival (2016).mp4',
      '未分类/说明.txt',
    ],
  );
});

test('同一剧集多集的通用海报跟随剧集归档', async () => {
  const result = await plan(
    [
      file('三体/三体.S01E01.mkv'),
      file('三体/三体.S01E02.mkv'),
      file('三体/poster.jpg'),
      file('三体/tvshow.nfo'),
    ],
    {
      media: {
        enabled: true,
        archive: 'rules',
        rules: [{ pattern: '**/*.mkv', folder: '{type}/{title}/{season}' }],
      },
    },
  );
  assert.equal(result.files[2].targetFile, '剧集/三体/Season 01/poster.jpg');
  assert.equal(result.files[3].targetFile, '剧集/三体/Season 01/tvshow.nfo');
});

test('缺失影视信息使用安全模板回退，glob元字符不能执行正则', async () => {
  const result = await plan([file('电影.mkv'), file('a+b.mkv')], {
    media: {
      enabled: true,
      archive: 'rules',
      rules: [
        { pattern: '电影.mkv', folder: '{title}/{year}/{season}/{folder}' },
        { pattern: 'a+b.mkv', folder: '字面匹配' },
      ],
    },
  });
  assert.equal(result.files[0].targetFile, '电影/未知年份/未分季/影视/电影.mkv');
  assert.equal(result.files[1].targetFile, '字面匹配/a+b.mkv');
});

test('多来源按来源末级目录隔离，逐个检查并保留已有筛选和选项', async () => {
  const sample = fixture(() => [file('同名.mkv')], {
    sourcePaths: ['我的资源/电影', '我的资源/剧集'],
    filters: { include: ['*.mkv'] },
  });
  const result = await planMediaTransfer(sample.input, sample.dependencies);
  assert.deepEqual(
    result.files.map((item) => item.targetFile),
    ['电影/同名.mkv', '剧集/同名.mkv'],
  );
  assert.deepEqual(
    result.files.map((item) => item.source.path),
    sample.input.sourcePaths,
  );
  assert.equal(sample.calls.length, 4);
  assert.deepEqual(sample.calls[1].listed.filters, sample.input.filters);
  assert.deepEqual(sample.calls[0].resolved, result.files[0].source);
  await assert.rejects(plan([], { sourcePaths: ['甲/电影', '乙/电影'] }), /名称重复/);
  await assert.rejects(plan([], { sourcePaths: ['电影', '电影'] }), /不能重复/);
  await assert.rejects(plan([], { sourcePaths: ['', '电影'] }), /互相包含/);
  assert.throws(() => normalizeSourcePaths({ sourcePaths: ['电影', '电影/系列'] }), /互相包含/);
  assert.throws(
    () =>
      normalizeSourcePaths({
        sourcePaths: ['电影'],
        selections: [{ path: 'a.mkv', isDir: false }],
      }),
    /勾选部分文件/,
  );
  assert.throws(() => normalizeSourcePaths({ sourcePaths: ['电影'], mode: 'sync' }), /仅支持复制/);
  assert.deepEqual(normalizeSourcePaths(), []);
  assert.throws(
    () =>
      normalizeSourcePaths({
        sourcePaths: Array.from({ length: 21 }, (_, index) => `目录${index}`),
      }),
    /20 个/,
  );
  assert.throws(() => normalizeSourcePaths({ sourcePaths: [undefined] }), /路径无效/);
});

test('路径、模板和选项不能越界，重命名碰撞在传输之前拒绝', async () => {
  for (const update of [
    { movieFolder: '../escape' },
    { seriesFolder: 'a\\b' },
    { rules: [{ pattern: '../*.mkv', folder: '电影' }] },
    { rules: [{ pattern: '*.mkv', folder: '{title}/../escape' }] },
    { rules: [{ pattern: '*.mkv', folder: '{unknown}' }] },
    { rules: [{ pattern: '*.mkv', folder: '{title' }] },
    { enabled: 'yes' },
    { preset: 'other' },
    { conflict: 'delete' },
  ])
    assert.throws(() => validateMediaOptions(update));
  for (const invalid of [
    '../secret.mkv',
    'a/../secret.mkv',
    '/secret.mkv',
    'a\\secret.mkv',
    'C:/secret.mkv',
  ]) {
    await assert.rejects(plan([file(invalid)]));
  }
  await assert.rejects(plan([], { sourcePaths: ['../secret'] }));
  await assert.rejects(plan([], { destination: { remote: 'google', path: '../secret' } }));
  await assert.rejects(
    plan([file('电影.2023.1080p.mkv'), file('电影.2023.2160p.mkv')], {
      media: { enabled: true, rename: 'clean' },
    }),
    /路径冲突/,
  );
  await assert.rejects(
    plan([file('a/片名.mkv'), file('b/片名.mkv')], {
      media: { enabled: true, archive: 'rules', rules: [{ pattern: '**/*.mkv', folder: '电影' }] },
    }),
    /路径冲突/,
  );
});

test('来源目录权限失败和异常文件大小停止计划', async () => {
  const sample = fixture([file('电影.mkv')]);
  sample.dependencies.resolveFs = async () => {
    throw new Error('登录失效');
  };
  await assert.rejects(planMediaTransfer(sample.input, sample.dependencies), /登录失效/);
  for (const size of [-1, NaN, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(plan([file('电影.mkv', size)]), /大小无效/);
  await assert.rejects(
    plan([file('电影.mkv', Number.MAX_SAFE_INTEGER), file('剧集.mkv', 1)]),
    /总大小/,
  );
});

test('文件数量上限在处理命名之前检查', async () => {
  await assert.rejects(
    plan(Array.from({ length: 100001 }, (_, index) => file(`${index}.mkv`))),
    /100000/,
  );
});
