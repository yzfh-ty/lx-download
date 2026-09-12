import http, { type IncomingMessage } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { getIP } from '@/utils/tools'
import { accessLog, startupLog, loginLog } from '@/utils/log4js'
import formidable from 'formidable'
// @ts-ignore
import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
const musicSdk = musicSdkRaw as any
import { initUserApis, callUserApiGetMusicUrl, isSourceSupported, getLoadedApis } from './userApi'
import * as customSourceHandlers from './customSourceHandlers'
import * as fileCache from './fileCache'
import * as serverDownloadQueue from './serverDownloadQueue'
import * as playlistSubscription from './playlistSubscription'
import * as remasterQueue from './remasterQueue'
import { getDownloadQualityCandidates } from './downloadQuality'
import crypto from 'node:crypto'
import needle from 'needle'
import { buildLyrics, parseLyrics } from '@/utils/lrcTool'
import { getJson, setJson } from '@/storage/database'
import { isPathWithin } from '@/utils/pathSafety'
import { formatConfigLogValue } from '@/utils/configLog'

// ===== Single Web Token Authentication =====
const AUTH_COOKIE_NAME = 'lx_auth_token'
const AUTH_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60
const SHARED_SPACE = 'shared'
const authSessions = new Map<string, number>()
let sessionAccessToken: string | undefined
const refreshAuthSessions = () => {
  const token = getConfiguredAccessToken()
  if (sessionAccessToken !== token) {
    authSessions.clear()
    sessionAccessToken = token
  }
}

/** 解析 Cookie 字符串 */
const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) return {}
  return Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...v] = c.trim().split('=')
      try { return [k.trim(), decodeURIComponent(v.join('='))] } catch { return [k.trim(), ''] }
    })
  )
}

const getConfiguredAccessToken = () => String(
  global.lx.config['player.token'] || '',
)

const getRequestAccessToken = (req: IncomingMessage) => {
  const cookieToken = parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME]
  return cookieToken || ''
}

const createAuthSession = () => {
  refreshAuthSessions()
  const sessionToken = crypto.randomBytes(32).toString('hex')
  authSessions.set(sessionToken, Date.now() + AUTH_COOKIE_MAX_AGE_SECONDS * 1000)
  return sessionToken
}

const tokenEquals = (provided: string, expected: string) => {
  if (!provided || !expected) return false
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer)
}

const checkPlayerAuth = (req: IncomingMessage): boolean => {
  refreshAuthSessions()
  const sessionToken = getRequestAccessToken(req)
  const expiresAt = authSessions.get(sessionToken)
  if (!expiresAt) return false
  if (expiresAt <= Date.now()) {
    authSessions.delete(sessionToken)
    return false
  }
  return true
}

/** 业务 API 只接受当前 Web 页面发起的同源请求。 */
const isSameOriginRequest = (req: IncomingMessage): boolean => {
  const requestHosts = [
    req.headers.host,
    req.headers['x-forwarded-host'],
  ].flatMap(value => typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [])
  const origin = req.headers.origin
  if (origin) {
    try { return requestHosts.includes(new URL(origin).host) } catch { return false }
  }
  const referer = req.headers.referer
  if (referer) {
    try { return requestHosts.includes(new URL(referer).host) } catch { return false }
  }
  const fetchSite = req.headers['sec-fetch-site']
  return fetchSite === 'same-origin'
}

/** Web 单 Token 门禁：/api/music、/api/user、/api/custom-source 全部需要登录。 */
const PLAYER_AUTH_PUBLIC_PATHS = ['/api/music/auth', '/api/music/config']
const isPlayerAuthRequiredPath = (pathname: string): boolean => {
  if (!getConfiguredAccessToken()) return true
  if (PLAYER_AUTH_PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) return false
  return pathname.startsWith('/api/music/') || pathname.startsWith('/api/user/') || pathname.startsWith('/api/custom-source/')
}

/** 验证单一 Web Token，并返回共享数据空间标识。 */
export const verifyUserAuth = (req: IncomingMessage): string | null => {
  return checkPlayerAuth(req) ? SHARED_SPACE : null
}

const getCacheRequestUsername = (req: IncomingMessage): string | null => {
  return verifyUserAuth(req)
}

const getMime = (filename: string) => {
  const ext = path.extname(filename).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

/**
 * 规范化歌曲信息，确保收藏列表中的 meta 属性在根节点也可用
 * 解决 SDK 无法识别收藏歌曲音质的问题
 */
const normalizeSongInfo = (songInfo: any) => {
  if (!songInfo) return songInfo
  const meta = songInfo.meta || {}

  // 1. 处理音质信息 (types / _types)
  if (!songInfo.types && meta) {
    songInfo.types = meta.qualitys || meta.types
  }
  if (!songInfo._types && meta) {
    songInfo._types = meta._qualitys || meta._types
  }

  // 2. 处理基础字段备用根节点映射
  if (!songInfo.albumName && meta.albumName) songInfo.albumName = meta.albumName
  if (!songInfo.albumId && meta.albumId) songInfo.albumId = meta.albumId
  if (!songInfo.img && meta.picUrl) songInfo.img = meta.picUrl
  if (!songInfo.name && meta.name) songInfo.name = meta.name
  if (!songInfo.singer && meta.singer) songInfo.singer = meta.singer
  if (!songInfo.source && meta.source) songInfo.source = meta.source
  if (!songInfo.interval && meta.interval) songInfo.interval = meta.interval

  // 3. 处理通用 ID 转换 (id -> songmid)
  if (!songInfo.songmid) {
    if (meta.songId) {
      songInfo.songmid = meta.songId
    } else if (songInfo.id) {
      const sourcePrefix = `${songInfo.source}_`
      if (typeof songInfo.id === 'string' && songInfo.id.startsWith(sourcePrefix)) {
        songInfo.songmid = songInfo.id.slice(sourcePrefix.length)
      } else {
        songInfo.songmid = songInfo.id
      }
    }
  }

  // 4. 针对各平台 SDK 所需的特定字段进行补全
  switch (songInfo.source) {
    case 'wy': // 网易
      if (!songInfo.id && meta.songId) songInfo.id = Number(meta.songId)
      if (!songInfo.songmid && songInfo.id) songInfo.songmid = String(songInfo.id)
      break

    case 'kg': // 酷狗
      if (!songInfo.hash && meta.hash) songInfo.hash = meta.hash
      // 兼容某些 SDK 可能需要的 songmid 格式 (数字_哈希 或 仅哈Hash)
      break

    case 'tx': // 腾讯
      if (!songInfo.strMediaMid && meta.strMediaMid) songInfo.strMediaMid = meta.strMediaMid
      if (!songInfo.albumMid && meta.albumMid) songInfo.albumMid = meta.albumMid
      // 只有当 meta 中的 songId 是纯数字时才回填至 root.songId，否则保持 undefined 触发 SDK 自动获取
      const metaSongId = String(meta.songId || '')
      if (/^\d+$/.test(metaSongId)) {
        songInfo.songId = metaSongId
      }
      break

    case 'mg': // 咪咕
      if (!songInfo.copyrightId && meta.copyrightId) songInfo.copyrightId = meta.copyrightId
      if (!songInfo.lrcUrl && meta.lrcUrl) songInfo.lrcUrl = meta.lrcUrl
      if (!songInfo.songId) songInfo.songId = songInfo.songmid
      break

    case 'kw': // 酷我
      // 已在步骤 3 中通用处理
      break
  }

  return songInfo
}

// 音乐解析进度 SSE 专属通道: requestId -> response
const musicProgressClients = new Map<string, http.ServerResponse>()

/** [新增] 服务器内部热重载数据 */
const checkAndCreateDir = (p: string) => {
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true })
    }
  } catch (e: any) {
    if (e.code !== 'EEXIST') {
      console.error(`Could not create directory ${p}:`, e.message)
    }
  }
}

