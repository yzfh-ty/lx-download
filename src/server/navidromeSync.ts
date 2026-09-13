import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getJson, setJson } from '@/storage/database'

export interface SyncPlaylist {
  id: string
  name: string
  enabled: boolean
  paths: string[]
  error?: string
}
interface Settings {
  enabled: boolean
  apiMode: boolean
  url: string
  username: string
  pathPrefix: string
  salt: string
  token: string
}
interface Binding {
  playlistId?: string
  creationName?: string
  creationAttempted?: boolean
  lastHash?: string
  lastSyncedAt?: number
  syncedCount?: number
  missingCount?: number
  lastError?: string
  pathExamples?: { local: string, expected: string, remote: string }
}
interface Dependencies {
  getPlaylists: () => SyncPlaylist[]
  reconcile: () => void
  request?: typeof fetch
}
const DEFAULTS: Settings = { enabled: false, apiMode: false, url: '', username: '', pathPrefix: '', salt: '', token: '' }
let settings = { ...DEFAULTS }
let deps: Dependencies | undefined
let loaded = false
let instanceId = ''
let running: Promise<void> | undefined
let timer: ReturnType<typeof setInterval> | undefined
let scheduled: ReturnType<typeof setTimeout> | undefined
let lastError = ''
let lastSyncedAt = 0
let rerun = false
let bindingBusy = false
const load = () => {
  if (loaded) return
  settings = { ...DEFAULTS, ...getJson<Partial<Settings>>('navidrome', 'settings', {}) }
  instanceId = getJson<string>('navidrome', 'instanceId', '') || randomUUID()
  setJson('navidrome', 'instanceId', instanceId)
  loaded = true
}
const scope = (config = settings) => createHash('sha256').update(config.url + '\0' + config.username).digest('hex')
const bindings = (config = settings) => getJson<Record<string, Binding>>('navidrome_bindings', scope(config), {})
const persistBindings = (value: Record<string, Binding>, config = settings) => setJson('navidrome_bindings', scope(config), value)
export const isApiMode = () => { load(); return settings.apiMode }
export const getSettings = () => {
  load()
  return { enabled: settings.enabled, apiMode: settings.apiMode, url: settings.url, username: settings.username, pathPrefix: settings.pathPrefix, hasPassword: !!settings.token, running: !!running, lastError, lastSyncedAt }
}
export const getStatuses = () => { load(); return bindings() }

const normalizeSettings = (input: any): Settings => {
  load()
  const url = String(input.url ?? settings.url).trim().replace(/\/+$/, '')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('请输入有效的 Navidrome 服务器地址') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('请输入不带账号、查询参数的 HTTP(S) Navidrome 地址')
  const username = String(input.username ?? settings.username).trim()
  if (!username) throw new Error('请输入 Navidrome 用户名')
  const pathPrefix = String(input.pathPrefix ?? settings.pathPrefix).trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (pathPrefix.split('/').some(part => part === '..' || part === '.') || /[\r\n\0]/.test(pathPrefix)) throw new Error('Navidrome 路径前缀无效')
  let { salt, token } = settings
  if (url !== settings.url || username !== settings.username) { salt = ''; token = '' }
  if (typeof input.password === 'string' && input.password.length) {
    salt = randomBytes(24).toString('hex')
    token = createHash('md5').update(input.password + salt).digest('hex')
  }
  if (!token) throw new Error('请输入该服务器账号的密码')
  return { url, username, pathPrefix, salt, token, enabled: input.enabled === undefined ? settings.enabled : input.enabled === true, apiMode: settings.apiMode || input.enabled === true }
}

