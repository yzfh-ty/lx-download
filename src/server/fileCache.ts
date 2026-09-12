

import fs from 'fs'
import type { Stats } from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import { PassThrough } from 'stream'
const { MusicTagger, MetaPicture } = require('music-tag-native')
const { setMeta } = require('../common/utils/musicMeta')
const iconv = require('iconv-lite')
import { buildLyrics, parseLyrics } from '../utils/lrcTool'
import { formatPlayTime } from '../common/utils/common'
import { loadCacheItems, saveCacheItems } from '@/storage/database'
import { assertSeparateDirectories } from '@/utils/pathSafety'

export const readLyricFile = (filePath: string) => {
    const data = fs.readFileSync(filePath)
    if (data.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))) return iconv.decode(data, 'utf8')
    const utf8 = iconv.decode(data, 'utf8')
    return utf8.includes('\uFFFD') ? iconv.decode(data, 'gbk') : utf8
}

export const getMetadataProxy = () => {
    const config = (global as any).lx?.config
    if (config?.['proxy.all.enabled'] !== true || !config?.['proxy.all.address']) return undefined
    try {
        const proxyUrl = new URL(config['proxy.all.address'])
        if (!['http:', 'https:'].includes(proxyUrl.protocol)) return undefined
        return {
            host: proxyUrl.hostname,
            port: Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80)),
        }
    } catch (e) {
        return undefined
    }
}

// --- Cache Naming Patterns ---
export const CACHE_NAMING_PATTERNS = {
    STANDARD: 'standard',       // {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
    SIMPLE: 'simple'            // {Name} - {Singer} - {Quality} - {Album}
}

let currentNamingPattern = CACHE_NAMING_PATTERNS.SIMPLE

export const normalizeNamingPattern = (pattern: unknown) => (
    pattern === CACHE_NAMING_PATTERNS.STANDARD
        ? CACHE_NAMING_PATTERNS.STANDARD
        : CACHE_NAMING_PATTERNS.SIMPLE
)

export const setNamingPattern = (pattern: unknown) => {
    currentNamingPattern = normalizeNamingPattern(pattern)
    return currentNamingPattern
}

// All server cache files live below the project-level cache directory.
export const CACHE_ROOTS = {
    // Kept as a compatibility value for old callers; it is never used as a path.
    DATA: 'data',
    ROOT: 'root'
}

let currentCacheLocation = CACHE_ROOTS.ROOT

// [纯下载模式] 下载目录: 默认 <cwd>/download, 可通过设置自定义。
const DEFAULT_DOWNLOAD_DIR = 'download'
let currentDownloadDir = DEFAULT_DOWNLOAD_DIR
// Only internal remaster jobs can register an isolated storage scope.
const remasterStorage = new Map<string, { root: string; audio: string; covers: string }>()
export const validateDownloadDir = (dir: unknown) => {
    const normalized = typeof dir === 'string' ? dir.trim() : ''
    assertSeparateDirectories(normalized || DEFAULT_DOWNLOAD_DIR, path.join(process.cwd(), 'cache'))
    return normalized || DEFAULT_DOWNLOAD_DIR
}
export const setDownloadDir = (dir: unknown) => {
    currentDownloadDir = validateDownloadDir(dir)
    console.log(`[FileCache] Download dir set to: ${currentDownloadDir || '(default) download'}`)
}
export const getDownloadDir = () => currentDownloadDir
const resolveDownloadBase = (): string => path.resolve(
    currentDownloadDir,
)
const CACHE_LIST_SYNC_TTL = 30 * 1000
const cacheListSyncState: Map<string, { lastSync: number, pending?: Promise<void> }> = new Map()


// Helper to get actual directory path
// [Unified Enhancement] Cache Progress Tracker
export const cacheProgress: Map<string, { progress: number; status: string; total?: number; received?: number; speed?: number; updatedAt?: number; errorMsg?: string }> = new Map()

// [New] Active Cache Tasks Tracker: username -> [ { songKey, controller } ]
export const activeTasks: Map<string, Array<{ songKey: string, controller: AbortController }>> = new Map()

// [新增] 歌词获取钩子：由 server.ts 在启动时注入，避免 fileCache 直接依赖 musicSdk
// 调用时会通过 /api/music/lyric 接口逻辑（先查本地 .lrc 缓存，再去源站）获取完整歌词对象
export interface LyricOptions {
    embedMetadata?: boolean
    embedCover?: boolean
    embedLyric?: boolean
    embedLyricTranslation?: boolean
    embedLyricRoma?: boolean
    embedLyricLx?: boolean
    downloadLyric?: boolean
    downloadLyricTranslation?: boolean
    downloadLyricRoma?: boolean
    downloadLyricLx?: boolean
    downloadLyricFormat?: 'utf8' | 'gbk'
    allowLyricSourceFallback?: boolean
}

export interface DownloadOptions extends LyricOptions {
    fileNamePattern?: 'name-artist' | 'artist-name' | 'name'
}

type LyricData = string | { lyric?: string; lrc?: string; tlyric?: string; rlyric?: string; lxlyric?: string; klyric?: string }
type LyricFetcher = (songInfo: any, username?: string, allowFallback?: boolean) => Promise<LyricData | null>
let _lyricFetcher: LyricFetcher | null = null
export const setLyricFetcher = (fn: LyricFetcher) => { _lyricFetcher = fn }

export const getCacheDir = (username?: string, isOnlyDownload?: boolean, location?: string) => {
    const staging = username ? remasterStorage.get(username) : undefined
    if (staging) {
        fs.mkdirSync(staging.audio, { recursive: true })
        return staging.audio
    }
    // 纯下载模式: 所有用户共用同一个下载根目录，不再创建用户子目录。
    if (isOnlyDownload) {
        const fullPath = resolveDownloadBase()
        if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true })
        return fullPath
    }
    const baseDir = path.join(process.cwd(), 'cache', 'files')

    // Single Web client: cache files share one common directory.
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true })
    return baseDir
}

export const getCoverCacheDir = (username?: string, location?: string) => {
    const staging = username ? remasterStorage.get(username) : undefined
    if (staging) {
        fs.mkdirSync(staging.covers, { recursive: true })
        return staging.covers
    }
    // Cover files belong to the same cache root as other server cache files.
    const baseDir = path.join(process.cwd(), 'cache', 'covers')
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true })
    return baseDir
}

// --- Cache Index Manager ---
export interface CacheItem {
    downloadComplete?: boolean
    id: string
    songmid?: string
    name: string
    singer: string
    album: string
    albumId?: string
    img?: string
    interval?: string
    source: string
    requestedSource?: string
    downloadSource?: string
    sourceName?: string
    quality: string
    filename: string
    folder: string // 'cache' or 'music'
    subPath?: string // [New] Relative path within the folder (e.g. 'Pop/2024')
    mtime: number
    size: number
    lyricFilename?: string
    ext: string
    hasCover?: boolean
    coverType?: 'embedded' | 'cached' | 'remote' | 'none'
    hasLyric?: boolean
    hasEmbedLyric?: boolean
    audioContainer?: string
    metadataWritable?: boolean
    metadataError?: string
    embedLyricError?: string
    coverCheckedVersion?: number
    coverCheckedMtime?: number
    coverCheckedSize?: number
    bitrate?: number
    sampleRate?: number
    bitDepth?: number
}

export type CacheFolder = 'cache' | 'music'

export interface RemoveCacheFileResult {
    deleted: boolean
    folder?: CacheFolder
}

export interface DownloadProvenance {
    requestedSource?: string
    downloadSource?: string
    sourceName?: string
}

class CacheIndexManager {
    private indexes: Map<string, Map<string, CacheItem>> = new Map() // "root:scope:folder" -> (songId -> CacheItem)

    private getScope(username: string, folder: 'cache' | 'music') {
        if (remasterStorage.has(username)) return username
        // All Web requests share one cache and download index.
        return 'shared'
    }

    private getIndexFile(username: string, folder: 'cache' | 'music', location?: string) {
        // Legacy JSON indexes used to sit beside the old cache files. New
        // indexes are stored in SQLite, so this path is read only for migration.
        const userDir = folder === 'music'
            ? getCacheDir(username, true)
            : path.join(process.cwd(), 'cache')

        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true })
        }
        const fileName = folder === 'music' ? 'download_index.json' : 'cache_index.json'
        return path.join(userDir, fileName)
    }

    private getKey(username: string, folder: 'cache' | 'music', location?: string) {
        const rootKey = remasterStorage.get(username)?.audio || (folder === 'music' ? resolveDownloadBase() : CACHE_ROOTS.ROOT)
        return `${rootKey}:${this.getScope(username, folder)}:${folder}`
    }

    load(username: string, folder: 'cache' | 'music', location?: string) {
        const key = this.getKey(username, folder, location)
        const entries = loadCacheItems(key)
        if (entries.length > 0) {
            this.indexes.set(key, new Map(entries))
            return this.indexes.get(key)!
        }

        // One-time import from the old JSON index. Runtime writes go to SQLite.
        const file = this.getIndexFile(username, folder, location)
        if (fs.existsSync(file)) {
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
                const imported = new Map<string, CacheItem>(Object.entries(data) as Array<[string, CacheItem]>)
                this.indexes.set(key, imported)
                saveCacheItems(key, imported.entries())
                try { fs.unlinkSync(file) } catch { /* best effort */ }
                return imported
            } catch (e) {
                // Ignore malformed legacy indexes and start clean.
            }
        }
        this.indexes.set(key, new Map())
        return this.indexes.get(key)!
    }

    save(username: string, folder: 'cache' | 'music', location?: string) {
        const loc = location || currentCacheLocation
        const key = this.getKey(username, folder, loc)
        const index = this.indexes.get(key)
        if (!index) return

        try {
            saveCacheItems(key, index.entries())
        } catch (e) {
            console.error(`[CacheIndex] Failed to save index for ${key}:`, e)
        }
    }

    get(username: string, songId: string, folder: 'cache' | 'music', quality?: string, exact: boolean = false, location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        if (quality) {
            const item = index.get(`${songId}_${quality}`)
            if (item) return item
            // exact 模式：精确匹配失败则不 fallback，直接返回 undefined
            if (exact) return undefined
        }
        // Fallback: 非精确模式下扫描同 ID 的任意质量
        const prefix = `${songId}_`
        for (const [k, item] of index.entries()) {
            if (k === songId || k.startsWith(prefix)) return item
        }
        return undefined
    }

    update(username: string, item: CacheItem, folder: 'cache' | 'music', location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        // Use composite key id_quality
        const itemKey = `${item.id}_${item.quality || 'unknown'}`
        index.set(itemKey, item)
        this.save(username, folder, location)
    }

    remove(username: string, songId: string, folder: 'cache' | 'music', quality?: string, location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        if (quality) {
            if (index.delete(`${songId}_${quality}`)) {
                this.save(username, folder, location)
                return true
            }
        }
        // Legacy or bulk remove by ID
        let deleted = false
        const prefix = `${songId}_`
        for (const k of Array.from(index.keys())) {
            if (k === songId || k.startsWith(prefix)) {
                index.delete(k)
                deleted = true
            }
        }
        if (deleted) this.save(username, folder, location)
        return deleted
    }

    getAll(username: string, folder: 'cache' | 'music', location?: string) {
        return Array.from((this.indexes.get(this.getKey(username, folder, location)) || this.load(username, folder, location)).values())
    }

    discard(username: string, folder: 'cache' | 'music', location?: string) {
        const key = this.getKey(username, folder, location)
        this.indexes.delete(key)
        saveCacheItems(key, [])
    }
}

export const indexManager = new CacheIndexManager()

const COVER_CHECK_VERSION = 4

const getCoverCacheHash = (filename: string, stats?: Stats) => {
    const version = stats ? `${stats.size}:${stats.mtimeMs}` : ''
    return crypto.createHash('md5').update(`${filename}:${version}`).digest('hex')
}

const getCoverCachePaths = (filename: string, username: string, stats?: Stats) => {
    const hash = getCoverCacheHash(filename, stats)
    const coverCacheDir = getCoverCacheDir(username)
    return {
        binPath: path.join(coverCacheDir, `${hash}.bin`),
        mimePath: path.join(coverCacheDir, `${hash}.mime`),
    }
}

const detectImageMime = (data: Buffer | Uint8Array) => {
    const buffer = Buffer.from(data)
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif'
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
    return null
}

const readCoverCache = (filename: string, username: string, stats?: Stats) => {
    const candidates = [getCoverCachePaths(filename, username, stats)]
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate.binPath) || !fs.existsSync(candidate.mimePath)) continue
            const data = fs.readFileSync(candidate.binPath)
            const detectedMime = detectImageMime(data)
            if (!detectedMime) continue
            const storedMime = fs.readFileSync(candidate.mimePath, 'utf8').trim()
            const persistent = getCoverCachePaths(filename, username, stats)
            if (candidate.binPath !== persistent.binPath) {
                fs.copyFileSync(candidate.binPath, persistent.binPath)
                fs.writeFileSync(persistent.mimePath, detectedMime || storedMime || 'image/jpeg')
            }
            return { data, mime: detectedMime || storedMime || 'image/jpeg' }
        } catch (e) { }
    }
    return null
}

const hasCachedCover = (filename: string, username: string, stats?: Stats) => {
    return !!readCoverCache(filename, username, stats)
}

const writeCoverCache = (filename: string, username: string, data: Buffer | Uint8Array, mime: string, stats?: Stats) => {
    const coverData = Buffer.from(data)
    const detectedMime = detectImageMime(coverData)
    if (!detectedMime) return false
    const { binPath, mimePath } = getCoverCachePaths(filename, username, stats)
    fs.writeFileSync(binPath, coverData)
    fs.writeFileSync(mimePath, detectedMime || mime || 'image/jpeg')
    return true
}

const resolveCacheRelativePath = (dir: string, filename: string) => {
    const root = path.resolve(dir)
    const resolved = path.resolve(root, filename)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null
    }
    return resolved
}

const walkCacheFiles = (root: string, callback: (filePath: string, relativePath: string, stats: fs.Stats) => void) => {
    if (!fs.existsSync(root)) return
    const visit = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const filePath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                visit(filePath)
                continue
            }
            if (!entry.isFile()) continue
            try {
                callback(filePath, path.relative(root, filePath).replace(/\\/g, '/'), fs.statSync(filePath))
            } catch (e) { }
        }
    }
    visit(root)
}

