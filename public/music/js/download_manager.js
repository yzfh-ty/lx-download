/**
 * Download Manager for LX Server Web Frontend
 * Manages parallel downloads, progress tracking, pausing, resuming, retries using Fetch + ReadableStream.
 */

class DownloadManager {
    constructor() {
        this.tasks = []; // Queue of tasks
        this.maxConcurrent = this.normalizeConcurrency(window.settings?.downloadConcurrency);
        this.activeCount = 0; // Currently active (local downloading + triggered server tasks)

        // UI Elements
        this.drawer = document.getElementById('view-downloads');
        this.listContainer = document.getElementById('download-list-container');
        this.globalSpeedEl = document.getElementById('download-global-speed');
        this.progressTextEl = document.getElementById('download-progress-text');
        this.renderBuffer = 12;
        this.estimatedTaskHeight = 92;
        this.renderedRange = { start: 0, end: 0 };
        this.filterState = {
            keyword: '',
            status: 'all',
            source: 'all'
        };
        this.isFilterPanelOpen = false;
        this.filterStorageKey = 'lx_download_filters';
        this.scrollRenderRaf = null;
        this.serverPollInFlight = false;
        this.serverQueueSyncInFlight = false;
        this.serverQueuePending = false;
        this.serverQueueLoaded = false;

        // Speed calculation
        this.lastTotalBytes = 0;
        this.lastTime = Date.now();
        this.speedInterval = setInterval(() => this.updateGlobalSpeed(), 1000);

        // [New] Poll for server-side caching progress
        this.serverPollInterval = setInterval(() => this.pollServerProgress(), 2000);

        if (this.listContainer) {
            this.listContainer.addEventListener('scroll', () => this.scheduleScrollRender());
        }

        this.loadFilters();
        this.updateFilterControls();
        // Restore tasks from sessionStorage
        this.restoreTasks();
        setTimeout(() => this.syncServerConcurrency(), 300);
        setTimeout(() => this.syncServerQueue(true), 500);
    }