class ApiError extends Error {
  constructor(public code: number, method: string) {
    super(code === 40 ? 'Navidrome 认证失败，请检查账号密码' : code === 50 ? 'Navidrome 账号无权执行此操作，请确认歌单属于当前账号且可编辑' : code === 70 ? 'Navidrome 歌单不存在，请重新绑定已有歌单' : `Navidrome ${method} 返回错误（${code}）`)
  }
}
const request = async (config: Settings, method: string, values: Record<string, string | string[]> = {}): Promise<any> => {
  const body = new URLSearchParams({ u: config.username, t: config.token, s: config.salt, v: '1.16.1', c: 'lx-download', f: 'json' })
  for (const [key, value] of Object.entries(values)) for (const entry of Array.isArray(value) ? value : [value]) body.append(key, entry)
  try {
    const response = await (deps?.request || fetch)(`${config.url}/rest/${method}.view`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'error', signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`Navidrome ${method} 请求失败（HTTP ${response.status}）`)
    const text = await response.text()
    if (text.length > 8 * 1024 * 1024) throw new Error('Navidrome 响应过大')
    let data: any
    try { data = JSON.parse(text)['subsonic-response'] } catch { throw new Error('Navidrome 返回了无效响应') }
    if (!data) throw new Error('Navidrome 返回了无效响应')
    if (data.status !== 'ok') throw new ApiError(Number(data.error?.code || 0), method)
    return data
  } catch (err: any) {
    if (err instanceof ApiError || String(err?.message).startsWith('Navidrome ')) throw err
    // Never expose request URLs, authentication tokens, response bodies or transport internals.
    throw new Error(`Navidrome ${method} 连接失败或超时`)
  }
}

export const testConnection = async (input: any) => {
  const config = normalizeSettings(input)
  await request(config, 'ping')
  await request(config, 'getPlaylists')
  const response = await request(config, 'search3', { query: '', artistCount: '0', albumCount: '0', songCount: '1', songOffset: '0' })
  if ((response.searchResult3?.song || []).some((song: any) => isVirtualNavidromePath(response.type, song.path))) {
    return { message: `连接成功，但${REAL_PATH_REQUIRED}` }
  }
  return { message: '连接成功，可以读取歌单' }
}
export const saveSettings = (input: any) => {
  if (running || bindingBusy) throw new Error('正在同步或修改远端歌单，请稍后保存连接配置')
  const next = normalizeSettings(input)
  setJson('navidrome', 'settings', next)
  settings = next
  deps?.reconcile()
  scheduleSync()
  return getSettings()
}

const signature = (plan: SyncPlaylist) => createHash('sha256').update(JSON.stringify([plan.name, plan.paths])).digest('hex')
const stillCurrent = (plan: SyncPlaylist) => {
  const latest = deps?.getPlaylists().find(item => item.id === plan.id)
  return settings.enabled && !!latest?.enabled && !latest.error && signature(latest) === signature(plan)
}
const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
const REAL_PATH_REQUIRED = 'Navidrome 当前返回虚拟路径。请在 Navidrome 的播放器设置中为 lx-download 启用“报告真实路径”，再将路径前缀设为下载目录在 Navidrome 中的真实路径（例如 /music）'
const isVirtualNavidromePath = (serverType: unknown, value: unknown) => (
  String(serverType || '').toLowerCase() === 'navidrome' && typeof value === 'string' && value.length > 0 &&
  !/^(?:\/|[A-Za-z]:\/)/.test(value.replace(/\\/g, '/'))
)
const libraryPaths = async (config: Settings) => {
  const result = new Map<string, string | null>()
  let virtualPaths = false, songCount = 0
  const examples: string[] = []
  for (let offset = 0; offset < 1000000; offset += 500) {
    const response = await request(config, 'search3', { query: '', artistCount: '0', albumCount: '0', songCount: '500', songOffset: String(offset) })
    const songs = response.searchResult3?.song || []
    if (!Array.isArray(songs)) throw new Error('Navidrome 歌曲索引响应无效')
    songCount += songs.length
    for (const song of songs) {
      if (!song.path || !song.id) continue
      if (isVirtualNavidromePath(response.type, song.path)) virtualPaths = true
      if (examples.length < 3) examples.push(String(song.path))
      const path = normalizePath(String(song.path))
      result.set(path, result.has(path) && result.get(path) !== String(song.id) ? null : String(song.id))
    }
    if (songs.length < 500) return { paths: result, virtualPaths, songCount, examples }
  }
  throw new Error('Navidrome 音乐库超过安全分页上限，本次保留原歌单')
}

