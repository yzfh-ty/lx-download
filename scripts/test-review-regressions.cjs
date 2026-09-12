// Run with: node scripts/test-review-regressions.cjs
// Uses disposable fixtures, an in-memory database and a loopback-only HTTP server.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(root, 'temp', 'review-regression-'));
const quiet = { log() {}, warn() {}, error() {} };
const results = [];
const timers = new Set();
const timeout = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; };
const realProcess = process;

function declarations(file, names) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = new Map();
  function walk(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(ast).replace(/^export\s+/, ''));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) found.set(node.name.text, `let ${node.getText(ast)};`);
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return names.map(name => { assert(found.has(name), `Missing ${file}: ${name}`); return found.get(name); }).join('\n');
}
function evaluate(source, names = [], globals = {}) {
  const context = vm.createContext({ console: quiet, Buffer, URL, AbortController, setTimeout: timeout, clearTimeout, setImmediate, exports: {}, ...globals });
  const code = ts.transpileModule(`${source}\nglobalThis.extracted = {${names.join(',')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInContext(code, context);
  return { ...context.extracted, exports: context.exports };
}
function extract(file, names, globals) { return evaluate(declarations(file, names), names, globals); }
const safety = evaluate(fs.readFileSync(path.join(root, 'src/utils/pathSafety.ts'), 'utf8'), [], { require }).exports;
function fileCacheHarness(folder) {
  const cwd = path.join(scratch, folder); fs.mkdirSync(cwd, { recursive: true });
  const db = new Map();
  const fakeRequire = name => {
    if (name === '@/storage/database') return {
      loadCacheItems: key => db.get(key) || [],
      saveCacheItems: (key, entries) => db.set(key, [...entries].map(([key, value]) => [key, { ...value }]))
    };
    if (name === '@/utils/pathSafety') return safety;
    if (name === 'music-tag-native') return { MusicTagger: class { loadPath() { throw new Error('Native tags excluded from regression fixtures'); } dispose() {} }, MetaPicture: class {} };
    if (name === '../common/utils/musicMeta') return { setMeta: async () => false };
    if (name === '../utils/lrcTool') return { buildLyrics: () => '', parseLyrics: () => ({}) };
    if (name === '../common/utils/common') return { formatPlayTime: () => '00:00' };
    if (name === 'file-type') return { fileTypeFromFile: async () => null };
    return require(name);
  };
  const source = fs.readFileSync(path.join(root, 'src/server/fileCache.ts'), 'utf8');
  const module = evaluate(source, ['getFileName', 'allocateDownloadTempPath', 'activeDownloadPaths', 'installDownloadedFile'], {
    require: fakeRequire, process: { cwd: () => cwd }, global: { lx: { config: {} } }
  });
  module.exports.setDownloadDir(path.join(cwd, 'download'));
  return { api: module.exports, internals: module, cwd, db };
}
async function check(name, fn) {
  await fn(); results.push(name); console.log(`PASS ${name}`);
}
const song = id => ({ id: String(id), songmid: String(id), name: 'Same name', singer: 'Artist', source: 'wy' });
const audio = marker => Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(4096, marker)]);
const options = { fileNamePattern: 'name-artist', embedMetadata: false, embedCover: false, embedLyric: false, downloadLyric: false };
let server;

async function main() {
  for (const mode of ['success', 'download-failure', 'cancel', 'rollback']) {
    await check(`R01 remaster ${mode} preserves unrelated files and index`, async () => {
      const { api, cwd } = fileCacheHarness('remaster-' + mode);
      const music = api.getCacheDir('shared', true);
      const covers = api.getCoverCacheDir('shared');
      const old = { id: 'wy_1', songmid: 'wy_1', source: 'wy', quality: '128k', filename: 'original.mp3', name: 'Original', singer: 'Artist' };
      const other = { ...old, id: 'wy_2', songmid: 'wy_2', filename: 'unrelated.mp3' };
      fs.writeFileSync(path.join(music, old.filename), 'ORIGINAL'); fs.writeFileSync(path.join(music, other.filename), 'UNRELATED');
      fs.writeFileSync(path.join(covers, 'sentinel.bin'), 'COVER');
      api.indexManager.update('shared', old, 'music'); api.indexManager.update('shared', other, 'music');
      const controller = new AbortController();
      api.downloadAndCache = async (_song, _url, _quality, username) => {
        assert.notEqual(api.getCacheDir(username, true), music);
        assert.notEqual(api.getCoverCacheDir(username), covers);
        assert.equal(api.indexManager.getAll(username, 'music').length, 0);
        if (mode === 'download-failure') throw new Error('fixture failure');
        fs.writeFileSync(path.join(api.getCacheDir(username, true), 'replacement.flac'), audio(1));
        api.indexManager.update(username, { ...old, quality: 'flac', filename: 'replacement.flac', ext: 'flac' }, 'music');
        if (mode === 'cancel') controller.abort();
      };
      const update = api.indexManager.update.bind(api.indexManager);
      let injected = false;
      api.indexManager.update = (username, item, ...rest) => {
        if (mode === 'rollback' && username === 'shared' && item.quality === 'flac' && !injected) { injected = true; throw new Error('fixture index failure'); }
        return update(username, item, ...rest);
      };
      const attempt = api.replaceDownloadedMusicItem('shared', old, song(1), 'https://fixture.invalid', 'flac', controller.signal);
      if (mode === 'success') {
        const replacement = await attempt; assert(fs.existsSync(path.join(music, replacement.filename)));
        assert.equal(api.indexManager.get('shared', 'wy_1', 'music', 'flac', true).quality, 'flac');
      } else {
        await assert.rejects(attempt);
        assert.equal(fs.readFileSync(path.join(music, old.filename), 'utf8'), 'ORIGINAL');
        assert.equal(api.indexManager.get('shared', 'wy_1', 'music', '128k', true).filename, old.filename);
      }
      assert.equal(fs.readFileSync(path.join(music, other.filename), 'utf8'), 'UNRELATED');
      assert.equal(fs.readFileSync(path.join(covers, 'sentinel.bin'), 'utf8'), 'COVER');
      assert(api.indexManager.get('shared', other.id, 'music', other.quality, true));
      assert.equal(fs.readdirSync(path.join(cwd, 'cache', 'remaster')).length, 0);
    });
  }

  const rangeRequests = [];
  server = http.createServer((req, res) => {
    const content = req.url === '/mp3' ? Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 3)]) : audio(req.url === '/two' ? 2 : 1);
    if (req.url === '/broken') { res.writeHead(200, { 'Content-Length': content.length }); res.write(content.subarray(0, 100)); timeout(() => res.destroy(), 15); return; }
    const start = req.headers.range ? Number(req.headers.range.match(/bytes=(\d+)-/)[1]) : 0;
    rangeRequests.push(req.headers.range || '');
    res.writeHead(start ? 206 : 200, { 'Content-Type': 'audio/flac', 'Content-Length': content.length - start, ...(start ? { 'Content-Range': `bytes ${start}-${content.length - 1}/${content.length}` } : {}) });
    res.end(content.subarray(start));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await check('R02 simultaneous same-name downloads keep distinct bytes', async () => {
    const { api } = fileCacheHarness('concurrent');
    const finalPaths = await Promise.all([api.downloadAndCache(song(1), base + '/one', 'flac', 'shared', undefined, true, false, false, {}, options), api.downloadAndCache(song(2), base + '/two', 'flac', 'shared', undefined, true, false, false, {}, options)]);
    const items = api.indexManager.getAll('shared', 'music'); assert.equal(items.length, 2); assert.notEqual(items[0].filename, items[1].filename);
    assert.deepEqual([...finalPaths].sort(), Array.from(items, item => item.filename).sort());
    assert.equal(api.getReadyDownloadedSongs().length, 2); assert(items.every(item => item.downloadComplete === true));
    const files = items.map(item => fs.readFileSync(path.join(api.getCacheDir('shared', true), item.filename)));
    assert(files.some(buffer => buffer.equals(audio(1)))); assert(files.some(buffer => buffer.equals(audio(2))));
  });
  await check('R02 three qualities and long names never overwrite', async () => {
    const { api } = fileCacheHarness('qualities');
    for (const quality of ['flac', 'flac24bit', 'hires']) await api.downloadAndCache({ ...song(1), name: 'Long'.repeat(80) }, base + '/one', quality, 'shared', undefined, true, false, false, {}, options);
    const items = api.indexManager.getAll('shared', 'music'); assert.equal(items.length, 3); assert.equal(new Set(items.map(item => item.filename)).size, 3);
    for (const item of items) assert(fs.existsSync(path.join(api.getCacheDir('shared', true), item.filename)));
  });
  await check('R02 concurrent MP3 and FLAC reserve different sidecar names', async () => {
    const { api } = fileCacheHarness('containers');
    await Promise.all([api.downloadAndCache(song(1), base + '/mp3', '128k', 'shared', undefined, true, false, false, {}, options), api.downloadAndCache(song(2), base + '/one', 'flac', 'shared', undefined, true, false, false, {}, options)]);
    const items = api.indexManager.getAll('shared', 'music'); assert.equal(items.length, 2);
    assert.equal(new Set(items.map(item => path.basename(item.filename, path.extname(item.filename)))).size, 2);
  });
  await check('Existing local song is detected across source IDs and qualities', () => {
    const { api } = fileCacheHarness('song-dedup');
    const music = api.getCacheDir('shared', true);
    const item = { id: 'unknown_legacy', songmid: 'unknown_legacy', source: 'unknown', quality: '320k', name: '已有歌曲', singer: '歌手', filename: '已有歌曲 - 歌手.mp3' };
    fs.writeFileSync(path.join(music, item.filename), 'LOCAL'); api.indexManager.update('shared', item, 'music');
    assert.equal(api.isSongCached({ id: 'wy_123', source: 'wy', name: '已有歌曲', singer: '歌手', quality: 'flac24bit' }, 'shared'), true);
  });
  await check('R08 interrupted response rejects, closes writer and resumes exact bytes', async () => {
    const { api } = fileCacheHarness('interrupted');
    await assert.rejects(api.downloadAndCache(song(1), base + '/broken', 'flac', 'shared', undefined, true, false, false, {}, options), /aborted|closed/);
    const music = api.getCacheDir('shared', true);
    const temps = fs.readdirSync(music).filter(name => name.endsWith('.tmp')); assert.equal(temps.length, 1);
    const offset = fs.statSync(path.join(music, temps[0])).size; assert(offset > 10);
    await api.downloadAndCache(song(1), base + '/one', 'flac', 'shared', undefined, true, false, false, {}, options);
    assert(rangeRequests.includes(`bytes=${offset - 10}-`));
    const [item] = api.indexManager.getAll('shared', 'music'); assert(fs.readFileSync(path.join(music, item.filename)).equals(audio(1)));
    assert.equal(fs.readdirSync(music).filter(name => name.endsWith('.tmp')).length, 0);
  });
  await check('R03 overlap and junction overlap rejected; valid cache clearing preserves music', () => {
    const { api, cwd } = fileCacheHarness('paths');
    const cache = api.getCacheDir('shared', false), music = api.getCacheDir('shared', true);
    for (const invalid of [cache, path.join(cache, 'sub'), cwd]) assert.throws(() => api.setDownloadDir(invalid));
    const link = path.join(cwd, 'cache-link'); fs.symlinkSync(path.join(cwd, 'cache'), link, 'junction');
    assert.throws(() => api.setDownloadDir(path.join(link, 'new-child')));
    fs.writeFileSync(path.join(cache, 'cache.mp3'), 'CACHE'); fs.writeFileSync(path.join(music, 'music.mp3'), 'MUSIC');
    api.clearAllCache('shared'); assert.equal(fs.readFileSync(path.join(music, 'music.mp3'), 'utf8'), 'MUSIC');
  });
  function subscriptions(fetch, enqueue, getCachedSongs) {
    const source = fs.readFileSync(path.join(root, 'src/server/playlistSubscription.ts'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
    const api = evaluate(source, ['initialize', 'subscribe', 'update', 'checkNow', 'list'], {
      fileCache: { normalizeSongId: item => item.id }, getJson: (_n, _k, fallback) => fallback, setJson() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1
    });
    api.initialize({ musicSdk: { mg: { songList: { getListDetail: fetch }, leaderboard: { getList: fetch } } }, normalizeSongInfo: song => song, enqueue, getCachedSongs }); return api;
  }
  await check('R04 pause/check/resume queues new songs exactly once', async () => {
    let list = [{ id: 'A' }]; const queued = [];
    const api = subscriptions(async () => ({ list, total: list.length }), (_u, tasks) => { queued.push(...tasks); return tasks; });
    const sub = await api.subscribe('shared', { source: 'mg', sourceListId: 'fixture' });
    await api.update('shared', sub.id, { enabled: false }); list = [...list, { id: 'B' }];
    await api.checkNow('shared', sub.id); await api.update('shared', sub.id, { enabled: true }); await api.checkNow('shared', sub.id); await api.checkNow('shared', sub.id);
    assert.deepEqual(queued.map(item => item.songInfo.id), ['A', 'B']);
  });
  await check('Subscription update skips an existing local song across source IDs and qualities', async () => {
    let list = [{ id: 'A', name: '已有歌曲', singer: '歌手', quality: 'flac24bit' }]; const queued = [];
    const api = subscriptions(async () => ({ list, total: list.length }), (_u, tasks) => { queued.push(...tasks); return tasks; }, async () => [{
      songInfo: { id: 'legacy-file-id', name: '已有歌曲', singer: '歌手' }, quality: '320k'
    }]);
    const sub = await api.subscribe('shared', { source: 'mg', sourceListId: 'fixture', quality: 'flac24bit' });
    assert.deepEqual(queued, []);
    list = [
      { id: 'legacy-remote-id', name: '已有歌曲', singer: '歌手', quality: 'flac24bit' },
      { id: 'B', name: '新增歌曲', singer: '歌手', quality: 'flac24bit' }
    ];
    const [result] = await api.checkNow('shared', sub.id);
    assert.equal(result.skippedExisting, 1); assert.equal(result.enqueued, 1);
    assert.deepEqual(queued.map(item => item.songInfo.id), ['B']);
  });
  await check('Leaderboard subscription uses the leaderboard provider', async () => {
    const queued = [];
    const api = subscriptions(async () => ({ list: [{ id: 'A' }], total: 1 }), (_u, tasks) => { queued.push(...tasks); return tasks; });
    const sub = await api.subscribe('shared', { kind: 'leaderboard', source: 'mg', sourceListId: '666' });
    assert.equal(sub.kind, 'leaderboard'); assert.deepEqual(queued.map(item => item.songInfo.id), ['A']);
  });
  await check('Server queue waits for local scan and deduplicates concurrent songs', async () => {
    const source = fs.readFileSync(path.join(root, 'src/server/serverDownloadQueue.ts'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
    let releaseScan;
    const scan = new Promise(resolve => { releaseScan = resolve; });
    const resolved = [];
    const api = evaluate(source, ['setLocalMusicScanPromise', 'initialize', 'enqueue', 'list'], {
      fileCache: {
        cacheProgress: new Map(), normalizeSongId: item => item.id, isSongCached: () => false,
        downloadAndCache: async () => {}
      },
      getJson: (_n, _k, fallback) => fallback, loadDownloadTasks: () => [], saveDownloadTasks: () => {}, setJson() {}
    });
    api.setLocalMusicScanPromise(scan);
    api.initialize(async task => { resolved.push(task.id); return { url: 'fixture', quality: task.requestedQuality, songInfo: task.songInfo }; });
    const added = api.enqueue('shared', [
      { id: 'A', songInfo: { id: 'A', name: '同一首歌', singer: '歌手' }, quality: '320k' },
      { id: 'B', songInfo: { id: 'B', name: '同一首歌', singer: '歌手' }, quality: 'flac24bit' }
    ]);
    assert.equal(added.length, 1); assert.equal(api.list('shared')[0].status, 'waiting'); assert.deepEqual(resolved, []);
    releaseScan(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(resolved, ['A']);
  });
  await check('R05 1050 songs fully fetched; incomplete page preserves snapshot', async () => {
    let incomplete = false;
    const api = subscriptions(async (_id, page) => ({ list: incomplete && page === 2 ? [] : Array.from({ length: 50 }, (_, i) => ({ id: String((page - 1) * 50 + i) })), total: 1050 }), (_u, tasks) => tasks);
    const sub = await api.subscribe('shared', { source: 'mg', sourceListId: 'fixture' }); assert.equal(sub.knownCount, 1050);
    incomplete = true; await assert.rejects(api.checkNow('shared', sub.id), /不完整/); assert.equal(api.list('shared')[0].knownCount, 1050);
  });
  await check('R06 malformed cookies ignored; R07 token rotation and logout invalidate sessions', () => {
    const config = { 'player.token': 'synthetic-old' };
    const api = extract('src/server/server.ts', ['AUTH_COOKIE_NAME', 'AUTH_COOKIE_MAX_AGE_SECONDS', 'authSessions', 'sessionAccessToken', 'refreshAuthSessions', 'getConfiguredAccessToken', 'parseCookies', 'getRequestAccessToken', 'createAuthSession', 'checkPlayerAuth'], { global: { lx: { config } }, crypto: require('node:crypto') });
    let session = api.createAuthSession(); const req = () => ({ headers: { cookie: `unrelated=%; lx_auth_token=${session}` } });
    assert(api.checkPlayerAuth(req())); config['player.token'] = 'synthetic-new'; assert(!api.checkPlayerAuth(req()));
    session = api.createAuthSession(); assert(api.checkPlayerAuth(req())); api.authSessions.delete(session); assert(!api.checkPlayerAuth(req()));
  });
  await check('R11 sibling directory and junction escapes rejected', () => {
    const data = path.join(scratch, 'data'), sibling = path.join(scratch, 'data-backup');
    fs.mkdirSync(data); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'fixture.txt'), 'PRIVATE');
    assert(!safety.isPathWithin(path.join(data, '../data-backup/fixture.txt'), data, false));
    const link = path.join(data, 'outside'); fs.symlinkSync(sibling, link, 'junction');
    assert(!safety.isPathWithin(path.join(link, 'fixture.txt'), data, false));
    assert(safety.isPathWithin(path.join(data, 'new-file.txt'), data, false));
  });
  await check('R06/R07/R11 real HTTP authentication and file boundary regression', async () => {
    const { api, cwd } = fileCacheHarness('http-app');
    const dataPath = path.join(cwd, 'data'); fs.mkdirSync(dataPath);
    fs.mkdirSync(path.join(cwd, 'data-backup')); fs.writeFileSync(path.join(cwd, 'data-backup', 'private.txt'), 'PRIVATE');
    fs.writeFileSync(path.join(dataPath, 'allowed.txt'), 'ALLOWED');
    const config = { 'player.token': 'synthetic-login-token', 'player.path': '/' };
    let appServer;
    const log = { info() {}, warn() {}, error() {} };
    const source = fs.readFileSync(path.join(root, 'src/server/server.ts'), 'utf8') + '\nexport { handleStartServer };';
    const module = evaluate(source, [], {
      global: { lx: { config, dataPath, staticPath: path.join(cwd, 'public') } }, process: { cwd: () => cwd },
      require: name => {
        if (name === 'node:http') return { ...http, createServer: handler => { appServer = http.createServer(handler); return appServer; } };
        if (name === '@/utils/tools') return { getIP: () => '127.0.0.1' };
        if (name === '@/utils/log4js') return { accessLog: log, startupLog: log, loginLog: log };
        if (name === '@/utils/pathSafety') return safety;
        if (name === '@/utils/configLog') return extract('src/utils/configLog.ts', ['formatConfigLogValue']);
        if (name === './fileCache') return api;
        if (name === './serverDownloadQueue') return { list: () => [], setLocalMusicScanPromise() {} };
        if (name === '@/storage/database') return { getJson: (_n, _k, fallback) => fallback, setJson() {} };
        if (name.startsWith('./') || name.startsWith('@/')) return {};
        return require(name);
      }
    });
    try {
      await module.exports.handleStartServer(0, '127.0.0.1');
      const origin = `http://127.0.0.1:${appServer.address().port}`;
      const login = await fetch(origin + '/api/music/auth', { method: 'POST', body: JSON.stringify({ token: config['player.token'] }) });
      assert.equal((await login.json()).success, true);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const headers = { Cookie: cookie + '; unrelated=%', Origin: origin };
      assert.equal((await fetch(origin + '/api/user/settings', { headers })).status, 200);
      const oldDownloadDir = api.getDownloadDir();
      const invalid = await fetch(origin + '/api/music/cache/config', { method: 'POST', headers, body: JSON.stringify({ downloadDir: path.join(cwd, 'cache', 'files') }) });
      assert.equal(invalid.status, 400); assert.match((await invalid.json()).message, /下载目录/); assert.equal(api.getDownloadDir(), oldDownloadDir);
      assert.equal((await fetch(origin + '/api/user/settings', { headers: { Cookie: 'unrelated=%', Origin: origin } })).status, 401);
      assert.equal((await fetch(origin + '/api/files/download?path=../data-backup/private.txt', { headers })).status, 403);
      assert.equal(await (await fetch(origin + '/api/files/download?path=allowed.txt', { headers })).text(), 'ALLOWED');
      config['player.token'] = 'synthetic-replacement-token';
      assert.equal((await fetch(origin + '/api/user/settings', { headers })).status, 401);
      const fresh = await fetch(origin + '/api/music/auth', { method: 'POST', body: JSON.stringify({ token: config['player.token'] }) });
      assert.equal((await fresh.json()).success, true);
    } finally {
      if (appServer) { appServer.closeAllConnections(); await new Promise(resolve => appServer.close(resolve)); }
    }
  });
  const html = extract('public/music/app.js', ['escapeHtmlText', 'htmlJs', 'safeImageUrl', 'htmlImageUrl'], { window: { location: { href: 'http://localhost/' } } });
  await check('R09 templates escape names, attributes and inline handler data', () => {
    const element = {}; const payload = '<img src=x onerror="globalThis.pwned=1">';
    const api = extract('public/music/js/songlist_manager.js', ['renderList'], { ...html, document: { getElementById: () => element }, window: {}, currentState: { source: 'wy', list: [{ id: "x');globalThis.pwned=1;//", name: payload, author: payload, img: 'javascript:alert(1)' }] } });
    api.renderList(); assert(!element.innerHTML.includes(payload)); assert(!element.innerHTML.includes('javascript:')); assert(element.innerHTML.includes('&lt;img'));
    const value = "'\"&quot;\\<>&\n";
    const decoded = html.htmlJs(value).replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    assert.equal(vm.runInNewContext(decoded), value);
  });
  await check('R10 Enter respects cancel; confirmation and Escape remain usable', async () => {
    function dialog() {
      const elements = [], listeners = {};
      const document = { activeElement: null, createElement(tag) { const events = {}; const node = { tag, append() {}, setAttribute() {}, addEventListener: (name, fn) => events[name] = fn, remove() {}, focus() { document.activeElement = node; }, events }; elements.push(node); return node; }, body: { appendChild() {} }, addEventListener: (name, fn) => listeners[name] = fn, removeEventListener() {} };
      const { showSelect } = extract('public/music/app.js', ['showSelect'], { document, setTimeout: fn => fn() });
      const promise = showSelect('Confirm', 'Fixture', { danger: true });
      return { elements, listeners, document, promise };
    }
    const cancel = dialog(); assert.equal(cancel.document.activeElement.textContent, '取消');
    cancel.listeners.keydown({ key: 'Enter' }); cancel.document.activeElement.events.click(); assert.equal(await cancel.promise, false);
    const confirm = dialog(); confirm.elements.find(node => node.textContent === '确定').events.click(); assert.equal(await confirm.promise, true);
    const escape = dialog(); escape.listeners.keydown({ key: 'Escape', preventDefault() {} }); assert.equal(await escape.promise, false);
  });
  await check('R12 token and proxy secrets redacted without changing config values', () => {
    const { formatConfigLogValue } = extract('src/utils/configLog.ts', ['formatConfigLogValue']);
    const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8'); const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    const block = ast.statements.find(node => ts.isBlock(node) && node.getText(ast).includes('const envLog'));
    const envParams = {}, logs = [];
    evaluate(block.getText(ast), [], { envParamKeys: ['WEBPLAYER_TOKEN', 'PORT', 'PROXY_ALL_ADDRESS'], envParams, formatConfigLogValue, process: { env: { WEBPLAYER_TOKEN: 'SYNTHETIC_SECRET', PORT: '9527', PROXY_ALL_ADDRESS: 'http://user:secret@proxy/' } }, console: { log: text => logs.push(text) } });
    assert.equal(envParams.WEBPLAYER_TOKEN, 'SYNTHETIC_SECRET'); assert(!logs.join('').includes('SYNTHETIC_SECRET')); assert(!logs.join('').includes('user:secret')); assert(logs.join('').includes('9527'));
  });
  console.log(`\n${results.length} regression checks passed. No production data or configuration accessed.`);
}
main().catch(error => { console.error(error); realProcess.exitCode = 1; }).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const timer of timers) clearTimeout(timer);
  // Only remove the exact fixture directory created by this process, never a computed user path.
  const expectedParent = fs.realpathSync(path.join(root, 'temp'));
  const actual = fs.realpathSync(scratch);
  if (path.dirname(actual) !== expectedParent || !path.basename(actual).startsWith('review-regression-')) throw new Error('Unsafe fixture cleanup path');
  fs.rmSync(actual, { recursive: true, force: true });
});
