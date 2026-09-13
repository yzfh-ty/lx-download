export const detectImageMime = (data: Buffer | Uint8Array) => {
    const buffer = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif'
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
    return null
}

// music-tag-native's MetaPicture.data getter retains native memory on repeated
// reads. Parse cover bytes in JavaScript so normal Buffer GC owns their lifetime.
export const readEmbeddedCover = async (filePath: string): Promise<{ data: Buffer; mime: string } | null> => {
    try {
        const { parseFile } = await import('music-metadata')
        const metadata = await parseFile(filePath, { duration: false, skipCovers: false })
        for (const picture of metadata.common.picture || []) {
            const mime = detectImageMime(picture.data)
            if (mime) return { data: Buffer.from(picture.data), mime }
        }
    } catch {
        // Missing, unsupported or damaged files can still use a cached/remote cover.
    }
    return null
}