const sync = async () => {
  if (!deps || !settings.enabled) return
  const config = { ...settings }
  const state = bindings(config)
  try {
    deps.reconcile()
    const plans = deps.getPlaylists().filter(plan => plan.enabled)
    if (!plans.length) return
    const library = await libraryPaths(config)
    for (const plan of plans) {
      const binding = state[plan.id] ||= {}
      delete binding.pathExamples
      try {
        if (plan.error) throw new Error(plan.error)
        if (!stillCurrent(plan)) { rerun = true; continue }
        const expectedPaths = plan.paths.map(path => [config.pathPrefix, path].filter(Boolean).join('/'))
        const ids = expectedPaths.map(path => library.paths.get(normalizePath(path)))
        binding.missingCount = ids.filter(id => !id).length
        // Navidrome's default path is synthesized from tags, not the filename.
        // Even an accidental exact match must not bind the wrong physical song.
        if (library.virtualPaths && plan.paths.length) binding.missingCount = plan.paths.length
        if (binding.missingCount) {
          const index = Math.max(0, ids.findIndex(id => !id))
          binding.pathExamples = { local: plan.paths[index], expected: expectedPaths[index], remote: library.examples[0] || '' }
        }
        if (library.virtualPaths && plan.paths.length) throw new Error(REAL_PATH_REQUIRED)
        if (ids.includes(null)) throw new Error('音乐库存在同路径的多个文件，无法安全匹配，请检查音乐库路径设置')
        // Rename existing remote playlists immediately, but don't drop tracks while the scanner catches up.
        let remotePlaylist: any
        if (binding.playlistId) {
          remotePlaylist = (await request(config, 'getPlaylist', { id: binding.playlistId })).playlist
          if (remotePlaylist?.owner !== config.username) throw new Error('绑定的歌单不属于当前账号，请重新核对绑定')
          if (!stillCurrent(plan)) { rerun = true; continue }
          if (remotePlaylist.name !== plan.name) await request(config, 'updatePlaylist', { playlistId: binding.playlistId, name: plan.name })
        }
        if (binding.missingCount) {
          const reason = library.songCount === 0
            ? 'Navidrome API 未返回歌曲，请确认连接账号可以访问音乐库，并检查扫描状态'
            : library.paths.size === 0
              ? 'Navidrome API 没有返回歌曲路径，请检查播放器的真实路径设置'
              : `${binding.missingCount} 首歌曲的文件路径未匹配，请核对下方路径示例、路径前缀及扫描状态`
          binding.lastError = `${reason}；${binding.playlistId ? '远端原有内容已保留' : '尚未创建远端歌单'}`
          continue
        }
        if (!binding.playlistId) {
          binding.creationName ||= `lx-download-${instanceId}-${plan.id}`
          const response = await request(config, 'getPlaylists')
          const found = (response.playlists?.playlist || []).filter((item: any) => item.name === binding.creationName && item.owner === config.username)
          if (found.length > 1) throw new Error('存在多个创建候选歌单，请手动绑定正确的歌单 ID')
          if (found.length === 1) binding.playlistId = String(found[0].id)
          else {
            if (binding.creationAttempted) throw new Error('上次创建结果未确认，为避免重复创建已停止重试；请检查远端并绑定歌单 ID')
            if (!stillCurrent(plan)) { rerun = true; continue }
            binding.creationAttempted = true
            persistBindings(state, config)
            let created: any
            try { created = await request(config, 'createPlaylist', { name: binding.creationName, songId: ids as string[] }) } catch (err) {
              if (err instanceof ApiError) binding.creationAttempted = false
              throw err
            }
            if (!created.playlist?.id) throw new Error('Navidrome 创建结果没有歌单 ID，请在远端核实后绑定')
            binding.playlistId = String(created.playlist.id)
          }
          // Save the ID before any rename or content update; restarting cannot create a second copy.
          persistBindings(state, config)
        }
        if (!stillCurrent(plan)) { rerun = true; continue }
        const hash = signature(plan) + ':' + createHash('sha256').update(JSON.stringify(ids)).digest('hex')
        const remoteIds = (remotePlaylist?.entry || []).map((entry: any) => String(entry.id))
        if (binding.lastHash !== hash || JSON.stringify(remoteIds) !== JSON.stringify(ids)) {
          if (ids.length) await request(config, 'createPlaylist', { playlistId: binding.playlistId!, songId: ids as string[] })
          else {
            const current = remotePlaylist || (await request(config, 'getPlaylist', { id: binding.playlistId! })).playlist
            const indexes = (current?.entry || []).map((_entry: any, index: number) => String(index))
            if (indexes.length) await request(config, 'updatePlaylist', { playlistId: binding.playlistId!, songIndexToRemove: indexes })
          }
          if (!stillCurrent(plan)) { rerun = true; continue }
          await request(config, 'updatePlaylist', { playlistId: binding.playlistId!, name: plan.name })
          binding.lastHash = hash
        }
        binding.syncedCount = ids.length
        binding.lastSyncedAt = Date.now()
        binding.lastError = ''
      } catch (err: any) {
        binding.lastError = err?.message || '歌单同步失败'
      } finally { persistBindings(state, config) }
    }
    lastSyncedAt = Date.now()
    lastError = ''
  } catch (err: any) { lastError = err?.message || 'Navidrome 同步失败' }
}