const removeEmptyCacheDirectories = (root: string) => {
    if (!fs.existsSync(root)) return
    const dirs: string[] = []
    const collect = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const child = path.join(dir, entry.name)
            collect(child)
            dirs.push(child)
        }
    }
    collect(root)
    for (const dir of dirs.reverse()) {
        try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir) } catch (e) { }
    }
}

const hasValidPictureData = (picture: any) => {
    if (!picture || !picture.data) return false
    try {
        return !!detectImageMime(Buffer.from(picture.data))
    } catch (e) {
        return false
    }
}

const hasValidEmbeddedCover = (pictures: any) => {
    return Array.isArray(pictures) && pictures.some(hasValidPictureData)
}

const isPlaceholderCoverUrl = (url: any) => {
    return typeof url === 'string' && /\/T002R\d+x\d+M000\.jpg(?:$|\?)/.test(url)
}

const hasUsableRemoteCover = (url: any) => typeof url === 'string' && /^https?:\/\//i.test(url) && !isPlaceholderCoverUrl(url)

const detectAudioContainer = (filePath: string) => {
    try {
        const fd = fs.openSync(filePath, 'r')
        const buffer = Buffer.alloc(16)
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
        fs.closeSync(fd)
        const head = buffer.subarray(0, bytesRead)
        if (head.subarray(0, 3).toString('ascii') === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'mp3'
        if (head.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac'
        if (head.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg'
        if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
        if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4'
        if (head.subarray(0, 4).toString('ascii') === 'MAC ') return 'ape'
        if (head[0] === 0x7b) return 'encrypted'
        return 'unknown'
    } catch (e) {
        return 'unknown'
    }
}

const getMetadataUnsupportedMessage = (container: string) => (
    container === 'encrypted'
        ? '音频为加密或非标准容器，无法写入封面和歌词标签'
        : '当前音频容器不支持写入封面和歌词标签'
)

export const getAudioMetadataUnsupportedStatus = (filePath: string) => {
    const audioContainer = detectAudioContainer(filePath)
    return {
        audioContainer,
        metadataWritable: false,
        error: getMetadataUnsupportedMessage(audioContainer),
    }
}

const readEmbeddedCoverState = (filePath: string) => {
    let tagger: any
    try {
        tagger = new MusicTagger()
        tagger.loadPath(filePath)
        return hasValidEmbeddedCover(tagger.pictures)
    } catch (e) {
        return false
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
    }
}

export const embedLyricsIntoFile = async (filePath: string, lyricText: string, metadata: any = {}) => {
    const audioContainer = detectAudioContainer(filePath)
    let tagger: any
    try {
        tagger = new MusicTagger()
        tagger.loadPath(filePath)
        const meta = {
            title: metadata.title ?? tagger.title ?? '',
            artist: metadata.artist ?? tagger.artist ?? '',
            album: metadata.album ?? tagger.album ?? '',
            APIC: metadata.APIC || null,
            lyrics: lyricText,
        }
        tagger.dispose()
        tagger = null
        const written = await setMeta(filePath, meta, getMetadataProxy())
        if (written === false) throw new Error(getMetadataUnsupportedMessage(audioContainer))
    } catch (e: any) {
        return {
            success: false,
            hasEmbedLyric: false,
            audioContainer,
            metadataWritable: false,
            error: e?.message || getMetadataUnsupportedMessage(audioContainer),
        }
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
    }

    let verifyTagger: any
    try {
        verifyTagger = new MusicTagger()
        verifyTagger.loadPath(filePath)
        const embeddedLyrics = verifyTagger.lyrics
        const hasEmbedLyric = !!(embeddedLyrics && embeddedLyrics.trim().length > 10)
        return {
            success: hasEmbedLyric,
            hasEmbedLyric,
            audioContainer,
            metadataWritable: true,
            error: hasEmbedLyric ? undefined : '歌词标签写入后校验失败，已保留外置歌词文件',
        }
    } catch (e: any) {
        return {
            success: false,
            hasEmbedLyric: false,
            audioContainer,
            metadataWritable: false,
            error: getMetadataUnsupportedMessage(audioContainer),
        }
    } finally {
        try { if (verifyTagger) verifyTagger.dispose() } catch (e) { }
    }
}

// Ensure directory exists
const ensureDir = (username?: string, isOnlyDownload?: boolean) => {
    const dir = getCacheDir(username, isOnlyDownload)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
    return dir
}

// Safe rename: try rename, fall back to copy+unlink if rename fails (cross-device, permissions, etc.)
const safeRenameSync = (src: string, dst: string) => {
    try {
        fs.renameSync(src, dst)
        return true
    } catch (err) {
        try {
            fs.copyFileSync(src, dst)
            fs.unlinkSync(src)
            return true
        } catch (err2) {
            throw err // keep original error context
        }
    }
}

/**
 * 规范化歌曲 ID：确保带上 source 前缀，与索引中的 Key 保持一致
 */
export const normalizeSongId = (songInfo: any): string => {
    let id = String(songInfo.songmid || songInfo.songId || songInfo.id || '')
    const source = songInfo.source || 'unknown'
    if (id && !id.includes('_') && source !== 'unknown') {
        id = `${source}_${id}`
    }
    return id
}

/**
 * Extract rich metadata from Lx songInfo object
 */
const extractSongMetadata = (songInfo: any) => {
    const meta = songInfo.meta || {}
    const id = normalizeSongId(songInfo)
    return {
        id: id,
        name: songInfo.name || meta.songName || 'Unknown',
        singer: (songInfo.singer || meta.singerName || 'Unknown').replaceAll('、', ';'),
        album: songInfo.albumName || meta.albumName ||
            (typeof songInfo.album === 'string' ? songInfo.album : songInfo.album?.name) || '',
        albumId: String(songInfo.albumId || meta.albumId || ''),
        img: songInfo.img || meta.picUrl || '',
        interval: songInfo.interval || meta.interval || '',
        source: songInfo.source || 'unknown'
    }
}

/**
 * Detect quality tag from bitrate and file metadata
 */
const detectQualityFromBitrate = (bitrate: number | undefined, ext: string, tagger?: any): LX.Quality => {
    const nativeQuality = String(tagger?.quality || '').toLowerCase()
    const isLossless = ext === '.flac' || ext === '.wav' || ext === '.ape' || nativeQuality === 'sq' || nativeQuality === 'hires'
    const br = bitrate || 0 // Already in kbps from music-tag-native

    if (isLossless) {
        const bitDepth = tagger?.bitDepth || 16
        const sampleRate = tagger?.sampleRate || 44100

        if (br > 4500 || sampleRate > 96000) return 'master' as LX.Quality
        if (br > 1000 || bitDepth > 16 || sampleRate > 48000) return 'flac24bit'
        return 'flac'
    }

    // Lossy formats (mp3, m4a, etc.)
    if (br >= 240) return '320k'
    if (br >= 170) return '192k'
    return '128k'
}

const losslessQualitySet = new Set(['flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master', 'ape', 'wav'])

const isClearlyLossyAudio = (container: string, tagger?: any) => {
    const nativeQuality = String(tagger?.quality || '').toLowerCase()
    return nativeQuality === 'hq' || container === 'mp3' || container === 'ogg'
}

const resolveInspectedQuality = (requestedQuality: string | undefined, detectedQuality: string, container: string, tagger?: any) => {
    if (isClearlyLossyAudio(container, tagger)) return detectedQuality
    if (requestedQuality && losslessQualitySet.has(requestedQuality)) return requestedQuality
    return detectedQuality
}

const needsQualityCorrection = (quality: string | undefined, container: string) => (
    !!quality && losslessQualitySet.has(quality) && (container === 'mp3' || container === 'ogg')
)

const inspectAudioFile = (filePath: string, requestedQuality?: string) => {
    const audioContainer = detectAudioContainer(filePath)
    const ext = audioContainer === 'unknown' || audioContainer === 'encrypted'
        ? path.extname(filePath).toLowerCase()
        : `.${audioContainer === 'mp4' ? 'm4a' : audioContainer}`
    let tagger: any
    try {
        tagger = new MusicTagger()
        tagger.loadPath(filePath)
        const bitrate = Number(tagger.bitRate) || undefined
        const detectedQuality = detectQualityFromBitrate(bitrate, ext, tagger)
        return {
            audioContainer,
            extension: ext,
            quality: resolveInspectedQuality(requestedQuality, detectedQuality, audioContainer, tagger),
            bitrate,
            sampleRate: Number(tagger.sampleRate) || undefined,
            bitDepth: Number(tagger.bitDepth) || undefined,
        }
    } catch (e) {
        const detectedQuality = detectQualityFromBitrate(undefined, ext)
        return {
            audioContainer,
            extension: ext,
            quality: needsQualityCorrection(requestedQuality, audioContainer) ? detectedQuality : (requestedQuality || detectedQuality),
            bitrate: undefined,
            sampleRate: undefined,
            bitDepth: undefined,
        }
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
    }
}

export const detectDownloadSource = (rawUrl: string, fallbackSource?: string) => {
    let value = String(rawUrl || '').toLowerCase()
    try { value = decodeURIComponent(value) } catch (e) { }

    const sourcePatterns: Array<[string, RegExp]> = [
        ['kw', /(?:^|[./])(?:kuwo\.cn|kuwo\.com)(?:[/:?]|$)/],
        ['wy', /(?:^|[./])(?:music\.126\.net|music\.163\.com|163yun\.com)(?:[/:?]|$)/],
        ['tx', /(?:^|[./])(?:qqmusic\.qq\.com|music\.tc\.qq\.com|stream\.qqmusic\.qq\.com)(?:[/:?]|$)/],
        ['kg', /(?:^|[./])(?:kugou\.com|kugou\.net)(?:[/:?]|$)/],
        ['mg', /(?:^|[./])(?:migu\.cn|miguvideo\.com|cmvideo\.cn)(?:[/:?]|$)/],
    ]
    for (const [source, pattern] of sourcePatterns) {
        if (pattern.test(value)) return source
    }
    return fallbackSource || undefined
}

// Generate consistent filename based on pattern with collision handling
const getFileName = (songInfo: any, quality?: string, isOnlyDownload?: boolean, username?: string) => {
    const sanitizeFilename = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

    const id = normalizeSongId(songInfo)
    const source = songInfo.source || 'unknown'
    const q = quality || songInfo.quality || 'unknown'
    const nameStr = sanitizeFilename(songInfo.name || 'Unknown')
    const singerStr = sanitizeFilename(songInfo.singer || 'Unknown')
    const albumValue = songInfo.albumName || songInfo.meta?.albumName ||
        (typeof songInfo.album === 'string' ? songInfo.album : songInfo.album?.name) ||
        'Unknown Album'
    const albumStr = sanitizeFilename(albumValue)

    const fileNamePattern = songInfo.__fileNamePattern || 'name-artist'
    let baseName = ''
    if (fileNamePattern === 'artist-name') {
        baseName = `${singerStr} - ${nameStr}`
    } else if (fileNamePattern === 'name') {
        baseName = nameStr
    } else if (currentNamingPattern === CACHE_NAMING_PATTERNS.SIMPLE && !songInfo.__fileNamePattern) {
        baseName = `${nameStr} - ${singerStr} - ${sanitizeFilename(q)} - ${albumStr}`
    } else {
        // Legacy/standard naming remains available for old internal callers.
        baseName = songInfo.__fileNamePattern
            ? `${nameStr} - ${singerStr}`
            : `${nameStr}_-_${singerStr}_-_${sanitizeFilename(source)}_-_${sanitizeFilename(id)}_-_${sanitizeFilename(q)}`
    }

    baseName = baseName.substring(0, 200)
    if (username) {
        const folder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const existingItems = indexManager.getAll(normalizedUsername, folder)
        const dir = getCacheDir(normalizedUsername, isOnlyDownload)
        const diskNames = new Set(fs.readdirSync(dir).filter(name => !name.endsWith('.tmp'))
            .map(name => path.basename(name, path.extname(name)).toLowerCase()))
        const conflicts = (candidate: string) => {
            const matching = existingItems.filter(item => path.basename(item.filename, path.extname(item.filename)).toLowerCase() === candidate.toLowerCase())
            if (matching.some(item => normalizeSongId(item) !== id || String(item.quality) !== String(q))) return true
            return matching.length === 0 && diskNames.has(candidate.toLowerCase())
        }
        const original = baseName
        let number = 1
        while (conflicts(baseName)) {
            const suffix = ` (${sanitizeFilename(id).slice(0, 60)}_${sanitizeFilename(q).slice(0, 20)}${number > 1 ? '_' + number : ''})`
            baseName = original.substring(0, 200 - suffix.length) + suffix
            number++
        }
    }

    if (baseName.length > 200) baseName = baseName.substring(0, 200)
    return baseName
}

// Helper to sanitize for URL/Path
const sanitize = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

const activeDownloadPaths = new Set<string>()
export const hasActiveDownloads = () => activeDownloadPaths.size > 0
const reservedDownloadNames = new Set<string>()
const allocateDownloadTempPath = (dir: string, songKey: string, pattern: string) => {
    const key = crypto.createHash('sha256').update(`${songKey}\0${pattern}`).digest('hex')
    let target = path.join(dir, `.lx-download-${key}.tmp`)
    if (activeDownloadPaths.has(target)) target = path.join(dir, `.lx-download-${key}-${crypto.randomUUID()}.tmp`)
    activeDownloadPaths.add(target)
    return target
}

const installDownloadedFile = async (tempPath: string, dir: string, preferredName: string, ext: string) => {
    for (let number = 1; ; number++) {
        const suffix = number === 1 ? '' : ` (${number})`
        const finalBaseName = preferredName.substring(0, 200 - suffix.length) + suffix
        const finalPath = path.join(dir, finalBaseName + ext)
        const reservation = path.resolve(dir, finalBaseName).toLowerCase()
        // Reserve the basename across containers, since MP3/FLAC share a .lrc sidecar.
        if (reservedDownloadNames.has(reservation) || fs.readdirSync(dir).some(name => (
            !name.endsWith('.tmp') && path.basename(name, path.extname(name)).toLowerCase() === finalBaseName.toLowerCase()
        ))) continue
        reservedDownloadNames.add(reservation)
        try {
            // Exclusive creation also protects against another task finishing between checks.
            await fs.promises.copyFile(tempPath, finalPath, fs.constants.COPYFILE_EXCL)
        } catch (error: any) {
            if (error.code === 'EEXIST') continue
            throw error
        } finally {
            reservedDownloadNames.delete(reservation)
        }
        await fs.promises.unlink(tempPath)
        return { finalPath, finalBaseName }
    }
}

// --- Public APIs ---

/**
 * Sync disk files with index database
 */
export const syncCacheIndex = async (username?: string, roots: Array<'cache' | 'music'> = ['music']) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav']

    for (const folder of roots) {
        const index = indexManager.load(normalizedUsername, folder)

        let updated = false
        const existingKeysInIndex = new Set(index.keys())
        const foundKeysOnDisk = new Set<string>()

        // Pre-build a filename to Item map within this folder for fast lookup
        const filenameToItemMap = new Map<string, { key: string, item: CacheItem }>()
        for (const [key, item] of index.entries()) {
            filenameToItemMap.set(item.filename, { key, item })
        }
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue

        // [Unified Enhancement] Recursive file walker (asynchronous)
        const getAllFilesAsync = async (dirPath: string, base: string = dirPath): Promise<string[]> => {
            const acc: string[] = []
            try {
                const exists = await fs.promises.access(dirPath).then(() => true).catch(() => false)
                if (!exists) return acc
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name)
                    if (entry.isDirectory()) {
                        const subFiles = await getAllFilesAsync(fullPath, base)
                        acc.push(...subFiles)
                    } else {
                        acc.push(path.relative(base, fullPath).replace(/\\/g, '/'))
                    }
                }
            } catch (e) {
                console.error(`[fileCache] error walking path: ${dirPath}`, e)
            }
            return acc
        }

        const files = await getAllFilesAsync(dir)
        for (const file of files) {
            if (file === 'cache_index.json' || file === 'music_index.json' || file === 'download_index.json') continue
            const ext = path.extname(file).toLowerCase()
            if (!extensions.includes(ext)) continue

            const filePath = path.join(dir, file)
            const stats = await fs.promises.stat(filePath)

            // Try to find if this file is already known in index by its filename
            let existingEntry = filenameToItemMap.get(file)
            let existing = existingEntry?.item
            let oldKey = existingEntry?.key

            let songId = existing?.id || ''
            let songName = existing?.name || ''
            let singer = existing?.singer || ''
            let source = existing?.source || ''
            let quality = existing?.quality || ''
            let album = existing?.album || ''
            let hasCover = existing?.hasCover || false

            // subPath calculation: the directory part of the relative path
            const subPath = path.dirname(file) === '.' ? '' : path.dirname(file).replace(/\\/g, '/')
            const fileNameOnly = path.basename(file)

            const nameWithoutExt = path.basename(fileNameOnly, ext)

            if (!existing) {
                // Not found by filename, try to parse from standard format
                const segments = nameWithoutExt.split('_-_')
                if (segments.length >= 5) {
                    songName = segments[0]
                    singer = segments[1]
                    source = segments[2]
                    songId = segments[3]
                    quality = segments[4]
                } else {
                    // Try simple pattern: Name - Singer - Quality - Album
                    const segmentsShort = nameWithoutExt.split(' - ')
                    if (segmentsShort.length >= 2) {
                        songName = segmentsShort[0]
                        singer = segmentsShort[1]
                        quality = segmentsShort[2] || 'unknown'
                        album = segmentsShort.slice(3).join(' - ')
                        songId = nameWithoutExt // Fallback ID for unknown files
                    } else {
                        // Fallback for completely unknown filenames (e.g. download_4.mp3)
                        songId = nameWithoutExt
                        source = 'unknown'
                        quality = 'unknown'
                    }
                }
            }

            if (!songId) continue
            // Normalize ID
            const normalizedId = songId.includes('_') ? songId : `${source || 'unknown'}_${songId}`

            // Always check for companion lyric file
            const lrcFile = file.substring(0, file.length - ext.length) + '.lrc'
            const hasLyricOnDisk = await fs.promises.access(path.join(dir, lrcFile)).then(() => true).catch(() => false)

            let finalQuality = quality || 'unknown'

            const needsCoverCheck = !existing ||
                existing.coverCheckedVersion !== COVER_CHECK_VERSION ||
                existing.coverCheckedMtime !== stats.mtimeMs ||
                existing.coverCheckedSize !== stats.size ||
                existing.hasCover === undefined ||
                (existing.coverType === 'cached' && !hasCachedCover(file, normalizedUsername, stats))
            const currentAudioContainer = existing?.audioContainer || detectAudioContainer(filePath)
            const qualityCorrectionNeeded = !!existing && needsQualityCorrection(existing.quality, currentAudioContainer)

            // Update or add to index if anything changed (size, mtime, lyric status, or cover status)
            if (!existing || existing.size !== stats.size || existing.hasLyric !== hasLyricOnDisk || needsCoverCheck || !existing.interval || existing.quality === 'unknown' || !existing.bitrate || qualityCorrectionNeeded) {
                if (existing) {
                    existing.size = stats.size
                    existing.mtime = stats.mtimeMs
                    existing.hasLyric = hasLyricOnDisk
                    existing.lyricFilename = hasLyricOnDisk ? lrcFile : undefined

                    if (existing.subPath !== subPath) {
                        existing.subPath = subPath
                        updated = true
                    }

                    if (needsCoverCheck) {
                        const hasEmbeddedCover = readEmbeddedCoverState(filePath)
                        const hasExternalCover = !hasEmbeddedCover && hasCachedCover(file, normalizedUsername, stats)
                        const coverType: CacheItem['coverType'] = hasEmbeddedCover
                            ? 'embedded'
                            : hasExternalCover
                                ? 'cached'
                                : hasUsableRemoteCover(existing.img)
                                    ? 'remote'
                                    : 'none'
                        const actualHasCover = coverType !== 'none'
                        if (existing.hasCover !== actualHasCover) updated = true
                        existing.hasCover = actualHasCover
                        existing.coverType = coverType
                        existing.coverCheckedVersion = COVER_CHECK_VERSION
                        existing.coverCheckedMtime = stats.mtimeMs
                        existing.coverCheckedSize = stats.size
                    }

                    // If interval or quality/bitrate is missing/unknown, or hasEmbedLyric not yet detected, try to extract it
                    if (!existing.interval || existing.quality === 'unknown' || !existing.bitrate || existing.hasEmbedLyric === undefined || existing.metadataWritable === undefined || qualityCorrectionNeeded) {
                        let tagger: any
                        try {
                            tagger = new MusicTagger()
                            tagger.loadPath(filePath)
                            const dur = tagger.duration
                            if (dur && !existing.interval) existing.interval = formatPlayTime(dur / 1000)
                            existing.bitrate = tagger.bitRate
                            existing.sampleRate = tagger.sampleRate
                            existing.bitDepth = tagger.bitDepth
                            if (!existing.quality || existing.quality === 'unknown' || qualityCorrectionNeeded) {
                                const detectedQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)
                                existing.quality = resolveInspectedQuality(existing.quality, detectedQuality, currentAudioContainer, tagger)
                            }
                            // [新增] 检测是否已嵌入歌词 USLT 标签
                            if (existing.hasEmbedLyric === undefined) {
                                const lyricsInTag = tagger.lyrics
                                existing.hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                            }
                            existing.audioContainer = currentAudioContainer
                            existing.metadataWritable = true
                            existing.metadataError = undefined
                        } catch (e: any) {
                            existing.audioContainer = currentAudioContainer
                            existing.metadataWritable = false
                            existing.metadataError = getMetadataUnsupportedMessage(existing.audioContainer)
                            existing.hasEmbedLyric = false
                        } finally {
                            try { if (tagger) tagger.dispose() } catch (e) { }
                        }
                        updated = true
                    }
                    if (existing.size !== stats.size || existing.hasLyric !== hasLyricOnDisk) updated = true
                    finalQuality = existing.quality
                } else {
                    // (New file logic remains same but uses hasLyricOnDisk)
                    let interval = ''
                    let bitrate: number | undefined
                    let sampleRate: number | undefined
                    let bitDepth: number | undefined
                    let hasEmbedLyric = false
                    let metadataWritable = false
                    let metadataError: string | undefined
                    const audioContainer = detectAudioContainer(filePath)

                    try {
                        const tagger = new MusicTagger()
                        tagger.loadPath(filePath)
                        if (tagger.title && !songName) songName = tagger.title
                        if (tagger.artist && !singer) singer = tagger.artist
                        if (tagger.album && !album) album = tagger.album
                        if (hasValidEmbeddedCover(tagger.pictures)) hasCover = true

                        const dur = tagger.duration
                        interval = dur ? formatPlayTime(dur / 1000) : ''

                        bitrate = tagger.bitRate
                        sampleRate = tagger.sampleRate
                        bitDepth = tagger.bitDepth
                        finalQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)

                        // [新增] 检测是否已嵌入歌词 USLT 标签
                        const lyricsInTag = tagger.lyrics
                        hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                        metadataWritable = true

                        tagger.dispose()
                    } catch (e: any) {
                        metadataError = getMetadataUnsupportedMessage(audioContainer)
                    }
                    const hasExternalCover = !hasCover && hasCachedCover(file, normalizedUsername, stats)
                    if (hasExternalCover) hasCover = true
                    const coverType: CacheItem['coverType'] = hasCover && !hasExternalCover
                        ? 'embedded'
                        : hasExternalCover
                            ? 'cached'
                            : 'none'
                    hasCover = coverType !== 'none'

                    const item: CacheItem = {
                        id: normalizedId,
                        songmid: normalizedId,
                        name: songName || nameWithoutExt || 'Unknown',
                        singer: singer || 'Unknown',
                        album: album || '',
                        albumId: '',
                        img: '',
                        interval: interval,
                        source: source || 'unknown',
                        quality: finalQuality as any,
                        filename: file,
                        folder: folder as any,
                        subPath,
                        mtime: stats.mtimeMs,
                        size: stats.size,
                        lyricFilename: hasLyricOnDisk ? lrcFile : undefined,
                        ext: ext.replace('.', ''),
                        hasCover: hasCover,
                        coverType,
                        hasLyric: hasLyricOnDisk,
                        hasEmbedLyric,
                        audioContainer,
                        metadataWritable,
                        metadataError,
                        coverCheckedVersion: COVER_CHECK_VERSION,
                        coverCheckedMtime: stats.mtimeMs,
                        coverCheckedSize: stats.size,
                        bitrate: bitrate,
                        sampleRate: sampleRate,
                        bitDepth: bitDepth
                    }
                    existing = item
                }
                updated = true
            }

            const compositeKey = `${normalizedId}_${finalQuality || 'unknown'}`
            foundKeysOnDisk.add(compositeKey)

            if (oldKey && oldKey !== compositeKey) {
                index.delete(oldKey)
                index.set(compositeKey, existing!)
                updated = true
            } else if (!oldKey) {
                index.set(compositeKey, existing!)
            }

            // Yield control back to Node.js event loop
            await new Promise(resolve => setImmediate(resolve))
        }

        // Remove deleted files from index
        for (const key of existingKeysInIndex) {
            if (!foundKeysOnDisk.has(key)) {
                index.delete(key)
                updated = true
            }
        }

        if (updated) {
            indexManager.save(normalizedUsername, folder)
        }
    }

    const syncKey = roots.length === 1 && roots[0] === 'music'
        ? `${resolveDownloadBase()}:${normalizedUsername}:music`
        : `${currentCacheLocation}:${resolveDownloadBase()}:${normalizedUsername}:${roots.join(',')}`
    const syncState = cacheListSyncState.get(syncKey) || { lastSync: 0 }
    syncState.lastSync = Date.now()
    cacheListSyncState.set(syncKey, syncState)
}