const readBody = async (req: IncomingMessage) => await new Promise<string>((resolve, reject) => {
  const chunks: any[] = []
  req.on('data', chunk => { chunks.push(chunk) })
  req.on('end', () => {
    resolve(Buffer.concat(chunks).toString('utf-8'))
  })
  req.on('error', reject)
})

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${units[index]}`
}

const getHeaderValue = (headers: Record<string, any>, key: string): string | undefined => {
  const value = headers[key] ?? headers[key.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value == null ? undefined : String(value)
}

const parseContentLength = (headers: Record<string, any>): number | null => {
  const range = getHeaderValue(headers, 'content-range')
  const total = range?.match(/\/(\d+)$/)?.[1]
  if (total) {
    const parsed = Number(total)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  const length = Number(getHeaderValue(headers, 'content-length'))
  if (Number.isFinite(length) && length > 0) return length

  return null
}

const getAudioRemoteSize = async (audioUrl: string): Promise<number | null> => {
  if (!/^https?:\/\//i.test(audioUrl)) return null

  const urlObj = new URL(audioUrl)
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': urlObj.origin,
  }
  const options = {
    follow_max: 5,
    response_timeout: 8000,
    read_timeout: 8000,
    headers,
  }

  try {
    const resp = await needle('head', audioUrl, null, options)
    const size = parseContentLength(resp.headers || {})
    if (size) return size
  } catch (e: any) {
    console.warn(`[QualitySize] HEAD failed: ${e.message}`)
  }

  try {
    const resp = await needle('get', audioUrl, null, {
      ...options,
      headers: {
        ...headers,
        Range: 'bytes=0-0',
      },
    })
    return parseContentLength(resp.headers || {})
  } catch (e: any) {
    console.warn(`[QualitySize] Range probe failed: ${e.message}`)
  }

  return null
}

const AUTO_SOURCE_ORDER = ['wy', 'tx', 'kw', 'kg', 'mg']
const SOURCE_MATCH_CACHE_TTL = 60_000
const sourceMatchCache = new Map<string, { expiresAt: number, promise: Promise<any[]> }>()

const normalizeSongMatchText = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[（(\[].*?[）)\]]/g, '')
  .replace(/[\s\p{P}\p{S}]/gu, '')

const normalizeSongNameText = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, '')

const splitSingerNames = (value: unknown) => String(value || '')
  .toLowerCase()
  .split(/[、，,&；;|/+]/)
  .map(normalizeSongMatchText)
  .filter(Boolean)

const isSingerMatch = (candidateSinger: unknown, targetSinger: unknown) => {
  const candidateText = normalizeSongMatchText(candidateSinger)
  const targetText = normalizeSongMatchText(targetSinger)
  if (!targetText) return true
  if (!candidateText) return false
  if (candidateText.includes(targetText) || targetText.includes(candidateText)) return true

  const candidateParts = splitSingerNames(candidateSinger)
  const targetParts = splitSingerNames(targetSinger)
  return candidateParts.some(candidatePart => targetParts.some(targetPart => (
    candidatePart.includes(targetPart) || targetPart.includes(candidatePart)
  )))
}

const getSongDurationSeconds = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10000 ? Math.round(value / 1000) : Math.round(value)
  }

  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const parsed = Number(text)
    return parsed > 10000 ? Math.round(parsed / 1000) : Math.round(parsed)
  }

  const parts = text.split(':').map(Number)
  if (parts.some(part => !Number.isFinite(part))) return 0
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
  return 0
}

const getSongMatchScore = (candidate: any, target: any) => {
  const candidateName = normalizeSongNameText(candidate?.name)
  const targetName = normalizeSongNameText(target?.name)
  if (!candidateName || !targetName) return -1
  if (!candidateName.includes(targetName) && !targetName.includes(candidateName)) return -1
  if (!isSingerMatch(candidate?.singer, target?.singer)) return -1

  const candidateDuration = getSongDurationSeconds(candidate?.interval)
  const targetDuration = getSongDurationSeconds(target?.interval)
  let durationScore = 0
  if (candidateDuration > 0 && targetDuration > 0) {
    const durationDiff = Math.abs(candidateDuration - targetDuration)
    if (durationDiff > 8) return -1
    durationScore = 8 - durationDiff
  }

  const nameScore = candidateName === targetName ? 20 : 10
  const candidateAlbum = normalizeSongMatchText(candidate?.albumName)
  const targetAlbum = normalizeSongMatchText(target?.albumName)
  const albumScore = candidateAlbum && targetAlbum && candidateAlbum === targetAlbum ? 3 : 0
  return nameScore + durationScore + albumScore
}

const findServerSourceMatches = async (songInfo: any, username: string) => {
  if (!songInfo?.name || !songInfo?.singer) return []

  const cacheKey = [
    username,
    songInfo.source,
    normalizeSongMatchText(songInfo.name),
    normalizeSongMatchText(songInfo.singer),
    getSongDurationSeconds(songInfo.interval),
  ].join(':')
  const now = Date.now()
  const cached = sourceMatchCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.promise

  for (const [key, value] of sourceMatchCache) {
    if (value.expiresAt <= now) sourceMatchCache.delete(key)
  }

  const searchSources = AUTO_SOURCE_ORDER.filter(source => (
    source !== songInfo.source && isSourceSupported(source, username) && musicSdk[source]?.musicSearch?.search
  ))
  const query = `${songInfo.name} ${songInfo.singer}`
  const promise = Promise.all(searchSources.map(async source => {
    try {
      const searchData = await musicSdk[source].musicSearch.search(query, 1, 20)
      const list = Array.isArray(searchData?.list) ? searchData.list : []
      return list.map((item: any) => ({ ...item, source }))
    } catch (err: any) {
      console.warn(`[ServerAutoSource] Search failed for ${source}: ${err?.message || err}`)
      return []
    }
  })).then(resultGroups => resultGroups.flat()
    .map(candidate => ({ candidate, score: getSongMatchScore(candidate, songInfo) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.candidate))

  sourceMatchCache.set(cacheKey, { expiresAt: now + SOURCE_MATCH_CACHE_TTL, promise })
  return promise
}

const lyricTimeExp = /(?:^|\s*)\[\d{1,2}:\d+(?:\.\d+)?\].+/m

const normalizeLyricResult = (result: any) => {
  if (!result) return null
  const lyricInfo = {
    lyric: result.lyric || result.lrc || '',
    tlyric: result.tlyric || '',
    rlyric: result.rlyric || '',
    lxlyric: result.lxlyric || result.klyric || '',
  }
  return lyricInfo.lyric && lyricTimeExp.test(lyricInfo.lyric) ? lyricInfo : null
}

// 兼容上游下载逻辑：当前音源歌词无效时，搜索并尝试其它匹配音源。
const fetchLyricWithFallback = async (rawSongInfo: any, username = '_open', allowFallback = true) => {
  const original = normalizeSongInfo({ ...rawSongInfo })
  const tryCandidate = async (candidate: any) => {
    const source = candidate?.source
    if (!source || !musicSdk[source]?.getLyric) return null
    let songmid = String(candidate.songmid || candidate.songId || candidate.id || '')
    const prefix = `${source}_`
    if (songmid.startsWith(prefix)) songmid = songmid.slice(prefix.length)
    if (!songmid) return null

    try {
      const requestObj = musicSdk[source].getLyric({
        ...candidate,
        songmid,
        name: candidate.name || '',
        singer: candidate.singer || '',
        hash: candidate.hash || '',
        interval: candidate.interval || '',
      })
      const lyricInfo = normalizeLyricResult(await requestObj.promise)
      if (lyricInfo) {
        console.log(`[LyricFallback] Using ${source}_${songmid} for "${original?.name || ''}"`)
        return lyricInfo
      }
    } catch (err: any) {
      console.warn(`[LyricFallback] ${source}_${songmid} failed: ${err?.message || err}`)
    }
    return null
  }

  // 先请求原始音源，只有歌词无效或请求失败时才触发跨音源搜索。
  const originalLyric = await tryCandidate(original)
  if (originalLyric) return originalLyric
  if (!allowFallback) return null

  try {
    const matches = await findServerSourceMatches(original, username)
    for (const match of matches) {
      const candidate = normalizeSongInfo({ ...match })
      if (candidate?.source === original?.source && String(candidate?.songmid || candidate?.id) === String(original?.songmid || original?.id)) continue
      const lyricInfo = await tryCandidate(candidate)
      if (lyricInfo) return lyricInfo
    }
  } catch (err: any) {
    console.warn(`[LyricFallback] Source search failed for "${original?.name || ''}": ${err?.message || err}`)
  }

  return null
}

interface ServerSongResolveResult {
  url: string
  quality: string
  songInfo: any
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
}

const resolveServerSong = async (
  rawSongInfo: any,
  requestedQuality: string,
  username: string,
  allowQualityFallback: boolean,
): Promise<ServerSongResolveResult> => {
  const originalSong = normalizeSongInfo({ ...rawSongInfo })
  if (!originalSong?.source) throw new Error('Missing song source')

  const qualities = allowQualityFallback
    ? getDownloadQualityCandidates(requestedQuality)
    : [requestedQuality]
  const errors: string[] = []

  const tryCandidates = async (quality: string, rawCandidates: any[]) => {
    for (const rawCandidate of rawCandidates) {
      const candidate = normalizeSongInfo({ ...rawCandidate })
      const source = candidate?.source
      if (!source || !isSourceSupported(source, username)) continue

      try {
        const result = await callUserApiGetMusicUrl(source, candidate, quality, username, undefined, true)
        if (!result?.url) throw new Error('audio source returned no URL')
        return {
          url: result.url,
          quality: result.type || quality,
          songInfo: candidate,
          requestedSource: originalSong.source,
          downloadSource: fileCache.detectDownloadSource(result.url, source),
          sourceName: result.sourceName,
        }
      } catch (err: any) {
        errors.push(`${source}/${quality}: ${err?.message || 'resolve failed'}`)
      }
    }
    return null
  }

  const originalResult = await tryCandidates(requestedQuality, [originalSong])
  if (originalResult) return originalResult

  const matches = await findServerSourceMatches(originalSong, username)
  const switchedResult = await tryCandidates(requestedQuality, matches)
  if (switchedResult) return switchedResult

  for (const quality of qualities.slice(1)) {
    const fallbackResult = await tryCandidates(quality, [originalSong, ...matches])
    if (fallbackResult) return fallbackResult
  }

  throw new Error(`No downloadable source found (${errors.join('; ')})`)
}

const isPathInside = (child: string, parent: string): boolean => {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  if (resolvedChild === resolvedParent) return true
  const withSep = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep
  return resolvedChild.startsWith(withSep)
}

const serveStatic = (req: IncomingMessage, res: http.ServerResponse, filePath: string) => {
  // Prevent path traversal: ensure the resolved file path stays within staticPath
  if (!isPathInside(filePath, global.lx.staticPath)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  const contentType = getMime(filePath)

  try {
    const stats = fs.statSync(filePath)
    const mtime = stats.mtime.getTime()
    const etag = `W/"${stats.size}-${mtime}"`
    const lastModified = stats.mtime.toUTCString()

    // Check Cache Validity (Conditional Requests)
    if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304)
      res.end()
      return
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404)
          res.end('Not Found')
        } else {
          res.writeHead(500)
          res.end('Server Error')
        }
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'ETag': etag,
          'Last-Modified': lastModified,
          'Cache-Control': 'no-cache, must-revalidate', // Force browser to revalidate every time
          'Pragma': 'no-cache',
          'Expires': '0',
        })
        res.end(content, 'utf-8')
      }
    })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.writeHead(404)
      res.end('Not Found')
    } else {
      res.writeHead(500)
      res.end('Server Error')
    }
  }
}

const handleStartServer = async (port = 9527, ip = '127.0.0.1') => await new Promise((resolve, reject) => {
  const httpServer = http.createServer(async (req, res) => {
    try {
    // CORS 跨域处理
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const ip = getIP(req)
    accessLog.info(`${req.method} ${req.url} from ${ip}`)
    // console.log(req.url)
    const urlObj = new URL(req.url ?? '', `http://${req.headers.host}`)
    const pathname = urlObj.pathname

    // 读取路径配置（每次请求都重新读取，保存后立刻生效）
    const playerPath = global.lx.config['player.path'] ?? '/'

    // 映射播放器逻辑 (无论是自定义路径还是前端硬编码的 /music/)
    const isPlayerRequest = (playerPath === '/' || playerPath === '')
      ? (pathname === '/' || !pathname.startsWith('/api/') && !pathname.startsWith('/rest/'))
      : (pathname.startsWith(playerPath + '/') || pathname === playerPath)


    const isLegacyPlayerAsset = playerPath !== '/music' && (
      pathname.startsWith('/music/assets/') ||
      pathname.startsWith('/music/css/') ||
      pathname.startsWith('/music/js/') ||
      pathname.startsWith('/music/fonts/') ||
      pathname.startsWith('/music/img/')
    )

    if (isPlayerRequest || isLegacyPlayerAsset) {
      const activePrefix = isPlayerRequest ? playerPath : '/music'
      const normalizedPrefix = (activePrefix === '/' || activePrefix === '') ? '' : activePrefix.replace(/\/+$/, '')
      // 白名单：登录页、静态资源无需认证
      const isLoginPage = pathname === `${normalizedPrefix}/login` || pathname === `${normalizedPrefix}/login.html`
      const isPublicAsset = pathname.startsWith(`${normalizedPrefix}/assets/`) ||
        pathname.startsWith(`${normalizedPrefix}/css/`) ||
        pathname.startsWith(`${normalizedPrefix}/js/`) ||
        pathname.startsWith(`${normalizedPrefix}/fonts/`) ||
        pathname.startsWith(`${normalizedPrefix}/img/`) ||
        isLegacyPlayerAsset

      // 认证检查
      if (!isLoginPage && !isPublicAsset) {
        if (!checkPlayerAuth(req)) {
          res.writeHead(302, { 'Location': `${normalizedPrefix}/login` })
          res.end()
          return
        }
      }

      // 规范化物理路径
      let targetPath = pathname
      // 将请求路径中的前缀映射到真实的 /music 物理目录
      if (pathname === activePrefix && activePrefix !== '/') {
        res.writeHead(301, { 'Location': pathname + '/' })
        res.end()
        return
      }

      const subPath = pathname.slice(normalizedPrefix.length)
      if (subPath === '/' || subPath === '') {
        targetPath = 'music/index.html'
      } else if (isLoginPage) {
        targetPath = 'music/login.html'
      } else {
        // [优化] 如果根路径是播放器，且请求已经包含 /music/ 前缀，则不再重复叠加
        if ((activePrefix === '/' || activePrefix === '') && subPath.startsWith('/music/')) {
          targetPath = subPath.slice(1)
        } else {
          targetPath = path.posix.join('music', subPath.startsWith('/') ? subPath.slice(1) : subPath)
        }
      }

      const filePath = path.join(global.lx.staticPath, targetPath)
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        serveStatic(req, res, filePath)
        return
      }
    }

    // Root route redirects to the Web player login page.
    if (pathname === '/' || pathname === '/index.html') {
      const loginBase = (playerPath === '/' || !playerPath) ? '' : playerPath.replace(/\/+$/, '')
      res.writeHead(302, { 'Location': `${loginBase}/login` })
      res.end()
      return
    }

    // Other public static resources.
    if (!pathname.startsWith('/api/')) {
      const generalFilePath = path.join(global.lx.staticPath, pathname)
      if (fs.existsSync(generalFilePath) && fs.statSync(generalFilePath).isFile()) {
        serveStatic(req, res, generalFilePath)
        return
      }
    }

    if (pathname.startsWith('/api/')) {

      // 站点密码门禁：Web 功能接口统一要求先登录（除登录/公开配置白名单外）
      if (isPlayerAuthRequiredPath(pathname) && (!checkPlayerAuth(req) || !isSameOriginRequest(req))) {
        res.writeHead(checkPlayerAuth(req) ? 403 : 401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: checkPlayerAuth(req) ? 'Same-origin request required' : 'Unauthorized' }))
        return
      }




      // [新增] Get User Settings (User Auth)
      if (pathname === '/api/user/settings' && req.method === 'GET') {
        if (!verifyUserAuth(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        const settings = getJson<Record<string, unknown>>('settings', 'shared', {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(settings))
        return
      }

      // [新增] Update User Settings (User Auth)
      if (pathname === '/api/user/settings' && req.method === 'POST') {
        await readBody(req).then(body => {
          try {
            const settings = JSON.parse(body)
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings')
            if (settings.downloadDir !== undefined) settings.downloadDir = fileCache.validateDownloadDir(settings.downloadDir)
            delete settings.serverCacheLocation
            setJson('settings', 'shared', settings)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || 'Invalid settings' }))
          }
        })
        return
      }

      if (pathname === '/api/user/imported-playlists' && req.method === 'GET') {
        if (!verifyUserAuth(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(getJson<any[]>('imported_playlists', 'shared', [])))
        return
      }

      if (pathname === '/api/user/imported-playlists' && req.method === 'POST') {
        if (!verifyUserAuth(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(body => {
          try {
            const playlists = JSON.parse(body)
            if (!Array.isArray(playlists)) throw new Error('Invalid imported playlists')
            setJson('imported_playlists', 'shared', playlists.slice(0, 100))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Invalid imported playlists' }))
          }
        })
        return
      }

      // Local music remaster APIs use the same account access rules as other cache operations.
      if (pathname.startsWith('/api/music/remaster/')) {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        if (pathname === '/api/music/remaster/start' && req.method === 'POST') {
          try {
            const body = JSON.parse(await readBody(req))
            const data = await remasterQueue.start(username, String(body?.targetQuality || ''), body?.filenames)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err?.message || '启动洗版失败' }))
          }
          return
        }

        if (pathname === '/api/music/remaster/status' && req.method === 'GET') {
          const offset = Number(urlObj.searchParams.get('offset') || 0)
          const limit = Number(urlObj.searchParams.get('limit') || 200)
          const data = remasterQueue.getStatus(username, offset, limit)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data }))
          return
        }

        if (pathname === '/api/music/remaster/cancel' && req.method === 'POST') {
          const cancelled = remasterQueue.cancel(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: { cancelled } }))
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: 'Not Found' }))
        return
      }

      // [新增] File Cache APIs
      // 1. Config Cache Location
      if (pathname === '/api/music/cache/config' && req.method === 'POST') {
        await readBody(req).then(async body => {
          try {
            const { location, namingPattern, downloadDir } = JSON.parse(body)
            let updated = false

            if (location) {
              if (location !== fileCache.getCacheLocation()) {
                fileCache.setCacheLocation(location)
                updated = true
              }
            }

            if (namingPattern) {
              const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
              if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
              updated = true
            }

            if (downloadDir !== undefined) {
              if (!checkPlayerAuth(req)) {
                res.writeHead(403, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, error: 'Unauthorized to change download directory' }))
                return
              }
              fileCache.setDownloadDir(downloadDir)
              if (global.lx.config) global.lx.config.downloadDir = fileCache.getDownloadDir()
              // Persist the server-side download path so a restart does not revert it.
              if (global.lx.saveConfig) global.lx.saveConfig()
              updated = true
            }

            if (updated) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, message: 'No changes' }))
            }
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message || 'Invalid cache configuration' }))
          }
        })
        return
      }

      // 1.1 Sync downloaded-music index
      if (pathname === '/api/music/cache/sync' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        try {
          await fileCache.syncCacheIndex(username, ['music'])
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, message: 'Sync completed' }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Sync failed: ' + (e as any).message }))
        }
        return
      }

      // 1.2 Batch Rename Cache Files
      if (pathname === '/api/music/cache/rename' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        try {
          const result = await fileCache.batchRenameCacheFiles(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Rename failed: ' + (e as any).message }))
        }
        return
      }

      // 2. Check Cache
      if (pathname === '/api/music/cache/check' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name')
        const singer = urlObj.searchParams.get('singer')
        const source = urlObj.searchParams.get('source')
        const songmid = urlObj.searchParams.get('songmid')
        const songId = urlObj.searchParams.get('songId')
        const quality = urlObj.searchParams.get('quality')
        const exactQuality = urlObj.searchParams.get('exactQuality') === '1' || urlObj.searchParams.get('exactQuality') === 'true'

        if (!name || !singer || !source || (!songmid && !songId)) {
          res.writeHead(400)
          res.end('Missing params')
          return
        }

        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        const result = fileCache.checkCache({ name, singer, source, songmid, songId, quality, exactQuality }, username)
        if (result && result.exists && username !== '_open' && username !== 'default') {
          const token = req.headers['x-user-token']
          if (token) {
            result.url += `&token=${encodeURIComponent(token as string)}`
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      // Persistent server download queue. These tasks continue after the browser closes.
      if (pathname === '/api/music/cache/queue' && req.method === 'GET') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: serverDownloadQueue.list(username) }))
        return
      }

      if (pathname === '/api/music/cache/queue' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(body => {
          try {
            const { tasks, namingPattern, concurrency } = JSON.parse(body)
            if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Missing tasks')
            if (concurrency !== undefined) serverDownloadQueue.setConcurrency(username, concurrency)
            if (namingPattern) {
              const auth = req.headers['x-frontend-auth']
              if (!checkPlayerAuth(req)) throw new Error('Unauthorized to change cache naming pattern')
              const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
              if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
            }
            const queued = serverDownloadQueue.enqueue(username, tasks)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: queued }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || 'Invalid queue request' }))
          }
        })
        return
      }

      if (pathname === '/api/music/cache/queue/concurrency' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(body => {
          try {
            const { concurrency } = JSON.parse(body)
            const savedConcurrency = serverDownloadQueue.setConcurrency(username, concurrency)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: { concurrency: savedConcurrency } }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || 'Invalid concurrency' }))
          }
        })
        return
      }

      if (pathname === '/api/music/cache/queue/resume' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(body => {
          try {
            const { id, all } = JSON.parse(body)
            if (all !== true && !id) throw new Error('Missing queue task id')
            serverDownloadQueue.resume(username, all ? undefined : id)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

      if (pathname === '/api/music/cache/queue/remove' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(body => {
          try {
            const options = JSON.parse(body)
            if (!options || (options.all !== true && options.completed !== true && !options.id)) throw new Error('Missing queue removal option')
            serverDownloadQueue.remove(username, options)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message }))
          }
        })
        return
      }

      // 3. Trigger Download
      if (pathname === '/api/music/cache/download' && req.method === 'POST') {
        await readBody(req).then(body => {
          try {
            const { songInfo, url, quality, fileNamePattern, namingPattern, cacheLyric, embedMetadata, embedCover, embedLyric, embedLyricTranslation, embedLyricRoma, embedLyricLx, downloadLyricTranslation, downloadLyricRoma, downloadLyricLx, downloadLyricFormat, allowLyricSourceFallback, requestedSource, downloadSource, sourceName } = JSON.parse(body)
            if (!songInfo || !url) {
              res.writeHead(400)
              res.end('Missing params')
              return
            }

            // Fire and forget (background download) with Abort support
            const reqUsername = (req.headers['x-user-name'] as string) || ''
            const isPublic = !reqUsername || reqUsername === 'default'
            let username = '_open'

            if (!isPublic) {
              const verified = verifyUserAuth(req)
              if (!verified) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
                return
              }
              username = verified
            }
            if (namingPattern) {
              const auth = req.headers['x-frontend-auth']
              if (!checkPlayerAuth(req)) {
                res.writeHead(403, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, error: 'Unauthorized to change cache naming pattern' }))
                return
              }
              const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
              if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
            }
            const songKey = fileCache.normalizeSongId(songInfo) + '_' + (quality || 'unknown')

            console.log(`[Cache] Registering active task: ${songKey} for user: "${username}"`)

            const controller = new AbortController()
            let userTasks = fileCache.activeTasks.get(username)
            if (!userTasks) {
              userTasks = []
              fileCache.activeTasks.set(username, userTasks)
            }
            userTasks.push({ songKey, controller })

            void fileCache.downloadAndCache(songInfo, url, quality, username, controller.signal, true, cacheLyric !== false, embedLyric !== false, {
              requestedSource: requestedSource || songInfo.source,
              downloadSource,
              sourceName,
            }, {
              fileNamePattern: ['name-artist', 'artist-name', 'name'].includes(fileNamePattern) ? fileNamePattern : 'name-artist',
              embedMetadata: embedMetadata !== false,
              embedCover: embedCover !== false,
              embedLyric: embedLyric !== false,
              embedLyricTranslation: embedLyricTranslation === true,
              embedLyricRoma: embedLyricRoma === true,
              embedLyricLx: embedLyricLx !== false,
              downloadLyric: cacheLyric !== false,
              downloadLyricTranslation: downloadLyricTranslation === true,
              downloadLyricRoma: downloadLyricRoma === true,
              downloadLyricLx: downloadLyricLx !== false,
              downloadLyricFormat: downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8',
              allowLyricSourceFallback: allowLyricSourceFallback !== false,
            })
              .then(() => console.log(`[Cache] Downloaded ${songInfo.name} for ${username || '_open'}`))
              .catch((err: any) => {
                if (err.message === 'Aborted') {
                  console.log(`[Cache] Task aborted for ${songInfo.name}`)
                } else {
                  console.error(`[Cache] Failed to download ${songInfo.name}:`, err)
                }
              })
              .finally(() => {
                // Cleanup active task
                const tasks = fileCache.activeTasks.get(username)
                if (tasks) {
                  const idx = tasks.findIndex(t => t.songKey === songKey)
                  if (idx !== -1) {
                    tasks.splice(idx, 1)
                    console.log(`[Cache] Cleaned up active task: ${songKey} for user: "${username}"`)
                  }
                }
              })

            res.writeHead(200)
            res.end(JSON.stringify({ success: true, message: 'Download started' }))
          } catch (e) {
            res.writeHead(500)
            res.end('Error')
          }
        })
        return
      }

      // [New] Stop Cache Task
      if (pathname === '/api/music/cache/stop' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        await readBody(req).then(body => {
          try {
            const { songKey, queueId, all } = JSON.parse(body)
            if (all) {
              fileCache.stopUserTasks(username)
              serverDownloadQueue.pause(username)
              console.log(`[Cache] Stopped all tasks for user: ${username}`)
            } else if (queueId) {
              serverDownloadQueue.pause(username, queueId)
              console.log(`[Cache] Paused persistent queue task ${queueId} for user: ${username}`)
            } else if (songKey) {
              fileCache.stopUserTasks(username, songKey)
              console.log(`[Cache] Stopped task ${songKey} for user: ${username}`)
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // ===== 歌单订阅（定时拉取远端歌单，自动对比新增并入队下载） =====
      if (pathname === '/api/music/subscriptions' && req.method === 'GET') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: playlistSubscription.list(username), settings: playlistSubscription.getSettings() }))
        return
      }

      if (pathname === '/api/music/subscriptions' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(async body => {
          try {
            const input = JSON.parse(body)
            const sub = await playlistSubscription.subscribe(username, input)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: sub }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || '订阅失败' }))
          }
        })
        return
      }

      if (pathname === '/api/music/subscriptions/update' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(async body => {
          try {
            const { id, ...patch } = JSON.parse(body)
            if (!id) throw new Error('Missing subscription id')
            const sub = await playlistSubscription.update(username, id, patch)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: sub }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || '更新失败' }))
          }
        })
        return
      }

      if (pathname === '/api/music/subscriptions/delete' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(body => {
          try {
            const { id } = JSON.parse(body)
            if (!id) throw new Error('Missing subscription id')
            const sub = playlistSubscription.unsubscribe(username, id)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: sub }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || '取消订阅失败' }))
          }
        })
        return
      }

      if (pathname === '/api/music/subscriptions/check' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(async body => {
          try {
            const { id, all } = JSON.parse(body)
            const results = await playlistSubscription.checkNow(username, all ? undefined : id)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: results }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || '检测失败' }))
          }
        })
        return
      }

      if (pathname === '/api/music/subscriptions/settings' && req.method === 'POST') {
        const username = getCacheRequestUsername(req)
        if (!username) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
          return
        }
        await readBody(req).then(body => {
          try {
            const { intervalMinutes } = JSON.parse(body)
            const saved = playlistSubscription.setIntervalMinutes(intervalMinutes)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: { intervalMinutes: saved } }))
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: err.message || '保存失败' }))
          }
        })
        return
      }

      // 4. Serve Cached File
      if (pathname.startsWith('/api/music/cache/file/')) {
        const parts = pathname.replace('/api/music/cache/file/', '').split('/')
        const reqUsername = parts.length > 1 ? decodeURIComponent(parts[0]) : '_open'
        const filename = parts.length > 1 ? parts[1] : parts[0]

        if (filename) {
          let username = '_open'
          const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default'

          if (!isPublic) {
            const urlToken = urlObj.searchParams.get('token')
            if (urlToken && !req.headers['x-user-token']) {
              (req.headers as any)['x-user-token'] = urlToken
            }
            if (reqUsername && !req.headers['x-user-name']) {
              (req.headers as any)['x-user-name'] = reqUsername
            }
            const verified = verifyUserAuth(req)
            if (!verified) {
              res.writeHead(401)
              res.end('Unauthorized')
              return
            }
            username = verified
          }
          fileCache.serveCacheFile(req, res, decodeURIComponent(filename), username)
          return
        }
      }

      // 5. Get Cache Statistics
      if (pathname === '/api/music/cache/stats' && req.method === 'GET') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        try {
          const stats = fileCache.getCacheStats(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: stats }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to get cache stats' }))
        }
        return
      }

      if (pathname === '/api/music/cache/clear' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        try {
          const result = fileCache.clearAllCache(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to clear cache' }))
        }
        return
      }

      if (pathname === '/api/music/cache/lyric/clear' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        try {
          const result = fileCache.clearLyricCache(username)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message || 'Failed to clear lyric cache' }))
        }
        return
      }

      // 7. Get Cache Progress
      if (pathname === '/api/music/cache/progress' && req.method === 'GET') {
        const ids = urlObj.searchParams.get('ids')?.split(',') || []
        const progress: any = {}
        ids.forEach(id => {
          if (fileCache.cacheProgress.has(id)) {
            progress[id] = fileCache.cacheProgress.get(id)
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: progress }))
        return
      }

      // 7. Get downloaded local-music list
      if (pathname === '/api/music/cache/list' && req.method === 'GET') {
        const username = 'shared'
        void fileCache.getCacheList(username).then(list => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          })
          res.end(JSON.stringify({ success: true, data: list }))
        }).catch(err => {
          res.writeHead(500)
          res.end(err.message)
        })
        return
      }

      // 8. Get Cache Cover
      if (pathname === '/api/music/cache/cover' && req.method === 'GET') {
        const username = 'shared'
        const filename = urlObj.searchParams.get('filename')
        if (!filename) {
          res.writeHead(400)
          res.end('Missing filename')
          return
        }
        const cover = await fileCache.getCacheCover(filename, username) as any
        if (cover && cover.data) {
          res.writeHead(200, {
            'Content-Type': cover.mime || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400'
          })
          res.end(cover.data)
        } else {
          // Fallback to logo or 404
          res.writeHead(404)
          res.end('Not Found')
        }
        return
      }

      // 9. Remove Cache File (Single or Batch)
      if (pathname === '/api/music/cache/remove' && req.method === 'POST') {
        const username = 'shared'
        await readBody(req).then(body => {
          try {
            const payload = JSON.parse(body)
            const legacyFilenames = payload.filenames
            const rawItems = Array.isArray(payload.items)
              ? payload.items
              : (legacyFilenames ? (Array.isArray(legacyFilenames) ? legacyFilenames : [legacyFilenames]) : [])
            if (rawItems.length === 0) throw new Error('Missing items')

            const deleteItems: Array<{ filename: string; folder?: fileCache.CacheFolder }> = rawItems.map((item: any) => {
              if (typeof item === 'string') return { filename: item }
              if (!item || typeof item.filename !== 'string') throw new Error('Invalid delete item')
              if (item.folder !== undefined && item.folder !== 'cache' && item.folder !== 'music') {
                throw new Error('Invalid folder')
              }
              return { filename: item.filename, folder: item.folder }
            })

            let deletedCount = 0
            const failures: Array<{ filename: string; folder?: fileCache.CacheFolder; message: string }> = []
            for (const item of deleteItems) {
              try {
                const result = fileCache.removeCacheFile(item.filename, username, item.folder)
                if (result.deleted) {
                  deletedCount++
                  accessLog.info(`music file deleted user=${username} folder=${result.folder} filename=${JSON.stringify(item.filename)}`)
                } else {
                  failures.push({ ...item, message: 'File not found' })
                }
              } catch (error: any) {
                failures.push({ ...item, message: error?.message || 'Delete failed' })
                accessLog.warn(`music file delete rejected user=${username} folder=${item.folder || 'unspecified'} filename=${JSON.stringify(item.filename)} reason=${JSON.stringify(error?.message || 'Delete failed')}`)
              }
            }

            const success = failures.length === 0
            const statusCode = success ? 200 : (deletedCount > 0 ? 207 : 409)
            res.writeHead(statusCode, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success,
              deletedCount,
              failedCount: failures.length,
              failures,
              message: success ? undefined : failures[0]?.message,
            }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message }))
          }
        })
        return
      }



      // 10. Update Metadata (Batch)
      if (pathname === '/api/music/cache/updateMetadata' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }
        await readBody(req).then(async body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames) throw new Error('Missing filenames')

            const fileList = Array.isArray(filenames) ? filenames : [filenames]
            const result = await fileCache.batchUpdateMetadata(fileList, username)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...result }))
          } catch (e: any) {
            res.writeHead(400)
            res.end(e.message)
          }
        })
        return
      }

      // [新增] Embed Lyric into Audio File Tags (USLT)
      if (pathname === '/api/music/cache/embedLyric' && req.method === 'POST') {
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        await readBody(req).then(async body => {
          try {
            const { filenames } = JSON.parse(body)
            if (!filenames || !Array.isArray(filenames)) throw new Error('Missing filenames')

            let successCount = 0
            let skippedCount = 0
            let failCount = 0
            const details: any[] = []

            for (const filename of filenames) {
              let filePath = ''
              let folder: 'cache' | 'music' = 'cache'

              // 在 cache 和 music 两个目录中查找文件
              for (const f of ['cache', 'music'] as const) {
                const dir = fileCache.getCacheDir(username, f === 'music')
                const candidate = path.join(dir, filename)
                if (fs.existsSync(candidate)) {
                  filePath = candidate
                  folder = f
                  break
                }
              }

              if (!filePath) {
                details.push({ filename, status: 'fail', reason: '文件不存在' })
                failCount++
                continue
              }

              try {
                const indexItem = fileCache.getIndexItemByFilename(filename, username) as any

                // 检查是否已有 USLT 歌词（已有则跳过）
                const { MusicTagger: MT } = require('music-tag-native')
                let checkTagger: any
                let existingLyrics = ''
                try {
                  checkTagger = new MT()
                  checkTagger.loadPath(filePath)
                  existingLyrics = checkTagger.lyrics || ''
                } catch (checkError: any) {
                  const unsupportedStatus = fileCache.getAudioMetadataUnsupportedStatus(filePath)
                  fileCache.setIndexEmbedLyric(filename, username, false, {
                    audioContainer: unsupportedStatus.audioContainer,
                    metadataWritable: false,
                    metadataError: unsupportedStatus.error,
                    embedLyricError: unsupportedStatus.error,
                  })
                  details.push({ filename, status: 'fail', reason: unsupportedStatus.error || '当前音频容器不支持嵌入歌词，外置歌词文件仍可正常使用' })
                  failCount++
                  continue
                } finally {
                  try { if (checkTagger) checkTagger.dispose() } catch (e) { }
                }

                if (existingLyrics && existingLyrics.trim().length > 10) {
                  details.push({ filename, status: 'skipped', reason: '已有歌词标签' })
                  skippedCount++
                  continue
                }

                // 从索引中获取 songInfo（索引条目本身就包含 source/songmid 等字段）
                const songInfo = indexItem

                // 优先读同名 .lrc 文件
                const ext = path.extname(filename)
                const baseName = filename.slice(0, filename.length - ext.length)
                const lrcFilename = baseName + '.lrc'
                const dir = fileCache.getCacheDir(username, folder === 'music')
                const lrcPath = path.join(dir, lrcFilename)

                let lyricData: any = null

                if (fs.existsSync(lrcPath)) {
                  lyricData = parseLyrics(fileCache.readLyricFile(lrcPath))
                  console.log(`[EmbedLyric] Using local .lrc for: ${filename}`)
                } else if (songInfo && songInfo.source && songInfo.source !== 'unknown') {
                  // 没有 .lrc 文件，尝试通过 SDK 获取
                  const lyricFetcherFn = fileCache.getLyricFetcher()
                  if (lyricFetcherFn) {
                    lyricData = await lyricFetcherFn(songInfo, username)
                  }
                  if (lyricData) {
                    console.log(`[EmbedLyric] Fetched lyric from SDK for: ${filename}`)
                  }
                }

                const lyricText = typeof lyricData === 'string' ? lyricData : buildLyrics(lyricData || {})
                if (!lyricText) {
                  details.push({ filename, status: 'fail', reason: '无法获取歌词' })
                  failCount++
                  continue
                }

                const embedResult = await fileCache.embedLyricsIntoFile(filePath, lyricText, {
                  title: indexItem?.name,
                  artist: indexItem?.singer,
                  album: indexItem?.album,
                  APIC: indexItem?.img,
                })
                fileCache.setIndexEmbedLyric(filename, username, embedResult.hasEmbedLyric, {
                  audioContainer: embedResult.audioContainer,
                  metadataWritable: embedResult.metadataWritable,
                  metadataError: embedResult.metadataWritable ? undefined : embedResult.error,
                  embedLyricError: embedResult.error,
                })
                if (!embedResult.success) {
                  details.push({ filename, status: 'fail', reason: embedResult.error || '歌词标签写入后校验失败，外置歌词文件仍可正常使用' })
                  failCount++
                  continue
                }

                details.push({ filename, status: 'success' })
                successCount++
                console.log(`[EmbedLyric] Embedded lyric for: ${filename}`)
              } catch (itemErr: any) {
                details.push({ filename, status: 'fail', reason: itemErr.message || '未知错误' })
                failCount++
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, successCount, skippedCount, failCount, details }))
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: e.message }))
          }
        })
        return
      }

      // [New] Fetch Lyrics
      if (pathname === '/api/music/lyric' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source')
        // [Optimization] Accept multiple ID param names for better client compatibility
        let songmid = urlObj.searchParams.get('songmid') || urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')

        if (!source || !songmid) {
          res.writeHead(400)
          res.end('Missing source or songmid')
          return
        }

        // [Fix] Normalize ID by stripping source prefix if present (e.g., "tx_001..." -> "001...")
        const sourcePrefix = `${source}_`
        if (songmid.startsWith(sourcePrefix)) {
          songmid = songmid.slice(sourcePrefix.length)
        }

        const useLyricCache = urlObj.searchParams.get('useCache') !== '0'
        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let lyricUsername = '_open'
        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (verified) lyricUsername = verified
        }
        const lyricCacheInfo = {
          source,
          songmid,
          id: urlObj.searchParams.get('songId') || urlObj.searchParams.get('id') || songmid,
          name: urlObj.searchParams.get('name') || '',
          singer: urlObj.searchParams.get('singer') || '',
        }

        if (useLyricCache) {
          const localLyricResult = fileCache.checkLyricCache(lyricCacheInfo, lyricUsername)
          if (localLyricResult.exists && localLyricResult.content) {
            console.log(`[Lyric] 命中本地 .lrc 缓存: ${source}_${songmid}`)
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' })
            res.end(JSON.stringify({ ...localLyricResult.content, _fromLocalCache: true }))
            return
          }
        }

        try {
          if (!musicSdk[source]) {
            throw new Error('Source not supported')
          }

          // console.log('[Lyric] Fetching lyric for:', source, songmid)

          // Construct complete songInfo object for SDK compatibility
          // KuGou (kg) needs: name, hash, interval
          // MiGu (mg) needs: copyrightId, lrcUrl, mrcUrl, trcUrl (优先，避免调用getMusicInfo API)
          const songInfo = normalizeSongInfo({
            source,
            songmid,
            id: urlObj.searchParams.get('songId') || urlObj.searchParams.get('id') || songmid,
            name: urlObj.searchParams.get('name') || '',
            singer: urlObj.searchParams.get('singer') || '',
            hash: urlObj.searchParams.get('hash') || '',
            interval: urlObj.searchParams.get('interval') || '',
            copyrightId: urlObj.searchParams.get('copyrightId') || '',
            albumId: urlObj.searchParams.get('albumId') || '',
            lrcUrl: urlObj.searchParams.get('lrcUrl') || '',
            mrcUrl: urlObj.searchParams.get('mrcUrl') || '',
            trcUrl: urlObj.searchParams.get('trcUrl') || ''
          })

          const allowSourceSwitch = urlObj.searchParams.get('allowSourceSwitch') !== '0'
          const lyricInfo = await fetchLyricWithFallback(songInfo, lyricUsername, allowSourceSwitch)
          if (!lyricInfo) throw new Error('Get lyric failed')

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': useLyricCache ? 'public, max-age=86400' : 'no-store'
          })
          res.end(JSON.stringify(lyricInfo))
        } catch (err: any) {
          console.error('[Lyric] Fetch error:', source, songmid, err.message || err)

          // [Fallback] 网络请求失败时，再次尝试本地 .lrc 文件（防止 Step2 miss 但物理文件存在的情况）
          const fallbackResult = useLyricCache ? fileCache.checkLyricCache(lyricCacheInfo, lyricUsername) : { exists: false }
          if (useLyricCache && fallbackResult.exists && fallbackResult.content) {
            console.log(`[Lyric] 网络失败，fallback 到本地 .lrc: ${source}_${songmid}`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ...fallbackResult.content, _fromLocalCache: true }))
            return
          }

          // Avoid circular structure error - only send message
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end(err.message || 'Failed to fetch lyric')
        }
        return
      }

      // [新增] File Cache Lyric APIs
      if (pathname === '/api/music/cache/lyric' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source')
        const songmid = urlObj.searchParams.get('songmid') || urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')
        const songId = urlObj.searchParams.get('songId') || urlObj.searchParams.get('id')

        const reqUsername = (req.headers['x-user-name'] as string) || ''
        const isPublic = !reqUsername || reqUsername === 'default'
        let username = '_open'

        if (!isPublic) {
          const verified = verifyUserAuth(req)
          if (!verified) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
            return
          }
          username = verified
        }

        if (!source || (!songmid && !songId)) {
          res.writeHead(400)
          res.end('Missing source or songmid')
          return
        }

        const name = urlObj.searchParams.get('name') || ''
        const singer = urlObj.searchParams.get('singer') || ''
        const result = fileCache.checkLyricCache({ source, songmid, id: songId, name, singer }, username)
        if (result.exists) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: result.content }))
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Not found in cache' }))
        }
        return
      }

      if (pathname === '/api/music/cache/lyric' && req.method === 'POST') {
        await readBody(req).then(async body => {
          try {
            const {
              songInfo,
              lyricsObj,
              embedLyric,
              downloadLyric,
              embedLyricTranslation,
              embedLyricRoma,
              embedLyricLx,
              downloadLyricTranslation,
              downloadLyricRoma,
              downloadLyricLx,
              downloadLyricFormat,
              quality,
            } = JSON.parse(body)
            const reqUsername = (req.headers['x-user-name'] as string) || ''
            const isPublic = !reqUsername || reqUsername === 'default'
            let username = '_open'

            if (!isPublic) {
              const verified = verifyUserAuth(req)
              if (!verified) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: false, message: 'Unauthorized' }))
                return
              }
              username = verified
            }

            if (!songInfo || !lyricsObj) {
              res.writeHead(400)
              res.end('Missing parameters')
              return
            }

            const normalizedSongInfo = { ...songInfo, quality: quality || songInfo.quality }
            const shouldDownloadLyric = downloadLyric !== false
            const shouldEmbedLyric = embedLyric === true
            const saved = shouldDownloadLyric
              ? fileCache.saveLyricCache(normalizedSongInfo, lyricsObj, username, true, {
                downloadLyricLx: downloadLyricLx !== false,
                downloadLyricTranslation: downloadLyricTranslation === true,
                downloadLyricRoma: downloadLyricRoma === true,
                downloadLyricFormat: downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8',
              })
              : true
            const embedResult = shouldEmbedLyric
              ? await fileCache.embedLyricTextForSong(
                normalizedSongInfo,
                buildLyrics(
                  lyricsObj,
                  embedLyricLx !== false,
                  embedLyricTranslation === true,
                  embedLyricRoma === true,
                ),
                username,
                quality || songInfo.quality,
              )
              : undefined
            const success = saved && (!shouldEmbedLyric || embedResult?.success === true)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success,
              embedded: embedResult ? embedResult.embedded : undefined,
              embedError: embedResult?.error,
            }))
          } catch (e: any) {
            res.writeHead(500)
            res.end('Server internal error')
          }
        })
        return
      }

      // Web player public configuration API.
      if (pathname === '/api/music/config' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        })
        res.end(JSON.stringify({
          downloadDir: fileCache.getDownloadDir()
        }))
        return
      }

      // Web single-token login. A server-memory session ID is stored in the HttpOnly cookie.
      if (pathname === '/api/music/auth' && req.method === 'POST') {
        await readBody(req).then(body => {
          try {
            const { token } = JSON.parse(body)
            const correctToken = getConfiguredAccessToken()

            if (tokenEquals(String(token || ''), correctToken)) {
              const sessionToken = createAuthSession()
              loginLog.info(`Web token login success from ${ip}`)
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionToken)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`
              })
              res.end(JSON.stringify({ success: true }))
            } else {
              loginLog.warn(`Web token login failed from ${ip}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false }))
            }
          } catch (err: any) {
            res.writeHead(500)
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        })
        return
      }

      // Web logout: clear the shared token cookie.
      if (pathname === '/api/music/auth/logout' && req.method === 'POST') {
        authSessions.delete(getRequestAccessToken(req))
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `${AUTH_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`
        })
        res.end(JSON.stringify({ success: true }))
        return
      }

      // [新增] Web 管理界面认证状态检查 API
      if (pathname === '/api/music/auth/verify' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ valid: checkPlayerAuth(req) }))
        return
      }

      // [新增] 音乐搜索 API
      if (pathname === '/api/music/search' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name') || ''
        const singer = urlObj.searchParams.get('singer') || ''
        const source = urlObj.searchParams.get('source') || 'kw'
        const type = urlObj.searchParams.get('type') || 'song' // 新增 type 参数: song, singer, album, playlist
        const limit = parseInt(urlObj.searchParams.get('limit') || '20')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        const fetchPages = parseInt(urlObj.searchParams.get('pages') || '1') // 新增：一次请求多少页

        if (!name) {
          res.writeHead(400); res.end('Missing name'); return
        }

        try {
          if (!musicSdk[source]) {
            throw new Error(`Source ${source} is not supported`)
          }

          let result
          if (type === 'song') {
            const PAGE_SIZE = 20
            let allSongs: any[] = []
            // 根据前端给定的起始页 (page) 和 请求量 (pages) 进行拉取
            const startPage = page
            const endPage = page + fetchPages - 1

            for (let p = startPage; p <= endPage; p++) {
              const searchData = await musicSdk[source].musicSearch.search(name, p, PAGE_SIZE)
              const pageList: any[] = searchData.list || []
              allSongs = allSongs.concat(pageList)
              // 如果本页返回数量小于 PAGE_SIZE，说明已经是最后页
              if (pageList.length < PAGE_SIZE) break
            }
            result = allSongs
          } else if (type === 'singer') {
            if (!musicSdk[source].extendSearch || !musicSdk[source].extendSearch.searchSinger) {
              throw new Error(`Source ${source} does not support singer search`)
            }
            const searchData = await musicSdk[source].extendSearch.searchSinger(name, page, limit)
            result = searchData.list || []
          } else if (type === 'album') {
            if (!musicSdk[source].extendSearch || !musicSdk[source].extendSearch.searchAlbum) {
              throw new Error(`Source ${source} does not support album search`)
            }
            const searchData = await musicSdk[source].extendSearch.searchAlbum(name, page, limit)
            result = searchData.list || []
          } else if (type === 'playlist') {
            if (!musicSdk[source].extendSearch || !musicSdk[source].extendSearch.searchPlaylist) {
              throw new Error(`Source ${source} does not support playlist search`)
            }
            const searchData = await musicSdk[source].extendSearch.searchPlaylist(name, page, limit)
            result = searchData.list || []
          } else {
            throw new Error(`Invalid search type: ${type}`)
          }

          fs.appendFileSync(path.join(process.cwd(), 'debug.txt'), `[Search] Source: ${source}, Type: ${type}, Query: ${name}, StartPage: ${page}, Pages: ${fetchPages}, Result Count: ${result.length}\n`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          fs.appendFileSync(path.join(process.cwd(), 'debug.txt'), `[Search Error] ${err.message}\n${err.stack}\n`)
          console.error(err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message, code: 500 }))
        }
        return
      }

      // [新增] 搜索提示 (TipSearch) API
      if (pathname === '/api/music/tipSearch' && req.method === 'GET') {
        const name = urlObj.searchParams.get('name') || ''
        const source = urlObj.searchParams.get('source') || 'kw'
        if (!name) {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].tipSearch) {
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return
          }
          const tips = await musicSdk[source].tipSearch.search(name)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(tips || []))
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('[]')
        }
        return
      }

      // [新增] 获取歌手详情 API
      if (pathname === '/api/music/artistDetail' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id')
        const source = urlObj.searchParams.get('source') || 'wy'
        if (!id) {
          res.writeHead(400); res.end('Missing id'); return
        }
        try {
          const data = await musicSdk[source].extendDetail.getArtistDetail(id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 获取歌手专辑列表 API
      if (pathname === '/api/music/artistAlbums' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id')
        const source = urlObj.searchParams.get('source') || 'wy'
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!id) {
          res.writeHead(400); res.end('Missing id'); return
        }
        try {
          const data = await musicSdk[source].extendDetail.getArtistAlbums(id, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 获取歌手歌曲 API（循环拉取全部，前端分页）
      if (pathname === '/api/music/artistSongs' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id')
        const source = urlObj.searchParams.get('source') || 'wy'
        const order = urlObj.searchParams.get('order') || 'hot'
        if (!id) {
          res.writeHead(400); res.end('Missing id'); return
        }
        try {
          const PAGE_SIZE = 100
          const configuredMaxPages = Number((global.lx.config as any)?.['artist.maxFetchPages'])
          const MAX_PAGES = Number.isFinite(configuredMaxPages) && configuredMaxPages > 0
            ? Math.min(Math.floor(configuredMaxPages), 100)
            : 20
          let allSongs: any[] = []
          for (let p = 1; p <= MAX_PAGES; p++) {
            const data = await musicSdk[source].extendDetail.getArtistSongs(id, p, PAGE_SIZE, order)
            const pageList: any[] = data.list || []
            allSongs = allSongs.concat(pageList)
            const total = Number(data.total) || 0
            if (pageList.length < PAGE_SIZE || (total > 0 && allSongs.length >= total)) break
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(allSongs))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 获取专辑歌曲 API
      if (pathname === '/api/music/albumSongs' && req.method === 'GET') {
        const id = urlObj.searchParams.get('id')
        const source = urlObj.searchParams.get('source') || 'wy'
        if (!id) {
          res.writeHead(400); res.end('Missing id'); return
        }
        try {
          const data = await musicSdk[source].extendDetail.getAlbumSongs(id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        } catch (err: any) {
          res.writeHead(500); res.end(err.message)
        }
        return
      }

      // [新增] 音乐解析进度 SSE 端点 (无需登录, 用 requestId 区分)
      if (pathname === '/api/music/progress' && req.method === 'GET') {
        const reqId = urlObj.searchParams.get('reqId')
        if (!reqId) {
          res.writeHead(400)
          res.end('Missing reqId')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no', // 关键：禁用 Nginx 等代理的缓冲
        })
        res.write('retry: 3000\n\n')
        musicProgressClients.set(reqId, res)
        req.on('close', () => {
          musicProgressClients.delete(reqId)
        })
        return
      }

      // [新增] 音乐 URL API
      if (pathname === '/api/music/url' && req.method === 'POST') {
        const verifiedUsername = 'shared'

        const clientId = req.headers['x-client-id'] as string | undefined
        const reqId = req.headers['x-req-id'] as string | undefined

        await readBody(req).then(async body => {
          // 辅助：通过 SSE 推送进度（内置竞态重试，最多等 600ms 让 SSE 连接就绪）
          let sseFailed = false
          const pushProgress = async (attempt: any, retries = 10): Promise<void> => {
            if (!reqId || sseFailed) return
            if (musicProgressClients.has(reqId)) {
              musicProgressClients.get(reqId)!.write(`data: ${JSON.stringify(attempt)}\n\n`)
              return
            }
            if (retries > 0) {
              await new Promise(r => setTimeout(r, 300))
              await pushProgress(attempt, retries - 1)
            } else {
              sseFailed = true
              console.warn(`[SSE] ReqId ${reqId} not found after retries (${musicProgressClients.size} clients registered)`)
            }
          }

          try {
            let { songInfo, quality, enableAutoSwitchApiSource } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            // console.log('[MusicUrl] Song Info:', JSON.stringify(songInfo, null, 2))
            if (!songInfo || !songInfo.source) {
              throw new Error('Invalid songInfo')
            }
            const source = songInfo.source
            let result: any

            let customSourceError: string | null = null
            let attempts: any[] = []
            if (isSourceSupported(source, verifiedUsername)) {
              try {
                console.log(`[MusicUrl] Using custom source for: ${source} (ReqId: ${reqId || 'None'}, User: ${verifiedUsername})`)

                const userApiResult = await callUserApiGetMusicUrl(
                  source, songInfo, quality || '128k', verifiedUsername,
                  (attempt) => { void pushProgress(attempt) },
                  enableAutoSwitchApiSource !== false
                )
                result = userApiResult
                attempts = userApiResult.attempts || []
              } catch (userApiError: any) {
                console.error(`[MusicUrl] Custom source failed:`, userApiError.message)
                customSourceError = userApiError.message
                attempts = userApiError.attempts || []
                // 不抛出错误，继续尝试内置源
              }
            } else {
              // isSourceSupported = false: 无任何自定义源支持此平台，立即通知前端
              void pushProgress({ name: '系统', status: 'fail', message: `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源` })
            }

            // 自定义源失败则直接报错（内置 SDK 无独立解析能力，回退无意义）
            if (!result) {
              const errMsg = customSourceError || `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`
              const err: any = new Error(errMsg)
              err.attempts = attempts
              throw err
            }

            // 合并解析尝试记录到响应（前端可用于诊断）
            if (attempts.length > 0) result.attempts = attempts

            // [Fix] Server-side Mixed Content handling & Redirect Resolution
            // If the upstream URL is HTTP, rewrite it to use our secure proxy OR resolve it if it's a redirect
            if (result && result.url) {
              // 1. Resolve Redirects (301, 302, 307, etc.) to get direct link
              try {
                // Only try to resolve if it looks like a remote URL and is not already resolved
                if (result.url.startsWith('http')) {
                  // console.log(`[MusicUrl] Resolving redirects for: ${songInfo.name} (${quality})`);

                  const checkRedirect = async (u: string, depth: number = 0): Promise<string> => {
                    if (depth > 3) return u // Max depth 3
                    try {
                      const resp = await needle('head', u, null, {
                        follow_max: 0,
                        response_timeout: 4000, // Increase timeout slightly
                        read_timeout: 4000,
                        headers: {
                          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                          'Referer': new URL(u).origin
                        }
                      })
                      if (resp.statusCode && [301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
                        let nextUrl = resp.headers.location
                        if (!nextUrl.startsWith('http')) {
                          try { nextUrl = new URL(nextUrl, u).href } catch (e) { }
                        }
                        // console.log(`[MusicUrl] Resolve redirect [${resp.statusCode}]: ${u.substring(0, 50)}... -> ${nextUrl.substring(0, 50)}...`)
                        return checkRedirect(nextUrl, depth + 1)
                      }
                      // If error status but not redirect, return original
                      if (resp.statusCode !== undefined && resp.statusCode >= 400) {
                        console.warn(`[MusicUrl] Redirect check failed with status ${resp.statusCode}, using original URL`);
                        return u;
                      }
                    } catch (e: any) {
                      console.warn(`[MusicUrl] head check failed: ${e.message}`);
                    }
                    return u
                  }

                  const finalUrl = await checkRedirect(result.url)
                  if (finalUrl !== result.url) {
                    result.url = finalUrl
                  }
                  // console.log(`[MusicUrl] Final Resolved URL: ${result.url.substring(0, 100)}...`);
                }
              } catch (e) {
                console.error('[MusicUrl] Resolve Error:', e)
              }

              // 2. Mixed Content Handling (Optional Proxy) implementation details handled by frontend now
              // But we can keep the log for debugging
              if (result.url.startsWith('http://')) {
                // console.log(`[MusicUrl] Note: URL is HTTP, frontend might proxy if enabled: ${result.url}`)
              }

              result.requestedSource = songInfo.source
              result.downloadSource = fileCache.detectDownloadSource(result.url, songInfo.source)
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            console.error('[MusicUrl] Error:', err.message)
            // [Fix] Return 500 but with specific error JSON to let frontend show detailed toast
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message, code: 500, attempts: err.attempts }))
          }
        })
        return
      }

      // [新增] 音质真实大小 API
      if (pathname === '/api/music/quality/size' && req.method === 'POST') {
        const verifiedUsername = 'shared'

        await readBody(req).then(async body => {
          try {
            let { songInfo, quality } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            if (!songInfo || !songInfo.source || !quality) {
              throw new Error('Invalid quality size request')
            }

            const result = await resolveServerSong(songInfo, quality, verifiedUsername, false)
            const bytes = await getAudioRemoteSize(result.url)
            if (!bytes) throw new Error('无法读取真实文件大小')

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              success: true,
              quality,
              bytes,
              size: formatBytes(bytes),
              type: result.quality,
              source: fileCache.detectDownloadSource(result.url, result.downloadSource || result.songInfo?.source),
              sourceName: result.sourceName,
            }))
          } catch (err: any) {
            console.error('[QualitySize] Error:', err.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: err.message, code: 500 }))
          }
        })
        return
      }

      // [新增] 歌词 API
      if (pathname === '/api/music/lyric' && req.method === 'POST') {
        await readBody(req).then(async body => {
          try {
            let { songInfo } = JSON.parse(body)
            songInfo = normalizeSongInfo(songInfo)
            if (!songInfo || !songInfo.source) {
              throw new Error('Invalid songInfo')
            }
            const source = songInfo.source
            if (!musicSdk[source] || !musicSdk[source].getLyric) {
              throw new Error(`Source ${source} not supported`)
            }
            const result = await musicSdk[source].getLyric(songInfo)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err: any) {
            console.error(err)
            res.writeHead(500)
            res.end(err.message)
          }
        })
        return
      }

      // [新增] 热搜 API
      if (pathname === '/api/music/hotSearch' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'mg'

        try {
          // 检查是否支持热搜
          if (!musicSdk[source] || !musicSdk[source].hotSearch) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: '该音源不支持热搜功能' }))
            return
          }

          // console.log(`[HotSearch] 获取热搜: source=${source}`)
          const result = await musicSdk[source].hotSearch.getList()

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300' // 5分钟缓存
          })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error('[HotSearch] Error:', err.message)
          // Return empty array instead of 500 to keep UI stable
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify([]))
        }
        return
      }

      // [新增] 歌单分类标签 API
      if (pathname === '/api/music/songList/tags' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getTags()
          const sortList = musicSdk[source].songList.sortList
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...result, sortList }))
        } catch (err: any) {
          console.error(`[SongList Tags] Error:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单标签失败' }))
        }
        return
      }
      // [新增] 歌单列表 API
      if (pathname === '/api/music/songList/list' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const tagId = urlObj.searchParams.get('tagId') || ''
        const sortId = urlObj.searchParams.get('sortId') || 'hot'
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getList(sortId, tagId, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[SongList List] Error:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单列表失败' }))
        }
        return
      }
      // [新增] 歌单详情 API
      if (pathname === '/api/music/songList/detail' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const id = urlObj.searchParams.get('id')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!id) {
          res.writeHead(400)
          res.end('Missing id')
          return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.getListDetail(id, page)
          if (result && result.list) {
            result.list = result.list.map(normalizeSongInfo)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[SongList Detail] Error:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取歌单详情失败' }))
        }
        return
      }
      // [新增] 歌单搜索 API
      if (pathname === '/api/music/songList/search' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'wy'
        const text = urlObj.searchParams.get('text')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!text) {
          res.writeHead(400)
          res.end('Missing text')
          return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].songList) {
            throw new Error(`Source ${source} does not support songList`)
          }
          const result = await musicSdk[source].songList.search(text, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[SongList Search] Error:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '搜索歌单失败' }))
        }
        return
      }

      // [新增] 获取用户歌单 API
      if (pathname === '/api/music/songList/userPlaylist' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'tx'
        const uid = urlObj.searchParams.get('uid')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!uid) {
          res.writeHead(400)
          res.end('Missing uid')
          return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].userPlaylist) {
            throw new Error(`Source ${source} does not support userPlaylist`)
          }
          const result = await musicSdk[source].userPlaylist.getList(uid, page)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[User Playlist] Error:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取用户歌单失败' }))
        }
        return
      }

      // [新增] 排行榜 - 获取榜单列表 API
      if (pathname === '/api/music/leaderboard/boards' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'kg'
        try {
          if (!musicSdk[source] || !musicSdk[source].leaderboard) {
            throw new Error(`Source ${source} does not support leaderboard`)
          }
          const result = await musicSdk[source].leaderboard.getBoards()
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=600'
          })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[Leaderboard Boards] Error:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取排行榜列表失败' }))
        }
        return
      }

      // [新增] 排行榜 - 获取榜单内歌曲 API
      if (pathname === '/api/music/leaderboard/list' && req.method === 'GET') {
        const source = urlObj.searchParams.get('source') || 'kg'
        const bangid = urlObj.searchParams.get('bangid')
        const page = parseInt(urlObj.searchParams.get('page') || '1')
        if (!bangid) {
          res.writeHead(400); res.end('Missing bangid'); return
        }
        try {
          if (!musicSdk[source] || !musicSdk[source].leaderboard) {
            throw new Error(`Source ${source} does not support leaderboard`)
          }
          const result = await musicSdk[source].leaderboard.getList(bangid, page)
          if (result && result.list) {
            result.list = result.list.map(normalizeSongInfo)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          console.error(`[Leaderboard List] Error:`, err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || '获取排行榜歌曲失败' }))
        }
        return
      }


      // [新增] 封面 API (备用)

      // [新增] 自定义源管理 API
      // 注：此处不再进行全局强制鉴权，鉴权逻辑已下放到 customSourceHandlers 中，
      // 以便根据请求体中的 username 字段判断是否需要校验管理员密码。

      // [新增] 管理员身份验证接口
      if (pathname === '/api/custom-source/validate' && req.method === 'POST') {
        return customSourceHandlers.handleValidate(req, res)
      }

      if (pathname === '/api/custom-source/import' && req.method === 'POST') {
        return customSourceHandlers.handleImport(req, res)
      }
      if (pathname === '/api/custom-source/upload' && req.method === 'POST') {
        return customSourceHandlers.handleUpload(req, res)
      }
      if (pathname === '/api/custom-source/list' && req.method === 'GET') {
        return customSourceHandlers.handleList(req, res, 'shared')
      }
      if (pathname === '/api/custom-source/toggle' && req.method === 'POST') {
        return customSourceHandlers.handleToggle(req, res)
      }
      if (pathname === '/api/custom-source/delete' && req.method === 'POST') {
        return customSourceHandlers.handleDelete(req, res)
      }

      if (pathname === '/api/custom-source/reorder' && req.method === 'POST') {
        return customSourceHandlers.handleReorder(req, res)
      }

      // elFinder 文件管理器连接器
      // Configuration API
      // Test Proxy API
      // Logs API
      // Stats API
      // [新增] 本地备份下载 API
      // [新增] 本地备份还原 API
      // [新增] 管理重载 API
      // Restart Server API
      // File Management - List Files
      // File Management - Download File
      if (pathname === '/api/files/download' && req.method === 'GET') {
        const auth = req.headers['x-frontend-auth']
        if (!checkPlayerAuth(req)) {
          res.writeHead(401)
          res.end('Unauthorized')
          return
        }

        const filePath = urlObj.searchParams.get('path') || ''
        const fullPath = path.resolve(global.lx.dataPath, filePath)

        if (!isPathWithin(fullPath, global.lx.dataPath, false)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }

        try {
          const content = fs.readFileSync(fullPath)
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${path.basename(fullPath)}"`,
          })
          res.end(content)
        } catch (err) {
          res.writeHead(404)
          res.end('File not found')
        }
        return
      }

      // File Management - Create/Update File
      // File Management - Delete File
    }

    // Serve static files.
    const filePath = path.join(process.cwd(), 'public', pathname === '/' ? 'index.html' : pathname)
    // Prevent directory traversal.
    if (!filePath.startsWith(path.join(process.cwd(), 'public'))) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      serveStatic(req, res, filePath)
      return
    }

    res.writeHead(404)
    res.end('Not Found')
    } catch (error: any) {
      accessLog.warn(`Request failed: ${error?.message || 'Unknown error'}`)
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
      if (!res.writableEnded) res.end(JSON.stringify({ success: false, message: 'Invalid request' }))
    }
  })

  // LX Music 客户端数据同步已移除；显式拒绝遗留 WebSocket 连接。
  httpServer.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })

  httpServer.on('error', error => {
    console.log(error)
    reject(error)
  })

  httpServer.on('listening', () => {
    const addr = httpServer.address()
    // console.log(addr)
    if (!addr) {
      reject(new Error('address is null'))
      return
    }
    const bind = typeof addr == 'string' ? `pipe ${addr}` : `port ${addr.port}`
    startupLog.info(`Listening on ${ip} ${bind}`)
    resolve(null)
  })
  httpServer.listen(port, ip)
})

