import * as fileCache from './fileCache'
import { getJson, setJson } from '@/storage/database'
import * as playlistFiles from './playlistFileManager'

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
  kind: 'playlist' | 'leaderboard'
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
  directoryName?: string
  playlistName?: string
  playlistNameCustomized?: boolean
  playlistNameSource?: string
  playlistFilename?: string
  remoteTracks?: Array<{ key: string, songInfo: any, localRelativePath?: string }>
  playlistUpdatedAt?: number
  playlistLastError?: string
  localCount?: number
  playlistTrackCount?: number
  playlistRoot?: string
  localFiles?: Record<string, string>
}

interface SubscriptionState {
  version: number
  intervalMinutes: number
  subscriptions: PlaylistSubscription[]
  unmatchedPlaylist?: playlistFiles.PlaylistFiles & { nameCustomized?: boolean, playlistUpdatedAt?: number, playlistLastError?: string, playlistTrackCount?: number }
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
  getDownloadRoot?: () => string
  getReadySongs?: () => any[]
  initialScan?: Promise<void>
  isDirectoryBusy?: (directory: string) => boolean
  onDirectoryRenamed?: (oldDirectory: string, newDirectory: string) => void
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
let initialScanReady = true
const busy = new Set<string>()
const removedIds = new Set<string>()
let reconcileTimer: ReturnType<typeof setTimeout> | null = null

export const scheduleReconcile = () => {
  if (reconcileTimer) return
  reconcileTimer = setTimeout(() => { reconcileTimer = null; reconcilePlaylists() }, 250)
}

const UNMATCHED_ID = 'local-unmatched'
const UNMATCHED_NAME = '未匹配'
const PLATFORM_NAMES: Record<string, string> = { wy: '网易云', tx: 'QQ音乐', kg: '酷狗', kw: '酷我', mg: '咪咕' }
const generatedPlaylistName = (sub: PlaylistSubscription) => {
  const platform = PLATFORM_NAMES[sub.source] || playlistFiles.sanitizePlaylistName(sub.source).slice(0, 16)
  const suffix = `（${platform}）`
  const title = sub.name.endsWith(suffix) ? sub.name.slice(0, -suffix.length) : sub.name
  return playlistFiles.appendPlaylistSuffix(title, suffix)
}
const reservedDirectories = (id: string) => [
  ...state.subscriptions.filter(s => s.id !== id).map(s => s.directoryName || ''),
  state.unmatchedPlaylist?.directoryName || UNMATCHED_NAME,
]

const rebaseSubscriptionPaths = (sub: PlaylistSubscription, oldDirectory: string) => {
  for (const track of sub.remoteTracks || []) {
    if (track.localRelativePath?.startsWith(oldDirectory + '/')) track.localRelativePath = sub.directoryName + track.localRelativePath.slice(oldDirectory.length)
  }
  for (const [key, relative] of Object.entries(sub.localFiles || {})) {
    if (relative.startsWith(oldDirectory + '/')) sub.localFiles![key] = sub.directoryName + relative.slice(oldDirectory.length)
  }
  if (oldDirectory !== sub.directoryName) deps?.onDirectoryRenamed?.(oldDirectory, sub.directoryName!)
}

const ensureSubscriptionDirectory = (root: string, sub: PlaylistSubscription) => {
  // Before this version playlistName was only stored after a user rename.
  sub.playlistNameCustomized ??= !!sub.playlistName
  const reserved = reservedDirectories(sub.id)
  if (!sub.playlistNameCustomized) {
    if (!sub.directoryName) sub.playlistName = generatedPlaylistName(sub)
    else if (sub.playlistNameSource !== sub.source && !deps?.isDirectoryBusy?.(sub.directoryName) && state.subscriptions.includes(sub)) {
      const oldDirectory = sub.directoryName
      const name = playlistFiles.availablePlaylistName(root, generatedPlaylistName(sub), sub.id, reserved, oldDirectory)
      playlistFiles.renamePlaylistDirectory(root, sub, name, reserved)
      rebaseSubscriptionPaths(sub, oldDirectory)
      sub.playlistNameSource = sub.source
      sub.playlistName = sub.directoryName
    }
  }
  const wasMissing = !sub.directoryName
  playlistFiles.ensurePlaylistDirectory(root, sub, reserved)
  if (wasMissing && !sub.playlistNameCustomized) {
    sub.playlistNameSource = sub.source
    sub.playlistName = sub.directoryName
  }
}

export const getUnmatchedPlaylist = () => {
  const files = state.unmatchedPlaylist
  return {
    id: UNMATCHED_ID,
    name: files?.name || UNMATCHED_NAME,
    directoryName: files?.directoryName || '',
    playlistPath: files?.directoryName ? `${files.directoryName}/${files.playlistFilename}` : '',
    playlistTrackCount: files?.playlistTrackCount || 0,
    playlistUpdatedAt: files?.playlistUpdatedAt || 0,
    playlistLastError: files?.playlistLastError || '',
  }
}

const syncUnmatchedPlaylist = (cachedSongs = deps?.getReadySongs?.() || []) => {
  if (!deps?.getDownloadRoot || !initialScanReady) return
  const files = state.unmatchedPlaylist ||= { id: UNMATCHED_ID, name: UNMATCHED_NAME }
  try {
    const root = deps.getDownloadRoot()
    const reserved = state.subscriptions.map(sub => sub.directoryName || '')
    if (files.directoryName && !files.nameCustomized && files.name === '本地未匹配') {
      playlistFiles.renamePlaylistDirectory(root, files, UNMATCHED_NAME, reserved)
      files.name = UNMATCHED_NAME
    }
    files.name ||= UNMATCHED_NAME
    playlistFiles.ensurePlaylistDirectory(root, files, reserved)
    const groups: Array<{ keys: string[], filename?: string, matched?: boolean }> = []
    const pathKey = (filename: string) => `path:${filename.replace(/\\/g, '/')}`
    const identityKeys = (song: any) => {
      const key = songKey(song)
      const name = normalizeSongText(song?.name || song?.meta?.songName)
      const singer = normalizeSongText(song?.singer || song?.meta?.singerName)
      return [...(key ? [`id:${key}`] : []), ...(name && singer ? [`metadata:${JSON.stringify([name, singer])}`] : [])]
    }
    for (const item of cachedSongs) {
      if (item.downloadComplete === false || !playlistFiles.audioExists(root, item.filename)) continue
      const physicalIdentity = playlistFiles.audioFileIdentity(root, item.filename)
      groups.push({ keys: [pathKey(item.filename), ...identityKeys(item.songInfo || item), ...(physicalIdentity ? [physicalIdentity] : [])], filename: item.filename.replace(/\\/g, '/') })
    }
    // Paused subscriptions still own their last successful snapshot. Network failures
    // never erase it, and old ID-only snapshots remain useful during migration.
    for (const sub of state.subscriptions) {
      const sameRoot = !sub.playlistRoot || sub.playlistRoot === root
      for (const [key, filename] of Object.entries(sameRoot ? sub.localFiles || {} : {})) {
        groups.push({ keys: [`id:${key}`, pathKey(filename)] })
      }
      for (const track of sub.remoteTracks || []) {
        const keys = identityKeys(track.songInfo)
        keys.push(`id:${track.key}`)
        if (sameRoot && track.localRelativePath) keys.push(pathKey(track.localRelativePath))
        groups.push({ keys, matched: true })
      }
      if (!sub.remoteTracks) for (const key of sub.knownSongIds) groups.push({ keys: [`id:${key}`], matched: true })
    }
    const tracks = playlistFiles.selectUnmatchedTracks(groups)
    const changed = playlistFiles.writePlaylistAtomic(root, files, tracks)
    files.playlistTrackCount = tracks.length
    files.playlistLastError = ''
    if (changed) {
      files.playlistUpdatedAt = Date.now()
      console.log(`[PlaylistSync] subscription=${UNMATCHED_ID} tracks=${tracks.length}`)
    }
  } catch (err: any) {
    files.playlistLastError = err?.message || '未匹配歌单同步失败'
    console.warn(`[PlaylistSync] failed subscription=${UNMATCHED_ID}: ${files.playlistLastError}`)
  }
  saveNow()
}

/** Synchronous filesystem commit: a completion, rename or unsubscribe cannot interleave. */
const syncPlaylist = (sub: PlaylistSubscription, cachedSongs = deps?.getReadySongs?.() || []) => {
  if (!deps?.getDownloadRoot || !sub.remoteTracks || removedIds.has(sub.id)) return
  try {
    const root = deps.getDownloadRoot()
    if (sub.playlistRoot && sub.playlistRoot !== root) {
      for (const track of sub.remoteTracks) track.localRelativePath = undefined
      sub.localCount = 0
      sub.playlistTrackCount = 0
      sub.localFiles = {}
    }
    ensureSubscriptionDirectory(root, sub)
    sub.playlistRoot = root
    sub.localFiles ||= {}
    const paths: string[] = []
    let localCount = 0
    for (const track of sub.remoteTracks) {
      track.localRelativePath ||= sub.localFiles[track.key]
      if (!playlistFiles.audioExists(root, track.localRelativePath)) track.localRelativePath = undefined
      const cached = cachedSongs.find(item => {
        const song = item.songInfo || item
        return (songKey(song) === track.key || hasSameSongMetadata(song, track.songInfo)) && playlistFiles.audioExists(root, item.filename)
      })
      if (track.localRelativePath || cached) localCount++
      if (!track.localRelativePath && cached) {
        track.localRelativePath = playlistFiles.materializeTrack(root, sub.directoryName!, track.key, cached.filename, undefined, cached.lyricFilename)
      }
      if (track.localRelativePath) paths.push(track.localRelativePath)
      if (track.localRelativePath) sub.localFiles[track.key] = track.localRelativePath
    }
    sub.localCount = localCount
    const changed = playlistFiles.writePlaylistAtomic(root, sub, paths)
    sub.playlistTrackCount = paths.length
    if (changed) sub.playlistUpdatedAt = Date.now()
    sub.playlistLastError = ''
    if (changed) console.log(`[PlaylistSync] subscription=${sub.id} tracks=${paths.length}/${sub.remoteTracks.length}`)
  } catch (err: any) {
    sub.playlistLastError = err?.message || '歌单文件同步失败'
    console.warn(`[PlaylistSync] failed subscription=${sub.id}: ${sub.playlistLastError}`)
  }
  saveNow()
}

/** Completion notifications are matched against persisted snapshots, including all shared-song subscribers. */
export const reconcilePlaylists = () => {
  const cached = deps?.getReadySongs?.() || []
  for (const sub of state.subscriptions) {
    if (sub.enabled) syncPlaylist(sub, cached)
  }
  syncUnmatchedPlaylist(cached)
}

export const notifyLocalScanComplete = () => {
  const needsRestore = !initialScanReady
  initialScanReady = true
  reconcilePlaylists()
  if (needsRestore) void restoreInitialDownloads()
}

export const rebuildPlaylist = (_username: string, id: string) => {
  if (id === UNMATCHED_ID) {
    if (!initialScanReady) throw new Error('本地音乐首次扫描尚未完成，请稍后重试')
    syncUnmatchedPlaylist()
    if (state.unmatchedPlaylist?.playlistLastError) throw new Error(state.unmatchedPlaylist.playlistLastError)
    return getUnmatchedPlaylist()
  }
  const sub = findSub(SHARED_SCOPE, id)
  if (!sub) throw new Error('订阅不存在')
  if (!sub.remoteTracks) throw new Error('请先检查订阅以获取完整歌曲列表')
  syncPlaylist(sub)
  if (sub.playlistLastError) throw new Error(sub.playlistLastError)
  return publicView(sub)
}

const renameFiles = (sub: PlaylistSubscription, name: string, force = false) => {
  if (!deps?.getDownloadRoot || (!force && name === sub.name)) return
  playlistFiles.ensurePlaylistDirectory(deps.getDownloadRoot(), sub, reservedDirectories(sub.id))
  if (deps.isDirectoryBusy?.(sub.directoryName!)) throw new Error('该歌单正在下载或写入标签，请等待当前任务完成后再改名')
  const oldDirectory = sub.directoryName
  playlistFiles.renamePlaylistDirectory(deps.getDownloadRoot(), sub, name, reservedDirectories(sub.id))
  rebaseSubscriptionPaths(sub, oldDirectory!)
  sub.playlistName = sub.directoryName
  sub.playlistNameCustomized = true
}

export const listNavidromePlaylists = () => [
  { ...getUnmatchedPlaylist(), kind: 'unmatched', subscriptionName: '' },
  ...state.subscriptions.map(sub => ({
    id: sub.id, kind: sub.kind, name: sub.playlistName || sub.directoryName || sub.name,
    subscriptionName: sub.name, directoryName: sub.directoryName || '',
    playlistPath: sub.directoryName ? `${sub.directoryName}/${sub.playlistFilename}` : '',
    playlistTrackCount: sub.playlistTrackCount || 0, playlistLastError: sub.playlistLastError || '',
    playlistUpdatedAt: sub.playlistUpdatedAt || 0,
  })),
]

export const renameNavidromePlaylist = (id: string, value: unknown) => {
  if (!deps?.getDownloadRoot || !initialScanReady) throw new Error('请等待本地音乐首次扫描完成')
  const name = String(value || '').trim()
  if (!name || playlistFiles.sanitizePlaylistName(name) !== name) throw new Error('名称不能为空，不能包含路径分隔符、非法字符或系统保留名称，且长度不能超过 64 个字符')
  if (id === UNMATCHED_ID) {
    const files = state.unmatchedPlaylist ||= { id: UNMATCHED_ID, name: UNMATCHED_NAME }
    if (files.directoryName && deps.isDirectoryBusy?.(files.directoryName)) throw new Error('该目录正在写入，请稍后再改名')
    const oldDirectory = files.directoryName
    playlistFiles.renamePlaylistDirectory(deps.getDownloadRoot(), files, name, state.subscriptions.map(sub => sub.directoryName || ''))
    files.name = name
    files.nameCustomized = true
    if (oldDirectory && oldDirectory !== files.directoryName) deps.onDirectoryRenamed?.(oldDirectory, files.directoryName!)
    syncUnmatchedPlaylist()
  } else {
    const sub = findSub(SHARED_SCOPE, id)
    if (!sub) throw new Error('歌单不存在')
    if (busy.has(id)) throw new Error('该订阅正在更新，请稍后再改名')
    renameFiles(sub, name, true)
    syncPlaylist(sub)
    syncUnmatchedPlaylist()
  }
  saveNow()
  return listNavidromePlaylists().find(playlist => playlist.id === id)!
}

/** Resolve at execution time so waiting/resumed tasks follow the current persisted directory. */
export const getDownloadDirectory = (songInfo: any) => {
  const key = songKey(songInfo)
  const sub = state.subscriptions.find(item => item.remoteTracks?.some(track => track.key === key || hasSameSongMetadata(track.songInfo, songInfo)))
  if (!sub || !deps?.getDownloadRoot) return undefined
  ensureSubscriptionDirectory(deps.getDownloadRoot(), sub)
  saveNow()
  return sub.directoryName
}

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
    const data = getJson<Partial<SubscriptionState>>('subscriptions', 'state', {})
    if (data && Array.isArray(data.subscriptions)) {
      state = {
        version: 1,
        intervalMinutes: normalizeInterval(data.intervalMinutes),
        unmatchedPlaylist: data.unmatchedPlaylist,
        subscriptions: data.subscriptions.map(sub => {
          const stats = { ...sub.stats }
          // 兼容已完成首次入队但旧版本未把初始歌曲计入 detected 的记录。
          if (sub.initialDownloadCompleted === true && stats.enqueued > stats.detected) {
            stats.detected = stats.enqueued
          }
          return {
            ...sub,
            kind: normalizeKind(sub.kind),
            stats,
            // 旧版本只建立基线，没有执行首次下载；启动后为这类订阅补入队。
            initialDownloadCompleted: sub.initialDownloadCompleted === true && Array.isArray(sub.remoteTracks),
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

const normalizeKind = (value: unknown): 'playlist' | 'leaderboard' => value === 'leaderboard' ? 'leaderboard' : 'playlist'

const buildId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

const findSub = (_username: string, id: string) => state.subscriptions.find(s => s.id === id)

const publicView = (sub: PlaylistSubscription) => {
  // 兼容服务热更新期间仍驻留内存的旧统计，确保首次入队也计入累计更新。
  if (sub.initialDownloadCompleted && sub.stats.enqueued > sub.stats.detected) {
    sub.stats.detected = sub.stats.enqueued
  }
  return {
    id: sub.id,
    kind: sub.kind,
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
    directoryName: sub.directoryName || '',
    playlistName: sub.playlistName || sub.directoryName || sub.name,
    playlistPath: sub.directoryName ? `${sub.directoryName}/${sub.playlistFilename}` : '',
    playlistUpdatedAt: sub.playlistUpdatedAt || 0,
    playlistLastError: sub.playlistLastError || '',
    localCount: sub.localCount || 0,
    playlistTrackCount: sub.playlistTrackCount || 0,
  }
}

/** 拉取远端歌单或榜单全部歌曲（自动翻页） */
const fetchRemoteSongs = async (sub: PlaylistSubscription): Promise<{ songs: any[], total: number, info: any }> => {
  const sdk = deps?.musicSdk?.[sub.source]?.[sub.kind === 'leaderboard' ? 'leaderboard' : 'songList']
  const getPage = sub.kind === 'leaderboard' ? sdk?.getList : sdk?.getListDetail
  if (!sdk || !getPage) throw new Error(`平台 ${sub.source} 不支持${sub.kind === 'leaderboard' ? '榜单' : '歌单'}`)

  const collected: any[] = []
  let total = 0
  let info: any = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await getPage.call(sdk, sub.sourceListId, page)
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
  const candidateKeys = sub.remoteTracks && sub.initialDownloadCompleted ? addedKeys : remoteKeys
  if (candidateKeys.length > 0 && sub.enabled) {
    // 订阅可能是在已有本地音乐之后才建立，或者歌单来源返回的 ID 与
    // 旧文件的 ID 不同（旧文件常被索引为 unknown_歌名 - 歌手）。
    // 先同步下载目录，再按 ID 或歌名+歌手过滤，避免更新歌单
    // 时把本地已有歌曲再次加入队列。
    const cachedSongs = (await deps!.getCachedSongs?.(SHARED_SCOPE) || []).filter(item => item.downloadComplete !== false)
    if (removedIds.has(sub.id) || !sub.enabled) return { addedKeys, addedSongs: [], enqueued: 0, skippedExisting: 0 }
    // Persist the full ordered snapshot before starting downloads; a very fast completion
    // can then find every subscriber even when the queue deduplicates a shared song.
    const previous = new Map((sub.remoteTracks || []).map(track => [track.key, track]))
    sub.remoteTracks = remoteKeys.map(key => ({ key, songInfo: keyToSong.get(key), localRelativePath: previous.get(key)?.localRelativePath }))
    syncPlaylist(sub, cachedSongs)
    if (sub.playlistLastError) throw new Error(sub.playlistLastError)
    const downloadableKeys = candidateKeys.filter(key => {
      const songInfo = keyToSong.get(key)
      const exists = cachedSongs.some(cached => {
        const cachedSongInfo = cached?.songInfo || cached
        return (songKey(cachedSongInfo) === key || hasSameSongMetadata(cachedSongInfo, songInfo)) &&
          (!deps?.getDownloadRoot || playlistFiles.audioExists(deps.getDownloadRoot(), cached.filename))
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
    const previous = new Map((sub.remoteTracks || []).map(track => [track.key, track]))
    sub.remoteTracks = remoteKeys.map(key => ({ key, songInfo: keyToSong.get(key), localRelativePath: previous.get(key)?.localRelativePath }))
    sub.knownSongIds = remoteKeys
    sub.knownTotal = total
    syncPlaylist(sub)
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
  if (busy.has(sub.id)) {
    if (isManual) throw new Error('该订阅正在更新，请稍后重试')
    return { id: sub.id, name: sub.name, error: '该订阅正在更新' }
  }
  busy.add(sub.id)
  const isBaseline = sub.knownSongIds.length === 0 && sub.knownTotal === 0
  try {
    const { songs, total } = await fetchRemoteSongs(sub)
    if (removedIds.has(sub.id)) return { id: sub.id, name: sub.name, error: '订阅已取消' }
    const { addedKeys, addedSongs, enqueued, skippedExisting } = await diffAndDownload(sub, songs, total, isBaseline)
    if (sub.enabled) sub.initialDownloadCompleted = true
    syncUnmatchedPlaylist()
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
  } finally { busy.delete(sub.id) }
}

const tick = async () => {
  if (checking || !deps || !initialScanReady) return
  checking = true
  try {
    // Refresh the disk index even when there are no network subscriptions.
    await deps.getCachedSongs?.(SHARED_SCOPE)
    reconcilePlaylists()
    const now = Date.now()
    const intervalMs = state.intervalMinutes * 60 * 1000
    const due = state.subscriptions.filter(s => s.enabled && now - s.lastCheckedAt >= intervalMs)
    for (const sub of due) {
      await checkSubscription(sub, false)
    }
  } catch (err: any) {
    console.warn('[PlaylistSync] Local music scan failed:', err?.message)
  } finally {
    checking = false
  }
}

/** 为旧版本已建立基线但未下载存量歌曲的订阅补做首次入队。 */
const restoreInitialDownloads = async () => {
  if (checking || !deps) return
  const pending = state.subscriptions.filter(sub => sub.enabled && (!sub.initialDownloadCompleted || !sub.remoteTracks))
  if (pending.length === 0) return

  checking = true
  try {
    for (const sub of pending) {
      if (busy.has(sub.id)) continue
      busy.add(sub.id)
      try {
        const { songs, total } = await fetchRemoteSongs(sub)
        if (removedIds.has(sub.id) || !sub.enabled) continue
        // Missing remoteTracks makes the entire remote list eligible without destroying the old baseline.
        const result = await diffAndDownload(sub, songs, total, true)
        syncUnmatchedPlaylist()
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
      } finally { busy.delete(sub.id) }
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
    const restore = () => {
      initialScanReady = true
      reconcilePlaylists()
      void restoreInitialDownloads()
    }
    if (subscriptionDeps.initialScan) {
      initialScanReady = false
      void subscriptionDeps.initialScan.then(restore).catch(err => console.warn('[PlaylistSync] Initial local scan failed:', err?.message))
    } else restore()
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
  kind?: 'playlist' | 'leaderboard'
  source: string
  sourceListId: string
  name?: string
  cover?: string
  quality?: string
}) => {
  if (!deps) throw new Error('Subscription module not initialized')
  const kind = normalizeKind(input.kind)
  const source = String(input.source || '').trim()
  const sourceListId = String(input.sourceListId || '').trim()
  if (!source || !sourceListId) throw new Error('缺少平台或歌单 ID')

  const existing = state.subscriptions.find(s => s.kind === kind && s.source === source && s.sourceListId === sourceListId)
  if (existing) throw new Error(`该${kind === 'leaderboard' ? '榜单' : '歌单'}已订阅`)

  const sub: PlaylistSubscription = {
    id: buildId(),
    kind,
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
  // Recheck after the network await to avoid concurrent duplicate subscriptions.
  if (state.subscriptions.some(s => s.kind === kind && s.source === source && s.sourceListId === sourceListId)) throw new Error('该歌单已订阅')
  state.subscriptions.push(sub)
  try {
    await diffAndDownload(sub, songs, total, true)
    sub.lastCheckedAt = Date.now()
    sub.stats.checks += 1
    sub.initialDownloadCompleted = true

    syncPlaylist(sub)
    syncUnmatchedPlaylist()
    saveNow()
    return publicView(sub)
  } catch (err) {
    state.subscriptions = state.subscriptions.filter(item => item !== sub)
    saveNow()
    throw err
  }
}

export const unsubscribe = (_username: string, id: string) => {
  const index = state.subscriptions.findIndex(s => s.id === id)
  if (index < 0) throw new Error('订阅不存在')
  const [removed] = state.subscriptions.splice(index, 1)
  removedIds.add(id)
  syncUnmatchedPlaylist()
  saveNow()
  return publicView(removed)
}

export const update = async (_username: string, id: string, patch: {
  kind?: 'playlist' | 'leaderboard'
  source?: string
  sourceListId?: string
  quality?: string
  enabled?: boolean
  name?: string
}) => {
  const sub = findSub(SHARED_SCOPE, id)
  if (!sub) throw new Error('订阅不存在')
  if (busy.has(id)) throw new Error('该订阅正在更新，请稍后重试')

  const nextSource = patch.source !== undefined ? String(patch.source).trim() : sub.source
  const nextSourceListId = patch.sourceListId !== undefined ? String(patch.sourceListId).trim() : sub.sourceListId
  const nextKind = patch.kind !== undefined ? normalizeKind(patch.kind) : sub.kind
  if (!nextSource || !nextSourceListId) throw new Error('缺少平台或歌单 ID')

  const targetChanged = nextKind !== sub.kind || nextSource !== sub.source || nextSourceListId !== sub.sourceListId
  if (targetChanged) {
    const duplicate = state.subscriptions.find(item => (
      item.id !== id && item.kind === nextKind && item.source === nextSource && item.sourceListId === nextSourceListId
    ))
    if (duplicate) throw new Error('该歌单已存在订阅')

    const nextSub: PlaylistSubscription = {
      ...sub,
      kind: nextKind,
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
      remoteTracks: undefined,
      stats: { checks: 0, detected: 0, enqueued: 0, lastError: '', lastErrorAt: 0 },
    }

    busy.add(id)
    try {
      const { songs, total, info } = await fetchRemoteSongs(nextSub)
      if (removedIds.has(id)) throw new Error('订阅已取消')
      if (state.subscriptions.some(item => item.id !== id && item.kind === nextKind && item.source === nextSource && item.sourceListId === nextSourceListId)) throw new Error('该歌单已存在订阅')
      if (patch.name === undefined && info) nextSub.name = String(info.name || info.title || nextSub.name).slice(0, 120)
      if (info) nextSub.cover = String(info.img || info.pic || info.cover || nextSub.cover)
      // Commit the new source before migrating an automatic platform-qualified directory.
      if (nextSub.enabled) await diffAndDownload(nextSub, songs, total, true)
      nextSub.lastCheckedAt = Date.now()
      nextSub.stats.checks += 1
      nextSub.initialDownloadCompleted = nextSub.enabled
      Object.assign(sub, nextSub)
      saveNow()
      syncPlaylist(sub)
      syncUnmatchedPlaylist()
      return publicView(sub)
    } finally { busy.delete(id) }
  }

  if (patch.name !== undefined) renameFiles(sub, String(patch.name).slice(0, 120))
  if (patch.quality !== undefined) sub.quality = normalizeQuality(patch.quality)
  if (patch.enabled !== undefined) sub.enabled = !!patch.enabled
  if (patch.name !== undefined) sub.name = String(patch.name).slice(0, 120)
  saveNow()
  if (sub.enabled) syncPlaylist(sub)
  syncUnmatchedPlaylist()
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
  if (saveTimer) clearTimeout(saveTimer)
  if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null; reconcilePlaylists() }
  tickTimer = null
  saveNow()
}
