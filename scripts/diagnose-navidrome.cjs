// Run in the existing lx-download container through stdin. Reads its SQLite
// settings without modifying them, and calls only read-only Subsonic endpoints.
// Authentication values and the server URL are never printed.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

async function main() {
  const database = new DatabaseSync(path.join(process.env.DATA_PATH || '/server/data', 'lx-download.sqlite'), { readOnly: true });
  let config, subscriptions;
  try {
    const read = (namespace, key) => {
      const row = database.prepare('SELECT value FROM kv WHERE namespace = ? AND item_key = ?').get(namespace, key);
      return row ? JSON.parse(row.value) : {};
    };
    config = read('navidrome', 'settings');
    subscriptions = read('subscriptions', 'state');
  } finally { database.close(); }
  if (!config.url || !config.username || !config.token || !config.salt) throw new Error('请先在网页保存 Navidrome 连接配置');
  const request = async (method, values = {}) => {
    const body = new URLSearchParams({ u: config.username, t: config.token, s: config.salt, v: '1.16.1', c: 'lx-download', f: 'json', ...values });
    let response;
    try {
      response = await fetch(`${config.url}/rest/${method}.view`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error(`${method} 连接失败或超时`); }
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
    let data;
    try { data = (await response.json())['subsonic-response']; }
    catch { throw new Error(`${method} 返回了无效 JSON`); }
    if (data?.status !== 'ok') throw new Error(`${method} API 错误 ${Number(data?.error?.code) || 0}`);
    return data;
  };
  const normalize = value => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const ping = await request('ping');
  const response = await request('search3', { query: '', artistCount: '0', albumCount: '0', songCount: '500', songOffset: '0' });
  const songs = response.searchResult3?.song || [];
  if (!Array.isArray(songs)) throw new Error('search3 歌曲列表格式无效');
  const sample = song => ({ id: song.id, path: song.path ?? null, title: song.title, artist: song.artist, album: song.album, size: song.size, suffix: song.suffix, musicFolderId: song.musicFolderId });
  const localPaths = [...new Set([
    ...(subscriptions.unmatchedPlaylist?.paths || []),
    ...(subscriptions.subscriptions || []).flatMap(sub => (sub.remoteTracks || []).map(track => track.localRelativePath).filter(Boolean)),
  ])];
  const expectedPaths = localPaths.map(file => normalize([config.pathPrefix, file].filter(Boolean).join('/')));
  const indexed = new Set(songs.map(song => normalize(song.path)).filter(Boolean));
  const result = {
    client: 'lx-download',
    serverType: ping.type, serverVersion: ping.serverVersion, protocolVersion: ping.version,
    configuredPathPrefix: config.pathPrefix || '', localPathCount: localPaths.length,
    localPathExamples: localPaths.slice(0, 3), expectedApiPathExamples: expectedPaths.slice(0, 3),
    sampledSongs: songs.length, sampleMayBeIncomplete: songs.length === 500,
    sampledSongsWithPaths: songs.filter(song => song.path).length,
    exactMatchesInSample: expectedPaths.filter(file => indexed.has(file)).length,
    apiSongExamples: songs.slice(0, 3).map(sample),
  };
  if (songs[0]?.id) {
    try { result.getSongExample = sample((await request('getSong', { id: String(songs[0].id) })).song || {}); }
    catch (error) { result.getSongError = error.message; }
  }
  try { result.musicFolders = (await request('getMusicFolders')).musicFolders?.musicFolder; }
  catch (error) { result.musicFoldersError = error.message; }
  try { result.scanStatus = (await request('getScanStatus')).scanStatus; }
  catch (error) { result.scanStatusError = error.message; }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => {
  console.error(/^[\w\s\u4e00-\u9fff]+$/.test(error.message) ? error.message : '诊断未完成，请确认脚本在 lx-download 容器内执行，且连接配置已保存');
  process.exitCode = 1;
});
