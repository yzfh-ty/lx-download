import * as fileCache from './fileCache'
import { getJson, setJson } from '@/storage/database'

/**
 * 歌单订阅：服务端定时拉取远端歌单，与上次快照对比，
 * 将新增歌曲自动加入服务端下载队列（serverDownloadQueue）。
 *
 * 数据持久化在 SQLite，所有订阅属于同一个 Web 实例。
 */

export interface SubscriptionStats {
  checks: number
  detected: number
  enqueued: number
  lastError: string
  lastErrorAt: number
}

export interface PlaylistSubscription {
  id: string
  source: string
  sourceListId: string
  name: string
  cover: string
  quality: string
  enabled: boolean
  createdAt: number
  lastCheckedAt: number
  lastChangedAt: number
  knownSongIds: string[]
  knownTotal: number
  initialDownloadCompleted: boolean
  stats: SubscriptionStats
}

interface SubscriptionState {
  version: number
  intervalMinutes: number
  subscriptions: PlaylistSubscription[]
}

type SubscriptionDownloadOptions = {
  fileNamePattern?: 'name-artist' | 'artist-name' | 'name'
  cacheLyric?: boolean
  embedMetadata?: boolean
  embedCover?: boolean
  embedLyric?: boolean
  embedLyricTranslation?: boolean
  embedLyricRoma?: boolean
  embedLyricLx?: boolean
  downloadLyricTranslation?: boolean
  downloadLyricRoma?: boolean
  downloadLyricLx?: boolean
  downloadLyricFormat?: 'utf8' | 'gbk'
  allowLyricSourceFallback?: boolean
}

interface SubscriptionDeps {
  musicSdk: any
  normalizeSongInfo: (songInfo: any) => any
  enqueue: (username: string, tasks: ({ id?: string, songInfo: any, quality?: string } & SubscriptionDownloadOptions)[]) => any[]
  getDownloadOptions?: (username: string) => SubscriptionDownloadOptions
  getCachedSongs?: (username: string) => Promise<any[]>
}

const VALID_QUALITIES = new Set(['128k', '192k', '320k', 'flac', 'flac24bit', 'hires'])
const DEFAULT_QUALITY = '320k'
const DEFAULT_INTERVAL_MIN = 360 // 全局默认 6 小时
const MIN_INTERVAL_MIN = 5
const MAX_PAGES = 1000
const TICK_MS = 60 * 1000
const SHARED_SCOPE = 'shared'

let deps: SubscriptionDeps | null = null
let state: SubscriptionState = { version: 1, intervalMinutes: DEFAULT_INTERVAL_MIN, subscriptions: [] }
let initialized = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let checking = false

const saveNow = () => {
  if (!initialized) return
  setJson('subscriptions', 'state', state)
}

const scheduleSave = () => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 2000)
}

const loadState = () => {
  try {
    const data = getJson<{ intervalMinutes?: number; subscriptions?: PlaylistSubscription[] }>('subscriptions', 'state', {})
    if (data && Array.isArray(data.subscriptions)) {
      state = {
        version: 1,
        intervalMinutes: normalizeInterval(data.intervalMinutes),
        subscriptions: data.subscriptions.map(sub => {
          const stats = { ...sub.stats }
          // 兼容已完成首次入队但旧版本未把初始歌曲计入 detected 的记录。
          if (sub.initialDownloadCompleted === true && stats.enqueued > stats.detected) {
            stats.detected = stats.enqueued
          }
          return {
            ...sub,
            stats,
            // 旧版本只建立基线，没有执行首次下载；启动后为这类订阅补入队。
            initialDownloadCompleted: sub.initialDownloadCompleted === true,
          }
        }),
      }
    }
  } catch (err) {
    console.error('[Subscription] Failed to load subscriptions:', err)
  }
}

const normalizeInterval = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MIN
  return Math.max(MIN_INTERVAL_MIN, parsed)
}

