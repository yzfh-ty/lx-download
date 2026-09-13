import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isPathWithin } from '@/utils/pathSafety'

export interface PlaylistFiles {
  id: string
  name: string
  playlistName?: string
  directoryName?: string
  playlistFilename?: string
}

/** Merge aliases before matching: fallback IDs and linked playlist copies are one song. */
export const selectUnmatchedTracks = (groups: Array<{ keys: string[], filename?: string, matched?: boolean }>) => {
  const parents = new Map<string, string>()
  const find = (key: string): string => {
    let root = key
    while (parents.has(root) && parents.get(root) !== root) root = parents.get(root)!
    while (parents.has(key) && parents.get(key) !== key) {
      const next = parents.get(key)!
      parents.set(key, root)
      key = next
    }
    return root
  }
  for (const { keys } of groups) {
    if (!keys.length) continue
    for (const key of keys) {
      if (!parents.has(key)) parents.set(key, key)
      parents.set(find(key), find(keys[0]))
    }
  }
  const matched = new Set(groups.filter(group => group.matched && group.keys.length).map(group => find(group.keys[0])))
  const selected = new Map<string, string>()
  // Prefer the original at the shallower path; keep a stable order across scans.
  const candidates = groups.filter(group => group.filename && group.keys.length).sort((a, b) =>
    a.filename!.split('/').length - b.filename!.split('/').length || a.filename!.localeCompare(b.filename!, 'zh-CN'))
  for (const group of candidates) {
    const key = find(group.keys[0])
    if (!matched.has(key) && !selected.has(key)) selected.set(key, group.filename!)
  }
  return Array.from(selected.values()).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

const OWNER_FILE = '.lx-playlist.json'
const AUDIO = /\.(mp3|flac|m4a|ogg|opus|wav|ape|aac|wma)$/i

export const sanitizePlaylistName = (name: string, fallback = '歌单') => {
  let clean = ''
  for (const character of String(name).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^[ .]+/g, '')) {
    if ((clean + character).length > 64 || Buffer.byteLength(clean + character, 'utf8') > 140) break
    clean += character
  }
  clean = clean.replace(/[ .]+$/g, '')
  if (!clean || clean === '.' || clean === '..') clean = fallback
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(clean)) clean = '_' + clean
  return clean
}

/** Keep the suffix intact even when a title must be shortened for the filesystem. */
export const appendPlaylistSuffix = (name: string, suffix: string) => {
  const title = Array.from(sanitizePlaylistName(name))
  while (title.length && ((title.join('') + suffix).length > 64 || Buffer.byteLength(title.join('') + suffix, 'utf8') > 140)) title.pop()
  return title.join('') + suffix
}

export const availablePlaylistName = (root: string, name: string, id: string, reserved: string[] = [], current?: string) => {
  const base = sanitizePlaylistName(name)
  let candidate = base
  let count = 0
  while (reserved.some(value => value.toLowerCase() === candidate.toLowerCase()) || (candidate !== current && fs.existsSync(safePath(root, candidate)))) {
    const platformSuffix = base.match(/（[^（）]+）$/)?.[0] || ''
    const title = platformSuffix ? base.slice(0, -platformSuffix.length) : base
    candidate = appendPlaylistSuffix(title, ` (${id}${count++ ? '-' + count : ''})${platformSuffix}`)
  }
  return candidate
}

export const safePath = (root: string, relative: string) => {
  if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split(/[\\/]/).some(part => part === '..' || part.includes(':')) || /[\r\n\x00]/.test(relative)) throw new Error('无效的歌单文件路径')
  const target = path.resolve(root, relative)
  if (!isPathWithin(target, root, false)) throw new Error('歌单文件路径超出下载目录')
  // Do not follow symlinks, including ones pointing to another playlist in this root.
  let current = path.resolve(root)
  for (const part of path.relative(current, target).split(path.sep)) {
    current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('歌单路径不允许符号链接') } catch (err: any) { if (err.code !== 'ENOENT') throw err }
  }
  return target
}

export const audioExists = (root: string, relative?: string): boolean => {
  if (!relative || !AUDIO.test(relative)) return false
  try { const stat = fs.statSync(safePath(root, relative)); return stat.isFile() && stat.size > 0 } catch { return false }
}

export const audioFileIdentity = (root: string, relative: string) => {
  const stat = fs.statSync(safePath(root, relative), { bigint: true })
  return stat.ino > 0n ? `inode:${stat.dev}:${stat.ino}` : undefined
}

