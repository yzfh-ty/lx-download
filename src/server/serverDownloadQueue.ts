import * as fileCache from './fileCache'
import { getJson, loadDownloadTasks, saveDownloadTasks, setJson } from '@/storage/database'

export type ServerDownloadStatus = 'waiting' | 'downloading' | 'tagging' | 'paused' | 'finished' | 'exists' | 'error'

export interface ServerDownloadTask {
  id: string
  songKey: string
  activeSongKey?: string
  songInfo: any
  quality: string
  requestedQuality: string
  status: ServerDownloadStatus
  progress: number
  total: number
  received: number
  speed: number
  errorMsg: string
  fileNamePattern: 'name-artist' | 'artist-name' | 'name'
  cacheLyric: boolean
  embedMetadata: boolean
  embedCover: boolean
  embedLyric: boolean
  embedLyricTranslation: boolean
  embedLyricRoma: boolean
  embedLyricLx: boolean
  downloadLyricTranslation: boolean
  downloadLyricRoma: boolean
  downloadLyricLx: boolean
  downloadLyricFormat: 'utf8' | 'gbk'
  allowLyricSourceFallback: boolean
  createdAt: number
  updatedAt: number
}

interface QueueInput {
  id?: string
  songInfo: any
  quality?: string
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

interface ResolveResult {
  url: string
  quality?: string
  songInfo?: any
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
}

type DownloadResolver = (task: ServerDownloadTask) => Promise<ResolveResult>

const DEFAULT_CONCURRENT = 3
const MAX_CONCURRENT = 5
const tasks = new Map<string, ServerDownloadTask>()
const controllers = new Map<string, AbortController>()
let concurrency = DEFAULT_CONCURRENT
let resolver: DownloadResolver | null = null
let initialized = false
let processing = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

const SHARED_SCOPE = 'shared'
const taskMapKey = (_username: string, id: string) => id
const validStatuses = new Set<ServerDownloadStatus>(['waiting', 'downloading', 'tagging', 'paused', 'finished', 'exists', 'error'])

const normalizeConcurrency = (value: unknown) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENT
  return Math.min(MAX_CONCURRENT, Math.max(1, parsed))
}

export const getConcurrency = (_username: string) => concurrency