const normalizeQuality = (value: unknown) => {
  const str = String(value || '').toLowerCase()
  return VALID_QUALITIES.has(str) ? str : DEFAULT_QUALITY
}

const buildId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const findSub = (_username: string, id: string) => state.subscriptions.find(s => s.id === id)

const publicView = (sub: PlaylistSubscription) => {
  // 兼容服务热更新期间仍驻留内存的旧统计，确保首次入队也计入累计更新。
  if (sub.initialDownloadCompleted && sub.stats.enqueued > sub.stats.detected) {
    sub.stats.detected = sub.stats.enqueued
  }
  return {
    id: sub.id,
    source: sub.source,
    sourceListId: sub.sourceListId,
    name: sub.name,
    cover: sub.cover,
    quality: sub.quality,
    enabled: sub.enabled,
    createdAt: sub.createdAt,
    lastCheckedAt: sub.lastCheckedAt,
    lastChangedAt: sub.lastChangedAt,
    knownCount: sub.knownSongIds.length,
    knownTotal: sub.knownTotal,
    stats: sub.stats,
  }
}

/** 拉取远端歌单全部歌曲（自动翻页） */
const fetchRemoteSongs = async (sub: PlaylistSubscription): Promise<{ songs: any[], total: number, info: any }> => {
  const sdk = deps?.musicSdk?.[sub.source]?.songList
  if (!sdk || !sdk.getListDetail) throw new Error(`平台 ${sub.source} 不支持歌单`)

  const collected: any[] = []
  let total = 0
  let info: any = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await sdk.getListDetail(sub.sourceListId, page)
    if (!result || !Array.isArray(result.list)) throw new Error('远端歌单数据不完整')
    total = Number(result.total) || collected.length
    info = result.info || info
    collected.push(...result.list)
    if (collected.length >= total) return { songs: collected, total, info }
    if (result.list.length === 0) throw new Error(`远端歌单数据不完整：已获取 ${collected.length}/${total} 首`)
  }
  throw new Error(`歌单超过安全分页上限，已获取 ${collected.length}/${total} 首；保留原有快照`)
}

const songKey = (songInfo: any) => fileCache.normalizeSongId(songInfo)

const normalizeSongText = (value: unknown) => String(value || '')
  .trim()
  .toLocaleLowerCase()
  .replace(/[、，,;；]/g, ',')
  .replace(/\s+/g, ' ')

const hasSameSongMetadata = (left: any, right: any) => {
  const leftName = normalizeSongText(left?.name || left?.meta?.songName)
  const rightName = normalizeSongText(right?.name || right?.meta?.songName)
  const leftSinger = normalizeSongText(left?.singer || left?.meta?.singerName)
  const rightSinger = normalizeSongText(right?.singer || right?.meta?.singerName)
  return !!leftName && !!leftSinger && leftName === rightName && leftSinger === rightSinger
}

const sanitizeTaskId = (value: string) => {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned.length > 160 ? cleaned.slice(0, 160) : cleaned
}

/**
 * 对比快照并处理新增歌曲。
 * 首次订阅的基线歌曲也会加入下载队列；后续检查只处理新增歌曲。
 */