/**
 * Get the indexed files from the configured download directory.
 */
export const getCacheList = async (username?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    // Keep downloaded-music metadata aligned with disk.
    const syncKey = `${resolveDownloadBase()}:${normalizedUsername}:music`
    const syncState = cacheListSyncState.get(syncKey) || { lastSync: 0 }
    const shouldSync = Date.now() - syncState.lastSync > CACHE_LIST_SYNC_TTL

    if (shouldSync) {
        if (!syncState.pending) {
            syncState.pending = syncCacheIndex(normalizedUsername, ['music'])
                .then(() => { syncState.lastSync = Date.now() })
                .finally(() => { syncState.pending = undefined })
            cacheListSyncState.set(syncKey, syncState)
        }
        await syncState.pending
    }

    const musicItems = indexManager.getAll(normalizedUsername, 'music')

    return musicItems.map(item => ({
        ...item,
        songInfo: {
            id: item.id,
            songmid: item.songmid || item.id,
            name: item.name,
            singer: item.singer,
            source: item.source,
            quality: item.quality,
            albumName: item.album,
            albumId: item.albumId,
            img: item.img,
            interval: item.interval,
            type: item.quality, // Compatibility
            types: {} // To be filled if needed
        },
        hasLyric: item.hasLyric || !!item.lyricFilename
    }))
}

/**
 * Batch rename existing files to the current naming pattern
 */
export const batchRenameCacheFiles = async (username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    // Download files use the independent shared downloadDir and no longer
    // participate in cache-location switching. Only the user-scoped metadata
    // cache can be moved between the data and root locations.
    const folders: Array<'cache' | 'music'> = ['cache']

    let successCount = 0
    let failCount = 0
    let skipCount = 0

    for (const folder of folders) {
        const index = indexManager.load(normalizedUsername, folder)
        const items = Array.from(index.values())
        let folderUpdated = false

        for (const item of items) {
            const songInfo = {
                id: item.id,
                songmid: item.songmid || item.id,
                name: item.name,
                singer: item.singer,
                source: item.source,
                quality: item.quality,
                albumName: item.album,
                albumId: item.albumId,
                img: item.img,
                interval: item.interval
            }

            const newBaseName = getFileName(songInfo, item.quality, folder === 'music', normalizedUsername)
            const newFilename = `${newBaseName}.${item.ext}`

            if (newFilename === item.filename) {
                skipCount++
                continue
            }

            const dir = getCacheDir(normalizedUsername, folder === 'music')
            const oldPath = path.join(dir, item.filename)
            const newPath = path.join(dir, newFilename)

            try {
                if (fs.existsSync(oldPath)) {
                    if (!fs.existsSync(newPath)) {
                        const oldStats = fs.statSync(oldPath)
                        const externalCover = readCoverCache(item.filename, normalizedUsername, oldStats)
                        fs.renameSync(oldPath, newPath)

                        if (item.lyricFilename) {
                            const oldLrcPath = path.join(dir, item.lyricFilename)
                            const newLrcFilename = `${newBaseName}.lrc`
                            const newLrcPath = path.join(dir, newLrcFilename)
                            if (fs.existsSync(oldLrcPath)) {
                                fs.renameSync(oldLrcPath, newLrcPath)
                                item.lyricFilename = newLrcFilename
                            }
                        }

                        item.filename = newFilename
                        if (externalCover) {
                            writeCoverCache(newFilename, normalizedUsername, externalCover.data, externalCover.mime, fs.statSync(newPath))
                            item.coverType = 'cached'
                            item.hasCover = true
                        }
                        successCount++
                        folderUpdated = true
                    } else {
                        failCount++
                    }
                } else {
                    failCount++
                }
            } catch (e) {
                console.error(`[FileCache] Failed to rename ${item.filename} in ${folder}:`, e)
                failCount++
            }
        }

        if (folderUpdated) {
            indexManager.save(normalizedUsername, folder)
        }
    }

    return { success: true, successCount, failCount, skipCount }
}

