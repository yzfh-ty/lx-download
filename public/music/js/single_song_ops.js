function getSongQualitySize(song, quality) {
    const maps = [
        song?._types,
        song?._qualitys,
        song?.meta?._types,
        song?.meta?._qualitys
    ];
    for (const map of maps) {
        const size = map?.[quality]?.size;
        if (size && size !== '0 B') return size;
    }

    const lists = [
        song?.types,
        song?.qualitys,
        song?.meta?.types,
        song?.meta?.qualitys
    ];
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        const size = list.find(t => (t?.type || t) === quality)?.size;
        if (size && size !== '0 B') return size;
    }

    return null;
}

const remoteQualitySizeCache = new Map();

const QUALITY_SOURCE_LABELS = {
    tx: 'TX',
    wy: 'WY',
    kw: 'KW',
    kg: 'KG',
    mg: 'MG'
};

function getSongQualityCacheKey(song, quality) {
    const meta = song?.meta || {};
    const source = song?.source || meta.source || '';
    const id = song?.songmid || song?.songId || song?.id || meta.songId || meta.songmid || '';
    return `${source}:${id}:${quality}`;
}

function getSongQualityResolvedSource(song, quality) {
    return song?._resolvedQualitySources?.[quality] || null;
}

function applySongQualityProbe(song, quality, probe) {
    if (!song || !quality || !probe) return;

    const size = probe.size || null;
    const source = probe.source || null;

    // Older favorites only contain the qualities known when they were saved.
    // Always create a canonical entry so newly supported qualities can be read
    // back by getSongQualitySize after the remote probe succeeds.
    if (!song._types || typeof song._types !== 'object' || Array.isArray(song._types)) {
        song._types = {};
    }
    if (!song._types[quality] || typeof song._types[quality] !== 'object') {
        song._types[quality] = {};
    }
    if (size) song._types[quality].size = size;

    if (source) {
        if (!song._resolvedQualitySources || typeof song._resolvedQualitySources !== 'object') {
            song._resolvedQualitySources = {};
        }
        song._resolvedQualitySources[quality] = source;
    }

    const maps = [song._types, song._qualitys, song.meta?._types, song.meta?._qualitys];
    maps.forEach(map => {
        if (!map?.[quality]) return;
        if (size) map[quality].size = size;
        if (source) map[quality].resolvedSource = source;
    });

    const lists = [song.types, song.qualitys, song.meta?.types, song.meta?.qualitys];
    lists.forEach(list => {
        if (!Array.isArray(list)) return;
        const item = list.find(t => (t?.type || t) === quality);
        if (item && typeof item === 'object') {
            if (size) item.size = size;
            if (source) item.resolvedSource = source;
        }
    });
}

async function fetchRemoteQualitySize(song, quality) {
    const cacheKey = getSongQualityCacheKey(song, quality);
    if (remoteQualitySizeCache.has(cacheKey)) {
        const cachedProbe = remoteQualitySizeCache.get(cacheKey);
        applySongQualityProbe(song, quality, cachedProbe);
        return cachedProbe;
    }

    try {
        const authHeaders = typeof getUserAuthHeaders === 'function' ? getUserAuthHeaders() : {};
        const res = await fetch('/api/music/quality/size', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            },
            body: JSON.stringify({ songInfo: song, quality })
        });
        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        const probe = {
            size: data?.size || null,
            bytes: Number(data?.bytes) || 0,
            source: data?.source || null,
            resolvedQuality: data?.type || quality,
            sourceName: data?.sourceName || ''
        };
        applySongQualityProbe(song, quality, probe);
        remoteQualitySizeCache.set(cacheKey, probe);
        return probe;
    } catch (e) {
        console.warn(`[QualitySize] 获取 ${quality} 真实大小失败:`, e);
        // Do not make a transient source/network failure permanent for this tab.
        remoteQualitySizeCache.delete(cacheKey);
        return null;
    }
}

async function buildQualityOptionLabels(song, qualities) {
    const unresolvedQualities = qualities.filter(q => !getSongQualitySize(song, q) || !getSongQualityResolvedSource(song, q));
    if (unresolvedQualities.length > 0) {
        window.showLoading?.('正在读取音质大小...');
        try {
            await Promise.all(unresolvedQualities.map(q => fetchRemoteQualitySize(song, q)));
        } finally {
            window.hideLoading?.();
        }
    }

    return qualities.map(q => getQualityOptionLabel(song, q));
}

function getQualityOptionLabel(song, quality) {
    const name = window.QualityManager ? window.QualityManager.getQualityDisplayName(quality) : quality;
    const size = getSongQualitySize(song, quality) || '未知大小';
    const source = getSongQualityResolvedSource(song, quality);
    const sourceLabel = source ? (QUALITY_SOURCE_LABELS[source] || String(source).toUpperCase()) : '';
    return `${name} [${size}${sourceLabel ? ` · ${sourceLabel}` : ''}]`;
}