const diffAndDownload = async (sub: PlaylistSubscription, songs: any[], total: number, isBaseline: boolean) => {
  const remoteKeys: string[] = []
  const keyToSong = new Map<string, any>()
  for (const raw of songs) {
    if (!raw) continue
    const normalized = deps!.normalizeSongInfo(raw)
    const key = songKey(normalized)
    if (!key || keyToSong.has(key)) continue
    keyToSong.set(key, normalized)
    remoteKeys.push(key)
  }

  const knownSet = new Set(sub.knownSongIds)
  const addedKeys = remoteKeys.filter(key => !knownSet.has(key))

  let enqueued = 0
  let skippedExisting = 0
  // 首次订阅下载当前歌单；后续检测只将新增歌曲加入下载队列。
  if (addedKeys.length > 0 && sub.enabled) {
    // 订阅可能是在已有本地音乐之后才建立，或者歌单来源返回的 ID 与
    // 旧文件的 ID 不同（旧文件常被索引为 unknown_歌名 - 歌手）。
    // 先同步下载目录，再按 ID 或歌名+歌手过滤，避免更新歌单
    // 时把本地已有歌曲再次加入队列。
    const cachedSongs = await deps!.getCachedSongs?.(SHARED_SCOPE) || []
    const downloadableKeys = addedKeys.filter(key => {
      const songInfo = keyToSong.get(key)
      const exists = cachedSongs.some(cached => {
        const cachedSongInfo = cached?.songInfo || cached
        return songKey(cachedSongInfo) === key || hasSameSongMetadata(cachedSongInfo, songInfo)
      })
      if (exists) skippedExisting++
      return !exists
    })

    // 累计更新包含首次订阅时加入队列的歌曲。
    sub.stats.detected += addedKeys.length
    if (!isBaseline) {
      sub.lastChangedAt = Date.now()
    }
    const downloadOptions = deps!.getDownloadOptions?.(SHARED_SCOPE) || {}
    const tasks = downloadableKeys.map(key => {
      const songInfo = keyToSong.get(key)
      return {
        id: sanitizeTaskId(`sub_${sub.id}_${key}`),
        songInfo,
        quality: sub.quality,
        fileNamePattern: downloadOptions.fileNamePattern as 'name-artist' | 'artist-name' | 'name' || 'name-artist',
        cacheLyric: downloadOptions.cacheLyric !== false,
        embedMetadata: downloadOptions.embedMetadata !== false,
        embedCover: downloadOptions.embedCover !== false,
        embedLyric: downloadOptions.embedLyric !== false,
        embedLyricTranslation: downloadOptions.embedLyricTranslation === true,
        embedLyricRoma: downloadOptions.embedLyricRoma === true,
        embedLyricLx: downloadOptions.embedLyricLx !== false,
        downloadLyricTranslation: downloadOptions.downloadLyricTranslation === true,
        downloadLyricRoma: downloadOptions.downloadLyricRoma === true,
        downloadLyricLx: downloadOptions.downloadLyricLx !== false,
        downloadLyricFormat: (downloadOptions.downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8') as 'utf8' | 'gbk',
        allowLyricSourceFallback: downloadOptions.allowLyricSourceFallback !== false,
      }
    })
    const queued = deps!.enqueue(SHARED_SCOPE, tasks)
    enqueued = Array.isArray(queued) ? queued.length : 0
    sub.stats.enqueued += enqueued
  }

  // Commit only after enqueue succeeds; paused checks must not consume new songs.
  if (sub.enabled) {
    sub.knownSongIds = remoteKeys
    sub.knownTotal = total
  }

  return {
    addedKeys,
    addedSongs: addedKeys.map(key => keyToSong.get(key)),
    enqueued,
    skippedExisting,
  }
}

/** 检测单个订阅（网络失败时保留旧快照，等待下次重试） */
export const checkSubscription = async (sub: PlaylistSubscription, isManual = false) => {
  const isBaseline = sub.knownSongIds.length === 0 && sub.knownTotal === 0
  try {
    const { songs, total } = await fetchRemoteSongs(sub)
    const { addedKeys, addedSongs, enqueued, skippedExisting } = await diffAndDownload(sub, songs, total, isBaseline)
    sub.lastCheckedAt = Date.now()
    sub.stats.checks += 1
    sub.stats.lastError = ''
    scheduleSave()
    return {
      id: sub.id,
      name: sub.name,
      isBaseline,
      addedCount: addedKeys.length,
      enqueued,
      skippedExisting,
      added: addedSongs,
    }
  } catch (err: any) {
    sub.lastCheckedAt = Date.now()
    sub.stats.checks += 1
    sub.stats.lastError = err?.message || '检测失败'
    sub.stats.lastErrorAt = Date.now()
    scheduleSave()
    if (isManual) throw err
    console.error(`[Subscription] Check failed for "${sub.name}":`, err?.message)
    return { id: sub.id, name: sub.name, error: err?.message || '检测失败' }
  }
}

const tick = async () => {
  if (checking || !deps) return
  const now = Date.now()
  const intervalMs = state.intervalMinutes * 60 * 1000
  const due = state.subscriptions.filter(s => s.enabled && now - s.lastCheckedAt >= intervalMs)
  if (due.length === 0) return

  checking = true
  try {
    for (const sub of due) {
      await checkSubscription(sub, false)
    }
  } finally {
    checking = false
  }
}

/** 为旧版本已建立基线但未下载存量歌曲的订阅补做首次入队。 */
const restoreInitialDownloads = async () => {
  if (checking || !deps) return
  const pending = state.subscriptions.filter(sub => sub.enabled && !sub.initialDownloadCompleted)
  if (pending.length === 0) return

  checking = true
  try {
    for (const sub of pending) {
      try {
        const { songs, total } = await fetchRemoteSongs(sub)
        // 旧订阅已有快照，临时清空快照即可复用首次入队逻辑；拉取成功后会立即重建。
        sub.knownSongIds = []
        sub.knownTotal = 0
        const result = await diffAndDownload(sub, songs, total, true)
        sub.lastCheckedAt = Date.now()
        sub.stats.checks += 1
        sub.stats.lastError = ''
        sub.initialDownloadCompleted = true
        scheduleSave()
        console.log(`[Subscription] Restored initial queue for "${sub.name}": ${result.enqueued} task(s)`)
      } catch (err: any) {
        sub.lastCheckedAt = Date.now()
        sub.stats.checks += 1
        sub.stats.lastError = err?.message || '首次下载入队失败'
        sub.stats.lastErrorAt = Date.now()
        scheduleSave()
        console.error(`[Subscription] Initial queue restore failed for "${sub.name}":`, err?.message)
      }
    }
  } finally {
    checking = false
  }
}

// ===== 对外 API =====

export const initialize = (subscriptionDeps: SubscriptionDeps) => {
  deps = subscriptionDeps
  if (!initialized) {
    initialized = true
    loadState()
    tickTimer = setInterval(() => void tick(), TICK_MS)
    void restoreInitialDownloads()
    console.log(`[Subscription] Initialized with ${state.subscriptions.length} subscription(s), interval: ${state.intervalMinutes}min`)
  }
}

export const list = (_username: string) => state.subscriptions.map(publicView)

export const getSettings = () => ({ intervalMinutes: state.intervalMinutes })

export const setIntervalMinutes = (value: unknown) => {
  state.intervalMinutes = normalizeInterval(value)
  scheduleSave()
  return state.intervalMinutes
}

export const subscribe = async (_username: string, input: {
  source: string
  sourceListId: string
  name?: string
  cover?: string
  quality?: string
}) => {
  if (!deps) throw new Error('Subscription module not initialized')
  const source = String(input.source || '').trim()
  const sourceListId = String(input.sourceListId || '').trim()
  if (!source || !sourceListId) throw new Error('缺少平台或歌单 ID')

  const existing = state.subscriptions.find(s => s.source === source && s.sourceListId === sourceListId)
  if (existing) throw new Error('该歌单已订阅')

  const sub: PlaylistSubscription = {
    id: buildId(),
    source,
    sourceListId,
    name: String(input.name || `歌单 ${sourceListId}`).slice(0, 120),
    cover: String(input.cover || ''),
    quality: normalizeQuality(input.quality),
    enabled: true,
    createdAt: Date.now(),
    lastCheckedAt: 0,
    lastChangedAt: 0,
    knownSongIds: [],
    knownTotal: 0,
    initialDownloadCompleted: false,
    stats: { checks: 0, detected: 0, enqueued: 0, lastError: '', lastErrorAt: 0 },
  }

  // 立即拉取当前歌单并加入下载队列，同时建立快照，保证后续只处理新增
  const { songs, total } = await fetchRemoteSongs(sub)
  await diffAndDownload(sub, songs, total, true)
  sub.lastCheckedAt = Date.now()
  sub.stats.checks += 1
  sub.initialDownloadCompleted = true

  state.subscriptions.push(sub)
  saveNow()
  return publicView(sub)
}

export const unsubscribe = (_username: string, id: string) => {
  const index = state.subscriptions.findIndex(s => s.id === id)
  if (index < 0) throw new Error('订阅不存在')
  const [removed] = state.subscriptions.splice(index, 1)
  saveNow()
  return publicView(removed)
}

export const update = async (_username: string, id: string, patch: {
  source?: string
  sourceListId?: string
  quality?: string
  enabled?: boolean
  name?: string
}) => {
  const sub = findSub(SHARED_SCOPE, id)
  if (!sub) throw new Error('订阅不存在')

  const nextSource = patch.source !== undefined ? String(patch.source).trim() : sub.source
  const nextSourceListId = patch.sourceListId !== undefined ? String(patch.sourceListId).trim() : sub.sourceListId
  if (!nextSource || !nextSourceListId) throw new Error('缺少平台或歌单 ID')

  const targetChanged = nextSource !== sub.source || nextSourceListId !== sub.sourceListId
  if (targetChanged) {
    const duplicate = state.subscriptions.find(item => (
      item.id !== id && item.source === nextSource && item.sourceListId === nextSourceListId
    ))
    if (duplicate) throw new Error('该歌单已存在订阅')

    const nextSub: PlaylistSubscription = {
      ...sub,
      source: nextSource,
      sourceListId: nextSourceListId,
      name: patch.name !== undefined ? String(patch.name).slice(0, 120) : sub.name,
      quality: patch.quality !== undefined ? normalizeQuality(patch.quality) : sub.quality,
      enabled: patch.enabled !== undefined ? !!patch.enabled : sub.enabled,
      lastCheckedAt: 0,
      lastChangedAt: 0,
      knownSongIds: [],
      knownTotal: 0,
      initialDownloadCompleted: false,
      stats: { checks: 0, detected: 0, enqueued: 0, lastError: '', lastErrorAt: 0 },
    }

    const { songs, total, info } = await fetchRemoteSongs(nextSub)
    if (patch.name === undefined && info) nextSub.name = String(info.name || info.title || nextSub.name).slice(0, 120)
    if (info) nextSub.cover = String(info.img || info.pic || info.cover || nextSub.cover)
    if (nextSub.enabled) await diffAndDownload(nextSub, songs, total, true)
    nextSub.lastCheckedAt = Date.now()
    nextSub.stats.checks += 1
    nextSub.initialDownloadCompleted = nextSub.enabled
    Object.assign(sub, nextSub)
    saveNow()
    return publicView(sub)
  }

  if (patch.quality !== undefined) sub.quality = normalizeQuality(patch.quality)
  if (patch.enabled !== undefined) sub.enabled = !!patch.enabled
  if (patch.name !== undefined) sub.name = String(patch.name).slice(0, 120)
  saveNow()
  if (sub.enabled && !sub.initialDownloadCompleted) void restoreInitialDownloads()
  return publicView(sub)
}

/** 手动检测：指定 id 或全部 */
export const checkNow = async (_username: string, id?: string) => {
  if (!deps) throw new Error('Subscription module not initialized')
  const targets = id
    ? [findSub(SHARED_SCOPE, id)].filter(Boolean) as PlaylistSubscription[]
    : state.subscriptions
  if (targets.length === 0) throw new Error('没有可检测的订阅')

  const results = []
  for (const sub of targets) {
    results.push(await checkSubscription(sub, true))
  }
  saveNow()
  return results
}

export const stop = () => {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  saveNow()
}