/**
 * Batch update ID3 metadata (title, artist, album, cover) from index to physical files
 */
export const batchUpdateMetadata = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    let successCount = 0
    let failCount = 0

    const allItems = indexManager.getAll(normalizedUsername, 'music')

    for (const filename of filenames) {
        const item = allItems.find(i => i.filename === filename)
        if (!item) {
            failCount++
            continue
        }

        const dir = getCacheDir(normalizedUsername, item.folder === 'music')
        const filePath = path.join(dir, item.filename)

        if (!fs.existsSync(filePath)) {
            failCount++
            continue
        }

        try {
            let imageBuffer: Buffer | undefined
            let imageMime = 'image/jpeg'
            const imageUrl = item.img
            if (imageUrl && imageUrl.startsWith('http') && !isPlaceholderCoverUrl(imageUrl)) {
                const chunks: Buffer[] = []
                const p = imageUrl.startsWith('https') ? https : http
                imageBuffer = await new Promise<Buffer>((resolveI, rejectI) => {
                    const req = p.get(imageUrl, ires => {
                        if ((ires.statusCode || 500) >= 400) {
                            ires.resume()
                            rejectI(new Error(`Cover status: ${ires.statusCode}`))
                            return
                        }
                        imageMime = String(ires.headers['content-type'] || 'image/jpeg').split(';')[0]
                        ires.on('data', c => chunks.push(c))
                        ires.on('end', () => resolveI(Buffer.concat(chunks)))
                        ires.on('error', rejectI)
                    })
                    req.on('error', rejectI)
                    setTimeout(() => { req.destroy(); rejectI(new Error('Timeout')) }, 8000)
                }).catch(() => undefined)
            }

            let tagger: any
            let taggerError: any
            try {
                tagger = new MusicTagger()
                tagger.loadPath(filePath)
                tagger.title = item.name || 'Unknown'
                tagger.artist = item.singer || 'Unknown'
                if (item.album) tagger.album = item.album
                if (imageBuffer && imageBuffer.length > 0) {
                    tagger.pictures = [new MetaPicture(imageMime, new Uint8Array(imageBuffer), 'Cover')]
                }
                tagger.save()
            } catch (e) {
                taggerError = e
            } finally {
                try { if (tagger) tagger.dispose() } catch (e) { }
            }

            const stats = fs.statSync(filePath)
            const hasEmbeddedCover = readEmbeddedCoverState(filePath)
            let hasCover = hasEmbeddedCover || hasCachedCover(item.filename, normalizedUsername, stats)
            if (!hasCover && imageBuffer?.length) {
                hasCover = writeCoverCache(item.filename, normalizedUsername, imageBuffer, imageMime, stats)
                if (taggerError) {
                    console.warn(`[FileCache] Audio tags are unavailable for ${filename}; using external cover cache`)
                }
            }
            if (taggerError && !hasCover) throw taggerError
            item.hasCover = hasCover
            item.coverType = hasEmbeddedCover ? 'embedded' : hasCover ? 'cached' : hasUsableRemoteCover(item.img) ? 'remote' : 'none'
            item.metadataWritable = !taggerError
            item.audioContainer = detectAudioContainer(filePath)
            item.metadataError = taggerError ? getMetadataUnsupportedMessage(item.audioContainer) : undefined
            item.coverCheckedVersion = COVER_CHECK_VERSION
            item.coverCheckedMtime = stats.mtimeMs
            item.coverCheckedSize = stats.size
            item.mtime = stats.mtimeMs
            item.size = stats.size

            indexManager.update(normalizedUsername, item, item.folder as 'cache' | 'music')
            successCount++
        } catch (e) {
            console.error(`[FileCache] Failed to update metadata for ${filename}:`, e)
            failCount++
        }
    }

    return { successCount, failCount }
}

const downloadCoverImage = async (imageUrl: string, redirects = 0): Promise<{ data: Buffer; mime: string } | null> => {
    if (!hasUsableRemoteCover(imageUrl) || redirects > 3) return null
    return await new Promise((resolve) => {
        const client = imageUrl.startsWith('https:') ? https : http
        const req = client.get(imageUrl, response => {
            const statusCode = response.statusCode || 500
            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                response.resume()
                const redirectedUrl = new URL(response.headers.location, imageUrl).toString()
                void downloadCoverImage(redirectedUrl, redirects + 1).then(resolve)
                return
            }
            if (statusCode >= 400) {
                response.resume()
                resolve(null)
                return
            }
            const chunks: Buffer[] = []
            let received = 0
            response.on('data', chunk => {
                const buffer = Buffer.from(chunk)
                received += buffer.length
                if (received <= 20 * 1024 * 1024) chunks.push(buffer)
            })
            response.on('end', () => {
                if (received > 20 * 1024 * 1024) {
                    resolve(null)
                    return
                }
                const data = Buffer.concat(chunks)
                const mime = detectImageMime(data)
                resolve(mime ? { data, mime } : null)
            })
            response.on('error', () => resolve(null))
        })
        req.on('error', () => resolve(null))
        req.setTimeout(10000, () => {
            req.destroy()
            resolve(null)
        })
    })
}

const setIndexCoverState = (filename: string, username: string, coverType: CacheItem['coverType'], stats?: Stats, location?: string) => {
    for (const folder of ['music'] as const) {
        const item = indexManager.getAll(username, folder, location).find(candidate => candidate.filename === filename)
        if (!item) continue
        item.coverType = coverType
        item.hasCover = coverType !== 'none'
        item.coverCheckedVersion = COVER_CHECK_VERSION
        if (stats) {
            item.coverCheckedMtime = stats.mtimeMs
            item.coverCheckedSize = stats.size
        }
        indexManager.save(username, folder, location)
        return item
    }
    return null
}

/**
 * Get cover image for a cached file
 */
export const getCacheCover = async (filename: string, username?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    const locations = [
        currentCacheLocation,
        currentCacheLocation === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA
    ]
    const roots: Array<'cache' | 'music'> = ['music']

    for (const loc of locations) {
        for (const folder of roots) {
            const dir = getCacheDir(normalizedUsername, folder === 'music', loc)
            const filePath = resolveCacheRelativePath(dir, filename) // [Fix] Allow subfolders safely

            if (filePath && fs.existsSync(filePath)) {
                let stats: Stats | undefined
                try {
                    stats = fs.statSync(filePath)
                    const cachedCover = readCoverCache(filename, normalizedUsername, stats)
                    if (cachedCover) {
                        setIndexCoverState(filename, normalizedUsername, 'cached', stats, loc)
                        return cachedCover
                    }
                } catch (e) {
                    console.error(`[Cache] Error reading cover cache for: ${filename}`, e)
                }

                let tagger: any
                try {
                    tagger = new MusicTagger()
                    tagger.loadPath(filePath)
                    const pics = tagger.pictures
                    const pic = Array.isArray(pics) ? pics.find(hasValidPictureData) : null
                    if (pic) {
                        const mime = pic.mimeType || 'image/jpeg'
                        const data = Buffer.from(pic.data)
                        writeCoverCache(filename, normalizedUsername, data, mime, stats)
                        setIndexCoverState(filename, normalizedUsername, 'embedded', stats, loc)
                        return { data, mime: detectImageMime(data) || mime }
                    }
                } catch (e) {
                    // console.error(`[Cache] Error reading tags for cover: ${filename}`, e)
                } finally {
                    try { if (tagger) tagger.dispose() } catch (e) { }
                }

                const item = indexManager.getAll(normalizedUsername, 'music', loc)
                    .find(candidate => candidate.filename === filename)
                if (item && hasUsableRemoteCover(item.img)) {
                    const remoteCover = await downloadCoverImage(item.img!)
                    if (remoteCover && writeCoverCache(filename, normalizedUsername, remoteCover.data, remoteCover.mime, stats)) {
                        setIndexCoverState(filename, normalizedUsername, 'cached', stats, loc)
                        return remoteCover
                    }
                }

                setIndexCoverState(filename, normalizedUsername, 'none', stats, loc)
            }
        }
    }
    return null
}

/**
 * Remove a specific cache file
 */
export const removeCacheFile = (filename: string, username?: string, requestedFolder?: CacheFolder): RemoveCacheFileResult => {
    if (!filename || typeof filename !== 'string') throw new Error('Invalid filename')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') throw new Error('Invalid folder')

    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const candidateFolders: CacheFolder[] = requestedFolder ? [requestedFolder] : ['music']
    const matches = candidateFolders.map(folder => {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        const filePath = resolveCacheRelativePath(dir, filename)
        return filePath && fs.existsSync(filePath) ? { folder, dir, filePath } : null
    }).filter((entry): entry is { folder: CacheFolder; dir: string; filePath: string } => entry !== null)

    // Older clients only sent a filename. Keep that format safe when the file has
    // a unique location, but never guess if cache and download both contain it.
    if (!requestedFolder && matches.length > 1) {
        throw new Error(`Ambiguous file location for ${filename}; folder is required`)
    }
    if (matches.length === 0) return { deleted: false }

    const { folder, dir, filePath } = matches[0]
    let coverCacheHash = ''
    try {
        coverCacheHash = getCoverCacheHash(filename, fs.statSync(filePath))
    } catch (e) { }

    try {
        fs.unlinkSync(filePath)
    } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e
    }
    console.log(`[FileCache] Deleted from ${folder}: ${filename}`)

    const ext = path.extname(filename)
    if (ext !== '.lrc') {
        const baseWithoutExt = filename.substring(0, filename.length - ext.length)
        const lrcPath = resolveCacheRelativePath(dir, baseWithoutExt + '.lrc')
        if (lrcPath && fs.existsSync(lrcPath)) {
            try {
                fs.unlinkSync(lrcPath)
            } catch (e: any) {
                if (e?.code !== 'ENOENT') throw e
            }
        }
    }

    const items = indexManager.getAll(normalizedUsername, folder)
    const item = items.find(i => i.filename === filename)
    if (item) indexManager.remove(normalizedUsername, item.id, folder, item.quality)

    // Cover cache is shared by filename. Preserve it while the same relative file
    // still exists in the other root so deleting cache does not affect downloads.
    const otherFolder: CacheFolder = folder === 'cache' ? 'music' : 'cache'
    const otherDir = getCacheDir(normalizedUsername, otherFolder === 'music')
    const otherPath = resolveCacheRelativePath(otherDir, filename)
    const hasCounterpart = !!otherPath && fs.existsSync(otherPath)
    if (!hasCounterpart) {
        try {
            const coverCacheDir = getCoverCacheDir(normalizedUsername)
            const hashes = [coverCacheHash, crypto.createHash('md5').update(filename).digest('hex')].filter(Boolean)
            for (const hash of hashes) {
                const binPath = path.join(coverCacheDir, `${hash}.bin`)
                const mimePath = path.join(coverCacheDir, `${hash}.mime`)
                if (fs.existsSync(binPath)) fs.unlinkSync(binPath)
                if (fs.existsSync(mimePath)) fs.unlinkSync(mimePath)
            }
        } catch (e) { }
    }

    return { deleted: true, folder }
}

export const setCacheLocation = (location: string) => {
    currentCacheLocation = CACHE_ROOTS.ROOT
    if (location && location !== CACHE_ROOTS.ROOT) {
        console.log(`[FileCache] Ignored legacy cache location "${location}"; using project cache/`)
    } else {
        console.log('[FileCache] Base cache location set to project cache/')
    }
}

export const getCacheLocation = () => currentCacheLocation

export const checkCache = (songInfo: any, username?: string, isLyricCheck: boolean = false) => {
    try {
        const id = normalizeSongId(songInfo)
        const quality = songInfo.quality || 'unknown'
        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

        // 1. Search by exact ID and Quality (Primary Check)
        // exactQuality=true 时：精确匹配，不允许 fallback 到不同音质
        const useExact = !!songInfo.exactQuality
        const folderTypes: Array<'cache' | 'music'> = ['music']
        for (const folder of folderTypes) {
            const cached = indexManager.get(normalizedUsername, id, folder, quality, useExact)
            if (cached) {
                // 二次校验：exactQuality 模式下确保音质匹配
                if (useExact && quality && cached.quality !== quality) continue
                const dir = getCacheDir(normalizedUsername, folder === 'music')
                const fileName = isLyricCheck ? cached.lyricFilename : cached.filename
                if (!fileName) continue
                const filePath = path.join(dir, fileName)
                if (fs.existsSync(filePath)) {
                    return {
                        exists: true,
                        path: filePath,
                        filename: fileName,
                        foundIn: normalizedUsername,
                        quality: cached.quality,
                        folder: folder,
                        url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(fileName)}?folder=${folder}`
                    }
                } else {
                    // Stale index entry, cleanup
                    if (!isLyricCheck) indexManager.remove(normalizedUsername, id, folder, cached.quality)
                }
            }
        }

        // 2. Search for Naming Collisions (Same Name + Singer + Quality, but different ID)
        const allItems = indexManager.getAll(normalizedUsername, 'music')

        const collision = allItems.find(item =>
            item.id !== id && // 排除当前正在查询的 ID 本身
            item.name.toLowerCase() === String(songInfo.name || '').toLowerCase() &&
            item.singer.toLowerCase() === String(songInfo.singer || '').toLowerCase() &&
            item.quality === quality &&
            (!isLyricCheck || item.hasLyric)
        )

        if (collision) {
            return {
                exists: true,
                isCollision: true,
                collisionSource: collision.source,
                collisionSongmid: collision.songmid,
                filename: isLyricCheck ? collision.lyricFilename : collision.filename,
                quality: collision.quality,
                foundIn: normalizedUsername,
                folder: collision.folder
            }
        }

        // 3. Fallback for non-exact (only if requested)
        if (!songInfo.exactQuality && !isLyricCheck) {
            const folderTypes: Array<'cache' | 'music'> = ['music']
            for (const folder of folderTypes) {
                const cachedAny = indexManager.get(normalizedUsername, id, folder)
                if (cachedAny) {
                    const dir = getCacheDir(normalizedUsername, folder === 'music')
                    const fileName = cachedAny.filename
                    const filePath = path.join(dir, fileName)
                    if (fs.existsSync(filePath)) {
                        return {
                            exists: true,
                            path: filePath,
                            filename: fileName,
                            foundIn: normalizedUsername,
                            quality: cachedAny.quality,
                            folder: folder,
                            url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(fileName)}?folder=${folder}`
                        }
                    }
                }
            }
        }

    } catch (e) {
        console.error('[FileCache] checkCache error:', e)
    }

    return { exists: false }
}

