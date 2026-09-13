// Isolated filesystem + in-memory persistence. Never loads production config or SQLite.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(root, 'temp', 'playlist-sync-'));
const quiet = { log() {}, warn() {}, error() {} };
let passed = 0;
const clone = value => JSON.parse(JSON.stringify(value));
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const context = vm.createContext({ exports: {}, console: quiet, Buffer, URL, AbortController,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) });
  vm.runInContext(code, context, { filename: file });
  return context.exports;
}
const safety = load('src/utils/pathSafety.ts');
const files = load('src/server/playlistFileManager.ts', { '@/utils/pathSafety': safety });
const song = id => ({ id, source: 'wy', name: `歌曲 ${id}`, singer: '歌手' });
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(label, database = new Map(), folder, initialScan) {
  let downloadRoot = folder || path.join(scratch, label);
  fs.mkdirSync(downloadRoot, { recursive: true });
  let remote = [song('A'), song('B')], failRemote = false, fetchHook;
  const available = [], queued = [];
  const db = {
    getJson: (namespace, key, fallback) => clone(database.get(`${namespace}/${key}`) ?? fallback),
    setJson: (namespace, key, value) => database.set(`${namespace}/${key}`, clone(value)),
    loadDownloadTasks: () => clone(database.get('tasks') || []),
    saveDownloadTasks: values => database.set('tasks', clone([...values]))
  };
  const cache = { normalizeSongId: value => value.id, cacheProgress: new Map(),
    getCacheDir: () => downloadRoot,
    isSongCached: value => available.some(item => item.id === value.id && files.audioExists(downloadRoot, item.filename)),
    getReadyDownloadedSongs: () => available.filter(item => item.downloadComplete !== false) };
  const api = load('src/server/playlistSubscription.ts', {
    './fileCache': cache, './playlistFileManager': files, '@/storage/database': db
  });
  const fetch = async () => {
    if (fetchHook) await fetchHook();
    if (failRemote) throw new Error('remote offline');
    return { list: remote, total: remote.length };
  };
  const deps = { musicSdk: { wy: { songList: { getListDetail: fetch }, leaderboard: { getList: fetch } } },
    normalizeSongInfo: value => value, enqueue: (_user, tasks) => { queued.push(...tasks); return tasks; },
    getCachedSongs: async () => available.filter(item => item.downloadComplete !== false),
    getReadySongs: () => available.filter(item => item.downloadComplete !== false), getDownloadRoot: () => downloadRoot, initialScan };
  const add = (id, filename = `${id}.flac`, complete = true) => {
    fs.mkdirSync(path.dirname(path.join(downloadRoot, filename)), { recursive: true });
    fs.writeFileSync(path.join(downloadRoot, filename), `audio ${id}`);
    const item = { ...song(id), filename, folder: 'music', downloadComplete: complete };
    available.push(item); return item;
  };
  api.initialize(deps);
  return { api, deps, cache, db, database, available, queued, add,
    get root() { return downloadRoot; }, setRoot(value) { downloadRoot = value; fs.mkdirSync(value, { recursive: true }); available.length = 0; },
    remote: value => { remote = value; }, fail: value => { failRemote = value; }, hook: value => { fetchHook = value; },
    subscribe: (name = '每日推荐', id = 'one') => api.subscribe('shared', { source: 'wy', sourceListId: id, name }),
    view: id => api.list('shared').find(item => item.id === id),
    readUnmatched: () => fs.readFileSync(path.join(downloadRoot, api.getUnmatchedPlaylist().playlistPath), 'utf8'),
    read: id => fs.readFileSync(path.join(downloadRoot, api.list('shared').find(item => item.id === id).playlistPath), 'utf8') };
}
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
(async () => {
  await check('automatic playlists and leaderboards include their platform without cross-platform collisions', async () => {
    const h = harness('platform-names'); h.add('A');
    const platforms = { wy: '网易云', tx: 'QQ音乐', kg: '酷狗', kw: '酷我', mg: '咪咕' };
    const directories = new Set();
    for (const [source, platform] of Object.entries(platforms)) {
      h.deps.musicSdk[source] = h.deps.musicSdk.wy;
      for (const kind of ['playlist', 'leaderboard']) {
        const sub = await h.api.subscribe('shared', { source, kind, sourceListId: 'same', name: '每日推荐' });
        assert(sub.directoryName.includes(`（${platform}）`));
        assert.equal(sub.playlistPath, `${sub.directoryName}/${sub.directoryName}.m3u8`);
        assert(!directories.has(sub.directoryName)); directories.add(sub.directoryName);
      }
    }
    assert.equal(h.api.listNavidromePlaylists().find(item => item.kind === 'playlist').name, '每日推荐（网易云）');
    assert.equal(h.api.getUnmatchedPlaylist().name, '未匹配');
  });
  await check('long and duplicate automatic names retain the platform suffix within filesystem limits', async () => {
    const h = harness('platform-long');
    for (const id of ['first', 'second']) {
      const sub = await h.subscribe('😀'.repeat(150), id);
      assert(sub.directoryName.endsWith('（网易云）')); assert(sub.directoryName.length <= 64);
      assert(Buffer.byteLength(sub.directoryName, 'utf8') <= 140);
    }
    const named = await h.subscribe('已带平台（网易云）', 'third');
    assert.equal(named.directoryName, '已带平台（网易云）');
  });
  await check('legacy automatic names migrate safely while custom names remain unchanged', async () => {
    const h = harness('platform-migration'); h.add('A'); const sub = await h.subscribe('同名');
    h.api.renameNavidromePlaylist(sub.id, '旧歌单'); h.api.stop();
    const saved = h.database.get('subscriptions/state').subscriptions[0];
    delete saved.playlistName; delete saved.playlistNameCustomized; delete saved.playlistNameSource;
    fs.mkdirSync(path.join(h.root, '同名（网易云）')); fs.writeFileSync(path.join(h.root, '同名（网易云）', 'sentinel'), 'USER');
    const restored = harness('unused', h.database, h.root);
    const migrated = restored.view(sub.id); assert(migrated.directoryName.endsWith('（网易云）'));
    assert.notEqual(migrated.directoryName, '同名（网易云）'); assert(!fs.existsSync(path.join(h.root, '旧歌单')));
    assert(fs.existsSync(path.join(h.root, migrated.directoryName, 'A.flac')));
    assert.equal(fs.readFileSync(path.join(h.root, '同名（网易云）', 'sentinel'), 'utf8'), 'USER');
    restored.api.renameNavidromePlaylist(sub.id, '手动收藏'); restored.api.stop();
    const customSaved = h.database.get('subscriptions/state').subscriptions[0]; delete customSaved.playlistNameCustomized; delete customSaved.playlistNameSource;
    const again = harness('unused', h.database, h.root);
    assert.equal(again.view(sub.id).directoryName, '手动收藏'); assert.equal(again.api.getDownloadDirectory(song('A')), '手动收藏');
  });
  await check('Navidrome names remain independent of subscription titles and persist across restart', async () => {
    const h = harness('navidrome-rename'); h.add('A'); const sub = await h.subscribe('远端标题');
    const renamed = h.api.renameNavidromePlaylist(sub.id, '我的收藏');
    assert.equal(renamed.name, '我的收藏'); assert.equal(renamed.subscriptionName, '远端标题');
    assert.equal(renamed.playlistPath, '我的收藏/我的收藏.m3u8'); assert(!fs.existsSync(path.join(h.root, sub.directoryName)));
    assert.equal(h.api.getDownloadDirectory(song('A')), '我的收藏');
    h.remote([song('A'), song('C')]); await h.api.checkNow('shared', sub.id);
    assert.equal(h.api.getDownloadDirectory(song('C')), '我的收藏');
    await h.api.update('shared', sub.id, { enabled: false }); assert.equal(h.api.getDownloadDirectory(song('C')), '我的收藏');
    const unmatched = h.api.renameNavidromePlaylist('local-unmatched', '其他音乐');
    assert.equal(unmatched.name, '其他音乐'); h.api.reconcilePlaylists(); h.api.stop();
    const restored = harness('unused', h.database, h.root);
    assert.equal(restored.api.getUnmatchedPlaylist().name, '其他音乐');
    assert.equal(restored.api.getDownloadDirectory(song('C')), '我的收藏');
    assert.equal(restored.api.listNavidromePlaylists().find(item => item.id === sub.id).name, '我的收藏');
  });
  await check('Navidrome rejects conflicting and unsafe names without moving files', async () => {
    const h = harness('navidrome-conflicts'); h.add('A'); const sub = await h.subscribe(); const before = h.read(sub.id);
    fs.mkdirSync(path.join(h.root, '用户目录'));
    for (const name of ['', '../escape', 'CON', '用户目录']) assert.throws(() => h.api.renameNavidromePlaylist(sub.id, name));
    assert.equal(h.read(sub.id), before);
    h.deps.isDirectoryBusy = () => true;
    assert.throws(() => h.api.renameNavidromePlaylist(sub.id, '新名称'), /正在下载/); assert.equal(h.read(sub.id), before);
  });
  await check('waiting downloads follow the latest folder name and completed paths rebase after rename', async () => {
    const h = harness('navidrome-queue'); h.remote([song('A')]);
    let releaseScan, releaseWrite, destination;
    h.cache.downloadAndCache = async (_song, _url, _quality, _user, _signal, _download, _lyric, _embed, _provenance, options) => {
      destination = options.relativeDirectory;
      await new Promise(resolve => { releaseWrite = resolve; });
      const filename = `${destination}/A.flac`; h.add('A', filename); return filename;
    };
    const queue = load('src/server/serverDownloadQueue.ts', { './fileCache': h.cache, '@/storage/database': h.db });
    queue.setLocalMusicScanPromise(new Promise(resolve => { releaseScan = resolve; }));
    queue.initialize(async task => ({ url: 'fixture', songInfo: task.songInfo }));
    queue.setDirectoryResolver(songInfo => h.api.getDownloadDirectory(songInfo));
    queue.setCompletionListener(() => h.api.reconcilePlaylists());
    h.deps.enqueue = (_user, inputs) => queue.enqueue('shared', inputs);
    h.deps.getReadySongs = () => [...h.available, ...queue.getCompletedSongs()];
    h.deps.isDirectoryBusy = directory => queue.isDirectoryBusy(directory);
    h.deps.onDirectoryRenamed = (oldDir, newDir) => {
      for (const item of h.available) if (item.filename.startsWith(oldDir + '/')) item.filename = newDir + item.filename.slice(oldDir.length);
      queue.rebaseDirectory(oldDir, newDir);
    };
    const sub = await h.subscribe(); h.api.renameNavidromePlaylist(sub.id, '开始前改名');
    releaseScan(); await flush(); assert.equal(destination, '开始前改名', JSON.stringify(queue.list('shared')));
    assert.throws(() => h.api.renameNavidromePlaylist(sub.id, '写入中改名'), /正在下载/);
    releaseWrite(); await flush(); await flush();
    assert(fs.existsSync(path.join(h.root, '开始前改名/A.flac'))); assert(!fs.existsSync(path.join(h.root, 'A.flac')));
    h.api.renameNavidromePlaylist(sub.id, '完成后改名');
    assert.equal(queue.getCompletedSongs()[0].filename, '完成后改名/A.flac'); assert.equal(h.view(sub.id).playlistTrackCount, 1);
    assert(h.read(sub.id).includes('./A.flac'));
  });
  await check('legacy unmatched playlist name migrates without changing audio files', () => {
    const h = harness('unmatched-old-name'); h.add('A'); h.api.reconcilePlaylists(); h.api.stop();
    const saved = h.database.get('subscriptions/state').unmatchedPlaylist;
    files.renamePlaylistDirectory(h.root, saved, '本地未匹配', []); saved.name = '本地未匹配';
    const restored = harness('unused', h.database, h.root);
    assert.equal(restored.api.getUnmatchedPlaylist().name, '未匹配');
    assert.equal(restored.api.getUnmatchedPlaylist().playlistPath, '未匹配/未匹配.m3u8');
    assert(!fs.existsSync(path.join(h.root, '本地未匹配')));
    assert.equal(fs.readFileSync(path.join(h.root, 'A.flac'), 'utf8'), 'audio A');
  });
  await check('unmatched playlist works without subscriptions and references original audio only', () => {
    const h = harness('unmatched-empty');
    assert.equal(h.api.getUnmatchedPlaylist().playlistPath, '未匹配/未匹配.m3u8');
    h.add('A', '原目录/已有歌曲.mp3'); h.add('B', 'B.flac', false);
    h.api.reconcilePlaylists();
    assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 1);
    assert(h.readUnmatched().includes('./../原目录/已有歌曲.mp3')); assert(!h.readUnmatched().includes('B.flac'));
    assert.deepEqual(fs.readdirSync(path.join(h.root, '未匹配')).sort(), ['.lx-playlist.json', '未匹配.m3u8'].sort());
    assert.equal(h.queued.length, 0); assert.equal(fs.readFileSync(path.join(h.root, '原目录/已有歌曲.mp3'), 'utf8'), 'audio A');
    fs.unlinkSync(path.join(h.root, '原目录/已有歌曲.mp3')); h.api.rebuildPlaylist('shared', 'local-unmatched');
    assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 0);
  });
  await check('subscribe, paused snapshots, failed fetch, remote removals and unsubscribe reclassify local songs', async () => {
    const h = harness('unmatched-matching'); h.add('A'); h.add('B'); h.api.reconcilePlaylists();
    assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 2);
    h.remote([song('A')]); const sub = await h.subscribe();
    assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 1); assert(!h.readUnmatched().includes('A.flac'));
    await h.api.update('shared', sub.id, { enabled: false }); h.remote([song('B')]); await h.api.checkNow('shared', sub.id);
    assert(!h.readUnmatched().includes('A.flac')); assert(h.readUnmatched().includes('B.flac'));
    await h.api.update('shared', sub.id, { enabled: true }); h.fail(true); const before = h.readUnmatched();
    await assert.rejects(h.api.checkNow('shared', sub.id)); assert.equal(h.readUnmatched(), before);
    h.fail(false); await h.api.checkNow('shared', sub.id);
    assert(h.readUnmatched().includes('A.flac')); assert(!h.readUnmatched().includes('B.flac'));
    h.api.unsubscribe('shared', sub.id); assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 2);
    assert(fs.existsSync(path.join(h.root, sub.directoryName, 'A.flac')));
  });
  await check('unmatched matching merges source fallback aliases, metadata aliases and known copied files', async () => {
    const h = harness('unmatched-aliases'); h.remote([song('A')]); const sub = await h.subscribe();
    const original = h.add('download-id', 'actual.mp3'); original.name = 'different resolved title';
    h.available.push({ ...song('A'), filename: 'actual.mp3' });
    h.api.reconcilePlaylists(); assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 0);
    const copy = { ...song('unknown-copy'), filename: sub.directoryName + '/actual.mp3' };
    h.available.push(copy); h.api.reconcilePlaylists(); assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 0);
    h.remote([]); await h.api.checkNow('shared', sub.id); assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 1);
    assert(h.readUnmatched().includes('./../actual.mp3'));
    h.api.unsubscribe('shared', sub.id); h.api.reconcilePlaylists(); assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 1);
    const alternate = h.add('alternate', 'alternate.mp3'); alternate.name = 'different resolved title';
    h.api.reconcilePlaylists(); assert.equal(h.api.getUnmatchedPlaylist().playlistTrackCount, 1);
  });
  await check('unmatched filename collisions persist across restart without touching foreign files', () => {
    const folder = path.join(scratch, 'unmatched-collision'); fs.mkdirSync(folder); fs.mkdirSync(path.join(folder, '未匹配'));
    fs.writeFileSync(path.join(folder, '未匹配', '未匹配.m3u8'), 'USER PLAYLIST');
    const h = harness('unused', new Map(), folder); const file = h.api.getUnmatchedPlaylist().playlistPath;
    assert.notEqual(file, '未匹配/未匹配.m3u8'); h.api.stop();
    const restored = harness('unused', h.database, folder);
    assert.equal(restored.api.getUnmatchedPlaylist().playlistPath, file);
    assert.equal(fs.readFileSync(path.join(folder, '未匹配', '未匹配.m3u8'), 'utf8'), 'USER PLAYLIST');
  });
  await check('unmatched restart waits for initial scan and directory changes never reuse old-root entries', async () => {
    const h = harness('unmatched-scan'); h.add('A'); h.api.reconcilePlaylists(); h.api.stop(); const before = h.readUnmatched();
    let release; const initialScan = new Promise(resolve => { release = resolve; });
    const restored = harness('unused', h.database, h.root, initialScan);
    restored.api.reconcilePlaylists(); assert.equal(restored.readUnmatched(), before);
    assert.throws(() => restored.api.rebuildPlaylist('shared', 'local-unmatched'), /扫描/);
    restored.available.push({ ...song('A'), filename: 'A.flac' }); release(); await flush();
    assert.equal(restored.readUnmatched(), before);
    restored.setRoot(path.join(scratch, 'unmatched-new-root')); restored.add('B'); restored.api.notifyLocalScanComplete();
    assert(!restored.readUnmatched().includes('A.flac')); assert(restored.readUnmatched().includes('B.flac'));
    assert.equal(h.readUnmatched(), before);
  });
  await check('creation, download completion, sidecars, shared playlists and stable mapping', async () => {
    const h = harness('basic'); const first = await h.subscribe();
    assert.equal(h.queued.length, 2); assert.equal(h.view(first.id).playlistTrackCount, 0);
    assert(h.read(first.id).startsWith('#EXTM3U\n')); assert(!h.read(first.id).includes('.flac'));
    const a = h.add('A', '实际音质回退.mp3', false); h.api.reconcilePlaylists(); assert.equal(h.view(first.id).playlistTrackCount, 0);
    a.downloadComplete = true; fs.writeFileSync(path.join(h.root, '实际音质回退.lrc'), '[00:00]歌词');
    h.add('B'); h.api.reconcilePlaylists();
    assert.equal(h.view(first.id).playlistTrackCount, 2); assert(h.read(first.id).includes('./实际音质回退.mp3'));
    assert(fs.existsSync(path.join(h.root, first.directoryName, '实际音质回退.lrc')));
    assert(!h.read(first.id).includes('.lrc'));
    const second = await h.subscribe('每日推荐', 'two');
    assert.notEqual(first.directoryName, second.directoryName); assert.equal(h.view(second.id).playlistTrackCount, 2);
    assert.equal(h.queued.length, 2);
    const before = fs.readdirSync(path.join(h.root, first.directoryName));
    h.api.reconcilePlaylists(); assert.deepEqual(fs.readdirSync(path.join(h.root, first.directoryName)), before);
    const sourceStat = fs.statSync(path.join(h.root, 'B.flac'));
    assert.equal(fs.statSync(path.join(h.root, first.directoryName, 'B.flac')).ino, sourceStat.ino);
  });
  await check('remote order and removals, re-add reuse, failed fetch preserves bytes', async () => {
    const h = harness('order'); h.add('A'); h.add('B'); const sub = await h.subscribe();
    h.remote([song('B'), song('A')]); await h.api.checkNow('shared', sub.id);
    assert(h.read(sub.id).indexOf('B.flac') < h.read(sub.id).indexOf('A.flac'));
    h.remote([song('B')]); await h.api.checkNow('shared', sub.id);
    assert(!h.read(sub.id).includes('A.flac')); assert(fs.existsSync(path.join(h.root, sub.directoryName, 'A.flac')));
    h.remote([song('A'), song('B')]); await h.api.checkNow('shared', sub.id);
    assert.equal(fs.readdirSync(path.join(h.root, sub.directoryName)).filter(file => file.endsWith('.flac')).length, 2);
    const before = h.read(sub.id); h.fail(true);
    await assert.rejects(h.api.checkNow('shared', sub.id), /remote offline/); assert.equal(h.read(sub.id), before);
    h.fail(false); h.remote([]); await h.api.checkNow('shared', sub.id);
    assert.equal(h.view(sub.id).playlistTrackCount, 0); assert(fs.existsSync(path.join(h.root, 'A.flac')));
  });
  await check('pause freezes M3U8; resume reconciles; unsubscribe leaves static files', async () => {
    const h = harness('pause'); const sub = await h.subscribe(); const before = h.read(sub.id);
    await h.api.update('shared', sub.id, { enabled: false }); h.add('A'); h.api.reconcilePlaylists();
    await h.api.checkNow('shared', sub.id); assert.equal(h.read(sub.id), before);
    await h.api.update('shared', sub.id, { enabled: true }); assert.equal(h.view(sub.id).playlistTrackCount, 1);
    const file = path.join(h.root, h.view(sub.id).playlistPath); const content = h.read(sub.id);
    h.api.unsubscribe('shared', sub.id); h.add('B'); h.api.reconcilePlaylists();
    assert.equal(fs.readFileSync(file, 'utf8'), content); assert(fs.existsSync(path.join(h.root, sub.directoryName, 'A.flac')));
  });
  await check('unsubscribe during remote fetch cannot enqueue or change the static playlist', async () => {
    const h = harness('cancel-race'); const sub = await h.subscribe(); const file = path.join(h.root, sub.playlistPath);
    const before = fs.readFileSync(file, 'utf8'); const count = h.queued.length;
    let release; h.hook(() => new Promise(resolve => { release = resolve; })); h.remote([song('C')]);
    const pending = h.api.checkNow('shared', sub.id); await flush(); h.api.unsubscribe('shared', sub.id); release(); await pending;
    assert.equal(h.queued.length, count); assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  await check('restart preserves names, order and paths without refetching', async () => {
    const h = harness('restart'); h.add('A'); h.remote([song('A')]); const sub = await h.subscribe(); h.api.stop();
    const restored = harness('unused', h.database, h.root);
    assert.equal(restored.view(sub.id).directoryName, sub.directoryName);
    assert.equal(restored.view(sub.id).playlistTrackCount, 1); assert.equal(restored.queued.length, 0);
    assert.equal(restored.read(sub.id), h.read(sub.id));
  });
  await check('legacy subscriptions fetch complete snapshot and backfill on restart', async () => {
    const h = harness('legacy'); const sub = await h.subscribe(); h.api.stop();
    const saved = h.database.get('subscriptions/state'); const legacy = saved.subscriptions[0];
    delete legacy.remoteTracks; delete legacy.directoryName; delete legacy.playlistFilename; delete legacy.playlistRoot;
    const restored = harness('unused', h.database, h.root); await flush(); await flush();
    assert(restored.view(sub.id).directoryName); assert.equal(restored.queued.length, 2);
  });
  await check('explicit rename updates paths and conflicts never overwrite user files', async () => {
    const h = harness('rename'); h.add('A'); const sub = await h.subscribe();
    const changed = await h.api.update('shared', sub.id, { name: '新名称' });
    assert.equal(changed.playlistPath, '新名称/新名称.m3u8'); assert(h.read(sub.id).includes('./A.flac'));
    assert(!fs.existsSync(path.join(h.root, sub.directoryName)));
    fs.mkdirSync(path.join(h.root, '冲突')); fs.writeFileSync(path.join(h.root, '冲突', 'sentinel'), 'KEEP');
    await assert.rejects(h.api.update('shared', sub.id, { name: '冲突' }), /已存在/);
    assert.equal(h.view(sub.id).name, '新名称'); assert.equal(fs.readFileSync(path.join(h.root, '冲突', 'sentinel'), 'utf8'), 'KEEP');
  });
  await check('missing audio reconciliation and explicit rebuild never emit nonexistent paths', async () => {
    const h = harness('missing'); h.add('A'); const sub = await h.subscribe();
    fs.unlinkSync(path.join(h.root, 'A.flac')); fs.unlinkSync(path.join(h.root, sub.directoryName, 'A.flac'));
    h.api.rebuildPlaylist('shared', sub.id); assert.equal(h.view(sub.id).playlistTrackCount, 0);
    assert(!h.read(sub.id).includes('.flac'));
  });
  await check('directory changes clear old-root mappings and protect foreign directories', async () => {
    const h = harness('root-change'); h.add('A'); const sub = await h.subscribe(); const oldRoot = h.root;
    h.setRoot(path.join(scratch, 'new-root')); h.api.reconcilePlaylists(); assert.equal(h.view(sub.id).playlistTrackCount, 0);
    assert(fs.existsSync(path.join(oldRoot, sub.playlistPath)));
    h.setRoot(path.join(scratch, 'foreign-root')); fs.mkdirSync(path.join(h.root, sub.directoryName));
    fs.writeFileSync(path.join(h.root, sub.playlistPath), 'USER PLAYLIST'); h.api.reconcilePlaylists();
    assert(h.view(sub.id).playlistLastError); assert.equal(fs.readFileSync(path.join(h.root, sub.playlistPath), 'utf8'), 'USER PLAYLIST');
  });
  await check('portable names, hostile paths, junction escapes and leading-hash tracks', () => {
    for (const value of ['CON', 'con.txt', 'PRN', 'COM1', 'LPT9', '...', 'a<>:"/\\|?*', '😀'.repeat(200)]) {
      const safe = files.sanitizePlaylistName(value); assert(safe); assert(!/[<>:"/\\|?*]|[ .]$/.test(safe)); assert(Array.from(safe).length <= 65);
    }
    const dir = path.join(scratch, 'safety'); fs.mkdirSync(dir);
    for (const value of ['../escape', 'C:\\escape', '/escape', 'x/../../escape', 'x:secret', 'x\n.mp3']) assert.throws(() => files.safePath(dir, value));
    const outside = path.join(scratch, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(dir, 'jump'), 'junction');
    assert.throws(() => files.safePath(dir, 'jump/a.mp3'));
    const sub = { id: 'test', name: 'hash' }; files.ensurePlaylistDirectory(dir, sub);
    fs.writeFileSync(path.join(dir, sub.directoryName, '#song.mp3'), 'AUDIO');
    files.writePlaylistAtomic(dir, sub, [sub.directoryName + '/#song.mp3']);
    assert(fs.readFileSync(path.join(dir, sub.directoryName, sub.playlistFilename), 'utf8').includes('./#song.mp3'));
  });
  await check('hardlink failure copies bytes; filename collision preserves user audio', () => {
    const dir = path.join(scratch, 'copy'); fs.mkdirSync(dir); const sub = { id: 'copy', name: 'copy' }; files.ensurePlaylistDirectory(dir, sub);
    fs.writeFileSync(path.join(dir, 'A.flac'), 'SOURCE'); fs.writeFileSync(path.join(dir, sub.directoryName, 'A.flac'), 'USER');
    const fakeFs = Object.create(fs); fakeFs.linkSync = () => { throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); };
    const copyFiles = load('src/server/playlistFileManager.ts', { 'node:fs': fakeFs, '@/utils/pathSafety': safety });
    const relative = copyFiles.materializeTrack(dir, sub.directoryName, 'A', 'A.flac');
    assert.equal(fs.readFileSync(path.join(dir, relative), 'utf8'), 'SOURCE');
    assert.equal(fs.readFileSync(path.join(dir, sub.directoryName, 'A.flac'), 'utf8'), 'USER');
  });
  await check('atomic replacement failure preserves old M3U8 and cleans only own temporary file', () => {
    const dir = path.join(scratch, 'atomic'); fs.mkdirSync(dir); const sub = { id: 'atomic', name: 'atomic' }; files.ensurePlaylistDirectory(dir, sub);
    files.writePlaylistAtomic(dir, sub, []); const target = path.join(dir, sub.directoryName, sub.playlistFilename); const before = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(path.join(dir, sub.directoryName, 'A.mp3'), 'AUDIO');
    const fakeFs = Object.create(fs); fakeFs.renameSync = () => { throw new Error('read only'); };
    const faulty = load('src/server/playlistFileManager.ts', { 'node:fs': fakeFs, '@/utils/pathSafety': safety });
    assert.throws(() => faulty.writePlaylistAtomic(dir, sub, [sub.directoryName + '/A.mp3']), /read only/);
    assert.equal(fs.readFileSync(target, 'utf8'), before); assert(!fs.readdirSync(path.dirname(target)).some(name => name.endsWith('.tmp')));
  });
  await check('one persisted queue task supplies multiple subscriptions after source fallback', async () => {
    const h = harness('queue'); h.remote([song('A')]);
    let release, downloads = 0;
    h.cache.downloadAndCache = async () => { downloads++; await new Promise(resolve => { release = resolve; }); h.add('resolved-id', 'final.mp3'); return 'final.mp3'; };
    const queue = load('src/server/serverDownloadQueue.ts', { './fileCache': h.cache, '@/storage/database': h.db });
    queue.initialize(async () => ({ url: 'fixture', songInfo: { ...song('resolved-id'), name: '解析后名称' }, quality: '128k' }));
    h.deps.enqueue = (_user, tasks) => queue.enqueue('shared', tasks);
    h.deps.getReadySongs = () => [...h.available, ...queue.getCompletedSongs()];
    queue.setCompletionListener(() => h.api.reconcilePlaylists());
    const first = await h.subscribe('First', 'first'); await flush();
    const second = await h.subscribe('Second', 'second'); await flush();
    // The resolver may change metadata/ID; dedup must still use original input identity.
    assert.equal(downloads, 1); assert.equal(queue.list('shared').length, 1);
    release(); await flush(); await flush();
    assert.equal(h.view(first.id).playlistTrackCount, 1); assert.equal(h.view(second.id).playlistTrackCount, 1);
    assert(h.read(second.id).includes('./final.mp3'));
    const third = await h.subscribe('Third', 'third'); await flush();
    assert.equal(downloads, 1); assert.equal(h.view(third.id).playlistTrackCount, 1);
    const persisted = h.database.get('tasks'); assert.equal(persisted[0].finalRelativePath, 'final.mp3'); assert.equal(persisted[0].originalSongInfo.id, 'A');
  });
  await check('restart resumes the persisted queue and completes the saved subscription', async () => {
    const h = harness('queue-restart'); h.remote([song('A')]);
    const queue = load('src/server/serverDownloadQueue.ts', { './fileCache': h.cache, '@/storage/database': h.db });
    queue.setLocalMusicScanPromise(new Promise(() => {})); queue.initialize(async () => { throw new Error('must wait for scan'); });
    h.deps.enqueue = (_user, tasks) => queue.enqueue('shared', tasks);
    const sub = await h.subscribe(); h.api.stop(); assert.equal(h.database.get('tasks')[0].status, 'waiting');
    const restarted = harness('unused', h.database, h.root);
    restarted.cache.downloadAndCache = async () => { restarted.add('A', 'resumed.flac'); return 'resumed.flac'; };
    const restoredQueue = load('src/server/serverDownloadQueue.ts', { './fileCache': restarted.cache, '@/storage/database': restarted.db });
    restarted.deps.getReadySongs = () => [...restarted.available, ...restoredQueue.getCompletedSongs()];
    restoredQueue.setCompletionListener(() => restarted.api.reconcilePlaylists());
    restoredQueue.initialize(async task => ({ url: 'fixture', songInfo: task.songInfo })); await flush(); await flush();
    assert.equal(restoredQueue.list('shared')[0].status, 'finished'); assert.equal(restarted.view(sub.id).playlistTrackCount, 1);
    assert(restarted.read(sub.id).includes('./resumed.flac'));
  });
  await check('failed directory rename rolls back both playlist filename and subscription paths', async () => {
    const h = harness('rename-rollback'); h.add('A'); const sub = await h.subscribe();
    const fakeFs = Object.create(fs);
    fakeFs.renameSync = (from, to) => { if (fs.statSync(from).isDirectory()) throw new Error('directory busy'); return fs.renameSync(from, to); };
    const faulty = load('src/server/playlistFileManager.ts', { 'node:fs': fakeFs, '@/utils/pathSafety': safety });
    const saved = h.database.get('subscriptions/state').subscriptions[0]; const before = clone(saved);
    assert.throws(() => faulty.renamePlaylistDirectory(h.root, saved, 'rename failed', []), /directory busy/);
    assert.equal(saved.directoryName, before.directoryName); assert.equal(saved.playlistFilename, before.playlistFilename);
    assert(fs.existsSync(path.join(h.root, sub.playlistPath))); assert(!fs.existsSync(path.join(h.root, sub.directoryName, 'rename failed.m3u8')));
  });
  await check('subscription UI escapes sync paths/errors and rebuild invokes the authenticated API wrapper', async () => {
    const container = {}, notices = [], window = { showSuccess: message => notices.push(message), showError: message => { throw new Error(message); } };
    const context = vm.createContext({ window, document: { addEventListener() {}, getElementById: id => id === 'subscription-page' ? container : null },
      showSuccess: window.showSuccess, showError: window.showError, console: quiet, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(root, 'public/music/js/subscription_manager.js'), 'utf8'), context);
    const manager = window.SubscriptionManager;
    manager.load = async () => {}; manager.cache = [{ id: 'fixture', source: 'wy', name: '<img src=x onerror=alert(1)>', stats: {}, playlistPath: '<path>.m3u8', playlistLastError: '<error>', knownCount: 1 }];
    manager.unmatchedPlaylist = { id: 'local-unmatched', playlistPath: '<unmatched>.m3u8', playlistLastError: '<unmatched-error>' };
    await manager.renderSettingsPanel(); assert(!container.innerHTML.includes('<img src=x')); assert(container.innerHTML.includes('&lt;path&gt;')); assert(container.innerHTML.includes('&lt;error&gt;'));
    assert(container.innerHTML.includes('&lt;unmatched&gt;')); assert(container.innerHTML.includes('&lt;unmatched-error&gt;'));
    manager._api = async (url, method, body) => { assert.equal(url, '/subscriptions/rebuild'); assert.equal(method, 'POST'); assert.equal(body.id, 'fixture'); return { data: { ...manager.cache[0], playlistTrackCount: 1 } }; };
    const button = {}; await manager.rebuild('fixture', button); assert.equal(button.disabled, false); assert.equal(notices.length, 1);
    manager._api = async (url, method, body) => { assert.equal(url, '/subscriptions/rebuild'); assert.equal(method, 'POST'); assert.equal(body.id, 'local-unmatched'); return { data: { ...manager.unmatchedPlaylist, playlistTrackCount: 3 } }; };
    await manager.rebuild('local-unmatched', button); assert.equal(manager.unmatchedPlaylist.playlistTrackCount, 3); assert.equal(manager.cache[0].id, 'fixture'); assert.equal(button.disabled, false);
  });
  console.log(`\n${passed} playlist sync checks passed. Production music and SQLite were not accessed.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  // Verify the resolved disposable target before recursive cleanup.
  assert(scratch.startsWith(path.join(root, 'temp') + path.sep));
  fs.rmSync(scratch, { recursive: true, force: true });
});