const sanitizeId = (value: unknown) => {
  const id = String(value || '')
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : `server_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

const saveNow = () => {
  if (!initialized) return
  try {
    setJson('download_queue', 'concurrency', concurrency)
    saveDownloadTasks(tasks.values())
  } catch (err) {
    console.warn('[ServerDownloadQueue] Failed to save SQLite queue:', err)
  }
}

const scheduleSave = () => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 150)
}

const loadTasks = () => {
  try {
    const savedTasks = loadDownloadTasks()
    if (!Array.isArray(savedTasks)) return
    const savedConcurrency = getJson<number | Record<string, unknown>>('download_queue', 'concurrency', DEFAULT_CONCURRENT)
    concurrency = normalizeConcurrency(typeof savedConcurrency === 'number'
      ? savedConcurrency
      : Object.values(savedConcurrency)[0])
    for (const raw of savedTasks) {
      if (!raw || !raw.songInfo) continue
      const id = sanitizeId(raw.id)
      const savedStatus = validStatuses.has(raw.status) ? raw.status as ServerDownloadStatus : 'waiting'
      const status: ServerDownloadStatus = savedStatus === 'downloading' || savedStatus === 'tagging' ? 'waiting' : savedStatus
      const quality = String(raw.quality || raw.requestedQuality || '320k')
      const requestedQuality = String(raw.requestedQuality || quality)
      const now = Date.now()
      const task: ServerDownloadTask = {
        id,
        songKey: String(raw.songKey || `${fileCache.normalizeSongId(raw.songInfo)}_${requestedQuality}`),
        activeSongKey: status === 'waiting' ? undefined : raw.activeSongKey ? String(raw.activeSongKey) : undefined,
        songInfo: raw.songInfo,
        quality: status === 'waiting' ? requestedQuality : quality,
        requestedQuality,
        status,
        progress: status === 'waiting' ? 0 : Number(raw.progress || 0),
        total: status === 'waiting' ? 0 : Number(raw.total || 0),
        received: status === 'waiting' ? 0 : Number(raw.received || 0),
        speed: 0,
        errorMsg: status === 'waiting' ? '' : String(raw.errorMsg || ''),
        fileNamePattern: ['name-artist', 'artist-name', 'name'].includes(raw.fileNamePattern) ? raw.fileNamePattern : 'name-artist',
        cacheLyric: raw.cacheLyric !== false,
        embedMetadata: raw.embedMetadata !== false,
        embedCover: raw.embedCover !== false,
        embedLyric: raw.embedLyric !== false,
        embedLyricTranslation: raw.embedLyricTranslation === true,
        embedLyricRoma: raw.embedLyricRoma === true,
        embedLyricLx: raw.embedLyricLx !== false,
        downloadLyricTranslation: raw.downloadLyricTranslation === true,
        downloadLyricRoma: raw.downloadLyricRoma === true,
        downloadLyricLx: raw.downloadLyricLx !== false,
        downloadLyricFormat: raw.downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8',
        allowLyricSourceFallback: raw.allowLyricSourceFallback !== false,
        createdAt: Number(raw.createdAt || now),
        updatedAt: now,
      }
      tasks.set(taskMapKey(SHARED_SCOPE, task.id), task)
    }
    console.log(`[ServerDownloadQueue] Restored ${tasks.size} persisted SQLite tasks`)
  } catch (err) {
    console.warn('[ServerDownloadQueue] Failed to restore queue:', err)
  }
}

const getPublicTask = (task: ServerDownloadTask) => {
  const live = task.status === 'downloading' && task.activeSongKey
    ? fileCache.cacheProgress.get(task.activeSongKey)
    : undefined
  const liveStatus = live?.status as ServerDownloadStatus | undefined
  return {
    id: task.id,
    songKey: task.activeSongKey || task.songKey,
    songInfo: task.songInfo,
    quality: task.quality,
    requestedQuality: task.requestedQuality,
    status: liveStatus || task.status,
    progress: Number(live?.progress ?? task.progress ?? 0),
    total: Number(live?.total ?? task.total ?? 0),
    received: Number(live?.received ?? task.received ?? 0),
    speed: Number(live?.speed ?? task.speed ?? 0),
    errorMsg: String(live?.errorMsg || task.errorMsg || ''),
    createdAt: task.createdAt,
    updatedAt: Number(live?.updatedAt || task.updatedAt),
  }
}

const runTask = async (task: ServerDownloadTask) => {
  if (!resolver || task.status !== 'waiting') return
  const key = taskMapKey(SHARED_SCOPE, task.id)
  const controller = new AbortController()
  controllers.set(key, controller)
  task.status = 'downloading'
  task.progress = 0
  task.total = 0
  task.received = 0
  task.speed = 0
  task.errorMsg = ''
  task.updatedAt = Date.now()
  scheduleSave()

  try {
    const resolved = await resolver(task)
    if (controller.signal.aborted) return
    if (!resolved?.url) throw new Error('无法解析下载地址')
    task.songInfo = resolved.songInfo || task.songInfo
    task.quality = resolved.quality || task.requestedQuality
    task.activeSongKey = fileCache.normalizeSongId(task.songInfo) + '_' + task.quality
    task.updatedAt = Date.now()
    scheduleSave()

    await fileCache.downloadAndCache(task.songInfo, resolved.url, task.quality, SHARED_SCOPE, controller.signal,
      true, task.cacheLyric, task.embedLyric, {
        requestedSource: resolved.requestedSource,
        downloadSource: resolved.downloadSource,
        sourceName: resolved.sourceName,
      }, {
        fileNamePattern: task.fileNamePattern,
        embedMetadata: task.embedMetadata,
        embedCover: task.embedCover,
        embedLyric: task.embedLyric,
        embedLyricTranslation: task.embedLyricTranslation,
        embedLyricRoma: task.embedLyricRoma,
        embedLyricLx: task.embedLyricLx,
        downloadLyric: task.cacheLyric,
        downloadLyricTranslation: task.downloadLyricTranslation,
        downloadLyricRoma: task.downloadLyricRoma,
        downloadLyricLx: task.downloadLyricLx,
        downloadLyricFormat: task.downloadLyricFormat,
        allowLyricSourceFallback: task.allowLyricSourceFallback,
      })

    if (controller.signal.aborted) return
    const progress = fileCache.cacheProgress.get(task.activeSongKey)
    task.status = progress?.status === 'exists' ? 'exists' : 'finished'
    task.progress = 100
    task.total = Number(progress?.total || progress?.received || task.total || 0)
    task.received = Number(progress?.received || task.total || 0)
    task.speed = 0
    task.errorMsg = ''
  } catch (err: any) {
    if (controller.signal.aborted || err?.message === 'Aborted') {
      task.status = 'paused'
      task.errorMsg = '已暂停'
    } else {
      task.status = 'error'
      task.errorMsg = err?.message || '下载失败'
    }
    task.speed = 0
  } finally {
    controllers.delete(key)
    task.updatedAt = Date.now()
    scheduleSave()
    void processQueue()
  }
}

const processQueue = async () => {
  if (processing || !resolver) return
  processing = true
  try {
    while (true) {
      let activeCount = 0
      for (const key of controllers.keys()) {
        if (tasks.has(key)) activeCount++
      }
      const next = Array.from(tasks.values()).find(task => (
        task.status === 'waiting' && activeCount < concurrency
      ))
      if (!next) break
      void runTask(next)
    }
  } finally {
    processing = false
  }
}

export const setConcurrency = (_username: string, value: unknown) => {
  const nextConcurrency = normalizeConcurrency(value)
  concurrency = nextConcurrency
  saveNow()
  void processQueue()
  return nextConcurrency
}

export const initialize = (downloadResolver: DownloadResolver) => {
  resolver = downloadResolver
  if (!initialized) {
    initialized = true
    loadTasks()
    saveNow()
  }
  void processQueue()
}

export const enqueue = (_username: string, inputs: QueueInput[]) => {
  const username = SHARED_SCOPE
  const added: ServerDownloadTask[] = []
  for (const input of inputs) {
    if (!input?.songInfo) continue
    const id = sanitizeId(input.id)
    const key = taskMapKey(username, id)
    const quality = input.quality || '320k'
    const existing = tasks.get(key)
    if (existing) {
      if (['waiting', 'downloading', 'tagging'].includes(existing.status)) continue

      const now = Date.now()
      existing.songKey = fileCache.normalizeSongId(input.songInfo) + '_' + quality
      existing.activeSongKey = undefined
      existing.songInfo = input.songInfo
      existing.quality = quality
      existing.requestedQuality = quality
      existing.status = 'waiting'
      existing.progress = 0
      existing.total = 0
      existing.received = 0
      existing.speed = 0
      existing.errorMsg = ''
      existing.fileNamePattern = ['name-artist', 'artist-name', 'name'].includes(input.fileNamePattern as string) ? input.fileNamePattern! : 'name-artist'
      existing.cacheLyric = input.cacheLyric !== false
      existing.embedMetadata = input.embedMetadata !== false
      existing.embedCover = input.embedCover !== false
      existing.embedLyric = input.embedLyric !== false
      existing.embedLyricTranslation = input.embedLyricTranslation === true
      existing.embedLyricRoma = input.embedLyricRoma === true
      existing.embedLyricLx = input.embedLyricLx !== false
      existing.downloadLyricTranslation = input.downloadLyricTranslation === true
      existing.downloadLyricRoma = input.downloadLyricRoma === true
      existing.downloadLyricLx = input.downloadLyricLx !== false
      existing.downloadLyricFormat = input.downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8'
      existing.allowLyricSourceFallback = input.allowLyricSourceFallback !== false
      existing.createdAt = now
      existing.updatedAt = now
      added.push(existing)
      continue
    }
    const now = Date.now()
    const task: ServerDownloadTask = {
      id,
      songKey: fileCache.normalizeSongId(input.songInfo) + '_' + quality,
      songInfo: input.songInfo,
      quality,
      requestedQuality: quality,
      status: 'waiting', progress: 0, total: 0, received: 0, speed: 0, errorMsg: '',
      fileNamePattern: ['name-artist', 'artist-name', 'name'].includes(input.fileNamePattern as string) ? input.fileNamePattern! : 'name-artist',
      cacheLyric: input.cacheLyric !== false,
      embedMetadata: input.embedMetadata !== false,
      embedCover: input.embedCover !== false,
      embedLyric: input.embedLyric !== false,
      embedLyricTranslation: input.embedLyricTranslation === true,
      embedLyricRoma: input.embedLyricRoma === true,
      embedLyricLx: input.embedLyricLx !== false,
      downloadLyricTranslation: input.downloadLyricTranslation === true,
      downloadLyricRoma: input.downloadLyricRoma === true,
      downloadLyricLx: input.downloadLyricLx !== false,
      downloadLyricFormat: input.downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8',
      allowLyricSourceFallback: input.allowLyricSourceFallback !== false,
      createdAt: now, updatedAt: now,
    }
    tasks.set(key, task)
    added.push(task)
  }
  saveNow()
  void processQueue()
  return added.map(task => getPublicTask(task))
}

export const list = (_username: string) => Array.from(tasks.values())
  .sort((a, b) => a.createdAt - b.createdAt)
  .map(task => getPublicTask(task))

export const pause = (_username: string, id?: string) => {
  for (const task of tasks.values()) {
    if (id && task.id !== id) continue
    if (!['waiting', 'downloading', 'tagging'].includes(task.status)) continue
    task.status = 'paused'
    task.speed = 0
    task.errorMsg = '已暂停'
    task.updatedAt = Date.now()
    controllers.get(taskMapKey(SHARED_SCOPE, task.id))?.abort()
  }
  saveNow()
}

export const resume = (_username: string, id?: string) => {
  for (const task of tasks.values()) {
    if (id && task.id !== id) continue
    if (task.status !== 'paused' && task.status !== 'error') continue
    task.status = 'waiting'
    task.progress = 0
    task.total = 0
    task.received = 0
    task.speed = 0
    task.errorMsg = ''
    task.activeSongKey = undefined
    task.quality = task.requestedQuality
    task.updatedAt = Date.now()
  }
  saveNow()
  void processQueue()
}

export const remove = (_username: string, options: { id?: string; all?: boolean; completed?: boolean }) => {
  for (const [key, task] of tasks) {
    const shouldRemove = options.all || (options.id && task.id === options.id) || (options.completed && ['finished', 'exists'].includes(task.status))
    if (!shouldRemove) continue
    controllers.get(key)?.abort()
    tasks.delete(key)
  }
  saveNow()
  void processQueue()
}