export const syncNow = async () => {
  load()
  if (!settings.enabled) throw new Error('请先启用 Navidrome API 同步')
  if (bindingBusy) throw new Error('正在修改远端歌单，请稍后同步')
  if (!running) running = Promise.resolve().then(sync).finally(() => {
    running = undefined
    if (rerun) { rerun = false; scheduleSync() }
  })
  await running
  return { settings: getSettings(), statuses: getStatuses() }
}
export const scheduleSync = () => {
  if (!settings.enabled || scheduled || running || bindingBusy) return
  scheduled = setTimeout(() => { scheduled = undefined; void syncNow().catch(() => {}) }, 500)
}
export const bindPlaylist = async (localId: string, playlistId: string) => {
  load()
  if (running || bindingBusy) throw new Error('正在同步或绑定歌单，请稍后重试')
  if (!deps?.getPlaylists().some(plan => plan.id === localId)) throw new Error('本地歌单不存在')
  if (!playlistId.trim()) throw new Error('请输入 Navidrome 歌单 ID')
  bindingBusy = true
  try {
    const config = { ...settings }
    const remote = await request(config, 'getPlaylist', { id: playlistId.trim() })
    if (remote.playlist?.owner !== config.username) throw new Error('只能绑定当前 Navidrome 账号拥有的歌单')
    const state = bindings(config)
    if (Object.entries(state).some(([id, binding]) => id !== localId && binding.playlistId === playlistId.trim())) throw new Error('该远端歌单已绑定其他本地歌单')
    state[localId] = { playlistId: playlistId.trim(), lastError: '' }
    persistBindings(state, config)
    return state[localId]
  } finally { bindingBusy = false; scheduleSync() }
}

const protectedPlaylistIds = (config: Settings) => new Set(Object.values(bindings(config))
  .map(binding => binding.playlistId).filter((id): id is string => !!id))
const pendingPlaylistNames = (config: Settings) => new Set(Object.values(bindings(config))
  .filter(binding => !binding.playlistId && binding.creationName).map(binding => binding.creationName!))

const remotePlaylists = async (config: Settings) => {
  const response = await request(config, 'getPlaylists')
  const playlists = response.playlists?.playlist || []
  if (!Array.isArray(playlists)) throw new Error('Navidrome 歌单列表响应无效')
  return playlists as Array<{ id: string, name: string, owner: string, songCount?: number }>
}