const normalizeSongIdentityText = (value: unknown) => String(value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[、，,;；]/g, ',')
    .replace(/\s+/g, ' ')

/**
 * 判断下载目录中是否已经存在这首歌的任意一版。
 *
 * 订阅和服务端队列使用这个检查，而普通下载仍使用 checkCache 的
 * 音质/来源语义。这样可以兼容旧文件缺少平台 ID、被索引为 unknown
 * 的情况，同时保证订阅更新不会再产生第二份同名歌曲。
 */
export const isSongCached = (songInfo: any, username?: string) => {
    try {
        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const id = normalizeSongId(songInfo)
        const name = normalizeSongIdentityText(songInfo?.name || songInfo?.meta?.songName)
        const singer = normalizeSongIdentityText(songInfo?.singer || songInfo?.meta?.singerName)
        if (!id && (!name || !singer)) return false

        const dir = getCacheDir(normalizedUsername, true)
        return indexManager.getAll(normalizedUsername, 'music').some(item => {
            if (item.downloadComplete === false) return false
            const itemPath = item.filename ? path.join(dir, item.filename) : ''
            if (!itemPath || !fs.existsSync(itemPath)) return false

            const sameId = !!id && normalizeSongId(item) === id
            const sameMetadata = !!name && !!singer &&
                normalizeSongIdentityText(item.name) === name &&
                normalizeSongIdentityText(item.singer) === singer
            return sameId || sameMetadata
        })
    } catch (err) {
        console.warn('[FileCache] Failed to check whether song is already cached:', err)
        return false
    }
}

/** Index rows can be installed before tagging finishes. Only expose completed audio to playlists. */
export const getReadyDownloadedSongs = () => indexManager.getAll('shared', 'music').filter(item => {
    if (item.downloadComplete === false) return false
    const progress = cacheProgress.get(normalizeSongId(item) + '_' + item.quality)
    return !progress || ['finished', 'exists'].includes(progress.status)
})

export const checkLyricCache = (songInfo: any, username?: string) => {
    const id = normalizeSongId(songInfo)
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    // Check index first
    const folderTypes: Array<'cache' | 'music'> = ['music']
    for (const folder of folderTypes) {
        const cached = indexManager.get(normalizedUsername, id, folder, songInfo.quality)
        if (cached && cached.hasLyric && cached.lyricFilename) {
            const dir = getCacheDir(normalizedUsername, folder === 'music')
            const lrcPath = path.join(dir, cached.lyricFilename)
            if (fs.existsSync(lrcPath)) {
                return {
                    exists: true,
                    path: lrcPath,
                    content: parseLyrics(readLyricFile(lrcPath)),
                    filename: cached.lyricFilename
                }
            }
        }
    }

    // [Fix] Index-based name+singer fallback for the simple naming pattern
    // When the lrc filename does not contain a song ID, match by name + singer from the index
    if (songInfo.name && songInfo.singer) {
        const targetName = String(songInfo.name).toLowerCase()
        const targetSinger = String(songInfo.singer).toLowerCase()
        for (const folder of folderTypes) {
            const allItems = indexManager.getAll(normalizedUsername, folder)
            const matched = allItems.find(item =>
                item.hasLyric &&
                item.lyricFilename &&
                item.name.toLowerCase() === targetName &&
                item.singer.toLowerCase() === targetSinger
            )
            if (matched && matched.lyricFilename) {
                const dir = getCacheDir(normalizedUsername, folder === 'music')
                const lrcPath = path.join(dir, matched.lyricFilename)
                if (fs.existsSync(lrcPath)) {
                    return {
                        exists: true,
                        path: lrcPath,
                        content: parseLyrics(readLyricFile(lrcPath)),
                        filename: matched.lyricFilename
                    }
                }
            }
        }
    }

    // Physical scan fallback (for standard naming pattern: Name_-_Singer_-_Source_-_ID_-_Quality)
    const roots = ['music']
    const basePaths = roots.map(folder => getCacheDir(normalizedUsername, folder === 'music'))

    // [Fix] Recursively search for lyrics if not in index
    const getAllLrcFiles = (dirPath: string, acc: string[] = []) => {
        if (!fs.existsSync(dirPath)) return acc
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name)
            if (entry.isDirectory()) {
                getAllLrcFiles(fullPath, acc)
            } else if (entry.name.endsWith('.lrc')) {
                acc.push(fullPath)
            }
        }
        return acc
    }

    const cleanId = (sid: string) => String(sid || '').replace(/^(tx|mg|wy|kg|kw|bd|mg)_/, '')
    const targetCleanId = cleanId(id)

    for (const dirPath of basePaths) {
        const lrcFiles = getAllLrcFiles(dirPath)
        for (const filePath of lrcFiles) {
            const file = path.basename(filePath)
            const fileNameWithoutExt = file.substring(0, file.lastIndexOf('.'))
            const segments = fileNameWithoutExt.split('_-_')
            if (segments.length >= 2) {
                const fileId = segments[segments.length - 2]
                const fileCleanId = cleanId(fileId)
                if (fileId === id || fileCleanId === id || fileId === targetCleanId || fileCleanId === targetCleanId) {
                    return {
                        exists: true,
                        path: filePath,
                        content: parseLyrics(readLyricFile(filePath)),
                        filename: path.relative(dirPath, filePath).replace(/\\/g, '/')
                    }
                }
            }
        }
    }

    return { exists: false }
}

// Legacy function name kept for API compatibility. This writes the optional
// sidecar .lrc download artifact; it is not a playback lyric cache.
export const saveLyricCache = (songInfo: any, lyricsObj: any, username?: string, isOnlyDownload?: boolean, options: LyricOptions = {}) => {
    try {
        let baseName: string
        let quality = songInfo.quality || 'unknown'
        let dir: string

        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const id = normalizeSongId(songInfo)
        const preferredFolders: Array<'cache' | 'music'> = isOnlyDownload ? ['music'] : ['cache', 'music']
        let audioResult: any = { exists: false }
        for (const folder of preferredFolders) {
            const cached = indexManager.get(normalizedUsername, id, folder, songInfo.quality, false)
            if (!cached?.filename) continue
            const root = getCacheDir(normalizedUsername, folder === 'music')
            const filePath = path.join(root, cached.filename)
            if (fs.existsSync(filePath)) {
                audioResult = {
                    exists: true,
                    path: filePath,
                    quality: cached.quality,
                    folder,
                    filename: cached.filename
                }
                break
            }
        }

        if (audioResult.exists && audioResult.path) {
            // If audio exists, save lyric in the same folder
            dir = path.dirname(audioResult.path)
            quality = audioResult.quality || quality
            baseName = path.basename(audioResult.path, path.extname(audioResult.path))
        } else {
            // Audio not found, fallback to target dir
            dir = ensureDir(username, isOnlyDownload)
            if (songInfo.quality) {
                baseName = getFileName(songInfo, songInfo.quality, isOnlyDownload, username)
            } else {
                baseName = getFileName(songInfo, 'unknown', isOnlyDownload, username)
            }
        }

        const lyricFile = baseName + '.lrc'
        const finalPath = path.join(dir, lyricFile)

        const formattedLrc = buildLyrics(
            lyricsObj,
            options.downloadLyricLx !== false,
            options.downloadLyricTranslation === true,
            options.downloadLyricRoma === true,
        )
        if (!formattedLrc) {
            console.log(`[FileCache] Empty lyrics for ${baseName}, skip saving.`)
            return false
        }

        // 与参考项目的 utf8 + BOM 默认格式保持一致；读取端会剥离 BOM。
        const outputLrc = formattedLrc.charCodeAt(0) === 0xFEFF ? formattedLrc : `\uFEFF${formattedLrc}`
        const encoding = options.downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8'
        fs.writeFileSync(finalPath, iconv.encode(outputLrc, encoding))
        console.log(`[Lyric] Lyric file saved to: ${finalPath}`)

        // Update index — use normalizeSongId to ensure the ID has source prefix, matching index keys
        const foldersToUpdate: Array<'cache' | 'music'> = isOnlyDownload ? ['music'] : ['cache', 'music']
        for (const folder of foldersToUpdate) {
            const existing = indexManager.get(normalizedUsername, id, folder, quality)
            if (existing) {
                const root = getCacheDir(normalizedUsername, folder === 'music')
                existing.lyricFilename = path.relative(root, finalPath).replace(/\\/g, '/')
                existing.hasLyric = true
                indexManager.save(normalizedUsername, folder)
                break
            }
        }
        if (!isOnlyDownload) void checkAndCleanupCache(username)
        return true
    } catch (err: any) {
        console.error(`[FileCache] Lyric cache save failed: ${err.message}`)
        return false
    }
}

const ensureCachedLyrics = async (
    songInfo: any,
    quality: string | undefined,
    username: string | undefined,
    isOnlyDownload: boolean | undefined,
    audioPath: string,
    folder: 'cache' | 'music',
    shouldCacheLyric: boolean,
    shouldEmbedLyric: boolean,
    options: LyricOptions = {},
) => {
    // lx-music-desktop 的 saveMeta 会跳过 APE 元数据写入，但仍可单独保存歌词文件。
    if (path.extname(audioPath).toLowerCase() === '.ape') shouldEmbedLyric = false
    if ((!shouldCacheLyric && !shouldEmbedLyric) || !fs.existsSync(audioPath)) return

    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const id = normalizeSongId(songInfo)
    const resolvedQuality = quality || 'unknown'
    const relativeAudioPath = path.relative(getCacheDir(normalizedUsername, folder === 'music'), audioPath).replace(/\\/g, '/')
    const item = indexManager.get(normalizedUsername, id, folder, resolvedQuality, true)
        || indexManager.getAll(normalizedUsername, folder).find(candidate => candidate.filename === relativeAudioPath)
    const lyricPath = audioPath.substring(0, audioPath.length - path.extname(audioPath).length) + '.lrc'
    let hasCachedLyric = fs.existsSync(lyricPath)
    let hasEmbedLyric = item?.hasEmbedLyric === true
    let embeddedLyricText = ''
    let metadataWritable = item?.metadataWritable !== false
    let metadataError = item?.metadataError
    let embedLyricError = item?.embedLyricError
    const audioContainer = item?.audioContainer || detectAudioContainer(audioPath)

    // metadataWritable 可能是旧索引中遗留的 false（例如封面写入失败时被一并标记），
    // 不能据此跳过歌词标签探测。歌词标签写入应当独立重试，最终结果再回写索引。
    if (shouldEmbedLyric && !hasEmbedLyric) {
        let tagger: any
        try {
            tagger = new MusicTagger()
            tagger.loadPath(audioPath)
            const lyricsInTag = tagger.lyrics || ''
            embeddedLyricText = lyricsInTag.trim()
            hasEmbedLyric = embeddedLyricText.length > 10
            metadataWritable = true
            metadataError = undefined
        } catch (e: any) {
            metadataWritable = false
            metadataError = getMetadataUnsupportedMessage(audioContainer)
            embedLyricError = metadataError
        } finally {
            try { if (tagger) tagger.dispose() } catch (e) { }
        }
    }

    const embedRequirementHandled = !shouldEmbedLyric || hasEmbedLyric || !metadataWritable
    if ((!shouldCacheLyric || hasCachedLyric) && embedRequirementHandled) {
        if (item && (item.hasLyric !== hasCachedLyric || item.hasEmbedLyric !== hasEmbedLyric || item.metadataWritable !== metadataWritable || item.embedLyricError !== embedLyricError)) {
            item.hasLyric = hasCachedLyric
            item.lyricFilename = hasCachedLyric
                ? path.relative(getCacheDir(normalizedUsername, folder === 'music'), lyricPath).replace(/\\/g, '/')
                : undefined
            item.hasEmbedLyric = hasEmbedLyric
            item.audioContainer = audioContainer
            item.metadataWritable = metadataWritable
            item.metadataError = metadataError
            item.embedLyricError = embedLyricError
            indexManager.save(normalizedUsername, folder)
        }
        return
    }

    try {
        // 已有外置歌词时直接复用，避免网络歌词接口的短暂失败导致无法内嵌。
        let lyricData: any = null
        if (hasCachedLyric) {
            try {
                const localLyric = readLyricFile(lyricPath)
                if (localLyric.trim()) lyricData = parseLyrics(localLyric)
            } catch (err: any) {
                console.warn(`[FileCache] Failed to read local lyric ${path.basename(lyricPath)}: ${err?.message || err}`)
            }
        }
        // 与 LX Music 的 getCachedLyricInfo 一致：目标文件旁没有歌词时，继续查找服务端已有歌词缓存。
        if (!lyricData) {
            const cachedLyric = checkLyricCache({ ...songInfo, quality: resolvedQuality }, username)
            if (cachedLyric.exists && cachedLyric.content) lyricData = cachedLyric.content
        }
        // 与 LX Music getLyricInfo 的最后一级回退一致：网络和外置缓存都不可用时读取音频内嵌歌词。
        if (!lyricData && embeddedLyricText) lyricData = parseLyrics(embeddedLyricText)
        if (!lyricData && _lyricFetcher) {
            lyricData = await _lyricFetcher(
                { ...songInfo, quality: resolvedQuality },
                normalizedUsername,
                options.allowLyricSourceFallback !== false,
            )
        }
        if (typeof lyricData === 'string') lyricData = parseLyrics(lyricData)
        if (!lyricData || !(lyricData.lyric || lyricData.lrc || lyricData.tlyric || lyricData.rlyric || lyricData.lxlyric || lyricData.klyric)) return

        if (shouldCacheLyric && !hasCachedLyric) {
            hasCachedLyric = saveLyricCache(
                { ...songInfo, quality: resolvedQuality },
                lyricData,
                username,
                isOnlyDownload,
                options,
            ) || fs.existsSync(lyricPath)
        }

        if (shouldEmbedLyric && !hasEmbedLyric && metadataWritable) {
            const lyricText = buildLyrics(
                lyricData,
                options.embedLyricLx !== false,
                options.embedLyricTranslation === true,
                options.embedLyricRoma === true,
            )
            if (!lyricText || !lyricText.trim()) return
            const embedMetadata = extractSongMetadata(songInfo)
            const embedResult = await embedLyricsIntoFile(audioPath, lyricText, {
                title: embedMetadata.name,
                artist: embedMetadata.singer,
                album: embedMetadata.album,
                APIC: embedMetadata.img,
            })
            hasEmbedLyric = embedResult.hasEmbedLyric
            metadataWritable = embedResult.metadataWritable
            metadataError = embedResult.metadataWritable ? undefined : embedResult.error
            embedLyricError = embedResult.error
            if (embedResult.success) {
                console.log(`[FileCache] USLT lyric embedded for: ${songInfo.name || songInfo.title || path.basename(audioPath)}`)
            } else {
                console.warn(`[FileCache] Lyric tag unavailable for ${path.basename(audioPath)}: ${embedResult.error}`)
            }
        }

        const finalItem = indexManager.get(normalizedUsername, id, folder, resolvedQuality, true) || item
        if (finalItem) {
            if (shouldCacheLyric && hasCachedLyric) {
                finalItem.hasLyric = true
                finalItem.lyricFilename = path.relative(getCacheDir(normalizedUsername, folder === 'music'), lyricPath).replace(/\\/g, '/')
            }
            if (shouldEmbedLyric) {
                finalItem.hasEmbedLyric = hasEmbedLyric
                finalItem.audioContainer = audioContainer
                finalItem.metadataWritable = metadataWritable
                finalItem.metadataError = metadataError
                finalItem.embedLyricError = embedLyricError
            }
            indexManager.save(normalizedUsername, folder)
        }
    } catch (err: any) {
        console.warn(`[FileCache] Failed to ensure lyrics for ${path.basename(audioPath)}: ${err?.message || err}`)
    }
}

