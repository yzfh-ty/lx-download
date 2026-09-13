// Real loopback Subsonic HTTP fixture and in-memory SQLite replacement; no production access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/server/navidromeSync.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const database = new Map();
let plans = [{ id: 'sub-A', name: '歌单（网易云）', enabled: true, paths: ['歌单/A.flac', '歌单/B.mp3'] }];
let songs = [{ id: 'song-A', path: 'download/歌单/A.flac' }, { id: 'song-B', path: 'download/歌单/B.mp3' }];
const remote = new Map();
const calls = [];
let failMethod, serverType, failDeleteId, holdDelete, loseCreate = false, loseBeforeCreate = false, holdSearch, createCount = 0, idCounter = 0, passed = 0;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const p = new URLSearchParams(body); const method = req.url.split('/').pop().replace('.view', '');
  calls.push({ method, params: p });
  assert.equal(req.method, 'POST'); assert(!req.url.includes('?')); assert.equal(p.has('p'), false);
  const reply = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', type: serverType, ...data } })); };
  const error = code => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code, message: 'untrusted remote error' } } })); };
  if (p.get('t') !== crypto.createHash('md5').update('fixture-password' + p.get('s')).digest('hex')) return error(40);
  if (method === failMethod) { res.statusCode = 503; res.end('remote error'); return; }
  if (method === 'ping') return reply({});
  if (method === 'search3') { if (holdSearch) await holdSearch(); return reply({ searchResult3: { song: songs.slice(Number(p.get('songOffset')), Number(p.get('songOffset')) + Number(p.get('songCount'))) } }); }
  if (method === 'getPlaylists') return reply({ playlists: { playlist: [...remote.values()] } });
  if (method === 'getPlaylist') { const item = remote.get(p.get('id')); return item ? reply({ playlist: item }) : error(70); }
  if (method === 'deletePlaylist') {
    if (holdDelete) await holdDelete();
    const id = p.get('id'), item = remote.get(id);
    if (!item) return error(70);
    if (item.owner !== p.get('u') || id === failDeleteId) return error(50);
    remote.delete(id); return reply({});
  }
  if (method === 'createPlaylist') {
    let item = remote.get(p.get('playlistId'));
    if (p.has('playlistId') && !item) return error(70);
    if (!p.has('playlistId')) {
      createCount++;
      if (loseBeforeCreate) { loseBeforeCreate = false; res.destroy(); return; }
      item = { id: 'playlist-' + (++idCounter), name: p.get('name'), owner: p.get('u'), entry: [] }; remote.set(item.id, item);
    }
    item.entry = p.getAll('songId').map(id => ({ id }));
    if (loseCreate) { loseCreate = false; res.destroy(); return; }
    return reply({ playlist: item });
  }
  if (method === 'updatePlaylist') {
    const item = remote.get(p.get('playlistId')); if (!item) return error(70);
    if (item.owner !== p.get('u')) return error(50);
    if (p.has('name')) item.name = p.get('name');
    const remove = new Set(p.getAll('songIndexToRemove').map(Number)); item.entry = item.entry.filter((_entry, index) => !remove.has(index));
    return reply({});
  }
  throw new Error('Unexpected endpoint ' + method);
});
function load() {
  const context = vm.createContext({ exports: {}, console: { log() {}, warn() {}, error() {} }, Buffer, URL, URLSearchParams, AbortSignal, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require: name => name === '@/storage/database' ? {
      getJson: (ns, key, fallback) => structuredClone(database.get(ns + '/' + key) ?? fallback),
      setJson: (ns, key, value) => database.set(ns + '/' + key, structuredClone(value))
    } : require(name) });
  vm.runInContext(source, context);
  const api = context.exports;
  api.initialize({ getPlaylists: () => structuredClone(plans), reconcile() {}, request: fetch });
  return api;
}
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let api = load();
  await check('connection settings authenticate without persisting or returning plaintext credentials', async () => {
    const input = { url, username: 'fixture-user', password: 'fixture-password', pathPrefix: 'download', enabled: true };
    await api.testConnection(input); api.saveSettings(input);
    assert(api.isApiMode()); assert(api.getSettings().hasPassword);
    assert(!JSON.stringify([...database.values()]).includes('fixture-password'));
    assert(!('token' in api.getSettings())); assert(!('salt' in api.getSettings()));
    await assert.rejects(api.testConnection({ ...input, password: 'wrong' }), /认证失败/);
    assert.throws(() => api.saveSettings({ url: 'http://127.0.0.1:1' }), /密码/);
    assert.throws(() => api.saveSettings({ url: url + '?token=secret' }), /HTTP/);
  });
  await check('first synchronization creates once; rename and reordering keep the same playlist ID', async () => {
    await api.syncNow(); const id = api.getStatuses()['sub-A'].playlistId;
    assert.equal(createCount, 1); assert.equal(remote.get(id).name, plans[0].name);
    assert.deepEqual(remote.get(id).entry.map(entry => entry.id), ['song-A', 'song-B']);
    plans[0].name = '新名称（网易云）'; plans[0].paths.reverse(); await api.syncNow();
    assert.equal(api.getStatuses()['sub-A'].playlistId, id); assert.equal(createCount, 1);
    assert.equal(remote.get(id).name, plans[0].name); assert.deepEqual(remote.get(id).entry.map(entry => entry.id), ['song-B', 'song-A']);
    api.stop(); api = load(); await api.syncNow(); assert.equal(createCount, 1); assert.equal(api.getStatuses()['sub-A'].playlistId, id);
    remote.get(id).entry.push({ id: 'external-change' }); await api.syncNow(); assert.deepEqual(remote.get(id).entry.map(entry => entry.id), ['song-B', 'song-A']); assert.equal(createCount, 1);
  });
  await check('unscanned and ambiguous paths preserve existing remote tracks', async () => {
    const id = api.getStatuses()['sub-A'].playlistId; const before = structuredClone(remote.get(id).entry);
    plans[0].paths.push('歌单/C.flac'); await api.syncNow(); assert.equal(api.getStatuses()['sub-A'].missingCount, 1); assert.deepEqual(remote.get(id).entry, before);
    songs.push({ id: 'song-C', path: 'download/歌单/C.flac' }); await api.syncNow(); assert.equal(remote.get(id).entry.length, 3);
    songs.push({ id: 'ambiguous', path: 'download/歌单/C.flac' }); await api.syncNow(); assert.match(api.getStatuses()['sub-A'].lastError, /多个文件/); assert.equal(remote.get(id).entry.length, 3); songs.pop();
  });
  await check('an explicitly empty local playlist clears tracks without replacing the playlist', async () => {
    const id = api.getStatuses()['sub-A'].playlistId; plans[0].paths = []; await api.syncNow(); assert.deepEqual(remote.get(id).entry, []); assert.equal(createCount, 1);
  });
  await check('network failure and remote deletion never recreate an existing binding', async () => {
    failMethod = 'search3'; await api.syncNow(); assert(api.getSettings().lastError); assert.equal(createCount, 1); failMethod = undefined;
    const id = api.getStatuses()['sub-A'].playlistId; remote.delete(id); await api.syncNow(); assert.match(api.getStatuses()['sub-A'].lastError, /不存在/); assert.equal(createCount, 1);
    remote.set('chosen-existing', { id: 'chosen-existing', name: '旧歌单', owner: 'fixture-user', entry: [] });
    await api.bindPlaylist('sub-A', 'chosen-existing'); await api.syncNow(); assert.equal(api.getStatuses()['sub-A'].playlistId, 'chosen-existing'); assert.equal(createCount, 1);
  });
  await check('lost creation response recovers the original ID after restart', async () => {
    plans.push({ id: 'sub-B', name: 'B', enabled: true, paths: [] }); loseCreate = true;
    await api.syncNow(); assert.equal(createCount, 2); assert(!api.getStatuses()['sub-B'].playlistId);
    api.stop(); api = load(); await api.syncNow(); assert.equal(createCount, 2); assert(api.getStatuses()['sub-B'].playlistId);
    assert.equal(remote.get(api.getStatuses()['sub-B'].playlistId).name, 'B');
  });
  await check('uncertain create without a recoverable result stops instead of duplicating', async () => {
    plans.push({ id: 'sub-C', name: 'C', enabled: true, paths: [] }); loseBeforeCreate = true; await api.syncNow();
    const count = createCount; await api.syncNow(); await api.syncNow(); assert.equal(createCount, count); assert.match(api.getStatuses()['sub-C'].lastError, /未确认/);
  });
  await check('paused subscriptions and connection pause keep records and API export mode', async () => {
    const before = calls.length; plans.forEach(plan => { plan.enabled = false; }); await api.syncNow(); assert.equal(calls.length, before);
    api.saveSettings({ enabled: false }); assert(api.isApiMode()); await assert.rejects(api.syncNow(), /启用/); api.saveSettings({ enabled: true });
  });
  await check('binding ownership and local uniqueness are enforced', async () => {
    remote.set('foreign', { id: 'foreign', owner: 'another-user', name: 'foreign', entry: [] });
    await assert.rejects(api.bindPlaylist('sub-A', 'foreign'), /当前/);
    await assert.rejects(api.bindPlaylist('sub-B', 'chosen-existing'), /其他/);
  });
  await check('concurrent triggers share one run; changed snapshots cannot write stale content', async () => {
    plans[0].enabled = true; let release; holdSearch = () => new Promise(resolve => { release = resolve; });
    const before = calls.filter(call => call.method === 'search3').length;
    const first = api.syncNow(), second = api.syncNow();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => api.saveSettings({ enabled: false }), /正在/);
    plans[0].name = 'fetch 期间改名'; release(); holdSearch = undefined; await Promise.all([first, second]);
    assert.equal(calls.filter(call => call.method === 'search3').length, before + 1);
    assert.notEqual(remote.get('chosen-existing').name, plans[0].name); await api.syncNow(); assert.equal(remote.get('chosen-existing').name, plans[0].name);
  });
  await check('large library paging matches exact paths beyond the first page', async () => {
    songs = Array.from({ length: 501 }, (_, index) => ({ id: 'page-' + index, path: 'download/paging/' + index + '.mp3' }));
    plans[0].paths = ['paging/500.mp3']; await api.syncNow();
    assert.deepEqual(remote.get('chosen-existing').entry, [{ id: 'page-500' }]);
    assert(calls.some(call => call.method === 'search3' && call.params.get('songOffset') === '500'));
  });
  await check('Navidrome virtual paths require Report real path and cannot create or overwrite playlists', async () => {
    const savedPlans = structuredClone(plans), savedSongs = songs;
    const before = structuredClone(remote.get('chosen-existing').entry);
    serverType = 'navidrome';
    songs = [{ id: 'virtual-song', path: '歌手/专辑/歌曲.flac' }];
    // A virtual path can accidentally equal a local filename. It is still not a
    // physical file identity, so neither an existing nor a new list may use it.
    plans = [
      { ...plans[0], paths: ['歌手/专辑/歌曲.flac'] },
      { id: 'unbound-virtual', name: '未匹配', enabled: true, paths: ['歌手/专辑/歌曲.flac'] },
    ];
    api.saveSettings({ pathPrefix: '' });
    const checked = await api.testConnection({});
    assert.match(checked.message, /虚拟路径/); assert.match(checked.message, /报告真实路径/);
    const callStart = calls.length;
    await api.syncNow();
    assert.match(api.getStatuses()['sub-A'].lastError, /报告真实路径/);
    assert.equal(api.getStatuses()['sub-A'].missingCount, 1);
    assert.equal(api.getStatuses()['sub-A'].pathExamples.remote, songs[0].path);
    assert.equal(api.getStatuses()['unbound-virtual'].playlistId, undefined);
    assert.deepEqual(remote.get('chosen-existing').entry, before);
    assert(!calls.slice(callStart).some(call => ['createPlaylist', 'updatePlaylist'].includes(call.method)));
    serverType = undefined; plans = savedPlans; songs = savedSongs; api.saveSettings({ pathPrefix: 'download' });
  });
  await check('Navidrome real absolute paths match Docker roots, nested mounts and legacy prefixes', async () => {
    const savedPlans = structuredClone(plans), savedSongs = songs;
    serverType = 'navidrome';
    for (const [prefix, remotePath] of [
      ['/music', '/music/歌单/真实文件名.flac'],
      ['/music/download', '/music/download/歌单/真实文件名.flac'],
      ['music', '/music/歌单/真实文件名.flac'],
      ['C:\\Music', 'C:\\Music\\歌单\\真实文件名.flac'],
    ]) {
      songs = [{ id: 'physical-song', path: remotePath }]; plans[0].paths = ['歌单/真实文件名.flac'];
      api.saveSettings({ pathPrefix: prefix });
      assert.equal(api.getSettings().pathPrefix, prefix.replace(/\\/g, '/'));
      assert(!/虚拟路径/.test((await api.testConnection({})).message));
      await api.syncNow();
      assert.equal(api.getStatuses()['sub-A'].lastError, '');
      assert.equal(api.getStatuses()['sub-A'].pathExamples, undefined);
      assert.deepEqual(remote.get('chosen-existing').entry, [{ id: 'physical-song' }]);
    }
    serverType = undefined; plans = savedPlans; songs = savedSongs; api.saveSettings({ pathPrefix: 'download' });
  });
  await check('wrong prefixes show local and API paths instead of incorrectly claiming scanning is pending', async () => {
    const savedPlans = structuredClone(plans), savedSongs = songs;
    serverType = 'navidrome';
    songs = [{ id: 'physical-song', path: '/music/歌单/真实文件名.flac' }];
    plans[0].paths = ['歌单/真实文件名.flac'];
    api.saveSettings({ pathPrefix: '' });
    const before = structuredClone(remote.get('chosen-existing').entry);
    await api.syncNow();
    const status = api.getStatuses()['sub-A'];
    assert.match(status.lastError, /路径未匹配/); assert.match(status.lastError, /路径前缀/);
    assert(!status.lastError.includes('等待 Navidrome 扫描识别'));
    assert.equal(status.pathExamples.local, plans[0].paths[0]);
    assert.equal(status.pathExamples.expected, plans[0].paths[0]);
    assert.equal(status.pathExamples.remote, songs[0].path);
    assert.deepEqual(remote.get('chosen-existing').entry, before);
    serverType = undefined; plans = savedPlans; songs = savedSongs; api.saveSettings({ pathPrefix: 'download' });
  });
  await check('empty indexes and missing path fields have distinct diagnostics and preserve existing tracks', async () => {
    const savedPlans = structuredClone(plans), savedSongs = songs;
    serverType = 'navidrome'; plans[0].paths = ['song.flac'];
    const before = structuredClone(remote.get('chosen-existing').entry);
    songs = []; await api.syncNow();
    assert.match(api.getStatuses()['sub-A'].lastError, /API 未返回歌曲/);
    songs = [{ id: 'missing-path', title: 'A song without a path' }]; await api.syncNow();
    assert.match(api.getStatuses()['sub-A'].lastError, /没有返回歌曲路径/);
    assert.deepEqual(remote.get('chosen-existing').entry, before);
    serverType = undefined; plans = savedPlans; songs = savedSongs;
  });
  await check('changing accounts keeps separate bindings and switching back restores the original ID', async () => {
    const oldId = api.getStatuses()['sub-A'].playlistId;
    assert.throws(() => api.saveSettings({ username: 'second-user' }), /密码/);
    api.saveSettings({ username: 'second-user', password: 'fixture-password' }); await api.syncNow();
    const secondId = api.getStatuses()['sub-A'].playlistId; assert.notEqual(secondId, oldId); assert.equal(remote.get(secondId).owner, 'second-user');
    api.saveSettings({ username: 'fixture-user', password: 'fixture-password' }); await api.syncNow(); assert.equal(api.getStatuses()['sub-A'].playlistId, oldId);
  });
  await check('path diagnostics escape local and remote filenames in the Web interface', () => {
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/music/js/navidrome_manager.js'), 'utf8'), { window });
    const manager = window.NavidromeManager;
    const hostile = '<img src=x onerror=alert(1)>.flac';
    manager.playlists = [{ id: 'fixture', name: '未匹配', kind: 'unmatched', playlistTrackCount: 1 }];
    manager.statuses = { fixture: { pathExamples: { local: hostile, expected: '/music/' + hostile, remote: '/remote/' + hostile } } };
    const cleanup = { innerHTML: '', querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) };
    const container = { innerHTML: '', querySelectorAll: () => [], querySelector: selector => selector === '#navidrome-cleanup' ? cleanup : ({ addEventListener() {} }) };
    manager.render(container);
    assert(!container.innerHTML.includes('<img'));
    assert(container.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;.flac'));
    assert(container.innerHTML.includes('/music/&lt;img'));
    assert(container.innerHTML.includes('/remote/&lt;img'));
  });
  assert(!calls.some(call => call.method === 'deletePlaylist'));
  let catalog;
  const currentId = api.getStatuses()['sub-A'].playlistId;
  await check('cleanup preview includes only owned playlists and marks bound IDs', async () => {
    remote.set('legacy-one', { id: 'legacy-one', name: plans[0].name, owner: 'fixture-user', songCount: 2, entry: [{ id: 'song-A' }] });
    remote.set('legacy-two', { id: 'legacy-two', name: '旧歌单', owner: 'fixture-user', songCount: 1, entry: [{ id: 'song-B' }] });
    remote.set('keep-personal', { id: 'keep-personal', name: plans[0].name, owner: 'fixture-user', songCount: 3, entry: [] });
    catalog = await api.listRemotePlaylists();
    assert.equal(catalog.playlists.find(item => item.id === currentId).bound, true);
    assert.equal(catalog.playlists.find(item => item.id === 'legacy-one').sameName, true);
    assert.equal(catalog.playlists.find(item => item.id === 'legacy-one').songCount, 2);
    assert(!catalog.playlists.some(item => item.id === 'foreign'));
    assert(!JSON.stringify(catalog).includes('fixture-password'));
  });
  await check('cleanup rejects an entire selection containing a bound or foreign playlist before any delete', async () => {
    const before = calls.filter(call => call.method === 'deletePlaylist').length;
    for (const id of [currentId, 'foreign']) {
      await assert.rejects(api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['legacy-one', id] }), /绑定|账号/);
      assert(remote.has('legacy-one'));
    }
    assert.equal(calls.filter(call => call.method === 'deletePlaylist').length, before);
    await assert.rejects(api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: [] }), /请选择/);
    await assert.rejects(api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['\n'] }), /无效/);
    await assert.rejects(api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: Array(101).fill('legacy-one') }), /请选择/);
  });
  await check('cleanup rechecks bindings and rejects previews from a previous connection account', async () => {
    await api.bindPlaylist('sub-A', 'legacy-one');
    await assert.rejects(api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['legacy-one'] }), /绑定/);
    await api.bindPlaylist('sub-A', currentId);
    api.saveSettings({ username: 'second-user', password: 'fixture-password' });
    await assert.rejects(api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['legacy-one'] }), /账号已改变|列表已失效/);
    api.saveSettings({ username: 'fixture-user', password: 'fixture-password' });
    assert(remote.has('legacy-one'));
  });
  await check('cleanup preserves playlists whose creation response is still awaiting recovery', async () => {
    const pending = api.getStatuses()['sub-C'];
    assert(pending.creationName); assert(!pending.playlistId);
    remote.set('pending-recovery', { id: 'pending-recovery', name: pending.creationName, owner: 'fixture-user', entry: [] });
    const preview = await api.listRemotePlaylists();
    assert.equal(preview.playlists.find(item => item.id === 'pending-recovery').pendingCreation, true);
    await assert.rejects(api.deleteRemotePlaylists({ scope: preview.scope, playlistIds: ['legacy-one', 'pending-recovery'] }), /确认创建结果/);
    assert(remote.has('legacy-one')); assert(remote.has('pending-recovery'));
  });
  await check('cleanup deletes only selected IDs and keeps bound playlists, other same-name lists and music', async () => {
    const originalSongs = JSON.stringify(songs), boundEntries = structuredClone(remote.get(currentId).entry);
    const result = await api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['legacy-one', 'legacy-two', 'legacy-one', 'already-gone'] });
    assert.deepEqual([...result.deleted], ['legacy-one', 'legacy-two']);
    assert.deepEqual([...result.missing], ['already-gone']); assert.equal(result.failed.length, 0);
    assert(!remote.has('legacy-one')); assert(!remote.has('legacy-two'));
    assert(remote.has('keep-personal')); assert(remote.has('foreign'));
    assert.deepEqual(remote.get(currentId).entry, boundEntries);
    assert.equal(JSON.stringify(songs), originalSongs);
    assert.equal(api.getStatuses()['sub-A'].playlistId, currentId);
    assert.equal(calls.filter(call => call.method === 'deletePlaylist' && call.params.get('id') === 'legacy-one').length, 1);
  });
  await check('cleanup reports per-playlist failures and can retry without touching other lists', async () => {
    for (const id of ['delete-ok', 'delete-denied']) remote.set(id, { id, name: id, owner: 'fixture-user', entry: [] });
    failDeleteId = 'delete-denied';
    const result = await api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['delete-denied', 'delete-ok'] });
    assert.deepEqual([...result.deleted], ['delete-ok']);
    assert.equal(result.failed[0].id, 'delete-denied'); assert(remote.has('delete-denied')); assert(!remote.has('delete-ok'));
    failDeleteId = undefined;
    const retry = await api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['delete-denied', 'delete-ok'] });
    assert.deepEqual([...retry.deleted], ['delete-denied']); assert.deepEqual([...retry.missing], ['delete-ok']);
  });
  await check('cleanup excludes concurrent sync, binding and connection changes until it completes', async () => {
    remote.set('delete-held', { id: 'delete-held', name: 'Held', owner: 'fixture-user', entry: [] });
    let release; holdDelete = () => new Promise(resolve => { release = resolve; });
    const pending = api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['delete-held'] });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => api.saveSettings({ enabled: false }), /正在/);
    await assert.rejects(api.bindPlaylist('sub-A', currentId), /正在/);
    await assert.rejects(api.syncNow(), /正在/);
    await assert.rejects(api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['keep-personal'] }), /正在/);
    release(); holdDelete = undefined; await pending;
    assert(!remote.has('delete-held')); assert(remote.has('keep-personal'));
    api.saveSettings({ enabled: true });
  });
  await check('cleanup stops the remaining batch after a transport failure and releases its lock', async () => {
    for (const id of ['offline-one', 'offline-two']) remote.set(id, { id, name: id, owner: 'fixture-user', entry: [] });
    const before = calls.filter(call => call.method === 'deletePlaylist').length;
    failMethod = 'deletePlaylist';
    const result = await api.deleteRemotePlaylists({ scope: catalog.scope, playlistIds: ['offline-one', 'offline-two'] });
    failMethod = undefined;
    assert.equal(result.deleted.length, 0); assert.equal(result.failed.length, 2);
    assert.match(result.failed[1].message, /未执行/);
    assert.equal(calls.filter(call => call.method === 'deletePlaylist').length, before + 1);
    assert(remote.has('offline-one')); assert(remote.has('offline-two'));
    api.saveSettings({ enabled: true });
  });
  await check('cleanup UI escapes names, requires confirmation and sends only reviewed unbound IDs', async () => {
    const requests = []; let confirm = false, confirmation = '';
    const preview = { scope: 'reviewed-scope', playlists: [
      { id: 'active', name: 'Current', bound: true, songCount: 1 },
      { id: 'old', name: '<img src=x onerror=alert(1)>', bound: false, songCount: 2 },
    ] };
    const window = { SubscriptionManager: { _api: async (url, method, body) => {
      requests.push({ url, method, body });
      return url.endsWith('/delete') ? { data: { deleted: ['old'], missing: [], failed: [] } } : { data: { ...preview, playlists: [preview.playlists[0]] } };
    } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/music/js/navidrome_manager.js'), 'utf8'), {
      window, showSelect: async (_title, message) => { confirmation = message; return confirm; }
    });
    const manager = window.NavidromeManager;
    manager.cleanupCatalog = preview;
    manager.cleanupSelection.add('active'); manager.cleanupSelection.add('old');
    const panel = { innerHTML: '', querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) };
    const container = { querySelectorAll: () => [], querySelector: () => panel };
    manager.renderCleanup(container); assert(!panel.innerHTML.includes('<img')); assert(panel.innerHTML.includes('&lt;img'));
    assert(panel.innerHTML.includes('data-cleanup-index="0" disabled'));
    await manager.cleanupAction('delete', container);
    assert.equal(requests.length, 0); assert(confirmation.includes('old')); assert(!confirmation.includes('active'));
    confirm = true; await manager.cleanupAction('delete', container);
    assert.equal(requests[0].url, '/navidrome/remote-playlists/delete');
    assert.equal(requests[0].body.scope, preview.scope); assert.deepEqual([...requests[0].body.playlistIds], ['old']);
    assert.equal(requests[1].url, '/navidrome/remote-playlists');
    assert.equal(manager.cleanupSelection.size, 0); assert.equal(manager.busy, false);
  });
  api.stop(); console.log(`\n${passed} Navidrome API checks passed; no production services or data accessed.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server.closeAllConnections(); server.close(); });