    async mapWithConcurrency(items, limit, mapper) {
        const results = new Array(items.length);
        let nextIndex = 0;
        const workerCount = Math.min(limit, items.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await mapper(items[index], index);
            }
        });
        await Promise.all(workers);
        return results;
    }

    // Update max concurrency limit dynamically
    updateMaxConcurrent(value) {
        this.maxConcurrent = this.normalizeConcurrency(value);
        console.log('[DownloadManager] Concurrency limit updated to:', this.maxConcurrent);
        this.syncServerConcurrency();
        this.processQueue();
    }

    async syncServerConcurrency() {
        try {
            await this.requestServerQueue('/api/music/cache/queue/concurrency', { concurrency: this.maxConcurrent });
        } catch (error) {
            console.warn('[DownloadManager] Failed to sync server concurrency:', error);
        }
    }

    normalizeConcurrency(value) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) return 3;
        return Math.min(5, Math.max(1, parsed));
    }

    getServerQueueHeaders() {
        return { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };
    }

    async requestServerQueue(path, body) {
        const options = { method: body === undefined ? 'GET' : 'POST', headers: this.getServerQueueHeaders() };
        if (body !== undefined) options.body = JSON.stringify(body);
        const response = await fetch(path, options);
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.success === false) throw new Error(result.message || `HTTP ${response.status}`);
        return result.data;
    }

    async enqueueServerTasks(tasks) {
        if (!tasks.length) return;
        this.serverQueuePending = true;
        try {
            const headers = this.getServerQueueHeaders();
            const payload = {
                concurrency: this.maxConcurrent,
                tasks: tasks.map(task => ({
                    id: task.id,
                    songInfo: this.getSongInfoForServer(task.song),
                    quality: task.quality,
                    fileNamePattern: window.settings?.downloadFileNamePattern || 'name-artist',
                    cacheLyric: window.settings?.enableServerLyricDownload !== false,
                    embedMetadata: window.settings?.enableServerMetadataEmbed !== false,
                    embedCover: window.settings?.enableServerCoverEmbed !== false,
                    embedLyric: window.settings?.enableServerLyricEmbed !== false,
                    embedLyricTranslation: window.settings?.enableServerLyricEmbedTranslation === true,
                    embedLyricRoma: window.settings?.enableServerLyricEmbedRoma === true,
                    embedLyricLx: window.settings?.enableServerLyricEmbedLx !== false,
                    downloadLyricTranslation: window.settings?.enableServerLyricDownloadTranslation === true,
                    downloadLyricRoma: window.settings?.enableServerLyricDownloadRoma === true,
                    downloadLyricLx: window.settings?.enableServerLyricDownloadLx !== false,
                    downloadLyricFormat: window.settings?.downloadLyricFormat === 'gbk' ? 'gbk' : 'utf8',
                    allowLyricSourceFallback: window.settings?.enableAutoSwitchApiSource !== false,
                }))
            };
            if (headers['x-frontend-auth'] && window.settings?.serverCacheNamingPattern) {
                payload.namingPattern = window.settings.serverCacheNamingPattern;
            }
            await this.requestServerQueue('/api/music/cache/queue', payload);
            tasks.forEach(task => {
                task.serverManaged = true;
                task.serverQueueRegistered = true;
                task.serverQueueId = task.id;
                task.status = 'waiting';
                task.errorMsg = '';
            });
            await this.syncServerQueue(true);
        } catch (error) {
            tasks.forEach(task => {
                task.serverQueueRegistered = false;
                task.status = 'error';
                task.errorMsg = error.message || '服务器队列登记失败';
            });
            this.renderList();
            this.saveTasks();
        } finally {
            this.serverQueuePending = false;
        }
    }

    async syncServerQueue(render = false) {
        if (this.serverQueueSyncInFlight) return;
        this.serverQueueSyncInFlight = true;
        try {
            const items = await this.requestServerQueue('/api/music/cache/queue');
            if (!Array.isArray(items)) return;
            const remoteIds = new Set();
            const updatedTasks = [];
            items.forEach(item => {
                remoteIds.add(item.id);
                let task = this.tasks.find(t => t.isServer && (t.serverQueueId === item.id || t.id === item.id));
                if (!task) {
                    task = {
                        id: item.id,
                        song: item.songInfo || {},
                        isServer: true,
                        serverManaged: true,
                        serverQueueRegistered: true,
                        serverQueueId: item.id,
                        serverSongKey: item.songKey || '',
                        quality: item.quality || item.requestedQuality || '',
                        status: item.status || 'waiting',
                        progress: item.progress || 0,
                        downloadedBytes: item.received || 0,
                        totalBytes: item.total || 0,
                        speed: item.speed || 0,
                        errorMsg: item.errorMsg || '',
                        retryCount: 0,
                        maxRetries: 2
                    };
                    this.tasks.push(task);
                } else {
                    task.song = item.songInfo || task.song;
                    task.serverManaged = true;
                    task.serverQueueRegistered = true;
                    task.serverQueueId = item.id;
                    task.serverSongKey = item.songKey || task.serverSongKey;
                    task.quality = item.quality || task.quality;
                    task.status = item.status || task.status;
                    task.progress = item.progress || 0;
                    task.downloadedBytes = item.received || 0;
                    task.totalBytes = item.total || 0;
                    task.speed = item.speed || 0;
                    task.errorMsg = item.errorMsg || '';
                }
                updatedTasks.push(task);
            });
            if (!this.serverQueuePending) {
                this.tasks = this.tasks.filter(task => !task.serverManaged || remoteIds.has(task.serverQueueId || task.id));
            }
            this.serverQueueLoaded = true;
            if (render) this.renderList();
            else updatedTasks.forEach(task => this.renderTask(task));
            this.saveTasks();
        } catch (error) {
            console.warn('[DownloadManager] Failed to sync server queue:', error);
        } finally {
            this.serverQueueSyncInFlight = false;
        }
    }

    normalizeServerSongId(songInfo) {
        let id = String(songInfo?.songmid || songInfo?.songId || songInfo?.id || '');
        const source = songInfo?.source || 'unknown';
        if (id && !id.includes('_') && source !== 'unknown') {
            id = `${source}_${id}`;
        }
        return id;
    }

    getSongIdentity(songInfo) {
        const meta = songInfo?.meta || {};
        const source = songInfo?.source || meta.source || 'unknown';
        const id = songInfo?.songmid || songInfo?.songId || meta.songmid || meta.songId ||
            songInfo?.id || songInfo?.hash || songInfo?.copyrightId || songInfo?.mid ||
            songInfo?.mediaMid || songInfo?.strMediaMid;
        if (id !== undefined && id !== null && id !== '') return `${source}:${id}`;

        return `${source}:${songInfo?.name || ''}:${songInfo?.singer || ''}:${songInfo?.albumName || ''}:${songInfo?.interval || ''}`;
    }

    getServerSongKey(songInfo, quality) {
        return `${this.normalizeServerSongId(songInfo)}_${quality || 'unknown'}`;
    }

    getTaskServerSongKey(task) {
        if (!task) return '';
        if (task.serverSongKey) return task.serverSongKey;
        const key = this.getServerSongKey(task.song || {}, task.quality);
        if (key && !key.startsWith('_')) return key;
        return task.id ? task.id.replace(/^server_(batch_)?/, '') : '';
    }

    createTaskId(prefix = 'dl') {
        const cryptoObj = window.crypto || window.msCrypto;
        if (cryptoObj?.randomUUID) return `${prefix}_${cryptoObj.randomUUID()}`;
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    async pollServerProgress() {
        if (this.serverPollInFlight) return;
        this.serverPollInFlight = true;
        try {
            await this.syncServerQueue(false);
        } catch (e) {
            console.error('[DownloadManager] Server queue poll error:', e);
        } finally {
            this.serverPollInFlight = false;
        }
    }

    // [New] 检测任务歌词是否存在
    async checkTaskLyric(task) {
        if (!task || !task.isServer || task.status !== 'finished') return;

        // [优化] 如果已经有结果，或者重试超过 3 次，则不再请求
        if ((task.hasLyric === true || task.hasLyric === false) || (task.lyricRetryCount || 0) >= 3) return;

        try {
            // 记录重试次数
            task.lyricRetryCount = (task.lyricRetryCount || 0) + 1;

            // 已完成的历史任务可能已有 .lrc，但音频标签仍未写入。
            // 开启嵌入时先走“获取歌词 + 保存 + 写入标签”的完整流程，不能只检查 .lrc 是否存在。
            if (window.settings?.enableServerLyricEmbed !== false && window.requestServerLyricCache) {
                const synced = await window.requestServerLyricCache(task.song, task.quality);
                if (synced) {
                    task.hasLyric = true;
                    this.renderTask(task);
                    this.saveTasks();
                    return;
                }
            }

            const song = task.song || {};
            const meta = song.meta || {};
            const source = song.source || meta.source || '';
            const songmid = song.songmid || song.songId || meta.songmid || meta.songId || song.id || '';
            const songId = song.id || song.songId || meta.songId || songmid;
            const url = `/api/music/cache/lyric?source=${encodeURIComponent(source)}&songmid=${encodeURIComponent(songmid)}&songId=${encodeURIComponent(songId || '')}&name=${encodeURIComponent(song.name || meta.songName || '')}&singer=${encodeURIComponent(song.singer || meta.singerName || '')}`;

            // [修复] 补全认证请求头
            const headers = {
                'Content-Type': 'application/json',
                ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
            };

            const username = 'shared';
            if (username && !headers['x-user-name']) headers['x-user-name'] = username;

            const resp = await fetch(url, { headers });
            if (resp.ok) {
                task.hasLyric = true;
            } else if (resp.status === 404) {
                // 旧任务可能已经下载完成，但历史流程只保存了音频没有嵌入歌词。
                // 开启自动嵌入时，补取歌词并让服务端同时写入音频标签。
                if (window.settings?.enableServerLyricEmbed !== false && window.requestServerLyricCache) {
                    const synced = await window.requestServerLyricCache(task.song, task.quality);
                    task.hasLyric = synced ? true : false;
                } else {
                    task.hasLyric = false;
                }
            } else {
                // 发生非 404 错误（如 401/500/网络错误）时才重置状态以便下次重试（受次数限制）
                task.hasLyric = undefined;
            }
            this.renderTask(task);
            this.saveTasks();
        } catch (e) {
            console.warn('[DownloadManager] Failed to check lyric cache:', task.id, e);
            task.hasLyric = undefined;
        }
    }

    // [New] 手动重试下载歌词
    async retryLyric(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || !task.isServer) return;

        console.log('[DownloadManager] Retrying lyric sync for:', task.song.name);
        if (window.requestServerLyricCache) {
            task.hasLyric = 'checking';
            this.renderTask(task);

            try {
                const synced = await window.requestServerLyricCache(task.song, task.quality, true); // 强制补全
                if (!synced) throw new Error('No lyric data available');
                if (window.showSuccess) window.showSuccess(`已成功补全歌词: ${task.song.name}`);
                // 再次检查
                setTimeout(() => this.checkTaskLyric(task), 1500);
            } catch (e) {
                task.hasLyric = false;
                this.renderTask(task);
                this.saveTasks();
                if (window.showError) window.showError(`补全歌词失败: ${task.song.name}`);
            }
        }
    }

    // [New] 一键重试所有下载面板中缺失的歌词
    async retryAllLyrics() {
        const missingTasks = this.tasks.filter(t => t.isServer && t.status === 'finished' && t.hasLyric === false);
        if (missingTasks.length === 0) {
            if (window.showInfo) window.showInfo('没有缺失歌词的任务');
            return;
        }

        if (window.showInfo) window.showInfo(`正在尝试补全 ${missingTasks.length} 首歌曲的歌词...`);

        // 串行下载，避免并发过大
        for (const task of missingTasks) {
            await this.retryLyric(task.id);
            // 稍微等待一下
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Toggle drawer
    toggleDrawer() {
        // 下载管理已是整页视图：确保其可见即可
        if (typeof switchTab === 'function') switchTab('downloads');
    }

    toggleFilterPanel() {
        this.isFilterPanelOpen = !this.isFilterPanelOpen;
        const panel = document.getElementById('download-filter-panel');
        const button = document.getElementById('download-filter-toggle');
        if (panel) panel.classList.toggle('hidden', !this.isFilterPanelOpen);
        if (button) button.classList.toggle('t-bg-main', this.isFilterPanelOpen);
    }

    loadFilters() {
        try {
            const cached = localStorage.getItem(this.filterStorageKey);
            if (!cached) return;
            const saved = JSON.parse(cached);
            if (!saved || typeof saved !== 'object') return;
            this.filterState = {
                keyword: typeof saved.keyword === 'string' ? saved.keyword : '',
                status: ['all', 'active', 'waiting', 'paused', 'error', 'completed'].includes(saved.status) ? saved.status : 'all',
                source: typeof saved.source === 'string' ? saved.source : 'all'
            };
        } catch (error) {
            console.warn('[DownloadManager] Failed to load filters:', error);
        }
    }

    saveFilters() {
        try {
            localStorage.setItem(this.filterStorageKey, JSON.stringify(this.filterState));
        } catch (error) {
            console.warn('[DownloadManager] Failed to save filters:', error);
        }
    }

    getTaskSearchText(task) {
        const song = task?.song || {};
        return [song.name, song.songName, song.singer, song.singerName, song.albumName, song.album?.name, task?.errorMsg]
            .filter(Boolean).join(' ').toLocaleLowerCase();
    }

    matchesTaskFilter(task) {
        const { keyword, status, source } = this.filterState;
        if (keyword && !this.getTaskSearchText(task).includes(keyword.toLocaleLowerCase())) return false;

        const taskStatus = task.status === 'starting' ? 'waiting' : task.status;
        if (status === 'active' && !['downloading', 'tagging'].includes(taskStatus)) return false;
        if (status === 'waiting' && taskStatus !== 'waiting') return false;
        if (status === 'paused' && taskStatus !== 'paused') return false;
        if (status === 'error' && taskStatus !== 'error') return false;
        if (status === 'completed' && !['finished', 'exists'].includes(taskStatus)) return false;

        if (source !== 'all' && (task.song?.source || 'unknown') !== source) return false;
        return true;
    }

    getFilteredTasks() {
        return this.tasks.filter(task => this.matchesTaskFilter(task));
    }

    getFilterCount() {
        const { keyword, status, source } = this.filterState;
        return (keyword ? 1 : 0) + (status !== 'all' ? 1 : 0) + (source !== 'all' ? 1 : 0);
    }

    updateFilterControls() {
        const keyword = document.getElementById('download-filter-keyword');
        const status = document.getElementById('download-filter-status');
        const source = document.getElementById('download-filter-source');
        if (keyword && keyword.value !== this.filterState.keyword) keyword.value = this.filterState.keyword;
        if (status) status.value = this.filterState.status;

        if (source) {
            const currentSource = this.filterState.source;
            const sourceMap = { wy: '网易', tx: 'QQ', kg: '酷狗', kw: '酷我', mg: '咪咕', unknown: '未知' };
            const sources = [...new Set(this.tasks.map(task => task.song?.source || 'unknown'))].sort();
            source.innerHTML = '<option value="all">全部音源</option>' + sources.map(value =>
                `<option value="${this.escapeHtml(value)}">${this.escapeHtml(sourceMap[value] || value)}</option>`
            ).join('');
            // 没有任务时先保留持久化筛选，等待服务端队列同步后再校验音源是否存在。
            if (sources.length === 0) {
                source.value = 'all';
            } else {
                source.value = sources.includes(currentSource) ? currentSource : 'all';
                if (this.filterState.source !== source.value) this.filterState.source = source.value;
            }
        }

        const count = this.getFilterCount();
        const badge = document.getElementById('download-filter-badge');
        if (badge) {
            badge.textContent = String(count);
            badge.classList.toggle('hidden', count === 0);
        }
        const result = document.getElementById('download-filter-result');
        if (result) result.textContent = count > 0 ? `显示 ${this.getFilteredTasks().length}/${this.tasks.length}` : '';
    }

    applyFilters() {
        const keyword = document.getElementById('download-filter-keyword');
        const status = document.getElementById('download-filter-status');
        const source = document.getElementById('download-filter-source');
        this.filterState.keyword = keyword?.value.trim() || '';
        this.filterState.status = status?.value || 'all';
        this.filterState.source = source?.value || 'all';
        this.saveFilters();
        if (this.listContainer) this.listContainer.scrollTop = 0;
        this.renderList();
    }

    resetFilters() {
        this.filterState = { keyword: '', status: 'all', source: 'all' };
        this.saveFilters();
        this.updateFilterControls();
        if (this.listContainer) this.listContainer.scrollTop = 0;
        this.renderList();
    }

    // Convert bytes to readable string
    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Helper to escape HTML to prevent XSS
    escapeHtml(unsafe) {
        return (unsafe || '').toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    // Helper to get song cover
    getSongCover(song) {
        if (!song) return './assets/logo.svg';
        return song.img || song.pic ||
            (song.meta && (song.meta.picUrl || song.meta.img)) ||
            (song.album && (song.album.picUrl || song.album.img)) ||
            './assets/logo.svg';
    }

    getSongInfoForServer(song) {
        const cover = this.getSongCover(song);
        const normalizedCover = cover && cover !== './assets/logo.svg' ? cover : '';
        return {
            ...song,
            img: song.img || normalizedCover,
            meta: {
                ...(song.meta || {}),
                picUrl: song.meta?.picUrl || normalizedCover
            }
        };
    }

    // [Unified] Status generator for drawer lists
    getStatusHtml(icon, text, isSpin = false) {
        return `
            <div class="flex flex-col items-center justify-center h-full text-center p-10 space-y-4">
                <i class="fas ${icon} ${isSpin ? 'fa-spin' : ''} text-4xl t-text-muted opacity-20"></i>
                <p class="text-sm t-text-muted font-medium">${text}</p>
            </div>
        `;
    }

    // Add multiple tasks
    async addTasks(songs) {
        if (!songs || songs.length === 0) return;

        // Keep large batches responsive by limiting concurrent preflight requests.
        const results = await this.mapWithConcurrency(songs, 8, async (song) => {
            const targetPref = song.quality || window.settings?.preferredQuality || 'flac24bit';
            const quality = song.quality || (window.QualityManager ? window.QualityManager.getBestQuality(song, targetPref) : targetPref);
            const cacheResult = await checkServerCache(song, quality, true);
            return { song, quality, cacheResult };
        });

        let skipCount = 0;
        const addedServerTasks = [];
        for (const { song, quality, cacheResult } of results) {
            const isServerTask = true;
            if (cacheResult.exists && !cacheResult.isCollision) {
                if (cacheResult.folder === 'music') {
                    skipCount++;
                    continue;
                }
            }

            // Check if already in queue (with same quality)
            const songIdentity = this.getSongIdentity(song);
            const existing = this.tasks.find(t =>
                this.getSongIdentity(t.song) === songIdentity &&
                t.quality === quality &&
                (t.status === 'waiting' || t.status === 'starting' || t.status === 'downloading' || t.status === 'tagging')
            );
            if (!existing) {
                const serverSongKey = this.getServerSongKey(song, quality);
                const taskId = song.taskId || this.createTaskId('server');

                const task = {
                    id: taskId,
                    song: song,
                    isServer: isServerTask,
                    serverManaged: true,
                    serverQueueRegistered: false,
                    serverQueueId: taskId,
                    serverSongKey,
                    quality: quality,
                    status: 'waiting',
                    errorMsg: '',
                    progress: 0,
                    downloadedBytes: 0,
                    totalBytes: 0,
                    speed: 0,
                    retryCount: 0,
                    maxRetries: 2,
                    collisionInfo: cacheResult.isCollision ? cacheResult : null
                };
                this.tasks.push(task);
                addedServerTasks.push(task);
            }
        }

        if (skipCount > 0 && window.showInfo) {
            window.showInfo(`${skipCount} 首歌曲已存在，已跳过`);
        }

        this.renderList();
        this.saveTasks();
        await this.enqueueServerTasks(addedServerTasks);
    }

    // The server owns scheduling and concurrency; this only refreshes the UI.
    processQueue() {
        this.renderList();
        this.updateGlobalProgress();
    }

    pauseTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return;

        if (!['downloading', 'waiting', 'tagging'].includes(task.status)) return;
        const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };
        fetch('/api/music/cache/stop', {
            method: 'POST',
            headers,
            body: JSON.stringify({ queueId: task.serverQueueId || task.id })
        }).catch(e => console.warn('[DownloadManager] Failed to stop server task:', e));
        task.status = 'paused';
        task.speed = 0;
        task.errorMsg = '已暂停';
        this.renderTask(task);
        this.saveTasks();
        this.updateGlobalProgress();
        this.processQueue();
    }

    resumeTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || (task.status !== 'paused' && task.status !== 'error')) return;

        task.status = 'waiting';
        task.downloadedBytes = 0;
        task.totalBytes = 0;
        task.progress = 0;
        task.speed = 0;
        task.errorMsg = '';
        task.missingProgressCount = 0;
        const request = task.serverQueueRegistered === false
            ? this.enqueueServerTasks([task])
            : this.requestServerQueue('/api/music/cache/queue/resume', { id: task.serverQueueId || task.id });
        request.catch(error => {
            task.status = 'error';
            task.errorMsg = error.message || '继续任务失败';
            this.renderTask(task);
        });
        this.renderTask(task);
        this.saveTasks();
        this.processQueue();
    }

    async deleteTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return;
        if (typeof showSelect === 'function') {
            const taskName = task.songInfo?.name || task.name || '该下载任务';
            const confirmed = await showSelect('移除下载任务', `确定要移除“${taskName}”的下载任务记录吗？已下载的音频文件不会被删除。`, {
                danger: true,
                confirmText: '确认移除'
            });
            if (!confirmed) return;
        }
        this.requestServerQueue('/api/music/cache/queue/remove', { id: task.serverQueueId || task.id })
            .catch(e => console.warn('[DownloadManager] Failed to remove server queue task:', e));
        this.tasks = this.tasks.filter(t => t.id !== taskId);
        this.renderList();
        this.processQueue();
        this.saveTasks();
    }

    pauseAll() {
        const headers = { 'Content-Type': 'application/json', ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}) };
        const hasManagedServerTasks = this.tasks.some(t => t.serverManaged && ['waiting', 'downloading', 'tagging'].includes(t.status));
        if (hasManagedServerTasks) {
            fetch('/api/music/cache/stop', {
                method: 'POST', headers, body: JSON.stringify({ all: true })
            }).catch(e => console.warn('[DownloadManager] Failed to pause persistent server queue:', e));
        }
        this.tasks.forEach(t => {
            if (t.status !== 'downloading' && t.status !== 'waiting' && t.status !== 'tagging' && t.status !== 'starting') return;

            t.status = 'paused';
            t.speed = 0;
            t.errorMsg = '已暂停';
        });
        this.activeCount = 0;
        this.renderList();
        this.saveTasks();
        this.updateGlobalProgress();
    }

    resumeAll() {
        const hasManagedServerTasks = this.tasks.some(t => t.serverManaged && (t.status === 'paused' || t.status === 'error'));
        if (hasManagedServerTasks) {
            this.requestServerQueue('/api/music/cache/queue/resume', { all: true })
                .catch(e => console.warn('[DownloadManager] Failed to resume persistent server queue:', e));
        }
        this.tasks.forEach(t => {
            if (t.status !== 'paused') return;
            t.status = 'waiting';
            t.downloadedBytes = 0;
            t.totalBytes = 0;
            t.progress = 0;
            t.speed = 0;
            t.errorMsg = '';
        });
        this.renderList();
        this.saveTasks();
        this.processQueue();
    }

    retryAllFailed() {
        // 取出所有失败任务的快照，避免在遍历同时修改数组引起问题
        const failedTasks = this.tasks.filter(t => t.status === 'error');
        if (failedTasks.length === 0) return;
        const unregisteredServerTasks = failedTasks.filter(t => t.serverManaged && t.serverQueueRegistered === false);

        failedTasks.forEach(t => {
            if (t.serverManaged) {
                if (t.serverQueueRegistered !== false) this.requestServerQueue('/api/music/cache/queue/resume', { id: t.serverQueueId || t.id })
                    .catch(e => console.warn('[DownloadManager] Failed to retry server queue task:', e));
            }
            t.retryCount = 0;
            t.downloadedBytes = 0;
            t.progress = 0;
            t.errorMsg = '';
            // 移到队列末尾
            this.tasks = this.tasks.filter(x => x.id !== t.id);

            t.status = 'waiting';
            this.tasks.push(t);
            this.renderTask(t);
        });

        if (unregisteredServerTasks.length) void this.enqueueServerTasks(unregisteredServerTasks);

        this.renderList();
        this.processQueue();
    }

    async clearCompleted() {
        const completedCount = this.tasks.filter(t => t.status === 'finished' || t.status === 'exists').length;
        if (completedCount === 0) return;
        if (typeof showSelect === 'function') {
            const confirmed = await showSelect('清空已完成任务', `确定要移除 ${completedCount} 条已完成下载任务记录吗？已下载的音频文件不会被删除。`, {
                danger: true,
                confirmText: '确认清空'
            });
            if (!confirmed) return;
        }
        if (this.tasks.some(t => t.serverManaged && (t.status === 'finished' || t.status === 'exists'))) {
            this.requestServerQueue('/api/music/cache/queue/remove', { completed: true })
                .catch(e => console.warn('[DownloadManager] Failed to clear completed server queue tasks:', e));
        }
        this.tasks = this.tasks.filter(t => t.status !== 'finished' && t.status !== 'exists');
        this.renderList();
        this.saveTasks();
    }

    clearAll() {
        // 先弹确认框
        if (typeof showSelect === 'function') {
            const hasActiveTasks = this.tasks.some(t => t.status === 'downloading' || t.status === 'waiting' || t.status === 'tagging');
            const title = hasActiveTasks ? '停止并清空任务' : '清空任务列表';
            const message = hasActiveTasks ? '确认要立即停止所有进行中的任务并清空列表吗？' : '确认要清空所有下载任务记录吗？';
            showSelect(title, message, {
                confirmText: hasActiveTasks ? '确认停止' : '确认清空',
                danger: true
            }).then(confirmed => {
                if (!confirmed) return;
                // [NEW] 通知服务器中止所有该用户的缓存任务
                const username = 'shared';
                fetch('/api/music/cache/stop', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-user-name': username,
                        ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                    },
                    body: JSON.stringify({ all: true })
                }).catch(err => console.error('[DownloadManager] Failed to stop server tasks:', err));
                this.requestServerQueue('/api/music/cache/queue/remove', { all: true })
                    .catch(err => console.error('[DownloadManager] Failed to clear persistent server queue:', err));

                this.tasks = [];
                this.activeCount = 0;
                this.renderList();
                this.saveTasks();
            });
        } else {
            this.requestServerQueue('/api/music/cache/queue/remove', { all: true })
                .catch(err => console.error('[DownloadManager] Failed to clear persistent server queue:', err));
            this.tasks = [];
            this.activeCount = 0;
            this.renderList();
            this.saveTasks();
        }
    }

    // Server queue is the only source of truth; clear legacy client task records.
    saveTasks() {
        try {
            sessionStorage.removeItem('lx_download_tasks');
        } catch (e) {
            console.warn('[DownloadManager] Failed to clear legacy client tasks:', e);
        }
    }

    // Do not restore legacy client tasks; downloads are server-managed now.
    restoreTasks() {
        try {
            sessionStorage.removeItem('lx_download_tasks');
        } catch (e) {
            console.warn('[DownloadManager] Failed to clear legacy client tasks:', e);
        }
    }

    // Update the UI Global Speed Counter
    updateGlobalSpeed() {
        let totalSpeed = 0;
        let active = 0;
        let pctTotal = 0;
        let pctCount = 0;

        this.tasks.forEach(t => {
            if (t.status === 'downloading' || t.status === 'tagging') {
                totalSpeed += (t.speed || 0);
                active++;
            }
            // 所有任务都纳入进度计算（server 任务可能 totalBytes=0，但 progress/status 是已知的）
            if (t.status === 'finished' || t.status === 'exists') {
                pctTotal += 100;
                pctCount++;
            } else if (t.status === 'downloading' || t.status === 'waiting' || t.status === 'tagging') {
                pctTotal += t.status === 'tagging' ? 100 : (t.progress || 0);
                pctCount++;
            }
        });

        if (this.globalSpeedEl) {
            this.globalSpeedEl.innerText = `${this.formatSize(totalSpeed)}/s • ${this.tasks.length} TASKS`;
        }

        if (this.progressTextEl) {
            const overallProgress = pctCount > 0 ? Math.round(pctTotal / pctCount) : 0;
            this.progressTextEl.innerText = `${overallProgress}%`;
        }
    }

    updateGlobalProgress() {
        this.updateGlobalSpeed(); // Calculates and updates
        // 更新悬浮任务按钮角标(活跃任务数)
        const badge = document.getElementById('download-nav-badge');
        if (badge) {
            const active = (this.tasks || []).filter(t => t.status === 'waiting' || t.status === 'downloading').length;
            badge.textContent = active > 99 ? '99+' : String(active);
            badge.classList.toggle('hidden', active === 0);
        }
    }

    // Render a single task row item to HTML
    renderTaskHtml(task) {
        const coverSrc = this.getSongCover(task.song);
        const sourceName = {
            'wy': '网易', 'tx': 'QQ', 'kg': '酷狗', 'kw': '酷我', 'mg': '咪咕'
        }[task.song.source] || task.song.source;

        let qualityLabel = task.quality || window.settings?.preferredQuality || '优先最高';
        // 如果是音质代码（如 320k），尝试转换为显示名称
        if (window.QualityManager) {
            // 先尝试把代码转换成名称（如 320k -> 高品质）
            const displayName = window.QualityManager.getQualityDisplayName(qualityLabel);
            if (displayName) qualityLabel = displayName;
        }

        let statusBg = 'bg-gray-100 t-text-muted';
        let statusText = '等待中';
        let actionBtnHTML = '';
        let progressWidth = task.progress || 0;
        let speedText = '';
        const isServerTask = true;

        if (task.status === 'downloading') {
            statusBg = 'bg-orange-100 text-orange-600';
            // 若 totalBytes=0 且 progress=0，说明还没轮询到进度，显示 indeterminate。
            const hasRealProgress = task.totalBytes > 0 || task.progress > 0;
            statusText = hasRealProgress ? `服务器 ${progressWidth}%` : '服务器下载中';
            speedText = `${this.formatSize(Math.max(0, task.speed || 0))}/s`;
        } else if (task.status === 'tagging') {
            statusBg = 'bg-orange-100 text-orange-600';
            statusText = '写入标签';
            progressWidth = 100;
        } else if (task.status === 'paused') {
            statusBg = 'bg-yellow-100 text-yellow-600';
            statusText = '已暂停';
            actionBtnHTML = `
                <button onclick="window.SystemDownloadManager.resumeTask('${task.id}')" class="w-8 h-8 rounded-full border border-emerald-200 text-emerald-500 hover:bg-emerald-50 flex items-center justify-center transition-colors shadow-sm" title="继续">
                    <i class="fas fa-play text-xs"></i>
                </button>
            `;
        } else if (task.status === 'error') {
            statusBg = 'bg-red-100 text-red-600';
            statusText = task.retryCount > 0 && task.retryCount < task.maxRetries ? `重试 (${task.retryCount})` : '失败';
            actionBtnHTML = `
                <button onclick="window.SystemDownloadManager.resumeTask('${task.id}')" class="w-8 h-8 rounded-full border border-red-200 text-red-500 hover:bg-red-50 flex items-center justify-center transition-colors shadow-sm" title="重试">
                    <i class="fas fa-redo text-xs"></i>
                </button>
            `;
        } else if (task.status === 'finished' || task.status === 'exists') {
            statusBg = 'bg-emerald-100 text-emerald-600';
            statusText = task.status === 'exists' ? '已存在' : '已存服务器';
            progressWidth = 100;
        } else if (task.status === 'waiting') {
            statusText = '服务器排队';
        }

        actionBtnHTML += `
            <button onclick="window.SystemDownloadManager.deleteTask('${task.id}')" class="w-8 h-8 rounded-full border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-500 flex items-center justify-center transition-colors ml-1 shadow-sm" title="移除任务">
                <i class="fas fa-trash-alt text-xs"></i>
            </button>
        `;

        return `
            <div id="dl-task-${task.id}" class="relative p-3 rounded-xl t-bg-panel hover:bg-gray-50/50 dark:hover:bg-gray-800/50 transition-colors border border-transparent hover:t-border-main group flex gap-3 overflow-hidden shadow-sm mb-2">
                <!-- Progress Bar Background -->
                ${task.status !== 'waiting' && task.status !== 'error' ? `
                <div class="absolute bottom-0 left-0 h-1.5 bg-orange-400 transition-all duration-300 opacity-60" style="width: ${progressWidth}%"></div>
                ` : ''}

                <!-- Cover -->
                <div class="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 shadow-sm border t-border-main">
                    <img src="${this.escapeHtml(coverSrc)}" class="w-full h-full object-cover">
                    ${(task.status === 'downloading') ? `
                    <div class="absolute inset-0 bg-black/40 flex items-center justify-center backdrop-blur-[2px]">
                        <i class="fas fa-cloud-upload-alt text-white text-xs"></i>
                    </div>` : ''}
                </div>

                <!-- Info -->
                <div class="flex-1 min-w-0 flex flex-col justify-center">
                    <div class="flex items-center gap-1.5 mb-1 flex-nowrap">
                        <span class="shrink-0 text-[10px] font-bold text-white bg-orange-500 px-1.5 py-0.5 rounded uppercase tracking-wider">${this.escapeHtml(sourceName)}</span>
                        <span class="shrink-0 text-[10px] font-bold text-white bg-purple-500 px-1.5 py-0.5 rounded tracking-wider">服务器</span>
                        <h4 class="text-sm font-bold t-text-main truncate leading-tight flex-1 min-w-0 dynamic-marquee overflow-hidden" data-text="${this.escapeHtml(task.song.name)}">${this.escapeHtml(task.song.name)}</h4>
                    </div>
                    
                    <div class="flex items-center justify-between mt-1">
                        <div class="text-[10px] t-text-muted truncate flex gap-2 items-center">
                            <span class="text-emerald-600 font-medium px-1 bg-emerald-50 rounded">${this.escapeHtml(qualityLabel)}</span>
                            <span class="truncate opacity-60">${this.escapeHtml(task.song.singer)}</span>
                        </div>
                        
                        <div class="flex items-center gap-1.5 font-bold">
                            ${speedText ? `<span class="text-[10px] font-mono text-emerald-500">${speedText}</span>` : ''}
                            
                            <!-- LRC Status Tag -->
                            ${task.status === 'finished' ? `
                                ${task.hasLyric === true ? `
                                    <span class="text-[9px] bg-emerald-500 text-white px-1 rounded h-3.5 flex items-center shadow-sm" title="歌词已同步">LRC</span>
                                ` : task.hasLyric === false ? `
                                    <div onclick="event.stopPropagation(); window.SystemDownloadManager.retryLyric('${task.id}')" class="text-[9px] bg-red-400 hover:bg-red-500 text-white px-1 rounded h-3.5 flex items-center gap-0.5 cursor-pointer shadow-sm transition-colors" title="歌词缺失，点击重试">
                                        <span>LRC+</span>
                                        <i class="fas fa-redo-alt text-[7px]"></i>
                                    </div>
                                ` : `
                                    <span class="text-[9px] bg-gray-400 text-white px-1 rounded h-3.5 flex items-center opacity-60" title="正在检查歌词...">LRC</span>
                                `}
                            ` : ''}

                            <span class="text-[10px] px-1.5 py-0.5 rounded ${statusBg} truncate max-w-[100px]">
                                ${task.errorMsg ? `<span title="${this.escapeHtml(task.errorMsg)}">${this.escapeHtml(task.errorMsg)}</span>` : statusText}
                            </span>
                        </div>
                    </div>
                </div>

                <!-- Actions -->
                <div class="flex items-center pl-1 opacity-0 group-hover:opacity-100 transition-all transform translate-x-2 group-hover:translate-x-0">
                    ${actionBtnHTML}
                </div>
            </div>
        `;
    }

    // Refresh entire list DOM
    renderList() {
        if (!this.listContainer) return;

        if (this.tasks.length === 0) {
            this.renderedRange = { start: 0, end: 0 };
            this.listContainer.innerHTML = this.getStatusHtml('fa-inbox', '暂无下载任务');
            this.updateFilterControls();
            return;
        }

        this.updateFilterControls();
        const filteredTasks = this.getFilteredTasks();
        if (filteredTasks.length === 0) {
            this.renderedRange = { start: 0, end: 0 };
            this.listContainer.innerHTML = this.getStatusHtml('fa-filter', '没有符合条件的下载任务');
            return;
        }

        const containerHeight = this.listContainer.clientHeight || 600;
        const visibleCount = Math.ceil(containerHeight / this.estimatedTaskHeight) + this.renderBuffer * 2;
        const maxStart = Math.max(0, filteredTasks.length - visibleCount);
        const start = Math.min(
            maxStart,
            Math.max(0, Math.floor(this.listContainer.scrollTop / this.estimatedTaskHeight) - this.renderBuffer)
        );
        const end = Math.min(filteredTasks.length, start + visibleCount);
        this.renderedRange = { start, end };

        const topSpacer = start * this.estimatedTaskHeight;
        const bottomSpacer = Math.max(0, (filteredTasks.length - end) * this.estimatedTaskHeight);
        const visibleTasks = filteredTasks.slice(start, end);

        this.listContainer.innerHTML = `
            <div style="height: ${topSpacer}px;"></div>
            ${visibleTasks.map(t => this.renderTaskHtml(t)).join('')}
            <div style="height: ${bottomSpacer}px;"></div>
        `;

        const firstTaskEl = this.listContainer.querySelector('[id^="dl-task-"]');
        if (firstTaskEl) {
            const measuredHeight = firstTaskEl.getBoundingClientRect().height + 8;
            if (measuredHeight > 0 && Math.abs(measuredHeight - this.estimatedTaskHeight) > 6) {
                this.estimatedTaskHeight = measuredHeight;
            }
        }

        // 触发标题滚动检测
        if (typeof applyMarqueeChecks === 'function') applyMarqueeChecks();
    }

    scheduleScrollRender() {
        if (this.scrollRenderRaf) return;
        this.scrollRenderRaf = requestAnimationFrame(() => {
            this.scrollRenderRaf = null;
            this.renderList();
        });
    }

    // Update specific task in DOM to avoid full re-render
    renderTask(task) {
        if (!this.listContainer) return;
        const taskEl = document.getElementById(`dl-task-${task.id}`);
        if (!taskEl) {
            if (!this.matchesTaskFilter(task)) return;
            const taskIndex = this.getFilteredTasks().findIndex(t => t.id === task.id);
            if (taskIndex >= 0 && (taskIndex < this.renderedRange.start || taskIndex >= this.renderedRange.end)) return;
            // Task element doesn't exist (maybe switched views?), do full render
            this.renderList();
            return;
        }

        // A status/source change may make the task leave the current result set.
        if (!this.matchesTaskFilter(task)) {
            this.renderList();
            return;
        }

        // Quick efficient replacement
        const div = document.createElement('div');
        div.innerHTML = this.renderTaskHtml(task);
        const newEl = div.firstElementChild;
        taskEl.parentNode.replaceChild(newEl, taskEl);
        // 触发标题滚动检测
        if (typeof applyMarqueeChecks === 'function') applyMarqueeChecks();
    }
}

// Global UI Toggles for Download Drawer
window.toggleDownloadDrawer = function () {
    if (window.SystemDownloadManager) {
        window.SystemDownloadManager.toggleDrawer();
    }
};

window.openDownloadManager = function () {
    if (typeof switchTab === 'function') switchTab('downloads');
};

// Initialize globally
window.SystemDownloadManager = new DownloadManager();