export const downloadAndCache = async (songInfo: any, url: string, quality?: string, username?: string, signal?: AbortSignal, isOnlyDownload?: boolean, shouldCacheLyric: boolean = true, shouldEmbedLyric: boolean = true, provenance: DownloadProvenance = {}, lyricOptions: DownloadOptions = {}) => {
    if (lyricOptions.fileNamePattern) songInfo = { ...songInfo, __fileNamePattern: lyricOptions.fileNamePattern }
    const dir = ensureDir(username, isOnlyDownload)
    const baseName = getFileName(songInfo, quality, isOnlyDownload, username)
    const songKey = normalizeSongId(songInfo) + '_' + (quality || 'unknown')
    const requestedSource = provenance.requestedSource || songInfo.requestedSource || songInfo.source || 'unknown'
    const downloadSource = detectDownloadSource(url, provenance.downloadSource || songInfo.downloadSource || songInfo.source)
    const sourceName = provenance.sourceName || songInfo.sourceName

    const result = checkCache({ ...songInfo, quality, exactQuality: true }, username, false)
    if (result.exists && !result.isCollision) {
        const targetFolder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
        if (result.folder === targetFolder && result.path) {
            await ensureCachedLyrics(songInfo, quality || result.quality, username, isOnlyDownload, result.path, targetFolder, shouldCacheLyric, shouldEmbedLyric, lyricOptions)
            const readyItem = indexManager.getAll(username || 'shared', targetFolder).find(item => item.filename === result.filename)
            if (readyItem) { readyItem.downloadComplete = true; indexManager.save(username || 'shared', targetFolder) }
            console.log(`[FileCache] Song already exists in ${targetFolder}, skipping download: ${result.filename}`)
            // 通知前端轮询：目标目录文件已存在，视为立即完成
            cacheProgress.set(songKey, { progress: 100, status: 'exists' })
            setTimeout(() => cacheProgress.delete(songKey), 30000)
            return result.filename
        }

        if (isOnlyDownload && result.folder === 'cache' && result.path) {
            const requestedOrCachedQuality = quality || result.quality || 'unknown'
            const inspection = inspectAudioFile(result.path, requestedOrCachedQuality)
            const actualQuality = inspection.quality || requestedOrCachedQuality
            const sourceExt = path.extname(result.filename || result.path) || '.mp3'
            const ext = inspection.extension || sourceExt
            const finalBaseName = getFileName(songInfo, actualQuality, isOnlyDownload, username)
            const finalPath = path.join(dir, finalBaseName + ext)
            if (!fs.existsSync(finalPath)) {
                fs.copyFileSync(result.path, finalPath)
            }

            const metadata = extractSongMetadata(songInfo)
            const id = metadata.id || String(songInfo.id || songInfo.songmid)
            const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
            const cachedItem = getIndexItemByFilename(result.filename, normalizedUsername)
            const actualDownloadSource = cachedItem?.downloadSource || downloadSource
            const actualSourceName = cachedItem?.sourceName || sourceName
            const stat = fs.statSync(finalPath)
            let hasCover = false
            let hasEmbedLyric = false
            let metadataWritable = false
            const audioContainer = inspection.audioContainer
            try {
                const tagger = new MusicTagger()
                tagger.loadPath(finalPath)
                hasCover = hasValidEmbeddedCover(tagger.pictures)
                const lyricsInTag = tagger.lyrics
                hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                metadataWritable = true
                tagger.dispose()
            } catch (e) { }

            let coverType: CacheItem['coverType'] = hasCover ? 'embedded' : 'none'
            if (!hasCover) {
                const sourceCover = await getCacheCover(result.filename, normalizedUsername)
                if (sourceCover?.data?.length && writeCoverCache(path.basename(finalPath), normalizedUsername, sourceCover.data, sourceCover.mime, stat)) {
                    hasCover = true
                    coverType = 'cached'
                } else if (hasUsableRemoteCover(metadata.img)) {
                    hasCover = true
                    coverType = 'remote'
                }
            }

            let lyricFilename: string | undefined
            const sourceLyricPath = result.path.substring(0, result.path.length - sourceExt.length) + '.lrc'
            if (shouldCacheLyric && fs.existsSync(sourceLyricPath)) {
                const targetLyricPath = path.join(dir, finalBaseName + '.lrc')
                fs.copyFileSync(sourceLyricPath, targetLyricPath)
                lyricFilename = path.basename(targetLyricPath)
            }

            indexManager.update(normalizedUsername, {
                id, songmid: id, name: metadata.name, singer: metadata.singer,
                album: metadata.album, albumId: metadata.albumId, img: metadata.img,
                interval: metadata.interval, source: metadata.source, requestedSource,
                downloadSource: actualDownloadSource, sourceName: actualSourceName,
                quality: actualQuality, filename: path.basename(finalPath),
                folder: 'music', mtime: Date.now(), size: stat.size,
                lyricFilename,
                ext: ext.replace('.', ''),
                hasCover,
                coverType,
                hasLyric: !!lyricFilename,
                hasEmbedLyric,
                audioContainer,
                bitrate: inspection.bitrate,
                sampleRate: inspection.sampleRate,
                bitDepth: inspection.bitDepth,
                metadataWritable,
                metadataError: metadataWritable ? undefined : getMetadataUnsupportedMessage(audioContainer)
            }, 'music')

            await ensureCachedLyrics(songInfo, actualQuality, username, true, finalPath, 'music', shouldCacheLyric, shouldEmbedLyric, lyricOptions)

            console.log(`[FileCache] Copied cached song to music folder: ${path.basename(finalPath)}`)
            cacheProgress.set(songKey, { progress: 100, status: 'finished', total: stat.size, received: stat.size })
            setTimeout(() => cacheProgress.delete(songKey), 30000)
            return path.basename(finalPath)
        }

        console.log(`[FileCache] Song already exists in ${result.folder}, skipping download: ${result.filename}`)
        cacheProgress.set(songKey, { progress: 100, status: 'exists' })
        setTimeout(() => cacheProgress.delete(songKey), 30000)
        return result.filename
    }

    if (signal?.aborted) return
    const tempPath = allocateDownloadTempPath(dir, songKey, songInfo.__fileNamePattern || currentNamingPattern)
    console.log(`[FileCache] Starting download for: ${baseName}`)

    return new Promise<string>((resolve, reject) => {
        let req: http.ClientRequest
        let response: http.IncomingMessage | undefined
        let output: fs.WriteStream | undefined
        let settled = false
        let finalizing = false
        let redirectCount = 0
        let resumeOffset = 0
        let resumeLastChunk: Buffer | null = null
        const MAX_REDIRECTS = 10

        try {
            if (fs.existsSync(tempPath)) {
                resumeOffset = fs.statSync(tempPath).size
                if (resumeOffset >= 10) {
                    const fd = fs.openSync(tempPath, 'r')
                    resumeLastChunk = Buffer.alloc(10)
                    fs.readSync(fd, resumeLastChunk, 0, 10, resumeOffset - 10)
                    fs.closeSync(fd)
                }
            }
        } catch (e) {
            resumeOffset = 0
            resumeLastChunk = null
        }

        const fail = (err: Error) => {
            if (settled) return
            const message = err.message || 'Download failed'
            cacheProgress.set(songKey, { progress: 0, status: 'error', errorMsg: message })
            settle(() => reject(err))
        }

        const settle = (fn: () => void) => {
            if (settled) return
            settled = true
            if (signal) signal.removeEventListener('abort', abortHandler)
            // Do not release the temporary path until its write handle is closed.
            if (output && !output.closed) {
                output.once('close', fn)
                output.destroy()
            } else {
                fn()
            }
            if (response && !response.complete) response.destroy()
            if (req && !req.destroyed) req.destroy()
        }

        const abortHandler = () => {
            // Let tag/index work finish before callers clean up its storage scope.
            if (finalizing) return
            // 保留临时文件，下一次启动时通过 Range 继续下载。
            cacheProgress.delete(songKey)
            settle(() => reject(new Error('Aborted')))
        }

        if (signal) signal.addEventListener('abort', abortHandler)

        // Node's http.get does not follow redirects automatically; follow the
        // common redirect codes while keeping the same progress/cleanup flow.
        const downloadFrom = (currentUrl: string) => {
            if (signal?.aborted) {
                fail(new Error('Aborted'))
                return
            }

            const protocol = currentUrl.startsWith('https') ? https : http
            const requestStart = resumeOffset >= 10 ? resumeOffset - 10 : resumeOffset
            // Always pass an options object. Passing `undefined` as the second
            // argument to https.get(url, options, callback) can leave Node
            // waiting indefinitely instead of issuing the initial request.
            const requestOptions = resumeOffset > 0
                ? { headers: { Range: `bytes=${requestStart}-` } }
                : {}
            req = protocol.get(currentUrl, requestOptions as any, (res) => {
                response = res
                res.on('error', fail)
                res.on('aborted', () => fail(new Error('Download response aborted')))
                res.on('close', () => {
                    if (!res.complete) fail(new Error('Download response closed before completion'))
                })
                const status = res.statusCode || 0
                if ([301, 302, 303, 307, 308].includes(status)) {
                    const location = res.headers.location
                    res.resume()
                    if (!location) {
                        fail(new Error(`Status: ${status} (missing Location header)`))
                        return
                    }
                    if (redirectCount >= MAX_REDIRECTS) {
                        fail(new Error(`Too many redirects (${MAX_REDIRECTS})`))
                        return
                    }
                    redirectCount++
                    const nextUrl = new URL(location, currentUrl).toString()
                    console.log(`[FileCache] Redirect ${status} -> ${nextUrl} (${redirectCount}/${MAX_REDIRECTS})`)
                    downloadFrom(nextUrl)
                    return
                }

                if (status === 416 && resumeOffset > 0) {
                    res.resume()
                    fs.unlink(tempPath, (error) => {
                        if (settled) return
                        if (error && error.code !== 'ENOENT') { fail(error); return }
                        resumeOffset = 0
                        resumeLastChunk = null
                        downloadFrom(currentUrl)
                    })
                    return
                }

                if (status !== 200 && status !== 206) {
                    fail(new Error(`Status: ${status}`))
                    return
                }

                const isResumed = resumeOffset > 0 && status === 206
                if (!isResumed) {
                    resumeOffset = 0
                    resumeLastChunk = null
                }

            cacheProgress.set(songKey, { progress: 0, status: 'downloading', total: 0, received: 0, speed: 0, updatedAt: Date.now() })
            const remaining = parseInt(res.headers['content-length'] || '0', 10)
            const total = remaining > 0 ? (isResumed ? requestStart : 0) + remaining : 0
            let received = resumeOffset
            let lastSpeedAt = Date.now()
            let lastSpeedBytes = 0
            let currentSpeed = 0
            const contentType = res.headers['content-type'] || ''
            let headerExt = '.mp3'
            if (contentType.includes('audio/flac')) headerExt = '.flac'
            else if (contentType.includes('audio/ogg')) headerExt = '.ogg'
            else if (contentType.includes('audio/x-m4a') || contentType.includes('audio/mp4')) headerExt = '.m4a'
            else if (contentType.includes('audio/wav')) headerExt = '.wav'

            const fileStream = fs.createWriteStream(tempPath, isResumed ? { flags: 'a' } : undefined)
            output = fileStream
            let writeFinished = false
            let resumeCheck = isResumed ? resumeLastChunk : null
            let resumeFailed = false
            res.on('data', (rawChunk) => {
                if (settled) return
                let chunk = Buffer.from(rawChunk)
                if (resumeCheck) {
                    const checkLength = Math.min(resumeCheck.length, chunk.length)
                    if (!chunk.subarray(0, checkLength).equals(resumeCheck.subarray(0, checkLength))) {
                        resumeFailed = true
                        // Truncate invalid resume data only after closing its write handle.
                        settle(() => {
                            fs.unlink(tempPath, () => reject(new Error('Resume validation failed')))
                        })
                        return
                    }
                    if (chunk.length <= resumeCheck.length) {
                        resumeCheck = resumeCheck.subarray(chunk.length)
                        return
                    }
                    chunk = chunk.subarray(resumeCheck.length)
                    resumeCheck = null
                }
                if (!chunk.length) return
                if (!fileStream.write(chunk)) res.pause()
                received += chunk.length
                const now = Date.now()
                if (now - lastSpeedAt >= 1000) {
                    currentSpeed = Math.max(0, (received - lastSpeedBytes) / ((now - lastSpeedAt) / 1000))
                    lastSpeedAt = now
                    lastSpeedBytes = received
                }
                const progress = total > 0 ? Math.round((received / total) * 100) : 0
                cacheProgress.set(songKey, { progress, status: 'downloading', total, received, speed: currentSpeed, updatedAt: now })
            })

            res.on('end', () => {
                if (resumeFailed || resumeCheck?.length) {
                    fail(new Error('Incomplete resume validation data'))
                } else {
                    fileStream.end()
                }
            })
            fileStream.on('drain', () => { if (!settled) res.resume() })
            fileStream.on('finish', () => { writeFinished = true })
            fileStream.on('close', async () => {
                try {
                if (settled) return
                if (!writeFinished) {
                    fail(new Error('Download stream closed before write finished'))
                    return
                }
                if (total > 0 && received < total) {
                    fail(new Error(`Download incomplete: ${received}/${total}`))
                    return
                }
                finalizing = true
                cacheProgress.set(songKey, { progress: 100, status: 'tagging', total, received, speed: 0, updatedAt: Date.now() })

                let ext = headerExt
                if (fs.existsSync(tempPath)) {
                    try {
                        const { fileTypeFromFile } = await import('file-type')
                        const type = await fileTypeFromFile(tempPath)
                        if (type) ext = `.${type.ext}`
                    } catch (e) { }
                }

                const inspection = inspectAudioFile(tempPath, quality)
                ext = inspection.extension || ext
                const actualQuality = inspection.quality || quality || 'unknown'
                const preferredName = getFileName(songInfo, actualQuality, isOnlyDownload, username)
                installDownloadedFile(tempPath, dir, preferredName, ext).then(async ({ finalPath, finalBaseName }) => {

                    let imageBuffer: Buffer | undefined
                    let imageMime = 'image/jpeg'
                    try {
                        const imageUrl = songInfo.img || (songInfo.meta && songInfo.meta.picUrl)
                        if (lyricOptions.embedCover !== false && imageUrl && imageUrl.startsWith('http') && !isPlaceholderCoverUrl(imageUrl)) {
                            const chunks: Buffer[] = []
                            const p = imageUrl.startsWith('https') ? https : http
                            imageBuffer = await new Promise((resolveI, rejectI) => {
                                const imgReq = p.get(imageUrl, ires => {
                                    if (ires.statusCode && ires.statusCode >= 400) {
                                        ires.resume()
                                        rejectI(new Error(`Cover status: ${ires.statusCode}`))
                                        return
                                    }
                                    imageMime = String(ires.headers['content-type'] || 'image/jpeg').split(';')[0]
                                    ires.on('data', c => chunks.push(c))
                                    ires.on('end', () => resolveI(Buffer.concat(chunks)))
                                    ires.on('error', rejectI)
                                })
                                imgReq.on('error', rejectI)
                                imgReq.setTimeout(10000, () => {
                                    imgReq.destroy(new Error('Cover download timeout'))
                                })
                            })
                        }
                    } catch (e) { }

                    const metadata = extractSongMetadata(songInfo)
                    const id = metadata.id || String(songInfo.id || songInfo.songmid)
                    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
                    const folderType: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'

                    indexManager.update(normalizedUsername, {
                        downloadComplete: false,
                        id, songmid: id, name: metadata.name, singer: metadata.singer,
                        album: metadata.album, albumId: metadata.albumId, img: metadata.img,
                        interval: metadata.interval, source: metadata.source, requestedSource,
                        downloadSource, sourceName,
                        quality: actualQuality, filename: finalBaseName + ext,
                        folder: folderType, mtime: Date.now(), size: received,
                        ext: ext.replace('.', ''), hasCover: false, hasLyric: false,
                        audioContainer: inspection.audioContainer,
                        bitrate: inspection.bitrate,
                        sampleRate: inspection.sampleRate,
                        bitDepth: inspection.bitDepth,
                    }, folderType)

                    const canEmbedContainer = ext.toLowerCase() !== '.ape'
                    const embedMetadata = lyricOptions.embedMetadata !== false && canEmbedContainer
                    const embedCover = lyricOptions.embedCover !== false && canEmbedContainer
                    let metadataWritable = false
                    if (embedMetadata || embedCover) {
                        try {
                            const written = await setMeta(finalPath, {
                                title: embedMetadata ? metadata.name : '',
                                artist: embedMetadata ? metadata.singer : '',
                                album: embedMetadata ? metadata.album : '',
                                APIC: embedCover ? metadata.img : null,
                                lyrics: '',
                            }, getMetadataProxy())
                            metadataWritable = written !== false
                        } catch (e: any) {
                            console.warn(`[FileCache] Reference metadata write failed for ${path.basename(finalPath)}: ${e?.message || e}`)
                        }
                    }

                    const taggedStats = fs.statSync(finalPath)
                    let finalHasCover = readEmbeddedCoverState(finalPath)
                    if (!finalHasCover && imageBuffer?.length) {
                        finalHasCover = writeCoverCache(finalBaseName + ext, normalizedUsername, imageBuffer, imageMime, taggedStats)
                    }
                    const taggedItem = indexManager.get(normalizedUsername, id, folderType, actualQuality)
                    if (taggedItem) {
                        taggedItem.coverType = readEmbeddedCoverState(finalPath)
                            ? 'embedded'
                            : finalHasCover
                                ? 'cached'
                                : hasUsableRemoteCover(metadata.img)
                                    ? 'remote'
                                    : 'none'
                        taggedItem.hasCover = taggedItem.coverType !== 'none'
                        taggedItem.audioContainer = inspection.audioContainer
                        taggedItem.metadataWritable = metadataWritable
                        taggedItem.metadataError = metadataWritable ? undefined : getMetadataUnsupportedMessage(taggedItem.audioContainer)
                        taggedItem.coverCheckedVersion = COVER_CHECK_VERSION
                        taggedItem.coverCheckedMtime = taggedStats.mtimeMs
                        taggedItem.coverCheckedSize = taggedStats.size
                        taggedItem.mtime = taggedStats.mtimeMs
                        taggedItem.size = taggedStats.size
                        indexManager.save(normalizedUsername, folderType)
                    }

                    await ensureCachedLyrics(songInfo, actualQuality, username, isOnlyDownload, finalPath, folderType, shouldCacheLyric, shouldEmbedLyric, lyricOptions)
                    const completedItem = indexManager.getAll(normalizedUsername, folderType).find(item => item.filename === finalBaseName + ext)
                    if (completedItem) { completedItem.downloadComplete = true; indexManager.save(normalizedUsername, folderType) }

                    cacheProgress.set(songKey, { progress: 100, status: 'finished', total: total || received, received, speed: 0, updatedAt: Date.now() })
                    setTimeout(() => cacheProgress.delete(songKey), 30000)
                    settle(() => {
                        resolve(finalBaseName + ext)
                        if (!isOnlyDownload) void checkAndCleanupCache(username)
                    })
                }).catch(fail)
                } catch (error: any) {
                    fail(error)
                }
            })
            fileStream.on('error', (err) => { fail(err) })
            })
            req.on('error', (err) => { fail(err) })
            req.setTimeout(30000, () => {
                req.destroy(new Error('Download request timeout'))
            })
        }

        downloadFrom(url)
    }).finally(() => activeDownloadPaths.delete(tempPath))
}