export const listRemotePlaylists = async () => {
  const config = normalizeSettings({})
  const remote = await remotePlaylists(config)
  if (scope(config) !== scope(settings)) throw new Error('连接账号已改变，请重新读取远端歌单')
  const protectedIds = protectedPlaylistIds(config)
  const pendingNames = pendingPlaylistNames(config)
  const localNames = new Set((deps?.getPlaylists() || []).map(plan => plan.name))
  const playlists = remote.filter(item => item.id && item.owner === config.username).map(item => ({
    id: String(item.id), name: String(item.name || ''),
    songCount: Number.isFinite(item.songCount) ? Math.max(0, Math.floor(item.songCount!)) : 0,
    bound: protectedIds.has(String(item.id)), pendingCreation: pendingNames.has(String(item.name || '')),
    sameName: localNames.has(String(item.name || '')),
  }))
  playlists.sort((a, b) => Number(a.bound) - Number(b.bound) || Number(b.sameName) - Number(a.sameName) || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id))
  return { scope: scope(config), playlists }
}

export const deleteRemotePlaylists = async (input: { scope?: unknown, playlistIds?: unknown }) => {
  load()
  if (running || bindingBusy) throw new Error('正在同步或修改远端歌单，请稍后清理')
  if (!Array.isArray(input.playlistIds) || input.playlistIds.length === 0 || input.playlistIds.length > 100) throw new Error('请选择 1 至 100 个需要删除的歌单')
  if (input.playlistIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200 || /[\r\n\0]/.test(id))) throw new Error('无效的歌单 ID')
  const ids = [...new Set(input.playlistIds.map((id: string) => id.trim()))]
  const config = normalizeSettings({})
  if (input.scope !== scope(config)) throw new Error('连接账号已改变或列表已失效，请重新读取远端歌单')
  bindingBusy = true
  try {
    const remote = new Map((await remotePlaylists(config)).map(item => [String(item.id), item]))
    const protectedIds = protectedPlaylistIds(config)
    const pendingNames = pendingPlaylistNames(config)
    // Validate the entire selection before deleting anything. A playlist may
    // have been bound or changed owner after the user opened the preview.
    for (const id of ids) {
      if (protectedIds.has(id)) throw new Error('所选歌单已有绑定，不能删除；请重新读取列表')
      if (remote.has(id) && remote.get(id)!.owner !== config.username) throw new Error('只能删除当前连接账号拥有的歌单')
      if (remote.has(id) && pendingNames.has(remote.get(id)!.name)) throw new Error('所选歌单正在等待确认创建结果，不能删除；请先完成恢复或绑定')
    }
    const result: { deleted: string[], missing: string[], failed: Array<{ id: string, name: string, message: string }> } = { deleted: [], missing: [], failed: [] }
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]
      if (!remote.has(id)) { result.missing.push(id); continue }
      try {
        await request(config, 'deletePlaylist', { id })
        result.deleted.push(id)
      } catch (err: any) {
        if (err instanceof ApiError && err.code === 70) result.missing.push(id)
        else {
          result.failed.push({ id, name: String(remote.get(id)!.name || ''), message: err?.message || '删除失败' })
          // A disconnected server or expired login affects the whole batch.
          // Release the mutation lock instead of waiting for every ID to time out.
          if (!(err instanceof ApiError) || err.code === 40) {
            for (const remaining of ids.slice(index + 1)) {
              if (!remote.has(remaining)) result.missing.push(remaining)
              else result.failed.push({ id: remaining, name: String(remote.get(remaining)!.name || ''), message: '未执行：前面的请求失败，请刷新列表后重试' })
            }
            break
          }
        }
      }
    }
    return result
  } finally { bindingBusy = false; scheduleSync() }
}

export const initialize = (dependencies: Dependencies) => {
  deps = dependencies
  load()
  if (!timer) timer = setInterval(() => { void syncNow().catch(() => {}) }, 60000)
  scheduleSync()
}
export const stop = () => {
  if (timer) clearInterval(timer)
  if (scheduled) clearTimeout(scheduled)
  timer = undefined
  scheduled = undefined
}