function getSelectableQualityOrder(song = null) {
    if (song && window.QualityManager?.getSelectableQualities) {
        return window.QualityManager.getSelectableQualities(song);
    }
    return window.QualityManager?.QUALITY_ORDER_LOW_TO_HIGH ||
        (window.QualityManager?.QUALITY_PRIORITY ? [...window.QualityManager.QUALITY_PRIORITY].reverse() : ['128k', '320k', 'flac', 'flac24bit']);
}

/**
 * 辅助函数：根据设置下载歌词文件或嵌入音频
 * @param {Object} song 歌曲信息
 * @param {String} quality 音质
 * @param {Boolean} force 是否强制同步（忽略设置开关，用于手动点击按钮）
 */
async function requestServerLyricCache(song, quality = null, force = false) {
    if (!force && typeof settings !== 'undefined' && settings.enableServerLyricCache === false && settings.enableServerLyricEmbed === false) return false;

    console.log(`[Lyric] 尝试下载歌词文件或嵌入音频: ${song.name} (${quality || 'auto'})`);
    try {
        const meta = song.meta || {};
        const source = song.source || meta.source || '';
        const songmid = song.songmid || song.songId || meta.songmid || meta.songId || song.id || '';
        const nameValue = song.name || meta.songName || '';
        const singerValue = song.singer || meta.singerName || '';
        const name = encodeURIComponent(nameValue);
        const singer = encodeURIComponent(singerValue);
        const hash = song.hash || meta.hash || '';
        const interval = song.interval || meta.interval || '';

        if (!source || !songmid) {
            console.warn('[Lyric] 歌曲缺少必要字段，跳过歌词处理:', song);
            return false;
        }

        // 1. 先尝试获取歌词数据
        const allowSourceSwitch = typeof settings === 'undefined' || settings.enableAutoSwitchApiSource !== false;
        const lyricUrl = `/api/music/lyric?source=${source}&songmid=${songmid}&name=${name}&singer=${singer}&hash=${hash}&interval=${interval}&allowSourceSwitch=${allowSourceSwitch ? '1' : '0'}`;
        const lRes = await fetch(lyricUrl);
        if (!lRes.ok) return false;
        const lyricInfo = await lRes.json();

        if (!lyricInfo || (!lyricInfo.lyric && !lyricInfo.lrc)) return false;

        // 2. 将歌词推送到服务器缓存接口
        const cacheUrl = `/api/music/cache/lyric`;
        const headers = {
            'Content-Type': 'application/json',
            ...getUserAuthHeaders()
        };

        // 构建包含音质信息的 songInfo
        const songInfoForCache = {
            ...song,
            source,
            songmid,
            songId: song.songId || meta.songId || songmid,
            name: nameValue,
            singer: singerValue,
            hash,
            interval
        };
        if (quality) songInfoForCache.quality = quality;

        const cacheRes = await fetch(cacheUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                songInfo: songInfoForCache,
                lyricsObj: lyricInfo,
                quality,
                embedLyric: typeof settings === 'undefined' || settings.enableServerLyricEmbed !== false,
                downloadLyric: typeof settings === 'undefined' || settings.enableServerLyricDownload !== false,
                embedLyricTranslation: typeof settings !== 'undefined' && settings.enableServerLyricEmbedTranslation === true,
                embedLyricRoma: typeof settings !== 'undefined' && settings.enableServerLyricEmbedRoma === true,
                embedLyricLx: typeof settings === 'undefined' || settings.enableServerLyricEmbedLx !== false,
                downloadLyricTranslation: typeof settings !== 'undefined' && settings.enableServerLyricDownloadTranslation === true,
                downloadLyricRoma: typeof settings !== 'undefined' && settings.enableServerLyricDownloadRoma === true,
                downloadLyricLx: typeof settings === 'undefined' || settings.enableServerLyricDownloadLx !== false,
                downloadLyricFormat: typeof settings !== 'undefined' && settings.downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8',
                allowLyricSourceFallback: allowSourceSwitch
            })
        });
        if (!cacheRes.ok) throw new Error('Lyric cache request failed');
        const cacheResult = await cacheRes.json().catch(() => ({}));
        if (cacheResult.embedded === false && cacheResult.embedError) {
            console.warn(`[Lyric] 歌词已缓存但自动嵌入失败: ${song.name}`, cacheResult.embedError);
        } else if (cacheResult.embedded) {
            console.log(`[Lyric] 歌曲下载触发歌词文件保存并自动嵌入成功: ${song.name}`);
        } else {
            console.log(`[Lyric] 歌曲下载触发的歌词文件处理成功: ${song.name}`);
        }
        return true;
    } catch (e) {
        console.warn(`[Lyric] 自动处理歌词失败: ${song.name}`, e);
        if (force) throw e;
        return false;
    }
}