const normalizeCacheUsername = (username?: string) => (
    username && username !== '_open' && username !== 'default' ? username : '_open'
)

const resolveMusicPath = (root: string, relativePath: string) => {
    const resolvedRoot = path.resolve(root)
    const resolvedPath = path.resolve(root, relativePath)
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
        throw new Error('Invalid music file path')
    }
    return resolvedPath
}

const getAvailableRemasterTarget = (
    root: string,
    subPath: string,
    preferredBaseName: string,
    extension: string,
    oldAudioPath: string,
    oldLyricPath: string,
    needsLyric: boolean,
) => {
    for (let index = 0; index < 10000; index++) {
        const suffix = index === 0 ? '' : ` (${index + 1})`
        const baseName = preferredBaseName.substring(0, Math.max(1, 200 - suffix.length)) + suffix
        const audioFilename = path.join(subPath, baseName + extension).replace(/\\/g, '/').replace(/^\.\//, '')
        const lyricFilename = path.join(subPath, baseName + '.lrc').replace(/\\/g, '/').replace(/^\.\//, '')
        const audioPath = resolveMusicPath(root, audioFilename)
        const lyricPath = resolveMusicPath(root, lyricFilename)
        const audioConflict = audioPath !== oldAudioPath && fs.existsSync(audioPath)
        const lyricConflict = needsLyric && lyricPath !== oldLyricPath && fs.existsSync(lyricPath)
        if (!audioConflict && !lyricConflict) {
            return { audioFilename, lyricFilename, audioPath, lyricPath }
        }
    }
    throw new Error('无法生成不冲突的目标文件名')
}

export const getDownloadedMusicItems = async (username?: string) => {
    const normalizedUsername = normalizeCacheUsername(username)
    await syncCacheIndex(normalizedUsername, ['music'])
    return indexManager.getAll(normalizedUsername, 'music').map(item => ({ ...item }))
}

export const replaceDownloadedMusicItem = async (
    username: string,
    originalItem: CacheItem,
    songInfo: any,
    url: string,
    quality: string,
    signal?: AbortSignal,
) => {
    const normalizedUsername = normalizeCacheUsername(username)
    const root = getCacheDir(normalizedUsername, true)
    const currentItem = indexManager.get(normalizedUsername, originalItem.id, 'music', originalItem.quality, true)
    if (!currentItem || currentItem.filename !== originalItem.filename) {
        throw new Error('原文件已发生变化或已不存在')
    }
    if (quality === currentItem.quality) throw new Error('实际音质与原音质相同，无需替换')

    const oldAudioPath = resolveMusicPath(root, currentItem.filename)
    if (!fs.existsSync(oldAudioPath)) throw new Error('原文件已不存在')

    const stagingBase = path.resolve(process.cwd(), 'cache', 'remaster')
    fs.mkdirSync(stagingBase, { recursive: true })
    const stageTaskRoot = fs.mkdtempSync(path.join(stagingBase, 'job-'))
    const stageUsername = `.remaster-staging/${crypto.randomBytes(12).toString('hex')}`
    remasterStorage.set(stageUsername, {
        root: stageTaskRoot,
        audio: path.join(stageTaskRoot, 'audio'),
        covers: path.join(stageTaskRoot, 'covers'),
    })
    const stageRoot = getCacheDir(stageUsername, true)
    const backupSuffix = `.remaster-${crypto.randomBytes(6).toString('hex')}.bak`
    const oldAudioBackup = oldAudioPath + backupSuffix
    let oldLyricPath = ''
    let oldLyricBackup = ''
    let targetAudioPath = ''
    let targetLyricPath = ''
    let replacementItem: CacheItem | null = null
    let backedUpOldAudio = false
    let backedUpOldLyric = false
    let installedNewAudio = false
    let installedNewLyric = false
    let updatedNewIndex = false
    let removedOldIndex = false

    try {
        await downloadAndCache(songInfo, url, quality, stageUsername, signal, true, true, true)
        if (signal?.aborted) throw new Error('Aborted')

        const stagedItems = indexManager.getAll(stageUsername, 'music')
        const targetId = normalizeSongId(songInfo)
        const downloadedItem = stagedItems.find(item => item.id === targetId)
        if (!downloadedItem) throw new Error('新音质文件未写入暂存索引')

        const sourceAudioPath = resolveMusicPath(stageRoot, downloadedItem.filename)
        const sourceStats = fs.existsSync(sourceAudioPath) ? fs.statSync(sourceAudioPath) : null
        if (!sourceStats?.isFile() || sourceStats.size <= 0) throw new Error('新音质文件无效或为空')
        const stagedHasCover = readEmbeddedCoverState(sourceAudioPath)
        const originalCover = stagedHasCover
            ? null
            : ((await getCacheCover(downloadedItem.filename, stageUsername)) || (await getCacheCover(currentItem.filename, normalizedUsername)))

        oldLyricPath = currentItem.lyricFilename ? resolveMusicPath(root, currentItem.lyricFilename) : ''
        oldLyricBackup = oldLyricPath ? oldLyricPath + backupSuffix : ''
        const sourceLyricPath = downloadedItem.lyricFilename
            ? resolveMusicPath(stageRoot, downloadedItem.lyricFilename)
            : ''
        const targetSubPath = currentItem.subPath || ''
        const downloadedExtension = path.extname(downloadedItem.filename) || `.${downloadedItem.ext || 'mp3'}`
        const preferredBaseName = getFileName(songInfo, quality, true, normalizedUsername)
        const target = getAvailableRemasterTarget(
            root,
            targetSubPath,
            preferredBaseName,
            downloadedExtension,
            oldAudioPath,
            oldLyricPath,
            !!((sourceLyricPath && fs.existsSync(sourceLyricPath)) || (oldLyricPath && fs.existsSync(oldLyricPath))),
        )
        const targetFilename = target.audioFilename
        const targetLyricFilename = target.lyricFilename
        targetAudioPath = target.audioPath
        targetLyricPath = target.lyricPath

        fs.renameSync(oldAudioPath, oldAudioBackup)
        backedUpOldAudio = true
        if (oldLyricPath && fs.existsSync(oldLyricPath)) {
            fs.renameSync(oldLyricPath, oldLyricBackup)
            backedUpOldLyric = true
        }

        fs.mkdirSync(path.dirname(targetAudioPath), { recursive: true })
        fs.copyFileSync(sourceAudioPath, targetAudioPath, fs.constants.COPYFILE_EXCL)
        installedNewAudio = true
        fs.unlinkSync(sourceAudioPath)

        let finalHasCover = readEmbeddedCoverState(targetAudioPath)
        if (!finalHasCover && originalCover?.data?.length) {
            let tagger: any
            try {
                tagger = new MusicTagger()
                tagger.loadPath(targetAudioPath)
                tagger.pictures = [
                    new MetaPicture(originalCover.mime || 'image/jpeg', new Uint8Array(originalCover.data), 'Cover'),
                ]
                tagger.save()
            } catch (e) {
                console.warn(`[FileCache] Unable to embed the original cover in ${targetFilename}; using external cover cache`)
            } finally {
                try { if (tagger) tagger.dispose() } catch (e) { }
            }
            finalHasCover = readEmbeddedCoverState(targetAudioPath)
        }

        let finalLyricFilename: string | undefined
        if (sourceLyricPath && fs.existsSync(sourceLyricPath)) {
            fs.mkdirSync(path.dirname(targetLyricPath), { recursive: true })
            if (sourceLyricPath !== targetLyricPath) {
                fs.copyFileSync(sourceLyricPath, targetLyricPath, fs.constants.COPYFILE_EXCL)
                installedNewLyric = true
                fs.unlinkSync(sourceLyricPath)
            }
            finalLyricFilename = targetLyricFilename
        } else if (backedUpOldLyric && fs.existsSync(oldLyricBackup)) {
            fs.mkdirSync(path.dirname(targetLyricPath), { recursive: true })
            fs.copyFileSync(oldLyricBackup, targetLyricPath, fs.constants.COPYFILE_EXCL)
            installedNewLyric = true
            finalLyricFilename = targetLyricFilename
        }

        const finalStats = fs.statSync(targetAudioPath)
        if (!finalHasCover && originalCover?.data?.length) {
            finalHasCover = writeCoverCache(
                targetFilename,
                normalizedUsername,
                originalCover.data,
                originalCover.mime || 'image/jpeg',
                finalStats,
            )
        }
        replacementItem = {
            ...downloadedItem,
            id: currentItem.id,
            songmid: currentItem.songmid || currentItem.id,
            source: currentItem.source,
            filename: targetFilename,
            folder: 'music',
            subPath: targetSubPath,
            lyricFilename: finalLyricFilename,
            hasLyric: !!finalLyricFilename,
            hasCover: finalHasCover,
            coverType: readEmbeddedCoverState(targetAudioPath) ? 'embedded' : finalHasCover ? 'cached' : hasUsableRemoteCover(downloadedItem.img) ? 'remote' : 'none',
            coverCheckedVersion: COVER_CHECK_VERSION,
            coverCheckedMtime: finalStats.mtimeMs,
            coverCheckedSize: finalStats.size,
            mtime: finalStats.mtimeMs,
            size: finalStats.size,
        }
        replacementItem.hasCover = replacementItem.coverType !== 'none'
        indexManager.update(normalizedUsername, replacementItem, 'music')
        updatedNewIndex = true
        indexManager.remove(normalizedUsername, currentItem.id, 'music', currentItem.quality)
        removedOldIndex = true

        try {
            if (backedUpOldAudio && fs.existsSync(oldAudioBackup)) fs.unlinkSync(oldAudioBackup)
        } catch (cleanupError) {
            console.warn('[FileCache] Failed to remove remaster audio backup:', cleanupError)
        }
        try {
            if (backedUpOldLyric && fs.existsSync(oldLyricBackup)) fs.unlinkSync(oldLyricBackup)
        } catch (cleanupError) {
            console.warn('[FileCache] Failed to remove remaster lyric backup:', cleanupError)
        }
        return { ...replacementItem }
    } catch (err) {
        try {
            if (updatedNewIndex && replacementItem) {
                indexManager.remove(normalizedUsername, replacementItem.id, 'music', replacementItem.quality)
            }
            if (installedNewLyric && targetLyricPath && fs.existsSync(targetLyricPath)) fs.unlinkSync(targetLyricPath)
            if (installedNewAudio && targetAudioPath && fs.existsSync(targetAudioPath)) fs.unlinkSync(targetAudioPath)
            if (backedUpOldAudio && fs.existsSync(oldAudioBackup) && !fs.existsSync(oldAudioPath)) {
                fs.renameSync(oldAudioBackup, oldAudioPath)
            }
            if (backedUpOldLyric && fs.existsSync(oldLyricBackup) && !fs.existsSync(oldLyricPath)) {
                fs.renameSync(oldLyricBackup, oldLyricPath)
            }
            if (removedOldIndex || updatedNewIndex) {
                indexManager.update(normalizedUsername, currentItem, 'music')
            }
        } catch (rollbackError) {
            console.error('[FileCache] Failed to roll back remaster replacement:', rollbackError)
        }
        throw err
    } finally {
        try {
            // Keep the registered scope alive until its own index is discarded.
            indexManager.discard(stageUsername, 'music')
            const realBase = fs.realpathSync(stagingBase)
            const realStage = fs.realpathSync(stageTaskRoot)
            const relative = path.relative(realBase, realStage)
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(realStage) !== realBase) {
                throw new Error('Refusing to remove a remaster directory outside its staging root')
            }
            fs.rmSync(realStage, { recursive: true, force: true })
        } catch (cleanupError) {
            console.warn('[FileCache] Failed to clean remaster staging directory:', cleanupError)
        } finally {
            remasterStorage.delete(stageUsername)
        }
    }
}

export const stopUserTasks = (username: string, songKey?: string) => {
    const tasks = activeTasks.get(username)
    if (!tasks) return
    if (songKey) {
        const idx = tasks.findIndex(t => t.songKey === songKey)
        if (idx !== -1) { tasks[idx].controller.abort(); tasks.splice(idx, 1) }
    } else {
        tasks.forEach(t => t.controller.abort())
        activeTasks.delete(username)
    }
}

// [新增] 根据文件名从索引中查找对应条目（跨 cache/music 两个目录）
export const getIndexItemByFilename = (filename: string, username: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of ['music'] as const) {
        const items = indexManager.getAll(normalizedUsername, folder)
        const found = items.find((i: any) => i.filename === filename)
        if (found) return { ...found, folder }
    }
    return null
}

