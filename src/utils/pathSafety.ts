import fs from 'node:fs'
import path from 'node:path'

/** Resolve existing ancestors too, so nonexistent children of junctions are safe. */
export const canonicalPath = (input: string): string => {
  const absolute = path.resolve(input)
  try { return fs.realpathSync(absolute) } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(absolute)
    if (parent === absolute) return absolute
    return path.join(canonicalPath(parent), path.basename(absolute))
  }
}

export const isPathWithin = (child: string, parent: string, allowEqual = true): boolean => {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child))
  return (!relative ? allowEqual : relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

export const assertSeparateDirectories = (first: string, second: string) => {
  if (isPathWithin(first, second) || isPathWithin(second, first)) {
    throw new Error('下载目录不能与服务器缓存目录相同或互相包含')
  }
}