export const startServer = async (port: number, ip: string) => {
  // Initialize file cache settings from global config
  if (global.lx.config) {
    if (global.lx.config.downloadDir) fileCache.setDownloadDir(global.lx.config.downloadDir)
    global.lx.config['cache.namingPattern'] = fileCache.setNamingPattern(global.lx.config['cache.namingPattern'])

  }

  // 注入兼容上游客户端的歌词获取逻辑：校验主歌词时间戳，并在当前音源失败时自动切换匹配音源。
  fileCache.setLyricFetcher((songInfo: any, username?: string, allowFallback?: boolean) => (
    fetchLyricWithFallback(songInfo, username || '_open', allowFallback !== false)
  ))

  startupLog.info(`starting download server in ${process.env.NODE_ENV == 'production' ? 'production' : 'development'}`)
  const proxyEnabled = global.lx.config['proxy.all.enabled']
  const proxyAddress = formatConfigLogValue('proxy.all.address', global.lx.config['proxy.all.address'] || '')
  console.log(`[Proxy] Music SDK Proxy: ${proxyEnabled ? `Enabled (${proxyAddress})` : 'Disabled'}`)
  startupLog.info(`Music SDK Proxy: ${proxyEnabled ? `Enabled (${proxyAddress})` : 'Disabled'}`)
  try {
    await musicSdk.init()
    startupLog.info('musicSdk initialized')
  } catch (err) {
    startupLog.error('musicSdk init failed:', err)
  }

  // 初始化自定义源
  try {
    console.log('[Server] Initializing custom user APIs...')
    // 修改：不传参数，默认加载 open + 所有用户源
    await initUserApis()
    console.log('[Server] Custom user APIs initialized')
  } catch (err: any) {
    console.error('[Server] Failed to initialize user APIs:', err.message)
  }

  // Restore shared file-cache settings from SQLite before the first cache request.
  try {
    const savedSettings = getJson<Record<string, any>>('settings', 'shared', {})
    if (savedSettings.serverCacheNamingPattern) {
      const normalizedNamingPattern = fileCache.setNamingPattern(savedSettings.serverCacheNamingPattern)
      console.log(`[Server] Restored cache naming pattern from SQLite: ${normalizedNamingPattern}`)
    }
    if (savedSettings.downloadDir !== undefined) {
      fileCache.setDownloadDir(savedSettings.downloadDir)
      if (global.lx.config) global.lx.config.downloadDir = fileCache.getDownloadDir()
      console.log(`[Server] Restored download dir from settings: ${fileCache.getDownloadDir() || '(default) download'}`)
    }
  } catch (err: any) {
    console.warn('[Server] Failed to restore fileCache location:', err.message)
  }

  // Download storage is shared globally; sync its single index after settings
  // have been applied.
  void fileCache.syncCacheIndex('_open', ['music'])

  serverDownloadQueue.initialize(async task => {
    const songInfo = normalizeSongInfo(task.songInfo)
    const resolved = await resolveServerSong(songInfo, task.requestedQuality, 'shared', true)
    return {
      url: resolved.url,
      quality: resolved.quality,
      songInfo: resolved.songInfo,
      requestedSource: resolved.requestedSource,
      downloadSource: resolved.downloadSource,
      sourceName: resolved.sourceName,
    }
  })

  customSourceHandlers.setAuthChecker(checkPlayerAuth)

  playlistSubscription.initialize({
    musicSdk,
    normalizeSongInfo,
    enqueue: (_username, tasks) => serverDownloadQueue.enqueue('shared', tasks),
    getDownloadOptions: (_username) => {
      try {
        const saved = getJson<Record<string, any>>('settings', 'shared', {})
        return {
          fileNamePattern: (['name-artist', 'artist-name', 'name'].includes(saved.downloadFileNamePattern)
            ? saved.downloadFileNamePattern
            : 'name-artist') as 'name-artist' | 'artist-name' | 'name',
          cacheLyric: saved.enableServerLyricDownload !== undefined
            ? saved.enableServerLyricDownload !== false
            : saved.enableServerLyricCache !== false,
          embedMetadata: saved.enableServerMetadataEmbed !== false,
          embedCover: saved.enableServerCoverEmbed !== false,
          embedLyric: saved.enableServerLyricEmbed !== false,
          embedLyricTranslation: saved.enableServerLyricEmbedTranslation === true,
          embedLyricRoma: saved.enableServerLyricEmbedRoma === true,
          embedLyricLx: saved.enableServerLyricEmbedLx !== false,
          downloadLyricTranslation: saved.enableServerLyricDownloadTranslation === true,
          downloadLyricRoma: saved.enableServerLyricDownloadRoma === true,
          downloadLyricLx: saved.enableServerLyricDownloadLx !== false,
          downloadLyricFormat: saved.downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8',
          allowLyricSourceFallback: saved.allowLyricSourceFallback !== false,
        }
      } catch (err) {
        console.warn('[Subscription] Failed to load download settings:', err)
        return {}
      }
    },
  })

  remasterQueue.initialize(async (songInfo, requestedQuality, username) => {
    const apiUsername = username === '_open' ? 'open' : username
    const resolved = await resolveServerSong(songInfo, requestedQuality, apiUsername, true)
    return {
      url: resolved.url,
      quality: resolved.quality,
    }
  })

  await handleStartServer(port, ip).then(() => {
    console.log('download server started')
  }).catch(err => {
    console.log(err)
  })
}