export const ensurePlaylistDirectory = (root: string, files: PlaylistFiles, reserved: string[] = []) => {
  fs.mkdirSync(root, { recursive: true })
  fs.accessSync(root, fs.constants.W_OK)
  if (!files.directoryName) {
    const base = sanitizePlaylistName(files.playlistName || files.name, `歌单-${files.id}`)
    const candidate = availablePlaylistName(root, base, files.id, reserved)
    files.directoryName = candidate
    files.playlistFilename = candidate + '.m3u8'
  }
  if (path.basename(files.directoryName) !== files.directoryName || /[\\/]/.test(files.directoryName)) throw new Error('无效的歌单目录名')
  const dir = safePath(root, files.directoryName)
  const owner = safePath(root, files.directoryName + '/' + OWNER_FILE)
  if (fs.existsSync(dir)) {
    if (!fs.existsSync(owner) || JSON.parse(fs.readFileSync(owner, 'utf8')).id !== files.id) throw new Error('歌单目录已被其他文件占用，请检查下载目录设置')
  } else {
    fs.mkdirSync(dir)
    fs.writeFileSync(owner, JSON.stringify({ id: files.id }), { flag: 'wx' })
  }
  files.playlistFilename ||= files.directoryName + '.m3u8'
  fs.accessSync(dir, fs.constants.W_OK)
  if (path.basename(files.playlistFilename) !== files.playlistFilename || /[\\/]/.test(files.playlistFilename) || !files.playlistFilename.endsWith('.m3u8')) throw new Error('无效的 M3U8 文件名')
  return dir
}

// Each mapping is persisted with the remote snapshot; never guess an audio extension.
export const materializeTrack = (root: string, directory: string, key: string, sourceRelative: string, previous?: string, lyricRelative?: string) => {
  if (previous?.startsWith(directory + '/') && audioExists(root, previous)) return previous
  if (!audioExists(root, sourceRelative)) return undefined
  const source = safePath(root, sourceRelative)
  if (path.dirname(source) === safePath(root, directory)) return sourceRelative.replace(/\\/g, '/')
  const original = path.basename(source)
  const ext = path.extname(original)
  const stem = sanitizePlaylistName(path.basename(original, ext), '歌曲')
  const suffix = createHash('sha256').update(key).digest('hex').slice(0, 10)
  let relative = directory + '/' + stem + ext
  // A file without our persisted mapping may belong to the user: don't overwrite it.
  let count = 0
  while (fs.existsSync(safePath(root, relative))) relative = `${directory}/${stem} (${suffix}${count++ ? '-' + count : ''})${ext}`
  const target = safePath(root, relative)
  try { fs.linkSync(source, target) } catch (err: any) {
    if (err.code === 'EEXIST') throw err
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  }
  try {
    const lyric = lyricRelative || sourceRelative.slice(0, -ext.length) + '.lrc'
    const lyricSource = safePath(root, lyric)
    const lyricTarget = safePath(root, relative.slice(0, -ext.length) + '.lrc')
    if (fs.existsSync(lyricSource) && !fs.existsSync(lyricTarget)) {
      // Sidecar failure must not discard the audio mapping and create duplicate files on retry.
      fs.copyFileSync(lyricSource, lyricTarget, fs.constants.COPYFILE_EXCL)
    }
  } catch (err: any) { console.warn('[PlaylistSync] Failed to copy lyric:', err?.message) }
  return relative
}

export const writePlaylistAtomic = (root: string, files: PlaylistFiles, tracks: string[]) => {
  const relative = files.directoryName + '/' + files.playlistFilename
  const target = safePath(root, relative)
  const entries = tracks.filter(track => audioExists(root, track)).map(track => './' + path.relative(path.dirname(target), safePath(root, track)).replace(/\\/g, '/'))
  const content = '#EXTM3U\n# 由 lx-download 自动生成，请勿手工编辑\n' + entries.map(entry => entry + '\n').join('')
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) return false
  const temporary = safePath(root, relative + '.' + randomUUID() + '.tmp')
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
    const modified = fs.existsSync(target) ? Math.max(Date.now(), fs.statSync(target).mtimeMs + 1) : Date.now()
    fs.utimesSync(temporary, modified / 1000, modified / 1000)
    fs.renameSync(temporary, target)
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  return true
}

export const renamePlaylistDirectory = (root: string, files: PlaylistFiles, name: string, reserved: string[]) => {
  ensurePlaylistDirectory(root, files)
  const directory = sanitizePlaylistName(name, `歌单-${files.id}`)
  if (directory === files.directoryName) return
  const oldDir = safePath(root, files.directoryName!)
  const nextDir = safePath(root, directory)
  if (reserved.some(value => value.toLowerCase() === directory.toLowerCase()) || fs.existsSync(nextDir)) throw new Error('同名歌单目录已存在，无法重命名')
  const oldPlaylist = safePath(root, files.directoryName + '/' + files.playlistFilename)
  const nextFilename = directory + '.m3u8'
  const renamedPlaylist = safePath(root, files.directoryName + '/' + nextFilename)
  if (fs.existsSync(renamedPlaylist)) throw new Error('同名歌单文件已存在')
  const hasPlaylist = fs.existsSync(oldPlaylist)
  if (hasPlaylist) fs.renameSync(oldPlaylist, renamedPlaylist)
  try { fs.renameSync(oldDir, nextDir) } catch (err) {
    if (hasPlaylist) fs.renameSync(renamedPlaylist, oldPlaylist)
    throw err
  }
  files.directoryName = directory
  files.playlistFilename = nextFilename
}