// [新增] 暴露 lyricFetcher 引用，供外部接口（如 embedLyric）使用
export const getLyricFetcher = () => _lyricFetcher

// [新增] 更新索引中指定文件的 hasEmbedLyric 状态（由 embedLyric 接口成功写入后调用）
export const setIndexEmbedLyric = (
    filename: string,
    username: string,
    value: boolean,
    metadata?: Pick<CacheItem, 'audioContainer' | 'metadataWritable' | 'metadataError' | 'embedLyricError'>,
) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of ['music'] as const) {
        const items = indexManager.getAll(normalizedUsername, folder)
        const found = items.find((i: any) => i.filename === filename)
        if (found) {
            (found as any).hasEmbedLyric = value
            if (metadata) Object.assign(found, metadata)
            indexManager.save(normalizedUsername, folder)
            return true
        }
    }
    return false
}

const getCachedAudioTarget = (songInfo: any, username?: string, quality?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const id = normalizeSongId(songInfo)
    const folders: Array<'music' | 'cache'> = ['music']

    for (const folder of folders) {
        const item = indexManager.get(normalizedUsername, id, folder, quality, true)
            || indexManager.getAll(normalizedUsername, folder).find(candidate => (
                candidate.id === id && (!quality || candidate.quality === quality)
            ))
        if (!item?.filename) continue

        const root = getCacheDir(normalizedUsername, folder === 'music')
        const audioPath = resolveCacheRelativePath(root, item.filename)
        if (!audioPath || !fs.existsSync(audioPath)) continue
        return { item, normalizedUsername, audioPath }
    }
    return null
}

export const embedLyricTextForSong = async (songInfo: any, lyricText: string, username?: string, quality?: string) => {
    const target = getCachedAudioTarget(songInfo, username, quality)
    if (!target) return { success: false, embedded: false, error: '找不到对应的音频文件' }
    if (!lyricText.trim()) return { success: false, embedded: false, error: '歌词内容为空' }

    const embedMetadata = extractSongMetadata(songInfo)
    const result = await embedLyricsIntoFile(target.audioPath, lyricText, {
        title: embedMetadata.name,
        artist: embedMetadata.singer,
        album: embedMetadata.album,
        APIC: embedMetadata.img,
    })
    setIndexEmbedLyric(target.item.filename, target.normalizedUsername, result.hasEmbedLyric, {
        audioContainer: result.audioContainer,
        metadataWritable: result.metadataWritable,
        metadataError: result.metadataWritable ? undefined : result.error,
        embedLyricError: result.error,
    })
    return { success: result.success, embedded: result.hasEmbedLyric, error: result.error }
}

// 根据歌曲索引和已缓存的 .lrc 自动将歌词写入音频标签。
// 下载完成后的补偿流程与本地歌曲页面的手动嵌入共用同一套写入/校验逻辑。
export const embedCachedLyric = async (songInfo: any, username?: string, quality?: string) => {
    const target = getCachedAudioTarget(songInfo, username, quality)
    if (!target) return { success: false, embedded: false, error: '找不到对应的音频文件' }

    const lyricFilename = target.item.lyricFilename || `${target.item.filename.substring(0, target.item.filename.lastIndexOf('.'))}.lrc`
    const root = getCacheDir(target.normalizedUsername, target.item.folder === 'music')
    const lyricPath = resolveCacheRelativePath(root, lyricFilename)
    if (!lyricPath || !fs.existsSync(lyricPath)) return { success: false, embedded: false, error: '找不到对应的歌词文件' }

    return embedLyricTextForSong(songInfo, readLyricFile(lyricPath), username, quality)
}

export const serveCacheFile = (req: http.IncomingMessage, res: http.ServerResponse, filename: string, username?: string) => {
    const locations = [
        currentCacheLocation,
        currentCacheLocation === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA
    ]
    const roots = ['music']
    let filePath = ''
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const loc of locations) {
        for (const folder of roots) {
            const dir = getCacheDir(normalizedUsername, folder === 'music', loc)
            const checkPath = resolveCacheRelativePath(dir, filename)
            if (checkPath && fs.existsSync(checkPath)) { filePath = checkPath; break }
        }
        if (filePath) break
    }
    if (!filePath) { res.writeHead(404); res.end('Not Found'); return }
    const stat = fs.statSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
        '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
    }
    const contentType = mimeTypes[ext] || 'application/octet-stream'
    const range = req.headers.range
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-")
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
        const chunksize = (end - start) + 1
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': contentType,
        })
        fs.createReadStream(filePath, { start, end }).pipe(res)
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
        fs.createReadStream(filePath).pipe(res)
    }
}

export const getCacheStats = (username?: string) => {
    const roots = ['cache', 'music']
    const result: any = { cache: { totalSize: 0, fileCount: 0 }, music: { totalSize: 0, fileCount: 0 }, totalSize: 0, fileCount: 0 }
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.lrc']
        walkCacheFiles(dir, (_filePath, relativePath, stats) => {
            const ext = path.extname(relativePath).toLowerCase()
            if (extensions.includes(ext)) {
                result[folder].totalSize += stats.size
                result.totalSize += stats.size
                if (ext !== '.lrc') { result[folder].fileCount++; result.fileCount++ }
            }
        })
    }
    return result
}

export const clearAllCache = (username?: string) => {
    validateDownloadDir(currentDownloadDir)
    const roots: Array<'cache'> = ['cache']
    let deletedCount = 0
    let freedSize = 0
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, false)
        if (!fs.existsSync(dir)) continue
        walkCacheFiles(dir, (filePath, relativePath, stats) => {
            if (path.basename(relativePath) === 'cache_index.json') return
            try { fs.unlinkSync(filePath); deletedCount++; freedSize += stats.size } catch (e) { }
        })
        removeEmptyCacheDirectories(dir)
        indexManager.load(normalizedUsername, folder).clear()
        indexManager.save(normalizedUsername, folder)
    }
    return { deletedCount, freedSize }
}

export const clearLyricCache = (username?: string) => {
    const roots: Array<'cache' | 'music'> = ['music']
    let deletedCount = 0
    let freedSize = 0
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        walkCacheFiles(dir, (filePath, relativePath, stats) => {
            if (!relativePath.toLowerCase().endsWith('.lrc')) return
            try { fs.unlinkSync(filePath); deletedCount++; freedSize += stats.size } catch (e) { }
        })
        removeEmptyCacheDirectories(dir)
        const items = indexManager.getAll(normalizedUsername, folder)
        items.forEach(item => { if (item.hasLyric) { item.hasLyric = false; item.lyricFilename = undefined } })
        indexManager.save(normalizedUsername, folder)
    }
    return { deletedCount, freedSize }
}

export const checkAndCleanupCache = async (username?: string) => {
    validateDownloadDir(currentDownloadDir)
    const config = (global as any).lx.config
    if (!config || !config['user.enableCacheSizeLimit']) return
    // Capacity limiting applies only to the reusable server cache. The
    // download directory contains user-owned music and must never be evicted.
    const { cache } = getCacheStats(username)
    const totalSize = cache.totalSize
    const limitBytes = (config['user.cacheSizeLimit'] || 2000) * 1024 * 1024
    if (totalSize <= limitBytes) return
    const allFiles: Array<{ path: string, size: number, mtime: number }> = []
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const cacheDir = getCacheDir(normalizedUsername, false)
    if (fs.existsSync(cacheDir)) {
        walkCacheFiles(cacheDir, (filePath, relativePath, stats) => {
            if (path.basename(relativePath) === 'cache_index.json') return
            allFiles.push({ path: filePath, size: stats.size, mtime: stats.mtime.getTime() })
        })
    }
    allFiles.sort((a, b) => a.mtime - b.mtime)
    let currentSize = totalSize
    const targetSize = limitBytes * 0.95
    let deletedCount = 0
    for (const file of allFiles) {
        if (currentSize <= targetSize) break
        try { fs.unlinkSync(file.path); currentSize -= file.size; deletedCount++ } catch (e) { }
    }
    removeEmptyCacheDirectories(cacheDir)
    void syncCacheIndex(normalizedUsername, ['cache'])
    console.log(`[FileCache] Cleaned up ${deletedCount} files for ${normalizedUsername}`)
}