// Placeholder for download function
// Download single song
// Download single song
async function downloadSong(songOrId, forceQuality = null, suppressAlerts = false) {
    let song;
    if (typeof songOrId === 'object') {
        song = songOrId;
    } else {
        if (!currentPlaylist) return false;
        song = currentPlaylist.find(s => s.id === songOrId);
    }

    if (!song) {
        if (!suppressAlerts) showError('未找到歌曲信息');
        return false;
    }

    // 单曲下载统一使用设置页音质，服务端队列负责按优先级自动降级。
    const targetQuality = window.settings?.preferredQuality || forceQuality || 'flac24bit';
    try {
        if (!window.SystemDownloadManager) {
            showError('下载管理器未就绪');
            return false;
        }
        await window.SystemDownloadManager.addTasks([{
            ...song,
            taskId: 'server_' + (song.id || song.songmid),
            isServer: true,
            quality: targetQuality
        }]);
        if (!suppressAlerts) showInfo(`已添加服务器下载任务（最高音质，失败自动降级）`);
        return true;
    } catch (e) {
        if (!suppressAlerts) showError('操作失败: ' + e.message);
        return false;
    }
}

// Batch download function shared by list selection and album downloads.
async function batchDownloadSongs(songsToDownload, batchOptions = {}) {
    if (!Array.isArray(songsToDownload) || songsToDownload.length === 0) {
        showError(batchOptions.emptyMessage || '未找到要下载的歌曲');
        return false;
    }

    // 单曲无论从哪个入口触发，都走服务器持久化队列，不显示批量选择弹窗。
    if (songsToDownload.length === 1 && typeof window.downloadSong === 'function') {
        return window.downloadSong(songsToDownload[0], null, true);
    }

    const clearSelection = batchOptions.clearSelection !== false;
    const selectionLabel = batchOptions.selectionLabel || `选择了 ${songsToDownload.length} 首歌曲`;
    // 批量下载统一进入服务端持久化队列。
    const availableQualities = getSelectableQualityOrder();
    const qualityDisplayNames = availableQualities.map(q => window.QualityManager ? window.QualityManager.getQualityDisplayName(q) : q);
    const selectedQualityDisplay = await showOptions('选择全局缓存音质', `请选择批量请求服务器缓存的音质，下载歌曲的音质将取不超过该音质的最大音质`, qualityDisplayNames);

    if (!selectedQualityDisplay) return false;
    const selectedQualityIndex = qualityDisplayNames.indexOf(selectedQualityDisplay);
    const targetQuality = availableQualities[selectedQualityIndex];

    if (isPublic && enablePublicRestriction && !isServerCacheAllowed && !isAdmin) {
        showError('权限不足，无法下载到服务器。');
        if (typeof window.handleAdminAuth === 'function') {
            const authorized = await window.handleAdminAuth('下载到服务器需要管理员身份');
            if (!authorized) return false;
        } else {
            return false;
        }
    }

    if (!window.SystemDownloadManager) {
        showError('下载管理器未就绪');
        return false;
    }

    const tasks = songsToDownload.map(s => ({
        ...s,
        taskId: 'server_' + (s.id || s.songmid),
        isServer: true,
        quality: targetQuality
    }));
    await window.SystemDownloadManager.addTasks(tasks);

    if (clearSelection) {
        if (typeof exitBatchMode === 'function') exitBatchMode();
        else if (typeof deselectAll === 'function') deselectAll();
    }
    showInfo(`已将 ${songsToDownload.length} 首歌曲加入服务器下载队列`);
    return true;
}

async function batchDownloadFromList() {
    if (selectedItems.size === 0) {
        showError('请先选择要下载的歌曲');
        return false;
    }

    // Convert IDs to Songs
    const songsToDownload = [];
    const findSong = (list, id) => list.find(s => String(s.id) === String(id));

    selectedItems.forEach(id => {
        let song = null;
        if (selectedSongObjects && selectedSongObjects.has(id)) song = selectedSongObjects.get(id);
        if (!song && typeof viewingPlaylist !== 'undefined' && viewingPlaylist) song = findSong(viewingPlaylist, id);
        if (!song && currentPlaylist) song = findSong(currentPlaylist, id);
        if (song) songsToDownload.push(song);
    });

    if (songsToDownload.length === 0) {
        showError('未找到选中歌曲的详细信息');
        return false;
    }

    return batchDownloadSongs(songsToDownload);
}

// Export functions
window.downloadSong = downloadSong;
window.batchDownloadSongs = batchDownloadSongs;
window.batchDownloadFromList = batchDownloadFromList;
window.requestServerLyricCache = requestServerLyricCache;
