/*
 * Copyright 2026 xcq0607 (https://github.com/xcq0607)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const APP_API_BASE = '/api/music';
let currentPage = 1;
window.currentPage = 1;
let currentSearch = { name: '', source: 'kw' };
let currentPlaylist = [];
window.viewingPlaylist = []; // Currently displayed list in UI
window.currentSearchScope = 'network'; // 'network', 'local_list', 'local_all' - Scope for UI view

let importedPlaylists = [];
const IMPORTED_PLAYLIST_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
let importedPlaylistRefreshInFlight = false;

async function saveImportedPlaylists() {
    try {
        await fetch('/api/user/imported-playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(importedPlaylists)
        });
    } catch (e) {
        console.warn('[ImportedPlaylists] 服务端歌单记录保存失败:', e);
    }
}

async function loadImportedPlaylists() {
    try {
        const response = await fetch('/api/user/imported-playlists', { cache: 'no-store' });
        if (!response.ok) return;
        const serverPlaylists = await response.json();
        importedPlaylists = Array.isArray(serverPlaylists) ? serverPlaylists : [];

        renderImportedPlaylists();
        void refreshImportedPlaylists();
    } catch (e) {
        console.warn('[ImportedPlaylists] 服务端歌单记录加载失败:', e);
    }
}

async function refreshImportedPlaylists() {
    if (importedPlaylistRefreshInFlight || importedPlaylists.length === 0) return;
    importedPlaylistRefreshInFlight = true;
    let changed = false;

    try {
        for (const item of [...importedPlaylists]) {
            if (!item?.id || !item?.source) continue;
            try {
                const requestId = window.normalizePlaylistRouteId?.(item.id) || item.id;
                const response = await fetch(`${APP_API_BASE}/songList/detail?source=${encodeURIComponent(item.source)}&id=${encodeURIComponent(requestId)}&page=1`, {
                    cache: 'no-store'
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !Array.isArray(data.list)) throw new Error(data.message || `HTTP ${response.status}`);

                const info = data.info || {};
                const next = {
                    ...item,
                    id: requestId,
                    name: info.name || info.title || item.name,
                    cover: info.img || info.pic || info.cover || item.cover || ''
                };
                const index = importedPlaylists.findIndex(saved => saved.source === item.source && String(saved.id) === String(item.id));
                if (index >= 0 && (next.id !== importedPlaylists[index].id || next.name !== importedPlaylists[index].name || next.cover !== importedPlaylists[index].cover)) {
                    importedPlaylists[index] = next;
                    changed = true;
                }
            } catch (error) {
                console.warn('[ImportedPlaylists] 远程歌单刷新失败:', item.source, item.id, error);
            }
        }

        if (changed) {
            renderImportedPlaylists();
            await saveImportedPlaylists();
        }
    } finally {
        importedPlaylistRefreshInFlight = false;
    }
}

function renderImportedPlaylists() {
    const container = document.getElementById('imported-playlists-container');
    if (!container) return;

    container.innerHTML = '';
    if (importedPlaylists.length === 0) {
        container.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-24 text-center t-text-muted">
                <i class="fas fa-folder-open text-5xl opacity-20 mb-4"></i>
                <p class="text-sm font-medium">暂无导入歌单</p>
                <p class="text-xs opacity-70 mt-1">点击右上角“导入歌单”开始添加</p>
            </div>`;
        return;
    }

    importedPlaylists.forEach(item => {
        const row = document.createElement('div');
        row.className = 't-bg-panel border t-border-main rounded-2xl p-4 cursor-pointer flex items-center gap-3 group transition-all hover:border-emerald-500/50 hover:shadow-md';
        row.title = `${item.name || '未命名歌单'} (${item.source || 'unknown'})`;

        const cover = document.createElement('img');
        cover.className = 'w-16 h-16 rounded-xl object-cover flex-shrink-0 bg-gray-100 dark:bg-gray-800';
        cover.src = item.cover || './assets/logo.svg';
        cover.alt = '';
        cover.onerror = () => { cover.src = './assets/logo.svg'; };
        const icon = document.createElement('i');
        icon.className = 'fas fa-music text-emerald-500 text-xs';
        const details = document.createElement('div');
        details.className = 'min-w-0 flex-1';
        const name = document.createElement('div');
        name.className = 'font-bold t-text-main truncate';
        name.textContent = item.name || '未命名歌单';
        const source = document.createElement('span');
        source.className = 'inline-flex items-center gap-1 mt-1 text-[10px] t-text-muted uppercase';
        source.innerHTML = '<i class="fas fa-link"></i>';
        source.append(document.createTextNode(` ${item.source || 'unknown'} · 点击打开`));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'hidden group-hover:block text-gray-400 hover:text-red-500 flex-shrink-0';
        remove.title = '移除导入记录';
        remove.setAttribute('aria-label', '移除导入记录');
        remove.innerHTML = '<i class="fas fa-times text-[10px]"></i>';
        remove.onclick = (event) => {
            event.stopPropagation();
            importedPlaylists = importedPlaylists.filter(saved => !(saved.source === item.source && String(saved.id) === String(item.id)));
            saveImportedPlaylists();
            renderImportedPlaylists();
        };
        row.onclick = () => {
            document.querySelectorAll('[data-imported-playlist]').forEach(el => el.classList.remove('active-sub-item'));
            row.classList.add('active-sub-item');
            if (window.SongListManager?.openDetail) {
                window.SongListManager.openDetail(item.id, item.source, {
                    returnTab: 'my-playlists',
                    sidebarTab: 'my-playlists'
                });
            }
        };

        row.dataset.importedPlaylist = 'true';
        details.append(name, source);
        row.append(cover, details, icon, remove);
        container.appendChild(row);
    });
}

function addImportedPlaylist(detail) {
    if (!detail || !detail.id || !detail.source) return;
    const info = detail.info || {};
    const imported = {
        id: normalizePlaylistRouteId(detail.id),
        source: detail.source,
        name: info.name || info.title || `${detail.source} 歌单`,
        cover: info.img || info.pic || info.cover || '',
        updatedAt: Date.now()
    };
    const existingIndex = importedPlaylists.findIndex(item => item.source === imported.source && item.id === imported.id);
    if (existingIndex >= 0) importedPlaylists.splice(existingIndex, 1);
    importedPlaylists.unshift(imported);
    importedPlaylists = importedPlaylists.slice(0, 100);
    saveImportedPlaylists();
    renderImportedPlaylists();
}

window.renderImportedPlaylists = renderImportedPlaylists;
window.addImportedPlaylist = addImportedPlaylist;
window.refreshImportedPlaylists = refreshImportedPlaylists;

document.addEventListener('DOMContentLoaded', () => {
    renderImportedPlaylists();
    void loadImportedPlaylists();
    window.setInterval(() => {
        void refreshImportedPlaylists();
    }, IMPORTED_PLAYLIST_REFRESH_INTERVAL_MS);
});

// Initialize Unified Search for Global Search
window.goToPage = function (page) {
    currentPage = page;
    window.currentPage = page;
    if (typeof doSearch === 'function') doSearch(page);
};

function initGlobalListSearch() {
    if (window.ListSearch) {
        window.ListSearch.init('global', {
            renderCallback: () => renderResults(window.viewingPlaylist),
            paginationCallback: (page, index) => {
                window.goToPage(page);
                setTimeout(() => window.ListSearch.scrollToMatch(index), 300);
            },
            getList: () => window.viewingPlaylist,
            itemsPerPage: settings.itemsPerPage === 'all' ? 999999 : parseInt(settings.itemsPerPage)
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initGlobalListSearch();
    // 历史标记残留导致解析树嵌套偏移：把下载管理视图归位到视图容器，保证与其它视图同级
    const dlView = document.getElementById('view-downloads');
    const refView = document.getElementById('view-search');
    if (dlView && refView && dlView.parentElement !== refView.parentElement) {
        refView.parentElement.appendChild(dlView);
    }
});

// Settings & Batch Selection
const DEFAULT_SETTINGS = {
    itemsPerPage: 20, // Default 20 items per page, can be 'all'
    defaultEntry: 'search', // 默认入口: 'search' | 'songlist' | 'leaderboard' | 'localmusic' | 'subscriptions' | 'source-management'
    preferredQuality: 'flac24bit', // 默认音质偏好
    downloadConcurrency: 3, // 下载并发量 (1-5)
    hotSearchLimit: 20, // 热搜显示数量
    lyricFontSize: 1.25, // 歌词字体大小 (rem)
    lyricFontFamily: '', // 词字体
    enableKeyboardShortcuts: true, // 按键快捷方式 (默认开启)
    showLyricTranslation: true, // 显示歌词翻译
    showLyricRoma: false, // 显示歌词罗马音
    swapLyricTransRoma: false, // 交换翻译与罗马音位置
    enableAutoSwitchSource: true, // 自动尝试换源 (默认开启)
    enableAutoSwitchApiSource: true, // 自动解析换源 (默认开启)
    enableAutoDegradeQuality: true, // 自动降低音质 (默认开启)
    // Download Settings
    enableServerLyricDownload: true, // 下载任务保存独立 LRC 文件
    downloadFileNamePattern: 'name-artist', // 下载文件名格式
    enableServerMetadataEmbed: true, // 嵌入歌曲标题、歌手、专辑等元信息
    enableServerCoverEmbed: true, // 嵌入歌曲封面
    enableServerLyricEmbed: true, // 嵌入歌词到音频文件
    enableServerLyricEmbedTranslation: false, // 嵌入翻译歌词
    enableServerLyricEmbedRoma: false, // 嵌入罗马音歌词
    enableServerLyricEmbedLx: true, // 嵌入 LX Music 扩展歌词
    enableServerLyricDownloadTranslation: false, // LRC 包含翻译歌词
    enableServerLyricDownloadRoma: false, // LRC 包含罗马音歌词
    enableServerLyricDownloadLx: true, // LRC 包含 LX Music 扩展歌词
    downloadLyricFormat: 'utf8', // 独立 LRC 编码格式: utf8 | gbk
    serverCacheNamingPattern: 'simple', // 缓存命名规则: standard | simple
    downloadDir: 'download', // 纯下载模式保存目录，默认使用程序目录下的 download
    enableRemaster: false, // 启用下载目录歌曲洗版
    enableLyricGlow: true, // 歌词荧光效果 (默认开启)
    deduplicatePlaylistByQuality: true, // 同 ID 歌曲仅加入最高音质 (默认开启)
};

function normalizeDownloadConcurrency(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.downloadConcurrency;
    return Math.min(5, Math.max(1, parsed));
}

function normalizeStoredSettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object') return nextSettings;
    delete nextSettings.serverCacheLocation;
    delete nextSettings.enableServerCache;
    delete nextSettings.remasterRetryManifest;
    if (nextSettings.enableServerLyricDownload === undefined && nextSettings.enableServerLyricCache !== undefined) {
        nextSettings.enableServerLyricDownload = nextSettings.enableServerLyricCache;
    }
    const supportedQualities = window.QualityManager?.SUPPORTED_QUALITIES || ['128k', '320k', 'flac', 'flac24bit'];
    if (!supportedQualities.includes(nextSettings.preferredQuality)) {
        nextSettings.preferredQuality = DEFAULT_SETTINGS.preferredQuality;
    }
    if (nextSettings.downloadConcurrency !== undefined) {
        nextSettings.downloadConcurrency = normalizeDownloadConcurrency(nextSettings.downloadConcurrency);
    }
    nextSettings.serverCacheNamingPattern = nextSettings.serverCacheNamingPattern === 'standard'
        ? 'standard'
        : 'simple';
    if (!['name-artist', 'artist-name', 'name'].includes(nextSettings.downloadFileNamePattern)) {
        nextSettings.downloadFileNamePattern = DEFAULT_SETTINGS.downloadFileNamePattern;
    }
    const validDefaultEntries = [
        'search', 'songlist', 'leaderboard', 'localmusic', 'my-playlists', 'subscriptions', 'source-management', 'downloads',
        'settings-system', 'settings-display', 'settings-logs'
    ];
    if (!validDefaultEntries.includes(nextSettings.defaultEntry)) {
        nextSettings.defaultEntry = DEFAULT_SETTINGS.defaultEntry;
    }
    return nextSettings;
}

let settings = { ...DEFAULT_SETTINGS };
let settingsReady = false;
let routeInitialized = false;
let lastHandledRouteHash = null;
const navigableTabs = new Set([
    'search', 'songlist', 'leaderboard', 'my-playlists', 'subscriptions', 'source-management', 'localmusic', 'downloads',
    'settings-system', 'settings-display', 'settings-logs'
]);

const tabRoutes = {
    search: '#/search',
    songlist: '#/songlist',
    leaderboard: '#/leaderboard',
    'my-playlists': '#/my-playlists',
    subscriptions: '#/subscriptions',
    'source-management': '#/source-management',
    localmusic: '#/localmusic',
    downloads: '#/downloads',
    'settings-system': '#/settings/system',
    'settings-display': '#/settings/display',
    'settings-logs': '#/settings/logs'
};

// 设置统一由服务端 SQLite 提供；浏览器不再持久化设置。
window.settings = settings; // 显式挂载到 window

function escapeHtmlText(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[ch]);
}

// Inline handlers need a JavaScript literal escaped for their HTML attribute.
function htmlJs(value) {
    return escapeHtmlText(JSON.stringify(value ?? null));
}

function safeImageUrl(value) {
    const fallback = './assets/logo.svg';
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    try {
        const url = new URL(raw, window.location.href);
        if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'blob:') return raw;
        if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(raw)) return raw;
    } catch (_) { }
    return fallback;
}

function htmlImageUrl(value) { return escapeHtmlText(safeImageUrl(value)); }

function showToast(type, message, duration = 3000) {
    // 兼容旧调用顺序：showToast(message, type)
    if (!['success', 'info', 'error'].includes(type) && ['success', 'info', 'error'].includes(message)) {
        [type, message] = [message, type];
    }

    const toast = document.createElement('div');
    const colors = {
        success: 'bg-emerald-500',
        info: 'bg-blue-500',
        error: 'bg-red-500'
    };
    toast.className = `fixed right-4 bottom-6 z-[1000] max-w-[min(24rem,calc(100vw-2rem))] ${colors[type] || colors.info} text-white px-4 py-3 rounded-xl shadow-lg text-sm font-medium whitespace-pre-wrap`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = String(message ?? '');
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), duration);
}

function showSuccess(message) { showToast('success', message, 2000); }
function showInfo(message) { showToast('info', message, 2500); }
function showError(message) { showToast('error', message, 3500); }

function showSelect(title, message, options = {}) {
    return new Promise((resolve) => {
        const previousFocus = document.activeElement;
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const backdrop = document.createElement('div');
        backdrop.className = 'absolute inset-0 bg-black/60 backdrop-blur-sm';

        const panel = document.createElement('div');
        panel.className = 't-bg-panel rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden relative z-10 border t-border-main';

        const header = document.createElement('div');
        header.className = 'px-5 py-4 border-b border-emerald-100/50 flex justify-between items-center bg-emerald-50/50';
        const heading = document.createElement('h3');
        heading.className = 'text-sm font-bold t-text-main';
        heading.textContent = String(title || '请确认');
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 't-text-muted hover:text-emerald-500 transition-colors';
        closeButton.setAttribute('aria-label', '关闭');
        closeButton.innerHTML = '<i class="fas fa-times text-lg"></i>';
        header.append(heading, closeButton);

        const body = document.createElement('div');
        body.className = 'p-5 space-y-4';
        const description = document.createElement('p');
        description.className = 'text-sm t-text-muted whitespace-pre-line';
        description.textContent = String(message || '确定继续吗？').replace(/<[^>]*>/g, '');

        const footer = document.createElement('div');
        footer.className = 'flex justify-end gap-2';
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'px-4 py-2 rounded-xl text-sm t-text-muted hover:t-bg-main transition-colors';
        cancelButton.textContent = options.cancelText || '取消';
        const confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.className = options.danger
            ? 'px-4 py-2 rounded-xl text-sm text-white bg-red-500 hover:bg-red-600 transition-colors'
            : 'px-4 py-2 rounded-xl text-sm text-white bg-emerald-500 hover:bg-emerald-600 transition-colors';
        confirmButton.textContent = options.confirmText || '确定';
        footer.append(cancelButton, confirmButton);
        body.append(description, footer);
        panel.append(header, body);
        modal.append(backdrop, panel);

        let closed = false;
        const close = (result) => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKeyDown);
            modal.remove();
            if (previousFocus && previousFocus.isConnected) previousFocus.focus();
            resolve(result);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') { event.preventDefault(); close(false); }
            if (event.key === 'Tab') {
                const buttons = [closeButton, cancelButton, confirmButton];
                const first = buttons[0], last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        };

        closeButton.addEventListener('click', () => close(false));
        backdrop.addEventListener('click', () => close(false));
        cancelButton.addEventListener('click', () => close(false));
        confirmButton.addEventListener('click', () => close(true));
        document.addEventListener('keydown', onKeyDown);
        document.body.appendChild(modal);
        setTimeout(() => { if (!closed) (options.danger ? cancelButton : confirmButton).focus(); }, 0);
    });
}

function showInput(title, message, options = {}) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const backdrop = document.createElement('div');
        backdrop.className = 'absolute inset-0 bg-black/60 backdrop-blur-sm';

        const panel = document.createElement('div');
        panel.className = 't-bg-panel rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden relative z-10 border t-border-main';

        const header = document.createElement('div');
        header.className = 'px-5 py-4 border-b border-emerald-100/50 flex justify-between items-center bg-emerald-50/50';
        const heading = document.createElement('h3');
        heading.className = 'text-sm font-bold t-text-main';
        heading.textContent = String(title || '请输入');
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 't-text-muted hover:text-emerald-500 transition-colors';
        closeButton.setAttribute('aria-label', '关闭');
        closeButton.innerHTML = '<i class="fas fa-times text-lg"></i>';
        header.append(heading, closeButton);

        const body = document.createElement('div');
        body.className = 'p-5 space-y-4';
        const description = document.createElement('p');
        description.className = 'text-sm t-text-muted whitespace-pre-line';
        description.textContent = String(message || '');
        const input = document.createElement('input');
        input.type = options.type || 'text';
        input.className = 'w-full rounded-xl border t-border-main px-3 py-2 text-sm bg-transparent focus:outline-none focus:ring-2 focus:ring-emerald-500';
        input.placeholder = String(options.placeholder || '');
        input.value = String(options.defaultValue || '');
        input.autocomplete = 'off';
        input.setAttribute('aria-label', String(title || '输入内容'));

        const footer = document.createElement('div');
        footer.className = 'flex justify-end gap-2';
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'px-4 py-2 rounded-xl text-sm t-text-muted hover:t-bg-main transition-colors';
        cancelButton.textContent = options.cancelText || '取消';
        const confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.className = 'px-4 py-2 rounded-xl text-sm text-white bg-emerald-500 hover:bg-emerald-600 transition-colors';
        confirmButton.textContent = options.confirmText || '确定';
        footer.append(cancelButton, confirmButton);
        body.append(description, input, footer);
        panel.append(header, body);
        modal.append(backdrop, panel);

        let closed = false;
        const close = (value) => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKeyDown);
            modal.remove();
            resolve(value);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') close(null);
            if (event.key === 'Enter' && document.activeElement === input) close(input.value.trim() || null);
        };

        closeButton.addEventListener('click', () => close(null));
        backdrop.addEventListener('click', () => close(null));
        cancelButton.addEventListener('click', () => close(null));
        confirmButton.addEventListener('click', () => close(input.value.trim() || null));
        document.addEventListener('keydown', onKeyDown);
        document.body.appendChild(modal);
        setTimeout(() => {
            input.focus();
            if (input.value) input.select();
        }, 0);
    });
}

function showOptions(title, message, options = []) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in';

        const backdrop = document.createElement('div');
        backdrop.className = 'absolute inset-0 bg-black/60 backdrop-blur-sm';

        const panel = document.createElement('div');
        panel.className = 't-bg-panel rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden relative z-10 border t-border-main';

        const header = document.createElement('div');
        header.className = 'px-5 py-4 border-b border-emerald-100/50 flex justify-between items-center bg-emerald-50/50';
        const heading = document.createElement('h3');
        heading.className = 'text-sm font-bold t-text-main';
        heading.textContent = String(title || '请选择');
        const closeButton = document.createElement('button');
        closeButton.className = 't-text-muted hover:text-emerald-500 transition-colors';
        closeButton.setAttribute('aria-label', '关闭');
        closeButton.innerHTML = '<i class="fas fa-times text-lg"></i>';
        header.append(heading, closeButton);

        const body = document.createElement('div');
        body.className = 'p-3';
        const description = document.createElement('p');
        description.className = 'px-3 py-2 text-xs t-text-muted mb-2 font-medium whitespace-pre-line';
        description.textContent = String(message || '');
        const list = document.createElement('div');
        list.className = 'max-h-[60vh] overflow-y-auto custom-scrollbar space-y-1';
        body.append(description, list);

        let closed = false;
        const close = (result) => {
            if (closed) return;
            closed = true;
            modal.classList.add('opacity-0');
            setTimeout(() => {
                modal.remove();
                resolve(result);
            }, 200);
        };

        for (const option of Array.isArray(options) ? options : []) {
            const button = document.createElement('button');
            button.className = 'w-full text-left px-4 py-3.5 t-text-main hover:bg-emerald-500 hover:text-white transition-all rounded-xl font-bold text-sm flex items-center justify-between group';
            const label = document.createElement('span');
            label.textContent = String(option);
            const icon = document.createElement('i');
            icon.className = 'fas fa-chevron-right text-[10px] opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all';
            button.append(label, icon);
            button.addEventListener('click', () => close(String(option)));
            list.appendChild(button);
        }

        closeButton.addEventListener('click', () => close(null));
        backdrop.addEventListener('click', () => close(null));
        panel.append(header, body);
        modal.append(backdrop, panel);
        document.body.appendChild(modal);
    });
}

window.showToast = showToast;
window.showSuccess = showSuccess;
window.showInfo = showInfo;
window.showError = showError;
window.showSelect = showSelect;
window.showInput = showInput;
window.showOptions = showOptions;

async function fetchSettingsFromServer() {
    try {
        console.log('[Settings] 正在从服务器尝试加载设置...');
        const response = await fetch('/api/user/settings', {
            cache: 'no-store',
            headers: getUserAuthHeaders()
        });

        if (!response.ok) {
            console.log(`[Settings] 服务器设置加载失败: HTTP ${response.status}`);
            return;
        }

        const serverSettings = await response.json();
        if (!serverSettings || typeof serverSettings !== 'object' || Array.isArray(serverSettings)) {
            console.warn('[Settings] 服务器返回的设置格式无效');
            return;
        }

        const mergedSettings = { ...settings, ...serverSettings };
        if (serverSettings.enableServerLyricDownload === undefined &&
            serverSettings.enableServerLyricCache !== undefined) {
            mergedSettings.enableServerLyricDownload = serverSettings.enableServerLyricCache;
        }

        settings = normalizeStoredSettings(mergedSettings);
        window.settings = settings;
        if (typeof syncSettingsUI === 'function') syncSettingsUI();
        console.log('[Settings] 从服务器加载设置成功');
    } catch (error) {
        console.error('[Settings] 从服务器加载设置失败:', error);
    } finally {
        settingsReady = true;
        initializeRoute();
    }
}

let settingsSyncTimer = null;
let settingsSyncQueue = Promise.resolve();

function pushSettingsToServer() {
    if (settingsSyncTimer) window.clearTimeout(settingsSyncTimer);

    return new Promise(resolve => {
        settingsSyncTimer = window.setTimeout(() => {
            settingsSyncTimer = null;
            settingsSyncQueue = settingsSyncQueue.then(async () => {
                const payload = { ...settings };
                // 兼容旧配置，但不再保存已经移除的本地开关。
                delete payload.saveAccountSettingsToFile;

                const response = await fetch('/api/user/settings', {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json', ...getUserAuthHeaders() },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                console.log('[Settings] 已实时同步到服务器');
                return true;
            }).catch(error => {
                console.error('[Settings] 实时同步失败:', error);
                return false;
            }).finally(resolve);
        }, 150);
    });
}
window.pushSettingsToServer = pushSettingsToServer;

window.batchMode = false;
window.selectedItems = new Set();
window.selectedSongObjects = new Map();

// ===== Web 单 Token 认证 =====
let authVerified = false;
let userToken = null;

/**
 * Web 使用同源 HttpOnly Cookie 携带全局 Token。
 * 不再向浏览器端保存或发送用户名、密码和用户 Token。
 */
function getUserAuthHeaders() {
    return {};
}
window.getUserAuthHeaders = getUserAuthHeaders;

function isUserLoggedIn() {
    return authVerified;
}
window.isUserLoggedIn = isUserLoggedIn;

async function ensureUserAuthToken(options = {}) {
    const force = options.force === true;
    if (force) authVerified = false;
    try {
        const response = await fetch('/api/music/auth/verify', { cache: 'no-store' });
        const result = await response.json().catch(() => ({}));
        authVerified = result.valid === true;
        userToken = authVerified ? 'shared' : null;
        if (typeof updateUserUI === 'function') updateUserUI();
        return authVerified;
    } catch (error) {
        authVerified = false;
        userToken = null;
        console.warn('[Auth] Token 验证失败:', error);
        return false;
    }
}
window.ensureUserAuthToken = ensureUserAuthToken;

/**
 * 更新顶部栏的用户状态显示 (登录按钮/用户名)
 */
function updateUserUI() {
    const loginBtn = document.getElementById('header-login-btn');
    const userDisplay = document.getElementById('header-user-display');
    const usernameEl = document.getElementById('header-username');

    if (!loginBtn || !userDisplay || !usernameEl) return;

    if (authVerified) {
        // 已登录
        loginBtn.classList.add('hidden');
        loginBtn.classList.remove('flex');
        userDisplay.classList.add('flex');
        userDisplay.classList.remove('hidden');
        usernameEl.innerText = 'Web';
    } else {
        // 未登录
        loginBtn.classList.add('flex');
        loginBtn.classList.remove('hidden');
        userDisplay.classList.add('hidden');
        userDisplay.classList.remove('flex');
    }
}
window.updateUserUI = updateUserUI;


// 页面加载时：检查是否开启认证，若开启则显示登出按钮
(async () => {
    try {
        const response = await fetch('/api/music/config');
        const config = await response.json();
        window.lx_config = config; // 获取公共配置供权限模块使用
        if (typeof config.downloadDir === 'string' && config.downloadDir.trim()) {
            settings = normalizeStoredSettings({ ...settings, downloadDir: config.downloadDir });
            window.settings = settings;
        }
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.classList.remove('hidden');
            logoutBtn.classList.add('flex');
        }

        // 获取到公共配置后，立即刷新一次 UI 状态 (管理员按钮/设置项禁用等)
        if (typeof syncSettingsUI === 'function') syncSettingsUI();

        // 同源请求自动携带 HttpOnly 全局 Token Cookie。
        authVerified = await ensureUserAuthToken();
        userToken = authVerified ? 'shared' : null;
        if (typeof syncSettingsUI === 'function') syncSettingsUI();

        await fetchSettingsFromServer();

        // [新增] 更新 UI 上的用户名状态
        updateUserUI();

    } catch (error) {
        console.error('[Auth] 初始化检查失败:', error);
    } finally {
        settingsReady = true;
        initializeRoute();
    }
})();

// ===== 认证代码结束 =====

// 音质选择器初始化
document.addEventListener('DOMContentLoaded', () => {
    // 音质选择器初始化
    const qualitySelect = document.getElementById('quality-select');
    if (qualitySelect && settings.preferredQuality) {
        qualitySelect.value = settings.preferredQuality;
    }

    const hotSearchLimitInput = document.getElementById('hot-search-limit-input');
    if (hotSearchLimitInput) {
        hotSearchLimitInput.value = (settings.hotSearchLimit !== undefined && settings.hotSearchLimit !== null) ? settings.hotSearchLimit : 20;
    }

    // Initialize SongList Manager
    if (window.SongListManager) {
        window.SongListManager.init();
    }

    // Initialize Lyric Font Size UI
    const lyricFontSizeSlider = document.getElementById('lyric-font-size-slider');
    const lyricFontSizeValue = document.getElementById('lyric-font-size-value');
    if (lyricFontSizeSlider && lyricFontSizeValue) {
        const size = settings.lyricFontSize || 1.25;
        lyricFontSizeSlider.value = size;
        lyricFontSizeValue.innerText = size;
        document.documentElement.style.setProperty('--lyric-font-size', `${size}rem`);
    }

    // Initialize Lyric Font Family UI
    const lyricFontFamilySelect = document.getElementById('lyric-font-family-select');
    if (lyricFontFamilySelect) {
        const fontFamily = settings.lyricFontFamily || '';
        // Check if value exists in default options, if not create it (unless empty)
        if (fontFamily) {
            let exists = Array.from(lyricFontFamilySelect.options).some(opt => opt.value === fontFamily);
            if (!exists) {
                const option = document.createElement('option');
                option.value = fontFamily;
                option.textContent = fontFamily; // Fallback display name
                lyricFontFamilySelect.add(option, null);
            }
            lyricFontFamilySelect.value = fontFamily;
            document.documentElement.style.setProperty('--lyric-font-family', fontFamily);
        }
    }

    // 同步所有设置 UI
    syncSettingsUI();
    updateUserUI();
});

function changeHotSearchLimit(value) {
    const limit = parseInt(value);
    // [Fix] Allow 0, Check Range 0-50
    if (!isNaN(limit) && limit >= 0 && limit <= 50) {
        updateSetting('hotSearchLimit', limit);
    } else {
        showError('请输入 0 到 50 之间的数字');
        // Reset input
        const input = document.getElementById('hot-search-limit-input');
        if (input) input.value = settings.hotSearchLimit || 20;
    }
}

// 读取本地字体
/**
 * 通用加载本地字体逻辑
 * @param {string} targetSelectId - 目标下拉框的 ID，默认为设置页的 'lyric-font-family-select'
 * @param {HTMLElement} btnEl - 触发按钮的引用，用于显示加载动画
 */
async function loadLocalFonts(targetSelectId = 'lyric-font-family-select', btnEl = null) {
    if (!('queryLocalFonts' in window)) {
        showError('抱歉，您的浏览器不支持读取本地字体功能 (Local Font Access API)。\n建议使用 Chrome / Edge 浏览器，并确保在 HTTPS 环境下使用。');
        return;
    }

    const btn = btnEl || document.querySelector('button[onclick="loadLocalFonts()"]');
    const originalText = btn ? btn.innerHTML : '';

    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>读取中...';
        }

        const fonts = await window.queryLocalFonts();
        const fontSelect = document.getElementById(targetSelectId);
        if (!fontSelect) return;

        // Use a set to store unique families
        const fontFamilies = new Set();
        fonts.forEach(font => fontFamilies.add(font.family));

        // Sort alphabetically
        const sortedFamilies = Array.from(fontFamilies).sort();

        if (sortedFamilies.length === 0) {
            showError('未能获取到字体列表');
            return;
        }

        // Remove existing local fonts group if exists
        const oldGroup = fontSelect.querySelector('optgroup[data-source="local"]');
        if (oldGroup) {
            oldGroup.remove();
        }

        // Create a single group for local fonts
        const group = document.createElement('optgroup');
        group.dataset.source = 'local';
        group.label = `本地已安装字体 (${sortedFamilies.length})`;

        sortedFamilies.forEach(family => {
            const option = document.createElement('option');
            // 设置页字体名保持原样
            option.value = targetSelectId === 'lc-font-select' ? `"${family}", sans-serif` : family;
            option.textContent = family;
            group.appendChild(option);
        });
        fontSelect.appendChild(group);

        showSuccess(`成功获取 ${sortedFamilies.length} 个本地字体！`);

    } catch (err) {
        console.error('[Font] Error loading fonts:', err);
        showError('获取字体失败: ' + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// 切换音质偏好
function changeQualityPreference(quality) {
    updateSetting('preferredQuality', quality);
}


// Hash routing and tab switching
function decodeRoutePart(value) {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
}

function normalizePlaylistRouteId(id) {
    const value = String(id || '');
    if (!value) return value;

    try {
        const url = new URL(value);
        const hashQueryIndex = url.hash.indexOf('?');
        const hashQuery = hashQueryIndex >= 0
            ? new URLSearchParams(url.hash.slice(hashQueryIndex + 1))
            : null;
        const queryId = url.searchParams.get('id') || url.searchParams.get('playlist_id') ||
            url.searchParams.get('playlistId') || hashQuery?.get('id') || hashQuery?.get('playlist_id');
        if (queryId) return queryId;
        const pathId = url.pathname.match(/(?:playlist|songlist|special|single)[^0-9]*(\d+)/i);
        if (pathId) return pathId[1];
    } catch (error) {
        // 非 URL 形式的 ID 直接保留原值。
    }

    const matched = value.match(/[?&](?:id|playlist_id|playlistId)=([^&#]+)/i);
    return matched ? decodeRoutePart(matched[1]) : value;
}

function buildPlaylistDetailRoute(context, source, id) {
    const base = context === 'my-playlists' ? 'my-playlists' : 'songlist';
    const routeId = normalizePlaylistRouteId(id);
    return `#/${base}/${encodeURIComponent(source || 'wy')}/${encodeURIComponent(routeId)}`;
}
window.buildPlaylistDetailRoute = buildPlaylistDetailRoute;
window.normalizePlaylistRouteId = normalizePlaylistRouteId;

function parseRoute() {
    const path = (location.hash || '').replace(/^#\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (parts[0] === 'subscriptions' || parts[0] === 'source-management') {
        return { type: 'tab', tab: parts[0] };
    }

    if (parts[0] === 'settings' && ['system', 'display', 'logs'].includes(parts[1])) {
        return { type: 'tab', tab: `settings-${parts[1]}` };
    }

    if (parts.length >= 3 && ['songlist', 'my-playlists'].includes(parts[0])) {
        return {
            type: 'detail',
            context: parts[0],
            source: decodeRoutePart(parts[1]),
            id: decodeRoutePart(parts.slice(2).join('/'))
        };
    }

    const tab = parts[0] || 'search';
    return { type: 'tab', tab: navigableTabs.has(tab) ? tab : 'search' };
}

function handleRouteChange() {
    const currentHash = location.hash || '#/search';
    if (currentHash === lastHandledRouteHash) return;
    lastHandledRouteHash = currentHash;

    const route = parseRoute();
    if (route.type === 'detail') {
        switchTab('songlist', {
            fromRoute: true,
            updateRoute: false,
            sidebarTab: route.context,
            detail: true
        });
        if (window.SongListManager?.openDetail) {
            window.SongListManager.openDetail(route.id, route.source, {
                returnTab: route.context,
                sidebarTab: route.context,
                updateRoute: false
            });
        }
        return;
    }

    const detailView = document.getElementById('view-songlist-detail');
    if (detailView) {
        detailView.style.transition = '';
        detailView.classList.add('hidden', 'opacity-0', 'translate-x-full');
        detailView.classList.remove('opacity-100');
    }
    switchTab(route.tab, { fromRoute: true, updateRoute: false });
}

function initializeRoute() {
    if (routeInitialized || document.readyState === 'loading') return;

    const hasExplicitRoute = Boolean(location.hash && location.hash !== '#');
    // 已有哈希路由时立即恢复页面，不要等待服务端设置请求完成后再切换。
    // 只有首次打开且没有路由时，才需要等待设置确定默认入口。
    if (!settingsReady && !hasExplicitRoute) return;

    routeInitialized = true;

    if (!hasExplicitRoute) {
        const defaultTab = navigableTabs.has(settings.defaultEntry) ? settings.defaultEntry : 'search';
        const defaultRoute = tabRoutes[defaultTab] || tabRoutes.search;
        history.replaceState({ route: defaultRoute }, '', defaultRoute);
    }

    handleRouteChange();
}

function ensureDetailViewPlacement() {
    const detailView = document.getElementById('view-songlist-detail');
    const searchView = document.getElementById('view-search');
    const viewsContainer = searchView?.parentElement;
    if (detailView && viewsContainer && detailView.parentElement !== viewsContainer) {
        viewsContainer.appendChild(detailView);
    }
}
ensureDetailViewPlacement();

function navigateToRoute(route) {
    if (!route || location.hash === route) return;
    // 前进导航使用 pushState，避免 hashchange 异步回调与当前页面切换互相覆盖。
    history.pushState({ route }, '', route);
}

window.addEventListener('popstate', handleRouteChange);
window.addEventListener('hashchange', handleRouteChange);
// 某些 Chrome 扩展页/嵌入环境在同文档历史回退时只更新地址，不派发路由事件。
// 低频检查作为兜底，避免地址与实际视图不一致。
window.setInterval(() => {
    if ((location.hash || '#/search') !== lastHandledRouteHash) {
        handleRouteChange();
    }
}, 200);

// 侧栏菜单直接绑定点击处理，避免首次点击时只执行锚点默认跳转而没有切换视图。
function bindSidebarNavigation() {
    document.querySelectorAll('#main-sidebar a[id^="tab-"]').forEach(anchor => {
        if (anchor.dataset.navigationBound === 'true') return;
        anchor.dataset.navigationBound = 'true';
        anchor.addEventListener('click', event => {
            event.preventDefault();
            switchTab(anchor.id.slice(4));
        });
    });
}
bindSidebarNavigation();
document.addEventListener('DOMContentLoaded', bindSidebarNavigation, { once: true });

function switchTab(tabId, options = {}) {
    const isFromRoute = options.fromRoute === true;
    if (!isFromRoute && options.updateRoute !== false) {
        const route = options.route || tabRoutes[options.sidebarTab || tabId];
        navigateToRoute(route);
    }

    const settingsSection = ['system', 'display', 'logs'].find(section => tabId === `settings-${section}`)
        || (tabId === 'settings' ? 'system' : null);
    const viewTabId = options.detail ? 'songlist-detail' : (settingsSection ? 'settings' : tabId);
    const sidebarTabId = options.sidebarTab || (settingsSection ? `settings-${settingsSection}` : tabId);

    document.querySelectorAll('[id^="view-"]').forEach(el => {
        el.classList.add('hidden');
        el.classList.remove('opacity-100');
        el.classList.add('opacity-0');
    });

    const activeView = document.getElementById(`view-${viewTabId}`);
    if (!activeView) return;

    activeView.classList.remove('hidden');
    if (options.detail) {
        // 详情是独立视图。显式隐藏歌单列表，避免异步加载或旧的过渡状态让两个视图同时可见。
        const songListView = document.getElementById('view-songlist');
        if (songListView && songListView !== activeView) {
            songListView.classList.add('hidden', 'opacity-0');
            songListView.classList.remove('opacity-100');
        }
    }
    // small delay to allow display block to apply before opacity transition
    setTimeout(() => {
        activeView.classList.remove('opacity-0');
        activeView.classList.add('opacity-100');
        // [新增] 切换 Tab 时顺便检查并更新一次用户状态
        if (typeof updateUserUI === 'function') updateUserUI();
    }, 10);

    // [新增] 切换到设置页面时刷新一次管理员状态和设置项 UI
    if (settingsSection) {
        if (typeof syncSettingsUI === 'function') syncSettingsUI();
        if (typeof switchSettingsTab === 'function') switchSettingsTab(settingsSection);
    }

    // Reset Sidebar Highlight
    document.querySelectorAll('[id^="tab-"]').forEach(el => {
        el.classList.remove('active-tab', 'text-emerald-600');
        el.classList.add('t-text-muted');
    });
    const activeTab = document.getElementById(`tab-${sidebarTabId}`);
    if (activeTab) {
        activeTab.classList.add('active-tab');
        activeTab.classList.remove('t-text-muted');
    }

    // Clear any pending timeouts

    // Auto-exit secondary modes (search/batch) when switching tabs
    exitListSecondaryModes();

    // Mobile: Close sidebar when switching tabs.
    if (window.innerWidth <= 1024) {
        const sidebar = document.getElementById('main-sidebar');
        if (sidebar && !sidebar.classList.contains('-translate-x-full')) {
            toggleSidebar();
        }
    }

    // Always clear sub-item highlight when switching top-level tabs
    document.querySelectorAll('[data-sidebar-list-id]').forEach(el => {
        el.classList.remove('active-sub-item');
        el.classList.add('t-text-muted');
    });

    // Reset Search Scope if switching to search/settings explicitly
    if (tabId === 'search') {
        initGlobalListSearch(); // [New] 强制重置 ListSearch 为 'global' 模式
        currentSearchScope = 'network';
        document.getElementById('search-source').classList.remove('hidden');
        document.getElementById('search-type').classList.remove('hidden');
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.placeholder = "搜索歌曲、歌手...";
            // 如果搜索框内容为空，则展示初始热搜状态，避免由于重用搜索界面展示本地列表导致的残留
            if (!searchInput.value.trim()) {
                showInitialSearchState();
            }
        }
        document.getElementById('page-title').innerText = "搜索音乐";
    }

    if (tabId === 'songlist') {
        document.getElementById('page-title').innerText = "歌单";
    }

    if (tabId === 'leaderboard') {
        document.getElementById('page-title').innerText = "排行榜";
        if (window.LeaderboardManager && !window.LeaderboardManager.initialized) {
            window.LeaderboardManager.init();
        }
    }

    if (tabId === 'localmusic') {
        document.getElementById('page-title').innerText = "本地音乐";
    }

    if (tabId === 'downloads') {
        document.getElementById('page-title').innerText = "下载管理";
    }

    if (tabId === 'my-playlists') {
        document.getElementById('page-title').innerText = "我的歌单";
        renderImportedPlaylists();
        void refreshImportedPlaylists();
    }

    if (tabId === 'subscriptions') {
        document.getElementById('page-title').innerText = "订阅歌单";
        if (window.SubscriptionManager?.renderSettingsPanel) {
            void window.SubscriptionManager.renderSettingsPanel();
        }
    }

    if (tabId === 'source-management') {
        document.getElementById('page-title').innerText = "音源管理";
        if (typeof loadCustomSources === 'function') {
            void loadCustomSources();
        }
    }

    // Title update (handled above for search, others here)
    if (settingsSection) {
        const settingsTitles = { system: '系统设置', display: '显示设置', logs: '系统日志' };
        document.getElementById('page-title').innerText = settingsTitles[settingsSection];
        // 确保设置界面的自定义源列表是最新的
        if (settingsSection === 'system' && typeof loadCustomSources === 'function') {
            loadCustomSources();
        }
    }

    // Auto-exit batch mode when switching tabs (Redundant but safe)
    if (window.batchMode && typeof toggleBatchMode === 'function') {
        toggleBatchMode();
    }
}

/**
 * 退出列表的二级模式（搜索框和批量模式）
 */
function exitListSecondaryModes() {
    if (window.ListSearch && window.ListSearch.state.active) {
        window.ListSearch.resetState();
    }
    if (window.batchMode) {
        // 搜索/歌单界面退出
        const batchToolbar = document.getElementById('batch-toolbar');
        const slBatchInlineActions = document.getElementById('sl-batch-inline-actions');
        if ((batchToolbar && !batchToolbar.classList.contains('hidden')) || (slBatchInlineActions && !slBatchInlineActions.classList.contains('hidden'))) {
            if (typeof toggleBatchMode === 'function') toggleBatchMode();
        }

        // 排行榜界面退出
        const lbBatchToolbar = document.getElementById('lb-batch-toolbar');
        if (lbBatchToolbar && !lbBatchToolbar.classList.contains('hidden')) {
            if (typeof toggleLbBatchMode === 'function') toggleLbBatchMode();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // 恢复搜索来源缓存
    const cachedSearchSource = localStorage.getItem('search-source');
    if (cachedSearchSource) {
        const searchSourceEl = document.getElementById('search-source');
        if (searchSourceEl) searchSourceEl.value = cachedSearchSource;
    }

    ensureDetailViewPlacement();
    initializeRoute();
});

// Search Logic
function handleSearchKeyPress(e) {
    if (e.key === 'Enter') {
        if (typeof hideSearchSuggestions === 'function') hideSearchSuggestions();
        doSearch();
    }
}

/**
 * 快速跳转到搜索页并执行查询
 * @param {string} query 搜索关键词
 * @param {string} source 可选，切换到指定搜索源
 */
function performSearch(query, source = null) {
    if (!query || query === '暂无播放' || query === '选择一首歌曲播放') return;

    // 预处理：移除括号及其内容 (支持中英文括号)，通常用于移除“歌曲名 (DJ版)”中的补充信息
    let cleanedQuery = query.replace(/\s*[\(\uff08].*?[\)\uff09]\s*/g, ' ').trim();
    // 避免因为移除内容导致的连续多余空格
    cleanedQuery = cleanedQuery.replace(/\s+/g, ' ');

    // 切换到搜索页
    switchTab('search');

    // 如果指定了源且属于支持的源，则更新选择框
    const sourceEl = document.getElementById('search-source');
    const validSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
    if (source && sourceEl && validSources.includes(source)) {
        sourceEl.value = source;
    }

    // 重置搜索范围到全网搜索
    if (typeof currentSearchScope !== 'undefined') {
        currentSearchScope = 'network';
    }

    // 设置搜索框内容
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = cleanedQuery || query; // 如果清理后为空，回退到原查询
        // 触发搜索
        doSearch();
    }
}
window.performSearch = performSearch;

let lastSearchResultList = null;
let lastSearchType = null;

function handleSearchTypeChange() {
    const typeSelect = document.getElementById('search-type');
    const sourceSelect = document.getElementById('search-source');
    if (!typeSelect || !sourceSelect) return;

    if (typeSelect.value === 'singer' || typeSelect.value === 'album') {
        // 只有 wy 和 tx 支持歌手/专辑搜索
        if (sourceSelect.value !== 'wy' && sourceSelect.value !== 'tx') {
            sourceSelect.value = 'wy';
        }
        // 禁用不支持的选项
        Array.from(sourceSelect.options).forEach(opt => {
            opt.disabled = (opt.value !== 'wy' && opt.value !== 'tx');
        });
    } else {
        Array.from(sourceSelect.options).forEach(opt => { opt.disabled = false; });
    }
    doSearch();
}
window.handleSearchTypeChange = handleSearchTypeChange;

const SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg'];


//搜索歌曲
async function doSearch(page = 1, append = false, prefetch = false) {
    const typeEl = document.getElementById('search-type');
    const type = typeEl ? typeEl.value : 'song';

    // 触发搜索时隐藏联想词
    if (typeof hideSearchSuggestions === 'function') hideSearchSuggestions();

    // 新搜索开始，隐藏返回按钮并清空记录
    const backBtn = document.getElementById('search-back-btn');
    if (backBtn) backBtn.classList.add('hidden');
    lastSearchResultList = null;
    lastSearchType = null;

    // 只有在开启全新搜索（第一页且非追加模式）时才重置局部过滤状态
    if (window.ListSearch && page === 1 && !append) window.ListSearch.resetState();

    const input = document.getElementById('search-input').value.trim();
    const resultsContainer = document.getElementById('search-results');

    // Network Search Logic
    const source = document.getElementById('search-source').value;
    //翻页步长
    const FETCH_PAGES_STEP = 1;

    // 保存到缓存
    localStorage.setItem('search-source', source);

    if (!input) {
        showInitialSearchState();
        return;
    }

    if (!append) {
        currentSearch = { name: input, source };
        currentPage = 1;
        window.currentNetworkPage = page;
        resultsContainer.innerHTML = '<div class="flex items-center justify-center h-full"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';
    } else {
        window.currentNetworkPage = page;
    }

    try {
        const headers = {};
        Object.assign(headers, getUserAuthHeaders());

        let list = [];
        if (source === 'all') {
            // Aggregate Search (Only supported for songs)
            const pageInfoEl = document.getElementById('page-info');
            if (pageInfoEl) pageInfoEl.innerText = `聚合搜索 (前20条/源)`;

            const promises = SOURCES.map(s =>
                fetch(`${APP_API_BASE}/search?name=${encodeURIComponent(input)}&source=${s}&page=1&type=${type}`, { headers })
                    .then(res => res.json())
                    .then(data => data.map(item => ({ ...item, source: s })))
                    .catch(e => {
                        console.warn(`[聚合搜索] ${s} 源失败:`, e);
                        return [];
                    })
            );
            const results = await Promise.all(promises);
            list = results.flat();
        } else {
            // Single Source Search — 支持前端决定拉取多少页
            const res = await fetch(`${APP_API_BASE}/search?name=${encodeURIComponent(input)}&source=${source}&type=${type}&page=${page}&pages=${FETCH_PAGES_STEP}`, { headers });

            if (!res.ok) {
                throw new Error(`搜索请求失败: ${res.status} ${res.statusText}`);
            }

            const data = await res.json();

            // 检查返回的数据是否为数组
            if (!Array.isArray(data)) {
                console.error('[Search] 后端返回非数组数据:', data);
                throw new Error(data.error || data.message || '搜索返回的数据格式错误');
            }

            list = data.map(item => ({ ...item, source }));
        }

        // song/singer/album 统一支持 append 追加翻页
        if (append && (type === 'song' || type === 'singer' || type === 'album')) {
            // [Fix] Ensure each new song has unique ID
            if (list && list.length > 0) {
                list.forEach((item, idx) => {
                    if (!item.id || item.id === 'undefined') {
                        item.id = item.songmid || item.songId || item.hash || item.copyrightId || item.mid || item.mediaMid || `temp_${Date.now()}_${idx}_append`;
                    }
                });
            }
            const existingIds = new Set((window.viewingPlaylist || []).map(item => String(item.id)));
            const newItems = list.filter(item => !existingIds.has(String(item.id)));

            if (newItems.length > 0) {
                const combinedList = [...(window.viewingPlaylist || []), ...newItems];
                if (!prefetch) currentPage++;
                if (type === 'singer') renderSingerResults(combinedList);
                else if (type === 'album') renderAlbumResults(combinedList);
                else renderResults(combinedList);
            } else {
                showInfo('没有更多搜索结果了');
            }
        } else {
            if (type === 'singer') renderSingerResults(list);
            else if (type === 'album') renderAlbumResults(list);
            else renderResults(list);
        }
    } catch (e) {
        console.error('[Search] 搜索失败:', e);
        if (append) {
            try {
                showError(`搜索追加出错: ${escapeHtmlText(e.message)}`);
            } catch (err) {
                showError(`搜索追加出错: ${escapeHtmlText(e.message)}`);
            }
        } else {
            resultsContainer.innerHTML = `<div class="text-center text-red-500 p-8">搜索出错: ${escapeHtmlText(e.message)}</div>`;
        }
    }
}

function changePage(delta) {
    const source = document.getElementById('search-source').value;
    if (source === 'all') {
        showInfo('聚合搜索模式暂不支持翻页');
        return;
    }
    const newPage = currentPage + delta;
    if (newPage < 1) return;
    doSearch(newPage);
}

// ========== 热搜功能 ==========
let hotSearchCache = null;
let hotSearchCacheTime = 0;
const HOT_SEARCH_CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

async function fetchHotSearch(source = 'mg') {
    // 检查缓存（必须匹配 source）
    if (hotSearchCache &&
        hotSearchCache.source === source && // Add checking source
        Date.now() - hotSearchCacheTime < HOT_SEARCH_CACHE_DURATION) {
        return hotSearchCache;
    }

    try {
        // [优化] 使用低优先级 fetch 获取热搜，避免阻塞主加载
        const res = await fetch(`${APP_API_BASE}/hotSearch?source=${source}`, { priority: 'low' });
        if (!res.ok) {
            throw new Error(`获取热搜失败: ${res.status}`);
        }
        const data = await res.json();

        // 更新缓存
        hotSearchCache = data;
        // Ensure data also carries the source info if not present
        if (!hotSearchCache.source) hotSearchCache.source = source;

        hotSearchCacheTime = Date.now();

        return data;
    } catch (e) {
        console.error('[HotSearch] 获取热搜失败:', e);
        return null;
    }
}

function renderHotSearch(data) {
    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');

    // 隐藏表头
    if (header) {
        header.classList.add('hidden');
    }

    // [Fix] If limit is 0, treat as disabled and show default state
    if (!container || !data || !data.list || data.list.length === 0 || settings.hotSearchLimit === 0) {
        // 显示默认空白状态
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full t-text-muted space-y-4">
                <i class="fas fa-music text-6xl opacity-20"></i>
                <p>输入关键词开始搜索音乐</p>
            </div>
        `;
        return;
    }

    const sourceTag = getSourceTag(data.source);
    // [Fix] Correctly handle 0, do not fall back to 20 if 0 is set
    const limit = (settings.hotSearchLimit !== undefined && settings.hotSearchLimit !== null) ? settings.hotSearchLimit : 20;
    const keywords = data.list.slice(0, limit); // 使用设置的数量

    container.innerHTML = `
        <div class="hot-search-container px-4 py-8 md:p-8">
            <div class="flex items-center mb-6">
                <i class="fas fa-fire text-orange-500 text-2xl mr-3"></i>
                <h3 class="text-xl font-bold t-text-main">热门搜索</h3>
                <span class="ml-3">${sourceTag}</span>
            </div>
            <div class="hot-search-list grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 md:gap-3">
                ${keywords.map((keyword, index) => `
                    <button onclick="handleHotSearchClick(${htmlJs(keyword)})"
                            class="hot-search-item group flex items-center px-2.5 py-3 md:p-3 t-bg-panel hover:bg-emerald-50 border t-border-main hover:border-emerald-400 rounded-lg transition-all shadow-sm hover:shadow-md overflow-hidden h-14">
                        <span class="rank flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold mr-3 ${index < 3 ? 'bg-gradient-to-r from-orange-400 to-red-500 text-white' : 'bg-gray-100 text-gray-500'
        }">
                            ${index + 1}
                        </span>
                        <span class="keyword flex-1 text-left text-sm font-medium t-text-main group-hover:text-emerald-600 truncate">
                            ${escapeHtmlText(keyword)}
                        </span>
                        <i class="fas fa-search text-xs text-gray-300 group-hover:text-emerald-500 transition-colors ml-2"></i>
                    </button>
                `).join('')}
            </div>
            <div class="mt-6 text-center">
                <button onclick="showInitialSearchState()" 
                        class="text-sm t-text-muted hover:text-emerald-500 transition-colors">
                    <i class="fas fa-sync-alt mr-1"></i>
                    刷新热搜
                </button>
            </div>
        </div>
    `;

    // 动态检测溢出并应用滚动效果
    setTimeout(() => {
        const items = container.querySelectorAll('.hot-search-item .keyword');
        items.forEach(el => {
            if (el.scrollWidth > el.clientWidth) {
                const text = el.textContent.trim();
                el.classList.remove('truncate');
                // 使用 mask-image 实现渐变列表
                el.innerHTML = `
                    <div class="w-full overflow-hidden relative" style="mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%); -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);">
                        <div class="inline-block whitespace-nowrap animate-marquee hover-scroll-paused" style="will-change: transform;">
                             <span>${escapeHtmlText(text)}</span>
                             <span class="mx-8"></span>
                             <span>${escapeHtmlText(text)}</span>
                             <span class="mx-8"></span>
                        </div>
                    </div>
                `;
            }
        });
    }, 0);
}

function handleHotSearchClick(keyword) {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = keyword;
        doSearch();
    }
}

function showInitialSearchState() {
    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');

    // 隐藏表头
    if (header) {
        header.classList.add('hidden');
    }

    // 显示加载状态
    container.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full t-text-muted space-y-4">
            <i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i>
            <p>正在加载热门搜索...</p>
        </div>
    `;

    // 异步获取并显示热搜
    const sourceSelect = document.getElementById('search-source');
    const source = sourceSelect ? sourceSelect.value : 'wy';

    fetchHotSearch(source).then(data => {
        renderHotSearch(data);
    }).catch(err => {
        console.error('[HotSearch] 显示热搜失败:', err);
        // 失败时显示默认状态
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full t-text-muted space-y-4">
                <i class="fas fa-music text-6xl opacity-20"></i>
                <p>输入关键词开始搜索音乐</p>
            </div>
        `;
    });
}


function getQualityTags(item) {
    const tags = [];
    // 兼容多种音质字段位置:
    // 1. types / _types (旧版/部分源)
    // 2. qualitys / _qualitys (新版/标准)
    // 3. meta.qualitys (收藏列表)
    const rawTypes = item.types || item._types ||
        item.qualitys || item._qualitys ||
        (item.meta && (item.meta.qualitys || item.meta._qualitys)) ||
        {};

    // Normalize types check
    let has320 = false;
    let hasFlac = false;
    let hasHiRes = false;
    let hasAtmos = false;
    let hasMaster = false;

    if (Array.isArray(rawTypes)) {
        const isConcrete = t => !(t && t.isPlatformQuality);
        has320 = rawTypes.some(t => t.type === '320k');
        hasFlac = rawTypes.some(t => t.type === 'flac');
        hasHiRes = rawTypes.some(t => (t.type === 'flac24bit' || t.type === 'hires') && isConcrete(t));
        hasAtmos = rawTypes.some(t => (t.type === 'atmos' || t.type === 'atmos_plus') && isConcrete(t));
        hasMaster = rawTypes.some(t => t.type === 'master' && isConcrete(t));
    } else {
        has320 = !!rawTypes['320k'];
        hasFlac = !!rawTypes['flac'];
        hasHiRes = !!(rawTypes['flac24bit'] && !rawTypes['flac24bit'].isPlatformQuality) || !!(rawTypes.hires && !rawTypes.hires.isPlatformQuality);
        hasAtmos = !!(rawTypes.atmos && !rawTypes.atmos.isPlatformQuality) || !!(rawTypes.atmos_plus && !rawTypes.atmos_plus.isPlatformQuality);
        hasMaster = !!(rawTypes.master && !rawTypes.master.isPlatformQuality);
    }

    // [New] 额外检查具体音质字段 (适用于本地歌曲或已确定音质的播放中歌曲)
    const q = item.quality || item.type;
    if (q) {
        if (q === 'master') hasMaster = true;
        else if (q === 'atmos' || q === 'atmos_plus') hasAtmos = true;
        else if (q === 'flac24bit' || q === 'hires') hasHiRes = true;
        else if (q === 'flac') hasFlac = true;
        else if (q === '320k') has320 = true;
    }

    if (hasMaster) tags.push('<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-purple border border-purple-200 dark:border-purple-500/30 transition-colors">Master</span>');
    else if (hasAtmos) tags.push('<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-blue border border-cyan-200 dark:border-cyan-500/30 transition-colors">Atmos</span>');
    else if (hasHiRes) tags.push('<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-yellow border border-yellow-200 dark:border-yellow-500/30 transition-colors">24bit无损</span>');
    else if (hasFlac) tags.push('<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-green border border-emerald-200 dark:border-emerald-500/30 transition-colors">无损</span>');
    else if (has320) tags.push('<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-blue border border-blue-200 dark:border-blue-500/30 transition-colors">高品质</span>');

    return tags.join('');
}
window.getQualityTags = getQualityTags;

function getSourceTag(source) {
    const colors = {
        kw: 't-badge-yellow border-yellow-200 dark:border-yellow-500/30',
        kg: 't-badge-blue border-blue-200 dark:border-blue-500/30',
        tx: 't-badge-green border-green-200 dark:border-emerald-500/30',
        wy: 't-badge-red border-red-200 dark:border-red-500/30',
        mg: 't-badge-pink border-pink-200 dark:border-pink-500/30'
    };
    const names = { kw: '酷我', kg: '酷狗', tx: 'QQ', wy: '网易', mg: '咪咕' };
    const color = colors[source] || 't-bg-main t-text-muted t-border-main';
    const name = names[source] || String(source || '').toUpperCase();
    return `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] font-bold border ${color} mr-1">${escapeHtmlText(name)}</span>`;
}
window.getSourceTag = getSourceTag;



function renderSingerResults(list) {
    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');
    if (header) header.classList.add('hidden');
    // 搜索歌手时隐藏底部分页栏
    const paginationBar = document.getElementById('search-pagination-bar');
    if (paginationBar) paginationBar.classList.add('hidden');

    window.viewingPlaylist = list;
    currentPlaylist = list || [];

    container.innerHTML = '<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2 md:gap-4 p-3 md:p-6"></div>';
    const grid = container.querySelector('div');
    list.forEach((singer, idx) => {
        const div = document.createElement('div');
        div.className = 'group flex flex-col items-center p-2 md:p-4 rounded-2xl transition-all hover:t-bg-panel hover:shadow-md cursor-pointer border border-transparent hover:border-emerald-500/30';
        div.dataset.singerId = singer.id;
        div.dataset.singerSource = singer.source || 'wy';
        div.onclick = () => enterArtist(singer.id, singer.source || 'wy');
        const aliasHtml = singer.alias && singer.alias.length
            ? `<span class="text-[9px] md:text-[10px] t-text-muted text-center truncate w-full mt-0.5 md:mt-1">${escapeHtmlText(singer.alias[0])}</span>`
            : '';
        div.innerHTML = `
            <div class="relative mb-2 md:mb-3">
                <div class="w-16 h-16 sm:w-24 sm:h-24 md:w-32 md:h-32 rounded-full overflow-hidden shadow-sm">
                    <img src="${htmlImageUrl(singer.picUrl || './assets/logo.svg')}"
                         onerror="this.src='./assets/logo.svg'"
                         class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500">
                </div>
            </div>
            <span class="text-[11px] md:text-sm font-bold t-text-main text-center truncate w-full" title="${escapeHtmlText(singer.name)}">${escapeHtmlText(singer.name)}</span>
            <div class="flex flex-col items-center mt-1">
                ${aliasHtml}
                <div class="mt-1">${getSourceTag ? getSourceTag(singer.source || 'wy') : (singer.source || 'wy').toUpperCase()}</div>
            </div>
            <span class="hidden md:inline-block text-[10px] px-2 py-0.5 mt-2 rounded bg-emerald-500 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                ${escapeHtmlText(singer.albumSize || 0)} 专辑
            </span>
        `;
        grid.appendChild(div);
    });
}

function renderAlbumResults(list) {
    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');
    if (header) header.classList.add('hidden');
    // 搜索专辑时隐藏底部分页栏
    const paginationBar = document.getElementById('search-pagination-bar');
    if (paginationBar) paginationBar.classList.add('hidden');

    window.viewingPlaylist = list;

    container.innerHTML = '<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 p-6"></div>';
    const grid = container.querySelector('div');
    list.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'group flex flex-col p-3 rounded-2xl transition-all hover:t-bg-panel hover:shadow-lg cursor-pointer border border-transparent hover:border-emerald-500/20';
        div.onclick = () => enterAlbum(item.id, item.source || 'wy');
        const publishDate = item.publishTime ? new Date(item.publishTime).toLocaleDateString() : '';
        div.innerHTML = `
            <div class="aspect-square rounded-xl overflow-hidden shadow-md mb-3 relative">
                <img src="${htmlImageUrl(item.picUrl || './assets/logo.svg')}"
                     onerror="this.src='./assets/logo.svg'"
                     class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
            </div>
            <span class="text-sm font-bold t-text-main line-clamp-2 h-10 leading-5 mb-1" title="${escapeHtmlText(item.name)}">${escapeHtmlText(item.name)}</span>
            <div class="flex items-center justify-between mt-1">
                <span class="text-[10px] t-text-muted truncate flex-1">${escapeHtmlText(item.artistName || '未知歌手')}</span>
                <span class="text-[10px] t-text-muted ml-2">${publishDate}</span>
            </div>
        `;
        grid.appendChild(div);
    });
}

function formatPlayCount(count) {
    if (!count) return '0';
    if (count > 100000000) return (count / 100000000).toFixed(1) + '亿';
    if (count > 10000) return (count / 10000).toFixed(1) + '万';
    return count;
}


let currentArtistId = null;
let currentArtistSource = 'wy';
let currentArtistInfo = null;
window.currentArtistId = null;
window.currentArtistSource = 'wy';
window.currentArtistOrder = 'hot';

async function enterArtist(id, source = 'wy', order = 'hot', tab = 'songs', isBack = false) {
    const typeEl = document.getElementById('search-type');

    // 记录返回状态 (仅当从非歌手列表进入 且 不是从子页面返回时)
    if (!isBack && document.getElementById('artist-detail-header') === null) {
        lastSearchType = typeEl ? typeEl.value : 'singer';
        lastSearchResultList = [...(window.viewingPlaylist || [])];
        currentArtistInfo = null; // 重置缓存
        window.history.pushState({ page: 'search-detail' }, '');
    }

    const previousArtistOrder = window.currentArtistOrder || 'hot';
    const isDifferentArtist = String(currentArtistId || '') !== String(id) || currentArtistSource !== source;
    const isDifferentOrder = previousArtistOrder !== order;
    if (isDifferentArtist || (tab === 'songs' && isDifferentOrder)) {
        window.currentArtistSongsCache = null;
        window.artistSongsPage = 1;
        if (window.ListSearch) window.ListSearch.resetState();
    }
    if (isDifferentArtist) {
        window.currentArtistAlbumsCache = null;
    }

    currentArtistId = id;
    currentArtistSource = source;
    window.currentArtistId = id;
    window.currentArtistSource = source;
    window.currentArtistOrder = order;
    window.currentArtistTab = tab;
    const resultsContainer = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');
    if (header) header.classList.add('hidden');

    // 只有在没有缓存或者 ID 变化时才获取详情
    if (!currentArtistInfo || String(currentArtistInfo.id) !== String(id) || currentArtistInfo.source !== source) {
        // 如果还没有头部，显示加载
        if (!document.getElementById('artist-detail-header')) {
            resultsContainer.innerHTML = '<div class="flex items-center justify-center h-full"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';
        }

        try {
        const detailRes = await fetch(`${APP_API_BASE}/artistDetail?id=${id}&source=${source}`);
            if (!detailRes.ok) throw new Error('Failed to fetch artist detail');
            currentArtistInfo = await detailRes.json();
        } catch (e) {
            showError(`获取歌手详情失败: ${escapeHtmlText(e.message)}`);
            goBackToSearch();
            return;
        }
    }

    // 渲染头部
    renderArtistHeader(currentArtistInfo, tab, order);

    // 加载具体内容
    if (tab === 'songs') {
        await loadArtistSongs(id, source, order);
    } else if (tab === 'albums') {
        await loadArtistAlbums(id, source);
    }

    const backBtn = document.getElementById('search-back-btn');
    if (backBtn) backBtn.classList.remove('hidden');
}

let isArtistFolded = false;

function renderArtistHeader(info, activeTab, order) {
    const container = document.getElementById('search-results');
    const isMobile = window.innerWidth < 768;

    // 计算各状态下的样式类和内联样式，确保与 toggleArtistFold 完全一致
    const headerPadding = isArtistFolded ? 'p-3 md:p-4' : 'p-6 md:p-8';
    const nameTransform = isArtistFolded
        ? (isMobile ? 'translate(40px, -30px) scale(0.65)' : 'translate(30px, 0px) scale(0.65)')
        : 'translate(0, 0) scale(1)';
    const tabsClass = isArtistFolded ? 'mt-1 pt-2' : 'mt-8 pt-6';

    let headerHtml = `
        <div id="artist-detail-header" class="relative ${headerPadding} is-folded t-bg-panel/50 border-b t-border-main transition-all duration-500 ease-in-out overflow-hidden group/header" style="${isArtistFolded ? 'min-height: ' + (isMobile ? '0px' : '90px') + ';' : ''}">
            <!-- Small Absolute Back Button -->
            <button onclick="goBackToSearch()" class="absolute top-2 left-2 md:top-4 md:left-4 w-8 h-8 md:w-10 md:h-10 flex items-center justify-center rounded-full bg-emerald-500/80 hover:bg-emerald-500 text-white transition-all z-30 shadow-md active:scale-90" title="返回搜索">
                <i class="fas fa-arrow-left"></i>
            </button>
            <!-- Fold Toggle Button -->
            <button id="artist-fold-btn" onclick="toggleArtistFold()" class="absolute top-2 right-2 md:top-4 md:right-4 w-8 h-8 md:w-10 md:h-10 flex items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 t-text-main transition-all z-30 shadow-sm active:scale-90" title="折叠/展开">
                <i class="fas fa-chevron-up transition-transform duration-500 ${isArtistFolded ? 'rotate-180' : ''}" id="artist-fold-icon"></i>
            </button>

            <div id="artist-main-layout" class="flex flex-col md:flex-row gap-6 md:gap-8 ${isArtistFolded && isMobile ? 'items-start text-left' : 'items-center md:items-start text-center md:text-left'} transition-all duration-500">
                <div id="artist-avatar-container" class="w-32 h-32 md:w-40 md:h-40 rounded-full overflow-hidden shadow-2xl ring-4 ring-emerald-500/20 flex-shrink-0 transition-all duration-500 origin-center" style="${isArtistFolded ? 'transform: scale(0); opacity: 0; width: 0; height: 0; margin: 0;' : ''}">
                    <img src="${info.avatar || './assets/logo.svg'}" 
                         onerror="this.src='./assets/logo.svg'"
                         class="w-full h-full object-cover">
                </div>
                <div class="flex-1 min-w-0">
                    <h2 id="artist-name-display" class="text-3xl md:text-4xl font-black t-text-main mb-2 transition-all duration-500 origin-left pointer-events-none" style="transform: ${nameTransform}; margin-bottom: ${isArtistFolded ? '0' : ''};">${escapeHtmlText(info.name)}</h2>
                    <div id="artist-collapsible-section" class="transition-all duration-500 ${isArtistFolded ? 'opacity-0 max-h-0' : 'opacity-100 max-h-[500px]'}">
                        <div id="artist-stats-bar" class="flex flex-wrap justify-center md:justify-start gap-3 mb-3 text-sm font-medium transition-all duration-500">
                            <span class="px-3 py-1 rounded-full t-bg-main t-text-muted border t-border-main">
                                <i class="fas fa-music mr-1.5 text-emerald-500"></i>${escapeHtmlText(info.musicSize)} 歌曲
                            </span>
                            <span class="px-3 py-1 rounded-full t-bg-main t-text-muted border t-border-main">
                                <i class="fas fa-compact-disc mr-1.5 text-blue-500"></i>${escapeHtmlText(info.albumSize)} 专辑
                            </span>
                        </div>
                        <div class="relative group">
                            <p id="artist-bio-text" class="text-sm t-text-muted leading-relaxed line-clamp-3 overflow-y-auto max-h-32 transition-all cursor-pointer bg-black/5 dark:bg-white/5 p-3 rounded-lg custom-scrollbar" 
                            onclick="this.classList.toggle('line-clamp-3')" title="点击展开/收回详情">
                                ${escapeHtmlText(info.desc || '暂无简介')}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
            
            <div id="artist-tabs-bar" class="flex items-end justify-between ${tabsClass} border-t t-border-main transition-all duration-500 relative z-40" style="min-height: 48px;">
                <div class="flex gap-8">
                    <button onclick="enterArtist(${htmlJs(info.id)}, ${htmlJs(info.source)}, ${htmlJs(order)}, 'songs')"
                            class="pb-2 text-sm font-bold transition-all relative ${activeTab === 'songs' ? 't-text-main' : 't-text-muted hover:t-text-main'}">
                        所有歌曲
                        ${activeTab === 'songs' ? '<div class="absolute bottom-0 left-0 right-0 h-1 bg-emerald-500 rounded-full"></div>' : ''}
                    </button>
                    <button onclick="enterArtist(${htmlJs(info.id)}, ${htmlJs(info.source)}, ${htmlJs(order)}, 'albums')"
                            class="pb-2 text-sm font-bold transition-all relative ${activeTab === 'albums' ? 't-text-main' : 't-text-muted hover:t-text-main'}">
                        所有专辑
                        ${activeTab === 'albums' ? '<div class="absolute bottom-0 left-0 right-0 h-1 bg-emerald-500 rounded-full"></div>' : ''}
                    </button>
                </div>
                
                ${activeTab === 'songs' ? `
                <div class="flex p-1 mb-1 t-bg-main rounded-lg border t-border-main shadow-sm relative z-50">
                    <button onclick="enterArtist(${htmlJs(info.id)}, ${htmlJs(info.source)}, 'hot', 'songs')"
                            class="px-4 py-1.5 text-xs font-bold rounded-md transition-all ${order === 'hot' ? 'bg-emerald-500 text-white shadow-sm' : 't-text-muted hover:t-bg-track'}">
                        热门
                    </button>
                    <button onclick="enterArtist(${htmlJs(info.id)}, ${htmlJs(info.source)}, 'time', 'songs')"
                            class="px-4 py-1.5 text-xs font-bold rounded-md transition-all ${order === 'time' ? 'bg-emerald-500 text-white shadow-sm' : 't-text-muted hover:t-bg-track'}">
                        最新
                    </button>
                </div>
                ` : ''}
            </div>
        </div>
        <div id="artist-detail-content" class="flex-1 overflow-y-auto p-2 md:p-4">
            <div class="flex items-center justify-center py-10">
                <i class="fas fa-spinner fa-spin text-2xl text-emerald-500"></i>
            </div>
        </div>
    `;
    container.innerHTML = headerHtml;
}

function toggleArtistFold() {
    const header = document.getElementById('artist-detail-header');
    const avatar = document.getElementById('artist-avatar-container');
    const collapsible = document.getElementById('artist-collapsible-section');
    const name = document.getElementById('artist-name-display');
    const tabsBar = document.getElementById('artist-tabs-bar');
    const foldIcon = document.getElementById('artist-fold-icon');
    const mainLayout = document.getElementById('artist-main-layout');

    if (!header) return;

    isArtistFolded = header.classList.toggle('is-folded');
    const isMobile = window.innerWidth < 768;

    if (isArtistFolded) {
        // 折叠状态
        header.classList.remove('p-6', 'md:p-8');
        header.classList.add('p-3', 'md:p-4');
        header.style.minHeight = isMobile ? '0px' : '90px';

        // 手机版强制左对齐，方便定位到返回键右侧
        if (isMobile) {
            mainLayout.classList.remove('items-center', 'text-center');
            mainLayout.classList.add('items-start', 'text-left');
        }

        avatar.style.transform = 'scale(0)';
        avatar.style.opacity = '0';
        avatar.style.width = '0';
        avatar.style.height = '0';
        avatar.style.margin = '0';

        collapsible.style.maxHeight = '0';
        collapsible.style.opacity = '0';
        collapsible.style.marginTop = '0';

        tabsBar.classList.remove('mt-8', 'pt-6');
        tabsBar.classList.add('mt-1', 'pt-2');

        // 响应式偏移
        if (isMobile) {
            name.style.transform = 'translate(40px, -30px) scale(0.65)';
        } else {
            name.style.transform = 'translate(30px, 0px) scale(0.65)';
        }
        name.style.marginBottom = '0';

        foldIcon.style.transform = 'rotate(180deg)';
    } else {
        // 展开状态
        header.classList.add('p-6', 'md:p-8');
        header.classList.remove('p-3', 'md:p-4');
        header.style.minHeight = '';

        if (isMobile) {
            mainLayout.classList.add('items-center', 'text-center');
            mainLayout.classList.remove('items-start', 'text-left');
        }

        avatar.style.transform = 'scale(1)';
        avatar.style.opacity = '1';
        avatar.style.width = '';
        avatar.style.height = '';
        avatar.style.margin = '';

        collapsible.style.maxHeight = '500px';
        collapsible.style.opacity = '1';
        collapsible.style.marginTop = '';

        tabsBar.classList.add('mt-8', 'pt-6');
        tabsBar.classList.remove('mt-1', 'pt-2');

        name.style.transform = 'translate(0, 0) scale(1)';
        name.style.marginBottom = '';

        foldIcon.style.transform = 'rotate(0deg)';
    }
}
window.toggleArtistFold = toggleArtistFold;

async function loadArtistSongs(id, source, order, forceFetch = false) {
    // Check if we can use cache to speed up UI transitions (like batch mode toggle)
    if (!forceFetch && window.currentArtistSongsCache && window.currentArtistId === id && window.currentArtistOrder === order && window.currentArtistSource === source) {
        renderArtistSongsUI(window.currentArtistSongsCache);
        return;
    }

    renderArtistSongsLoading();

    try {
        const res = await fetch(`${APP_API_BASE}/artistSongs?id=${id}&source=${source}&order=${order}`);
        if (!res.ok) throw new Error('Failed to fetch songs');
        const list = await res.json();

        const isCurrentRequest = String(window.currentArtistId) === String(id)
            && window.currentArtistSource === source
            && window.currentArtistOrder === order
            && window.currentArtistTab === 'songs';
        if (!isCurrentRequest) return;

        // [Fix] 唯一 ID
        list.forEach((item, idx) => {
            if (!item.id || item.id === 'undefined') {
                item.id = item.songmid || item.songId || item.hash || item.copyrightId || item.mid || item.mediaMid || `art_${id}_${idx}`;
            }
        });

        // 缓存当前结果
        window.currentArtistSongsCache = list;
        window.currentArtistId = id;
        window.currentArtistSource = source;
        window.currentArtistOrder = order;
        window.artistSongsPage = 1; // 重置到第1页

        renderArtistSongsUI(list, 1);
    } catch (e) {
        showError(`加载歌曲失败: ${escapeHtmlText(e.message)}`);
        goBackToSearch();
    }
}

function renderArtistSongsLoading() {
    const content = document.getElementById('artist-detail-content');
    if (!content) return;
    window.viewingPlaylist = [];
    content.innerHTML = `
        <div class="flex items-center justify-center py-12 t-text-muted">
            <i class="fas fa-spinner fa-spin text-2xl text-emerald-500 mr-3"></i>
            <span class="text-sm font-medium">正在加载歌曲...</span>
        </div>
    `;
}

function renderArtistSongsUI(list, page) {
    const content = document.getElementById('artist-detail-content');
    if (!content) return;

    window.viewingPlaylist = list;

    if (!list || list.length === 0) {
        content.innerHTML = '<div class="text-center py-10 t-text-muted">暂无歌曲</div>';
        return;
    }

    // 前端分页逻辑
    const totalItems = list.length;
    let itemsPerPage = (settings && settings.itemsPerPage === 'all') ? totalItems : parseInt((settings && settings.itemsPerPage) || 20);
    if (!itemsPerPage || itemsPerPage <= 0) itemsPerPage = 20;
    const totalPages = Math.ceil(totalItems / itemsPerPage);

    // 使用传入的 page 或者全局 artistSongsPage，默认第1页
    if (page !== undefined) window.artistSongsPage = page;
    if (!window.artistSongsPage || window.artistSongsPage < 1) window.artistSongsPage = 1;
    if (window.artistSongsPage > totalPages) window.artistSongsPage = totalPages;

    const currentPage = window.artistSongsPage;
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);

    // Apply filtering logic from ListSearch
    const fullIndexedList = window.ListSearch ? window.ListSearch.getDisplayList(list) : list.map((item, index) => ({ item, originalIndex: index }));
    const indexedDisplayList = fullIndexedList.slice(startIndex, endIndex);

    let html = `
        <!-- 表头 -->
        <div class="grid grid-cols-12 gap-2 md:gap-4 p-3 md:p-4 border-b t-border-main t-bg-main text-gray-500 text-sm font-medium sticky top-0 z-10 rounded-t-2xl overflow-hidden shadow-sm">
            <div class="col-span-3 sm:col-span-1 text-center flex items-center justify-center gap-1 sm:gap-2">
                <span>#</span>
                <div class="flex items-center gap-1">
                    <button onclick="toggleBatchMode()"
                        class="text-[10px] text-emerald-600 hover:text-emerald-700" title="批量操作">
                        <i class="fas fa-tasks"></i>
                    </button>
                    <button onclick="window.ListSearch.toggleBar()"
                        class="text-[10px] text-emerald-600 hover:text-emerald-700" title="内搜索 (/)">
                        <i class="fas fa-search"></i>
                    </button>
                </div>
            </div>
            <div class="col-span-7 sm:col-span-7 md:col-span-6 lg:col-span-4">歌曲标题</div>
            <div class="hidden sm:block sm:col-span-3 md:col-span-3 lg:col-span-3 text-right md:text-left">歌手</div>
            <div class="hidden lg:block lg:col-span-2">专辑</div>
            <div class="hidden md:block md:col-span-1 text-center md:text-left">时长</div>
            <div class="hidden sm:block sm:col-span-1 text-right">操作</div>
            <div class="col-span-2 sm:hidden text-right">操作</div>
        </div>
        
        <div class="space-y-1 mt-2">
            ${indexedDisplayList.map((obj) => {
        const { item, originalIndex: index } = obj;
        const isSelected = window.selectedItems.has(String(item.id));
        const isMatched = window.ListSearch && window.ListSearch.isMatched(index);
        const isCurrentMatch = window.ListSearch && window.ListSearch.isCurrentMatch(index);

        let rowClass = 'grid grid-cols-12 gap-2 md:gap-4 p-3 rounded-xl hover:t-bg-panel transition-all group cursor-pointer border border-transparent ';
        if (isCurrentMatch) rowClass += 'search-current ';
        else if (isMatched) rowClass += 'search-match ';
        if (isSelected) rowClass += 'row-selected ring-1 ring-emerald-500/30 ';

        return `
                        ${window.batchMode ? `
                            <input type="checkbox" 
                                   class="batch-checkbox w-4 h-4 text-emerald-600 rounded" 
                                   data-song-id="${item.id}"
                                   ${isSelected ? 'checked' : ''}
                            onclick="event.stopPropagation(); handleBatchSelect(${htmlJs(String(item.id))}, this.checked);">
                        ` : `<span class="index-num group-hover:hidden">${index + 1}</span><i class="fas fa-download text-emerald-500 hidden group-hover:block text-[10px]"></i>`}
                    </div>

                    <!-- Title -->
                    <div class="col-span-9 sm:col-span-7 md:col-span-6 lg:col-span-4 flex items-center gap-3 min-w-0">
                        <div class="w-10 h-10 md:w-12 md:h-12 rounded-lg overflow-hidden flex-shrink-0 shadow-sm relative">
                            <img src="${item.img || './assets/logo.svg'}" 
                                 onerror="this.src='./assets/logo.svg'" 
                                 class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                                <i class="fas fa-download text-white text-xs"></i>
                            </div>
                        </div>
                        <div class="min-w-0 flex-1">
                            <div class="font-bold t-text-main text-sm md:text-base leading-tight truncate group-hover:text-emerald-600 transition-colors">${escapeHtmlText(item.name)}</div>
                            <div class="flex items-center gap-1 mt-1">
                                ${getSourceTag ? getSourceTag(item.source) : ''}
                                ${getQualityTags ? getQualityTags(item) : ''}
                            </div>
                        </div>
                    </div>

                    <!-- Artist -->
                    <div class="hidden sm:flex sm:col-span-3 md:col-span-3 lg:col-span-3 text-sm t-text-muted items-center truncate">
                        ${item.singer}
                    </div>

                    <!-- Album -->
                    <div class="hidden lg:flex lg:col-span-2 text-sm t-text-muted items-center truncate">
                        ${item.albumName || '-'}
                    </div>

                    <!-- Duration -->
                    <div class="hidden md:flex md:col-span-1 items-center justify-center text-xs font-mono t-text-muted">
                        ${escapeHtmlText(item.interval || '--:--')}
                    </div>

                    <!-- Actions -->
                    <div class="col-span-2 sm:col-span-1 flex items-center justify-end gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                        <button class="p-1.5 hover:bg-blue-50 rounded-lg text-blue-600 transition-colors" title="下载" onclick="event.stopPropagation(); downloadSong(${htmlJs(item)})">
                            <i class="fas fa-download w-3.5 h-3.5"></i>
                        </button>
                    </div>
                </div>
            `;
    }).join('')}
        </div>

        <!-- 歌手详情内部分页控件 -->
        <div class=" mt-2 flex-shrink-0">
            <button onclick="artistSongsPrevPage()"
                class="text-gray-500 hover:text-emerald-600 disabled:opacity-30 transition-colors ${currentPage <= 1 ? 'opacity-30 pointer-events-none' : ''}">
                <i class="fas fa-chevron-left"></i> 上一页
            </button>
            <span class="text-xs t-text-muted font-mono">显示 ${startIndex + 1}-${endIndex} 首，共 ${totalItems} 首</span>
            <button onclick="artistSongsNextPage()"
                class="text-gray-500 hover:text-emerald-600 disabled:opacity-30 transition-colors ${currentPage >= totalPages ? 'opacity-30 pointer-events-none' : ''}">
                下一页 <i class="fas fa-chevron-right"></i>
            </button>
        </div>
    `;
    content.innerHTML = html;

    // Init Marquee if needed (though we use truncate here)
    if (window.applyMarqueeChecks) applyMarqueeChecks();
}
window.renderArtistSongsUI = renderArtistSongsUI;

// 歌手详情页内部翻页函数
function artistSongsPrevPage() {
    const list = window.currentArtistSongsCache;
    if (!list) return;
    if (!window.artistSongsPage || window.artistSongsPage <= 1) return;
    renderArtistSongsUI(list, window.artistSongsPage - 1);
}
function artistSongsNextPage() {
    const list = window.currentArtistSongsCache;
    if (!list) return;
    const totalItems = list.length;
    let itemsPerPage = (settings && settings.itemsPerPage === 'all') ? totalItems : parseInt((settings && settings.itemsPerPage) || 20);
    if (!itemsPerPage || itemsPerPage <= 0) itemsPerPage = 20;
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    if ((window.artistSongsPage || 1) >= totalPages) return;
    renderArtistSongsUI(list, (window.artistSongsPage || 1) + 1);
}
window.artistSongsPrevPage = artistSongsPrevPage;
window.artistSongsNextPage = artistSongsNextPage;

const ARTIST_ALBUM_PAGE_SIZE = 50;
const ARTIST_ALBUM_MAX_PAGES = 100;

function renderArtistAlbumsLoading(loaded = 0, total = 0) {
    const content = document.getElementById('artist-detail-content');
    if (!content) return;
    const progressText = loaded > 0
        ? '正在加载全部专辑，已读取 ' + loaded + (total > 0 ? '/' + total : '') + ' 张...'
        : '正在加载全部专辑...';
    const wrapper = document.createElement('div');
    const icon = document.createElement('i');
    const label = document.createElement('span');
    wrapper.className = 'flex items-center justify-center py-12 t-text-muted';
    icon.className = 'fas fa-spinner fa-spin text-2xl text-emerald-500 mr-3';
    label.className = 'text-sm font-medium';
    label.textContent = progressText;
    wrapper.append(icon, label);
    content.replaceChildren(wrapper);
}

async function fetchAllArtistAlbums(id, source, signal, onProgress) {
    const albums = [];
    const albumKeys = new Set();
    let total = 0;

    for (let page = 1; page <= ARTIST_ALBUM_MAX_PAGES; page++) {
        const query = new URLSearchParams({ id: String(id), source, page: String(page) });
        const res = await fetch(APP_API_BASE + '/artistAlbums?' + query.toString(), { signal });
        if (!res.ok) throw new Error('Failed to fetch artist albums page ' + page);

        const data = await res.json();
        const pageList = Array.isArray(data.list) ? data.list : [];
        const previousCount = albums.length;
        total = Math.max(total, Number(data.total) || 0);

        pageList.forEach((album, index) => {
            const albumId = album.id ?? album.mid;
            const key = albumId !== undefined && albumId !== null && albumId !== ''
                ? source + ':' + albumId
                : source + ':page:' + page + ':index:' + index;
            if (albumKeys.has(key)) return;
            albumKeys.add(key);
            albums.push({ ...album, source: album.source || source });
        });

        if (typeof onProgress === 'function') onProgress(albums.length, total);

        const reachedTotal = total > 0 && albums.length >= total;
        const pageExhausted = pageList.length < ARTIST_ALBUM_PAGE_SIZE;
        const noNewAlbums = albums.length === previousCount;
        if (pageList.length === 0 || reachedTotal || pageExhausted || noNewAlbums) break;
    }

    return { list: albums, total: total || albums.length };
}



async function loadArtistAlbums(id, source, forceFetch = false) {
    if (!forceFetch && window.currentArtistAlbumsCache && String(window.currentArtistId) === String(id) && window.currentArtistSource === source) {
        renderArtistAlbumsUI(window.currentArtistAlbumsCache);
        return;
    }

    renderArtistAlbumsLoading();

    try {
        const data = await fetchAllArtistAlbums(id, source, undefined, (loaded, total) => {
            const stillViewingArtist = String(window.currentArtistId) === String(id) && window.currentArtistSource === source;
            if (window.currentArtistTab === 'albums' && stillViewingArtist) {
                renderArtistAlbumsLoading(loaded, total);
            }
        });
        const list = data.list;
        const stillViewingArtist = String(window.currentArtistId) === String(id) && window.currentArtistSource === source;
        if (!stillViewingArtist) return;

        window.currentArtistAlbumsCache = list;
        window.currentArtistAlbumsTotal = data.total;

        if (window.currentArtistTab === 'albums') {
            renderArtistAlbumsUI(list);
        }
    } catch (e) {
        const stillViewingArtist = String(window.currentArtistId) === String(id) && window.currentArtistSource === source;
        if (stillViewingArtist) {
            showError(`加载专辑失败: ${escapeHtmlText(e.message)}`);
            goBackToSearch();
        } else {
            console.warn('[ArtistAlbums] 已离开歌手页，忽略专辑加载失败:', e);
        }
    }
}

function renderArtistAlbumsUI(list) {
    const content = document.getElementById('artist-detail-content');
    if (!content) return;

    if (!list || list.length === 0) {
        content.innerHTML = '<div class="text-center py-10 t-text-muted">暂无专辑</div>';
        return;
    }

    const artistName = currentArtistInfo?.name || '';
    const html = `
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6 p-2 md:p-4 animate-in fade-in duration-300">
            ${list.map((album, index) => {
                const albumId = album.id ?? album.mid;
                const albumSource = album.source || window.currentArtistSource || 'wy';
                const albumName = album.name || '未知专辑';
                return `
                <div class="artist-album-card group flex flex-col p-3 rounded-2xl transition-all hover:t-bg-panel hover:shadow-lg cursor-pointer border border-transparent hover:border-emerald-500/20" data-album-index="${index}">
                    <div class="aspect-square rounded-xl overflow-hidden shadow-md mb-3 relative bg-gray-100 dark:bg-gray-800">
                        <img src="${htmlImageUrl(getImgUrl(album))}"
                             onerror="this.src='./assets/logo.svg'" 
                             class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
                        <div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                             <div class="w-12 h-12 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-lg transform translate-y-4 group-hover:translate-y-0 transition-transform duration-300">
                                <i class="fas fa-download"></i>
                             </div>
                        </div>
                        <div class="absolute top-1.5 right-1.5 flex gap-1.5">
                            <button type="button" class="artist-album-download-btn w-8 h-8 rounded-full bg-black/45 hover:bg-emerald-500 text-white flex items-center justify-center opacity-100 sm:opacity-0 group-hover:opacity-100 transition-all shadow-sm disabled:opacity-60 disabled:cursor-wait" data-album-index="${index}" title="下载本专辑全部歌曲">
                                <i class="fas fa-download text-xs"></i>
                            </button>
                        </div>
                    </div>
                    <span class="text-sm font-bold t-text-main line-clamp-2 h-10 leading-5 mb-1 group-hover:text-emerald-600 transition-colors" title="${escapeHtmlText(albumName)}">${escapeHtmlText(albumName)}</span>
                    <div class="flex items-center justify-between mt-1">
                        <span class="text-[10px] t-text-muted">${escapeHtmlText(album.publishTime || '')}</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 font-bold">${album.total ?? album.count ?? album.size ?? album.songCount ?? 0} 首</span>
                    </div>
                </div>
            `;
            }).join('')}
        </div>
    `;
    content.innerHTML = html;

    content.querySelectorAll('.artist-album-card').forEach(card => {
        card.addEventListener('click', () => {
            const album = list[Number(card.dataset.albumIndex)];
            if (album) enterAlbum(album.id ?? album.mid, album.source || window.currentArtistSource || 'wy');
        });
    });
    content.querySelectorAll('.artist-album-download-btn').forEach(button => {
        button.addEventListener('click', async event => {
            event.stopPropagation();
            const album = list[Number(button.dataset.albumIndex)];
            if (album) await downloadArtistAlbumSongs(album, button);
        });
    });
}
window.renderArtistAlbumsUI = renderArtistAlbumsUI;

async function downloadArtistAlbumSongs(album, button) {
    if (typeof window.batchDownloadSongs !== 'function') {
        showError('批量下载功能未就绪');
        return;
    }

    const albumId = album.id ?? album.mid;
    const albumSource = album.source || window.currentArtistSource || 'wy';
    const albumName = album.name || '未知专辑';
    if (albumId === undefined || albumId === null || albumId === '') {
        showError(`专辑「${albumName}」缺少有效 ID，无法下载`);
        return;
    }
    const icon = button?.querySelector('i');
    if (button) button.disabled = true;
    if (icon) icon.className = 'fas fa-spinner fa-spin text-xs';

    try {
        const query = new URLSearchParams({ id: String(albumId), source: albumSource });
        const res = await fetch(APP_API_BASE + '/albumSongs?' + query.toString());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const rawSongs = Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : []);
        if (rawSongs.length === 0) {
            showError(`专辑「${albumName}」没有可下载的歌曲`);
            return;
        }

        const songs = rawSongs.map(song => ({
            ...song,
            source: song.source || albumSource,
            albumName: song.albumName || albumName,
            meta: {
                ...(song.meta || {}),
                albumId: song.meta?.albumId || song.albumId || albumId,
                albumName: song.meta?.albumName || albumName
            }
        }));
        await window.batchDownloadSongs(songs, {
            clearSelection: false,
            selectionLabel: `专辑「${albumName}」共 ${songs.length} 首歌曲`
        });
    } catch (e) {
        console.error('[ArtistAlbums] 读取专辑歌曲失败:', albumName, e);
        showError(`读取专辑「${albumName}」失败: ${escapeHtmlText(e.message)}`);
    } finally {
        if (button) button.disabled = false;
        if (icon) icon.className = 'fas fa-download text-xs';
    }
}
window.downloadArtistAlbumSongs = downloadArtistAlbumSongs;

async function enterAlbum(id, source = 'wy') {
    // 保存进入专辑前的上下文，如果是从歌手页进入，则记录歌手 ID
    const artistHeader = document.getElementById('artist-detail-header');
    if (artistHeader) {
        window.tempArtistContext = {
            id: window.currentArtistId,
            source: window.currentArtistSource,
            tab: window.currentArtistTab || 'albums',
            order: window.currentArtistOrder || 'hot'
        };
        artistHeader.remove(); // 进入专辑详情时移除歌手头部，保持界面整洁
    } else {
        window.tempArtistContext = null;
    }

    const typeEl = document.getElementById('search-type');
    if (!artistHeader) {
        lastSearchType = typeEl ? typeEl.value : 'album';
        lastSearchResultList = [...(window.viewingPlaylist || [])];
    }
    window.history.pushState({ page: 'search-detail' }, '');

    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '<div class="flex items-center justify-center h-full"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';

    try {
        const res = await fetch(`${APP_API_BASE}/albumSongs?id=${id}&source=${source}`);
        if (!res.ok) throw new Error('Failed to fetch album songs');
        const data = await res.json();
        const songList = data.list || (Array.isArray(data) ? data : []);
        renderResults(songList);
        const pageInfoEl = document.getElementById('page-info');
        if (pageInfoEl) pageInfoEl.innerText = `专辑歌曲列表`;

        const backBtn = document.getElementById('search-back-btn');
        if (backBtn) backBtn.classList.remove('hidden');
    } catch (e) {
        showError(`获取专辑歌曲失败: ${escapeHtmlText(e.message)}`);
        goBackToSearch();
    }
}

function goBackToSearch(fromPopState = false) {
    if (!fromPopState) {
        if (window.history.state && window.history.state.page === 'search-detail') {
            window.history.back();
            return;
        }
    }

    // 如果有暂存的歌手上下文，优先返回歌手页
    if (window.tempArtistContext) {
        const ctx = window.tempArtistContext;
        window.tempArtistContext = null; // 用完即弃
        enterArtist(ctx.id, ctx.source, ctx.order, ctx.tab, true);
        return;
    }

    if (!lastSearchResultList) return;

    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');

    // 清除详情页专用头部
    const detailHeader = document.getElementById('artist-detail-header');
    if (detailHeader) detailHeader.remove();

    // 恢复搜索结果列表头部
    if (header) header.classList.remove('hidden');

    if (lastSearchType === 'singer') {
        renderSingerResults(lastSearchResultList);
    } else if (lastSearchType === 'album') {
        renderAlbumResults(lastSearchResultList);
    } else {
        renderResults(lastSearchResultList);
    }

    const backBtn = document.getElementById('search-back-btn');
    if (backBtn) backBtn.classList.add('hidden');

    const pageInfoEl = document.getElementById('page-info');
    if (pageInfoEl) {
        pageInfoEl.innerText = `搜索结果`;
    }

    lastSearchResultList = null;
    lastSearchType = null;
    currentArtistId = null;
}
window.goBackToSearch = goBackToSearch;

window.enterArtist = enterArtist;

// Helper for loose image paths
function getImgUrl(item) {
    if (!item) return './assets/logo.svg';
    const s = item;
    // 优先从标准 meta 获取
    if (s.meta && s.meta.picUrl) return s.meta.picUrl;
    // 兼容各种 SDK 的原始字段
    return s.img || s.pic || s.picUrl || s.picture ||
        (s.album && (s.album.picUrl || s.album.img || s.album.pic)) ||
        (s.al && (s.al.picUrl || s.al.img)) ||
        (s.meta && (s.meta.img || s.meta.pic)) ||
        './assets/logo.svg';
}

// List search logic is now handled by ListSearch service in list_search.js
function renderResults(list) {
    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');
    if (header) header.classList.remove('hidden');
    // 搜索歌曲时恢复底部分页栏显示
    const paginationBar = document.getElementById('search-pagination-bar');
    if (paginationBar) paginationBar.classList.remove('hidden');
    // 重置歌手详情分页（进入歌曲搜索视图时清空）
    window.artistSongsPage = 1;
    const headerTitle = document.getElementById('header-title');
    const headerAlbum = document.getElementById('header-album');

    // Determine if we should show the album column
    // Search results (network) show album, collections (local) do not
    const showAlbum = currentSearchScope === 'network';


    // Update Header
    if (header) {
        header.classList.remove('hidden');
    }
    if (headerTitle) {
        if (showAlbum) {
            headerTitle.classList.remove('lg:col-span-6');
            headerTitle.classList.add('lg:col-span-4');
        } else {
            headerTitle.classList.remove('lg:col-span-4');
            headerTitle.classList.add('lg:col-span-6');
        }
    }
    if (headerAlbum) {
        if (showAlbum) {
            headerAlbum.classList.add('hidden');
            headerAlbum.classList.add('lg:block');
        } else {
            headerAlbum.classList.add('hidden');
            headerAlbum.classList.remove('lg:block');
        }
    }

    container.innerHTML = '';

    // [Fix] 确保每个歌曲都有唯一的 ID，防止批量操作时因为 ID 缺失(undefined)导致只能选中一个
    // 很多源(如酷狗、咪咕)返回的原始数据可能只有 hash 或 copyrightsId 而没有 id 字段
    if (list && list.length > 0) {
        list.forEach((item, idx) => {
            if (!item.id || item.id === 'undefined') {
                item.id = item.songmid || item.songId || item.hash || item.copyrightId || item.mid || item.mediaMid || `temp_${Date.now()}_${idx}`;
            }
        });
    }

    window.viewingPlaylist = list;

    if (!list || list.length === 0) {
        container.innerHTML = '<div class="text-center t-text-muted p-8">未找到相关结果</div>';
        updatePaginationInfo(0, 0, 0, 1, 1);
        return;
    }

    // Applying Unified Filter with original index preservation BEFORE pagination
    const indexedDisplayList = window.ListSearch.getDisplayList(list);

    // Pagination
    const totalItems = indexedDisplayList.length;
    let itemsPerPage = settings.itemsPerPage === 'all' ? totalItems : parseInt(settings.itemsPerPage);
    if (itemsPerPage <= 0) itemsPerPage = 20;
    const totalPages = Math.ceil(totalItems / (itemsPerPage || 1));

    // Bounds check
    if (currentPage > totalPages) currentPage = totalPages || 1;
    if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);

    const pageList = indexedDisplayList.slice(startIndex, endIndex);

    pageList.forEach((obj, pageIndex) => {
        const { item, originalIndex: actualIndexInOriginal } = obj;
        const row = document.createElement('div');
        row.id = `gl-row-${actualIndexInOriginal}`;
        row.dataset.songId = String(item.id);

        const isMatched = window.ListSearch.isMatched(actualIndexInOriginal);
        const isCurrentMatch = window.ListSearch.isCurrentMatch(actualIndexInOriginal);
        const isSelected = window.selectedItems.has(String(item.id));

        let rowClass = 'grid grid-cols-12 gap-4 p-3 rounded-xl hover:t-bg-panel group transition-colors cursor-pointer ';
        if (isCurrentMatch) rowClass += 'search-current ';
        else if (isMatched) rowClass += 'search-match ';
        if (isSelected) rowClass += 'row-selected ring-1 ring-emerald-500/30 ';

        row.className = rowClass;

        // Add click listener for the row
        row.onclick = (e) => {
            if (window.batchMode) {
                const id = String(item.id);
                const isChecked = !window.selectedItems.has(id);
                window.handleBatchSelect(id, isChecked);
            } else {
                // If not in batch mode, clicking row adds the song to downloads
                downloadFromView(actualIndexInOriginal);
            }
        };

        // Image
        const imgUrl = getImgUrl(item);

        // Grid Layout Adjustment
        const titleLgSpan = showAlbum ? 'lg:col-span-4' : 'lg:col-span-6';

        row.innerHTML = `
            <!-- Index -->
            <div class="col-span-1 sm:col-span-1 text-center font-mono t-text-muted text-xs md:text-sm flex items-center justify-center">
                ${window.batchMode ? `
                    <input type="checkbox" 
                           class="batch-checkbox w-4 h-4 text-emerald-600 rounded" 
                           data-song-id="${item.id}"
                           ${isSelected ? 'checked' : ''}
                    onclick="event.stopPropagation(); handleBatchSelect(${htmlJs(String(item.id))}, this.checked);">
                ` : `<span class="index-num">${actualIndexInOriginal + 1}</span>`}
            </div>

            <!-- Title (Image + Text) -->
            <div class="col-span-9 sm:col-span-7 md:col-span-6 ${titleLgSpan} flex items-center overflow-hidden pr-2">
                <div class="relative w-10 h-10 md:w-12 md:h-12 mr-3 md:mr-4 flex-shrink-0 group cursor-pointer">
                     <img data-src="${htmlImageUrl(imgUrl)}" src="./assets/logo.svg"
                          loading="lazy" fetchpriority="low"
                          class="lazy-image w-full h-full rounded-lg object-cover shadow-sm group-hover:shadow-md transition-all group-hover:scale-105 duration-300 dynamic-logo is-placeholder" 
                          alt="${escapeHtmlText(item.name)}"
                          onerror="this.src='./assets/logo.svg'; this.classList.add('is-placeholder');">
                     <div class="absolute inset-0 bg-black/20 rounded-lg hidden group-hover:flex items-center justify-center transition-all">
                        <i class="fas fa-download text-white text-xs md:text-sm"></i>
                     </div>
                </div>
                <div class="min-w-0 flex-1 flex flex-col justify-center overflow-hidden">
                    <div class="font-bold t-text-main text-sm md:text-base leading-tight hover:text-emerald-600 transition-colors">
                         ${createMarqueeHtml(item.name)}
                    </div>
                    <div class="flex items-center gap-1 mt-0.5 md:mt-1 pr-2 overflow-hidden">
                         ${getSourceTag(item.source)}
                         ${getQualityTags(item)}
                         <div class="sm:hidden flex-1 min-w-0">
                            ${createMarqueeHtml(item.singer, 'text-[10px] t-text-muted')}
                         </div>
                    </div>
                </div>
            </div>

            <!-- Artist (Hidden on Mobile) -->
            <div class="hidden sm:flex sm:col-span-3 md:col-span-3 lg:col-span-3 t-text-muted text-sm md:text-base items-center hover:text-emerald-600 transition-colors cursor-pointer overflow-hidden"
                 title="${item.singer}"
                 onclick="event.stopPropagation(); document.getElementById('search-input').value = ${htmlJs(item.singer)}; doSearch();">
                ${createMarqueeHtml(item.singer)}
            </div>

            <!-- Album (Hidden until LG) -->
            ${showAlbum ? `
            <div class="hidden lg:block lg:col-span-2 t-text-muted text-sm truncate flex items-center" title="${item.albumName || ''}">
                ${item.albumName || '-'}
            </div>
            ` : ''}

            <!-- Duration (Hidden until MD) -->
            <div class="hidden md:block md:col-span-1 t-text-muted text-sm font-mono text-center flex items-center justify-center">
                ${escapeHtmlText(item.interval || '--:--')}
            </div>

            <!-- Actions -->
            <div class="col-span-2 sm:col-span-1 flex items-center justify-end gap-0.5 sm:gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                <button class="p-1 sm:p-1.5 hover:bg-blue-50 rounded-lg text-blue-600 transition-colors" 
                        title="下载" 
                        onclick="event.stopPropagation(); downloadSong(${htmlJs(item)})">
                    <i class="fas fa-download w-3 h-3 sm:w-4 sm:h-4"></i>
                </button>
            </div>
        `;

        container.appendChild(row);
    });

    // Update pagination info
    updatePaginationInfo(startIndex + 1, endIndex, totalItems, currentPage, totalPages);

    // Init Lazy Loader
    lazyLoadImages(container);
    applyMarqueeChecks(container);

    // [Prefetch] 自动后台预加载逻辑
    if (currentSearchScope === 'network' && currentPage === totalPages) {
        const FETCH_PAGES_STEP = 3;
        const nextNetPage = (window.currentNetworkPage || 1) + FETCH_PAGES_STEP;

        // 避免重复触发
        if (!window._prefetchingPending || window._prefetchingPending !== nextNetPage) {
            window._prefetchingPending = nextNetPage;
            console.log(`[Prefetch] 触及本地末页 (${totalPages})，自动拉取后续 ${FETCH_PAGES_STEP} 页... (Next URL Page: ${nextNetPage})`);

            // 延迟一点触发，确保 UI 先更新
            setTimeout(() => {
                doSearch(nextNetPage, true, true).finally(() => {
                    // 完成后清除标志，但不再主动重置，防止同一页重复触发
                });
            }, 500);
        }
    }
}

// Generic Marquee Helper
function createMarqueeHtml(text, className = '') {
    // Return a container marked for dynamic checking
    // different screens are different, so we check overflow after render
    // Added min-w-0 to prevent flex item from expanding beyond parent
    const safeText = escapeHtmlText(text);
    return `<div class="truncate dynamic-marquee min-w-0 ${className}" data-text="${safeText}">${safeText}</div>`;
}
//滚动显示
function applyMarqueeChecks(root = document) {
    // Wait for render
    setTimeout(() => {
        const scope = root || document;
        const elements = scope.querySelectorAll('.dynamic-marquee.truncate');
        elements.forEach(el => {
            if (el.scrollWidth > el.clientWidth) {
                const text = el.getAttribute('data-text') || el.innerText;

                // 必须保留 overflow-hidden 以限制宽度
                el.classList.remove('truncate');
                el.classList.add('overflow-hidden');

                // 使用 mask-image 实现边缘渐隐效果
                const maskStyle = 'mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%); -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);';

                const wrapper = document.createElement('div');
                wrapper.className = 'w-full relative';
                wrapper.setAttribute('style', maskStyle);
                const track = document.createElement('div');
                track.className = 'inline-block whitespace-nowrap animate-marquee hover:pause-animation';
                const firstText = document.createElement('span');
                firstText.textContent = text;
                const firstGap = document.createElement('span');
                firstGap.className = 'mx-8';
                const secondText = document.createElement('span');
                secondText.textContent = text;
                const secondGap = document.createElement('span');
                secondGap.className = 'mx-8';
                track.append(firstText, firstGap, secondText, secondGap);
                wrapper.appendChild(track);
                el.replaceChildren(wrapper);
            }
        });
    }, 50);
}

// Re-check marquees on resize
window.addEventListener('resize', () => {
    clearTimeout(window._marqueeResizeTimer);
    window._marqueeResizeTimer = setTimeout(applyMarqueeChecks, 300);
});

// Lazy Loading Logic
let imageObserver;

function lazyLoadImages(root = document) {
    const scope = root || document;
    const loadImage = (img) => {
        const src = img.getAttribute('data-src');
        if (!src) return;
        if (img.src.includes('logo.svg')) {
            img.classList.add('is-placeholder');
        }
        img.src = src;
        img.onload = () => {
            img.classList.remove('is-placeholder', 'opacity-0');
            img.removeAttribute('data-src');
        };
        img.onerror = () => {
            img.src = './assets/logo.svg';
            img.classList.add('is-placeholder');
            img.removeAttribute('data-src');
        };
    };

    if ('IntersectionObserver' in window) {
        if (!imageObserver) {
            imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    loadImage(entry.target);
                    observer.unobserve(entry.target);
                }
            });
        }, {
            rootMargin: '100px 0px', // Load before it comes into view
            threshold: 0.01
        });
        }

        const images = scope.querySelectorAll('img.lazy-image[data-src]');
        images.forEach(img => {
            imageObserver.observe(img);
        });
    } else {
        // Fallback for older browsers
        const images = scope.querySelectorAll('img.lazy-image[data-src]');
        images.forEach(loadImage);
    }
}
window.lazyLoadImages = lazyLoadImages;
window.unobserveLazyImages = function (root = document) {
    if (!imageObserver) return;
    const scope = root || document;
    scope.querySelectorAll('img.lazy-image').forEach(img => imageObserver.unobserve(img));
};

// List search logic is now handled by ListSearch service


async function checkServerCache(song, quality, exactQuality = false) {
    try {
        const params = new URLSearchParams({
            name: song.name,
            singer: song.singer,
            source: song.source,
            songmid: song.songmid || (song.meta && (song.meta.songmid || song.meta.songId)) || '',
            songId: song.songId || (song.meta && song.meta.songId) || song.id,
            quality: quality || ''
        });
        if (exactQuality) params.append('exactQuality', '1');

        const res = await fetch(`/api/music/cache/check?${params}`, {
            headers: getUserAuthHeaders()
        });
        if (res.ok) return await res.json();
    } catch (e) {
        console.error('[ServerCache] Check failed:', e);
    }
    return { exists: false };
}

async function handleAdminAuth() {
    // Single Web Token authentication replaces the former admin/user split.
    if (!authVerified) await ensureUserAuthToken({ force: true });
    return authVerified;
}
window.handleAdminAuth = handleAdminAuth;

let lastNamingPattern = window.settings?.serverCacheNamingPattern || 'simple';

async function updateServerCacheConfig(location, pattern, downloadDir) {
    const loc = 'root';
    const pat = pattern || window.settings?.serverCacheNamingPattern || 'simple';
    const oldPattern = lastNamingPattern;

    const headers = { 'Content-Type': 'application/json' };
    // 携带当前 Web 会话 Cookie。
    Object.assign(headers, getUserAuthHeaders());

    try {
        const response = await fetch('/api/music/cache/config', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                location: loc,
                namingPattern: pat,
                ...(downloadDir !== undefined ? { downloadDir } : {})
            })
        });
        if (!response.ok) {
            console.warn('[ServerCache] Config update failed:', response.status);
            // 失败时回滚 UI
            if (typeof syncSettingsUI === 'function') {
                if (pattern) syncSettingsUI('serverCacheNamingPattern', settings.serverCacheNamingPattern);
            }
            return false;
        } else {
            console.log('[Cache] 服务器配置已同步:', loc, pat);

            // 如果命名模式真的发生了变化（且不是初始化同步）
            if (pattern && oldPattern && pattern !== oldPattern) {
                const confirmed = await showSelect('歌曲命名格式变更', `检测到命名方式已更改为 "${pat}"。是否将服务器上已下载的本地歌曲重新命名为新的格式？<br><br><span class="text-xs opacity-70">注：这会同时移动对应的歌词文件，确保播放器能正常识别。</span>`, {
                    confirmText: '现在重命名',
                    cancelText: '保持现状',
                    confirmColor: 'bg-emerald-500'
                });

                if (confirmed) {
                    showLoading('正在重命名服务器文件...');
                    try {
                        const renameRes = await fetch('/api/music/cache/rename', {
                            method: 'POST',
                            headers: headers
                        });
                        const renameData = await renameRes.json();
                        hideLoading();
                        if (renameData.success) {
                            showToast(`重命名完成！成功: ${renameData.successCount}, 跳过: ${renameData.skipCount}, 失败: ${renameData.failCount}`, 'success');
                        } else {
                            showToast('重命名操作失败: ' + (renameData.message || '未知错误'), 'error');
                        }
                    } catch (e) {
                        hideLoading();
                        showToast('重命名请求异常', 'error');
                        console.error(e);
                    }
                }
            }
            lastNamingPattern = pat; // 更新最后同步的模式
            return true;
        }
    } catch (e) {
        console.error('[ServerCache] Config update failed:', e);
        return false;
    }
}
window.updateServerCacheConfig = updateServerCacheConfig; // Expose global

/**
 * Handle a song click in the search/list view by adding it to downloads.
 */
function downloadFromView(index) {
    if (!viewingPlaylist || !viewingPlaylist[index]) return;
    downloadSingleSong(viewingPlaylist[index]);
}
window.downloadFromView = downloadFromView;

/** 单曲下载入口 */
function downloadSingleSong(song) {
    if (!song) return;
    if (typeof window.downloadSong !== 'function') {
        showError('下载功能未就绪');
        return;
    }
    void window.downloadSong(song);
}
window.downloadSingleSong = downloadSingleSong;

function updatePlaylist(list, startIndex = 0, scope = 'local_list', shouldAddToDefault = null) {
    // shouldAddToDefault === false 表示"全部下载"场景，否则下载单曲
    const songs = Array.isArray(list) ? list.filter(Boolean) : [];
    const targets = shouldAddToDefault === false ? songs : [songs[startIndex]].filter(Boolean);
    if (targets.length === 0) {
        showError('没有可下载的歌曲');
        return;
    }
    if (typeof window.batchDownloadSongs !== 'function') {
        showError('下载功能未就绪');
        return;
    }
    if (targets.length === 1 && typeof window.downloadSong === 'function') {
        void window.downloadSong(targets[0]);
        return;
    }
    void window.batchDownloadSongs(targets, { selectionLabel: '全部下载，共 ' + targets.length + ' 首' });
}
window.updatePlaylist = updatePlaylist;

// 显示错误提示（现代化 Toast）
// 移除旧版 showError，由后文统一的 showToast 驱动
// 占位图片变色

// 全局图片设置助手，处理占位图逻辑
window.setImg = (id, src) => {
    const el = document.getElementById(id);
    if (el) {
        // 如果是从占位图切换到真实图片，保留滤镜直到加载完成
        if (el.src.includes('logo.svg') && src && !src.includes('logo.svg')) {
            el.classList.add('is-placeholder');
            const handleLoad = () => {
                el.classList.remove('is-placeholder');
                el.removeEventListener('load', handleLoad);
                el.removeEventListener('error', handleLoad); // 失败也移除
            };
            el.addEventListener('load', handleLoad);
            el.addEventListener('error', handleLoad);
        } else if (src && src.includes('logo.svg')) {
            el.classList.add('is-placeholder');
        } else {
            el.classList.remove('is-placeholder');
        }

        if (src) el.src = src;
        el.onerror = () => {
            el.src = './assets/logo.svg';
            el.classList.add('is-placeholder');
        };
    }
};


function loadSettings() {
    // 同步 UI 状态
    syncSettingsUI();
}

// ========== 键盘快捷键逻辑 ==========
let seekTimer = null;
let isLongPress = false;

// 注册全局键盘监听
document.addEventListener('keydown', (e) => {
    if (!settings.enableKeyboardShortcuts) return;

    // 如果焦点在输入框中，忽略快捷键
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
    }

    switch (e.code) {
        case 'Digit1':
            if (e.altKey) switchTab('search');
            break;
        case 'Digit2':
            if (e.altKey) switchTab('songlist');
            break;
        case 'Digit3':
            if (e.altKey) switchTab('leaderboard');
            break;
        case 'Digit4':
            if (e.altKey) switchTab('search');
            break;
        case 'Digit5':
            if (e.altKey) switchTab('settings-system');
            break;
        case 'KeyJ':
            if (typeof toggleDownloadDrawer === 'function') toggleDownloadDrawer();
            break;
    }
});

function getRemasterStorageUsername() {
    return 'shared';
}

async function toggleRemasterFeature(enabled) {
    const toggle = document.getElementById('setting-enable-remaster');
    try {
        await updateSetting('enableRemaster', !!enabled);
        if (toggle) toggle.checked = !!window.settings?.enableRemaster;
        window.LocalMusicManager?.syncRemasterVisibility();
    } catch (e) {
        if (toggle) toggle.checked = !!window.settings?.enableRemaster;
        showError(e.message || '更新洗版设置失败');
    }
}

window.getRemasterStorageUsername = getRemasterStorageUsername;
window.toggleRemasterFeature = toggleRemasterFeature;

async function updateSetting(key, value) {
    const previousValue = settings[key];
    if (SETTINGS_UI_MAP[key]?.normalize) {
        value = SETTINGS_UI_MAP[key].normalize(value);
    }
    if (key === 'preferredQuality') {
        const supportedQualities = window.QualityManager?.SUPPORTED_QUALITIES || ['128k', '320k', 'flac', 'flac24bit'];
        if (!supportedQualities.includes(value)) value = DEFAULT_SETTINGS.preferredQuality;
    }
    settings[key] = value;
    window.settings = settings; // 确保全局引用同步
    console.log(`[Settings] ${key} 已更新为:`, value);
    // 实时同步 UI 并应用效果
    syncSettingsUI(key, value);

    // 下载目录属于服务端运行时配置，需要先同步到 fileCache 才会立即生效。
    if (key === 'downloadDir' && window.updateServerCacheConfig) {
        const applied = await window.updateServerCacheConfig(undefined, undefined, value);
        if (!applied) {
            settings[key] = previousValue;
            window.settings = settings;
            syncSettingsUI(key, previousValue);
            showError('下载目录同步失败，请确认已通过站点认证。');
            return;
        }
    }

    // 设置以服务器为唯一来源，修改后实时同步（短暂合并连续输入）。
    void pushSettingsToServer();

}
// Settings that still have controls in the current web interface.
const SETTINGS_UI_MAP = {
    defaultEntry: { id: 'setting-default-entry', type: 'value' },
    downloadConcurrency: {
        id: 'setting-download-concurrency',
        type: 'value',
        normalize: normalizeDownloadConcurrency,
        action: (v) => {
            if (window.SystemDownloadManager) {
                window.SystemDownloadManager.updateMaxConcurrent(v);
            }
        }
    },
    downloadDir: { id: 'setting-download-dir', type: 'value' },
    downloadFileNamePattern: { id: 'setting-download-file-name-pattern', type: 'value' },
    enableServerMetadataEmbed: { id: 'toggle-server-metadata-embed', type: 'checkbox' },
    enableServerCoverEmbed: { id: 'toggle-server-cover-embed', type: 'checkbox' },
    enableServerLyricEmbed: {
        id: 'toggle-server-lyric-embed',
        type: 'checkbox'
    },
    enableServerLyricDownload: {
        id: 'toggle-server-lyric-download',
        type: 'checkbox'
    },
    preferredQuality: {
        id: 'quality-select',
        type: 'value',
        action: (v, isSingle) => {
            if (isSingle && window.showSuccess && window.QualityManager) {
                window.showSuccess(`默认音质已设置为: ${window.QualityManager.getQualityDisplayName(v)}`);
            }
        }
    },
    hotSearchLimit: {
        id: 'hot-search-limit-input',
        type: 'value',
        action: () => document.getElementById('search-results-header')?.classList.contains('hidden') && showInitialSearchState()
    },
    itemsPerPage: { id: 'items-per-page-select', type: 'value' }
};

//缓存设置项
function syncSettingsUI(key = null, value = null) {
    const updateItem = (itemKey, itemValue, isSingle) => {
        const config = SETTINGS_UI_MAP[itemKey];
        if (!config) return;

        if (config.normalize) itemValue = config.normalize(itemValue);
        if (settings[itemKey] !== itemValue) {
            settings[itemKey] = itemValue;
            window.settings = settings;
        }
        const el = document.getElementById(config.id);
        if (el) {
            if (config.type === 'checkbox') el.checked = !!itemValue;
            else el.value = itemValue;

            el.disabled = false;
        }

        if (config.action) config.action(itemValue, isSingle);
    };

    // [新增] 更新管理员 UI 状态 (标签、按钮)

    if (key !== null && value !== null) {
        // 单项更新
        updateItem(key, value, true);
    } else {
        // 全局同步
        Object.keys(SETTINGS_UI_MAP).forEach(itemKey => {
            const val = settings[itemKey];
            // 处理默认值逻辑 (如果 settings 中没有，则可能需要 fallback 或跳过)
            if (val !== undefined) {
                updateItem(itemKey, val, false);
            }
        });
    }

    // 更新浏览器存储统计
    updateStorageStatsUI();
}

// ========== 缓存统计与重置逻辑 ==========

async function calcStorageUsage() {
    try {
        // 1. 优先使用原生 API 获取包含 IndexedDB 的准确占用
        if (navigator.storage && navigator.storage.estimate) {
            const estimate = await navigator.storage.estimate();
            const total = estimate.usage || 0;
            if (total > 0) {
                if (total < 1024) return total + ' B';
                if (total < 1024 * 1024) return (total / 1024).toFixed(2) + ' KB';
                return (total / (1024 * 1024)).toFixed(2) + ' MB';
            }
        }
    } catch (e) {
        console.warn('[Storage] 无法使用 Storage Estimate API:', e);
    }

    // 2. 回退到手动计算 localStorage (兜底)
    let total = 0;
    for (let x in localStorage) {
        if (!localStorage.hasOwnProperty(x)) continue;
        const val = localStorage.getItem(x);
        if (val) total += (x.length + val.length) * 2;
    }
    if (total < 1024) return total + ' B';
    if (total < 1024 * 1024) return (total / 1024).toFixed(2) + ' KB';
    return (total / (1024 * 1024)).toFixed(2) + ' MB';
}

async function updateStorageStatsUI() {
    const el = document.getElementById('storage-usage-info');
    if (el) {
        el.innerText = await calcStorageUsage();
    }
}

async function resetAllSettings() {
    const ok = await showSelect('重置所有设置', '确定要重置吗？这不会删除您的歌单，但会恢复音质、列表显示、主题等设置到默认状态。 (Restore all settings to default?)', { danger: true });
    if (!ok) return;
    try {
        // Reset to default
        settings = { ...DEFAULT_SETTINGS };
        window.settings = settings;
        await pushSettingsToServer();

        showSuccess('设置已重置，正在重新加载页面...');
        setTimeout(() => {
            window.location.reload();
        }, 1500);
    } catch (e) {
        showError('重置失败: ' + e.message);
    }
}

async function clearCache(type) {
    if (!(await showSelect('清除缓存', '确定要清除本地缓存吗？', { danger: true }))) return;

    let clearLyricFiles = false;
    if (type === 'lyric') {
        clearLyricFiles = await showSelect('清除缓存', '是否同时清除下载目录内的独立歌词 LRC 文件？', { danger: true });

    }

    let count = 0;
    const keysToRemove = [];

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        // 独立 LRC 文件由服务端管理；浏览器不保存歌词或歌曲链接缓存。
        if (type === 'lyric' && key.startsWith('lx_lyric_')) {
            keysToRemove.push(key);
        }
    }

    keysToRemove.forEach(k => {
        localStorage.removeItem(k);
        count++;
    });

    updateStorageStatsUI();
    const mapFromName = { 'lyric': '歌词', 'url': '链接' };
    showSuccess(`已清除 ${count} 条${mapFromName[type] || ''}本地缓存`);

    if (clearLyricFiles) {
        try {
            const username = 'shared';
            const headers = {};
            Object.assign(headers, getUserAuthHeaders());

            const res = await fetch('/api/music/cache/lyric/clear', { method: 'POST', headers });
            const data = await res.json();
            if (data.success) {
                showSuccess(`已同时清除 ${data.data.deletedCount} 个本地LRC文件`);
            } else {
                throw new Error(data.message || '清除失败');
            }
        } catch (e) {
            showError('清除独立歌词文件失败: ' + e.message);
        }
    }
}

function toggleDownloadDrawer() {
    if (typeof switchTab === 'function') switchTab('downloads');
}
window.toggleDownloadDrawer = toggleDownloadDrawer;
// Expose functions to window for HTML access
window.switchTab = switchTab;
window.handleSearchKeyPress = handleSearchKeyPress;
window.doSearch = doSearch;
window.changePage = changePage;
window.handleHotSearchClick = handleHotSearchClick;
window.changeHotSearchLimit = changeHotSearchLimit;
window.resetAllSettings = resetAllSettings;
window.clearCache = clearCache;
// Custom Source Management (自定义源管理)
// ========================================

let customSourceMode = 'file'; // 'file' or 'url'

// 处理本地文件上传
async function handleFileUpload(input) {
    const file = input.files[0];
    if (!file) return;

    // 验证文件类型
    if (!file.name.endsWith('.js')) {
        showError('请选择 .js 文件');
        return;
    }

    // 更新文件名显示
    // document.getElementById('file-name-display').textContent = file.name;

    try {
        // 读取文件内容
        const content = await file.text();

        // 先验证脚本
        showInfo('正在验证脚本...');
        const adminPass = localStorage.getItem('lx_admin_password');
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };
        if (adminPass) headers['x-frontend-auth'] = adminPass;

        let validationRes = await fetch('/api/custom-source/validate', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                script: content,
                username: 'shared'
            })
        });

        if (validationRes.status === 403) {
            const errData = await validationRes.json();
            showError(errData.error || '权限限制：请先登录管理员。');
            const authorized = await handleAdminAuth('上传自定义源需要管理员权限');
            if (authorized) return handleFileUpload(input);
            input.value = '';
            return;
        }

        const validation = await validationRes.json();

        if (validation.disabledVM) {
            showError(validation.error || '已禁用VM。当前服务器已禁用 VM 模式。');
            input.value = '';
            return;
        }

        if (!validation.valid && !validation.requireUnsafe) {
            showError(`脚本无效: ${validation.error}`);
            input.value = '';
            // document.getElementById('file-name-display').textContent = '点击选择 .js 文件';
            return;
        }

        // 验证通过，上传
        showInfo(`验证通过，正在上传 "${validation.metadata.name || file.name}"...`);
        let result = await uploadCustomSource(file.name, content, 'file');

        if (result.disabledVM) {
            showError(result.message || '已禁用VM');
            input.value = '';
            return;
        }

        // 如果需要不安全模式确认
        if (result.requireUnsafe) {
            const confirmed = await showSelect('安全风险确认', result.message || '该脚本需要原生 VM 模式运行，可能存在安全风险，是否继续？', { danger: true, confirmText: '允许并上传' });
            if (confirmed) {
                result = await uploadCustomSource(file.name, content, 'file', true);
                if (result.disabledVM) {
                    showError(result.message || '已禁用VM');
                    input.value = '';
                    return;
                }
            } else {
                showInfo('已取消上传');
                input.value = '';
                return;
            }
        }

        showSuccess(`已上传: ${validation.metadata.name || file.name} ${validation.metadata.version ? (/^v/i.test(validation.metadata.version) ? validation.metadata.version : 'v' + validation.metadata.version) : ''}`);

        // 重置输入
        input.value = '';
        // document.getElementById('file-name-display').textContent = '点击选择 .js 文件';

        // 刷新源列表
        loadCustomSources();
    } catch (error) {
        console.error('[CustomSource] 上传失败:', error);
        showError(`上传失败: ${error.message}`);
    }
}

// 处理远程链接导入
async function handleUrlImport() {
    const input = await showInput("导入远程音源", "请输入自定义源脚本的 URL 地址:", {
        placeholder: "https://example.com/script.js",
        confirmText: "开始导入"
    });

    if (input === null) return; // 用户取消

    const url = input.trim();
    if (!url) {
        showError('请输入链接地址');
        return;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (error) {
        showError('请输入有效的 HTTP(S) URL');
        return;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        showError('只支持 HTTP(S) 地址');
        return;
    }

    try {
        showInfo('正在获取并验证远程脚本...');

        const username = 'shared';
        const filename = parsedUrl.pathname.split('/').pop() || '';
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };
        const adminPass = localStorage.getItem('lx_admin_password');
        if (adminPass) headers['x-frontend-auth'] = adminPass;

        // 从服务器代理下载
        const response = await fetch(`/api/custom-source/import`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                url,
                filename,
                username: username
            })
        });

        if (response.status === 403) {
            const data = await response.json();
            showError(data.error || '权限限制：请先登录管理员。');
            const authorized = await handleAdminAuth('导入自定义源需要管理员权限');
            if (authorized) return handleUrlImport();
            return;
        }

        let result = await response.json();

        if (result.disabledVM) {
            showError(result.message || '已禁用VM');
            return;
        }

        if (!response.ok || (result.success === false && !result.requireUnsafe)) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        // 如果需要不安全模式确认
        if (result.requireUnsafe) {
            const confirmed = await showSelect('安全风险确认', result.message || '该脚本需要原生 VM 模式运行，可能存在安全风险，是否继续？', { danger: true, confirmText: '允许并导入' });
            if (confirmed) {
                const retryHeaders = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };
                if (adminPass) retryHeaders['x-frontend-auth'] = adminPass;
                const retryResp = await fetch(`/api/custom-source/import`, {
                    method: 'POST',
                    headers: retryHeaders,
                    body: JSON.stringify({
                        url,
                        filename,
                        username: username,
                        allowUnsafeVM: true,
                    })
                });
                if (retryResp.status === 403) {
                    showError('管理员验证校验失败');
                    return;
                }
                result = await retryResp.json();
                if (result.disabledVM) {
                    showError(result.message || '已禁用VM');
                    return;
                }
            } else {
                showInfo('已取消导入');
                return;
            }
        }

        showSuccess(`已导入: ${result.filename}`);

        // 刷新源列表
        loadCustomSources();
    } catch (error) {
        console.error('[CustomSource] 导入失败:', error);
        showError(`导入失败: ${error.message}`);
    }
}

// 上传自定义源到服务器
async function uploadCustomSource(filename, content, type, allowUnsafeVM = false) {
    const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };
    const adminPass = localStorage.getItem('lx_admin_password');
    if (adminPass) headers['x-frontend-auth'] = adminPass;

    const response = await fetch('/api/custom-source/upload', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
            filename,
            content,
            type,
            username: 'shared',
            allowUnsafeVM
        })
    });

    if (response.status === 403) {
        const result = await response.json();
        showError(result.error || '权限不足：请先登录管理员。');
        const authorized = await handleAdminAuth('上传自定义源需要管理员权限');
        if (authorized) return uploadCustomSource(filename, content, type, allowUnsafeVM);
        return;
    }

    if (!response.ok) {
        const errorText = await response.text();
        let errMsg = errorText;
        try {
            const errJson = JSON.parse(errorText);
            if (errJson.error) errMsg = errJson.error;
        } catch (e) { }
        throw new Error(errMsg || `HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result.success === false && !result.requireUnsafe && !result.disabledVM) {
        throw new Error(result.error || '上传失败');
    }
    return result;
}

// 加载自定义源列表 (随时可以调用以刷新界面)
async function loadCustomSources() {
    await renderCustomSources();
}

// ========== 自定义源管理逻辑 ==========

async function fetchCustomSources() {
    try {
        const username = 'shared';
        const headers = getUserAuthHeaders();
        const adminPass = localStorage.getItem('lx_admin_password');
        if (adminPass) headers['x-frontend-auth'] = adminPass;

        const res = await fetch(`/api/custom-source/list?username=${username}`, {
            headers: headers
        });

        if (res.status === 403) {
            // 被后端拒绝访问
            console.warn('[CustomSource] List access denied (403)');
            return null; // 返回 null 表示由于权限原因被拦截
        }

        if (!res.ok) throw new Error('Failed to fetch sources');
        return await res.json();
    } catch (err) {
        console.error('Fetch sources failed:', err);
        return [];
    }
}


async function renderCustomSources() {
    let list = await fetchCustomSources();

    const isAdmin = !!localStorage.getItem('lx_admin_password');
    const isUser = !!userToken;

    // 控制模态框头部的工具栏显示/隐藏
    const toolbar = document.getElementById('custom-source-toolbar');
    if (toolbar) {
        toolbar.classList.toggle('hidden', !isAdmin && !isUser);
    }

    // 渲染目标容器 ID 列表：模态框内 & 设置界面内
    const targetIds = ['custom-sources-list', 'settings-custom-sources-list'];

    targetIds.forEach(containerId => {
        const container = document.getElementById(containerId);
        if (!container) return;

        // 空状态
        if (!list || list.length === 0) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center p-6 t-text-muted">
                    <i class="fas fa-box-open text-3xl mb-3 opacity-30"></i>
                    <p class="text-sm">暂无自定义源</p>
                    ${containerId === 'custom-sources-list' ?
                    `<button onclick="document.getElementById('script-file').click()" class="mt-3 text-emerald-600 hover:text-emerald-700 text-sm font-medium">即刻上传</button>`
                    : ''}
                </div>
            `;
            return;
        }

        container.innerHTML = '';

        list.forEach((source, index) => {
            const div = document.createElement('div');
            // 设置界面使用稍紧凑的样式，模态框使用标准样式 (这里为了统一先用一样的，微调边距)
            div.className = `t-bg-panel p-4 rounded-xl border t-border-main shadow-sm hover:shadow-md transition-all mb-3 relative group flex items-start source-item`;
            div.dataset.id = source.id;
            div.dataset.enabled = source.enabled;
            div.dataset.index = index;

            // 格式化支持的源
            let supportedBadges = '';
            if (source.supportedSources && source.supportedSources.length > 0) {
                const sourceMap = {
                    'kg': { name: '酷狗', color: 't-badge-blue' },
                    'kw': { name: '酷我', color: 't-badge-yellow' },
                    'tx': { name: 'QQ', color: 't-badge-green' },
                    'wy': { name: '网易', color: 't-badge-red' },
                    'mg': { name: '咪咕', color: 't-badge-pink' }
                };

                supportedBadges = `<div class="flex flex-wrap gap-1.5 mt-2">
                ${source.supportedSources.map(s => {
                    const info = sourceMap[s] || { name: s, color: 't-badge-gray' };
                    return `<span class="px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors border border-transparent ${info.color}">${escapeHtmlText(info.name)}</span>`;
                }).join('')}
            </div>`;
            } else {
                supportedBadges = `<div class="mt-2 text-[10px] t-text-muted italic">未知支持源</div>`;
            }

            const size = source.size && !isNaN(source.size) ? (source.size / 1024).toFixed(1) + ' KB' : '未知大小';
            let date = '未知日期';
            try {
                if (source.uploadTime) date = new Date(source.uploadTime).toLocaleDateString();
            } catch (e) { }

            /* Status Badge Logic */
            let statusBadge = '';
            let errorMsg = '';

            if (source.enabled) {
                if (source.status === 'success') {
                    statusBadge = `<span class="text-[10px] bg-emerald-50 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 dark:border-emerald-500/30 px-1.5 py-0.5 rounded-full border border-emerald-100 flex items-center gap-1 transition-colors"><i class="fas fa-check-circle"></i>正常</span>`;
                } else if (source.status === 'failed') {
                    statusBadge = `<span class="text-[10px] bg-red-50 text-red-600 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30 px-1.5 py-0.5 rounded-full border border-red-100 flex items-center gap-1 cursor-help transition-colors" title="${escapeHtmlText(source.error || '加载失败')}"><i class="fas fa-times-circle"></i>失败</span>`;
                    errorMsg = `<div class="text-[10px] text-red-500 dark:text-red-400 mt-1 flex items-start gap-1 p-1.5 bg-red-50 dark:bg-red-900/20 rounded transition-colors"><i class="fas fa-info-circle mt-0.5 flex-shrink-0"></i><span class="break-all">${escapeHtmlText(source.error || '未知错误')}</span></div>`;
                } else {
                    statusBadge = `<span class="text-[10px] bg-blue-50 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/30 px-1.5 py-0.5 rounded-full border border-blue-100 flex items-center gap-1 transition-colors"><i class="fas fa-circle-notch fa-spin"></i>加载...</span>`;
                }
            }

            const vmTag = source.allowUnsafeVM ?
                `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-red-50 text-red-500 border border-red-100 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30">VM</span>` : '';

            const canManageSource = isAdmin || isUser;

            div.innerHTML = `
            <div class="flex items-center self-stretch cursor-grab custom-source-handle t-text-muted hover:text-emerald-500 pr-4 -ml-2 transition-all active:scale-110 touch-none" title="拖拽排序">
                <i class="fas fa-grip-vertical text-lg"></i>
            </div>
            <div class="flex justify-between items-start flex-1 min-w-0">
                <div class="flex-1 pr-4 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <i class="fas fa-file-code text-emerald-500 flex-shrink-0"></i>
                         ${createMarqueeHtml(source.name, "font-bold t-text-main text-sm")}
                         ${vmTag}
                    </div>
                    ${errorMsg}
                    <div class="flex flex-wrap items-center text-[10px] t-text-muted gap-x-3 gap-y-1 mt-1.5">
                        <span class="flex items-center"><i class="fas fa-user mr-1 opacity-70"></i>${escapeHtmlText(source.author || '未知')}</span>
                        <span class="flex items-center"><i class="far fa-hdd mr-1 opacity-70"></i>${size}</span>
                        <span class="t-bg-main t-text-muted px-1.5 py-0.5 rounded-lg shrink-0 transition-colors font-mono pointer-events-none border t-border-main">${escapeHtmlText(source.version ? (/^v/i.test(source.version) ? source.version : 'v' + source.version) : '未知')}</span>
                        ${statusBadge}
                    </div>
                    ${supportedBadges}
                </div>
                <div class="flex flex-col items-end gap-2 shrink-0">
                    <button onclick="toggleSource(${htmlJs(source.id)}, ${source.enabled === true})"
                            class="px-3 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap w-20 flex justify-center items-center ${source.enabled
                    ? (source.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400 hover:bg-emerald-200 dark:hover:bg-emerald-500/30')
                    : 't-bg-track t-text-muted hover:t-bg-item-hover'}">
                        ${source.enabled ? '已启用' : '已禁用'}
                    </button>
                    <div class="flex items-center gap-1">
                        ${source.enabled && source.status === 'failed' && canManageSource ? `
                        <button onclick="reloadSource(${htmlJs(source.id)})"
                                class="p-1.5 text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/40 rounded-lg transition-colors"
                                title="尝试重新加载">
                            <i class="fas fa-sync-alt text-sm"></i>
                        </button>` : ''}
                        ${canManageSource ? `
                        <button onclick="deleteSource(${htmlJs(source.id)})"
                                class="p-1.5 t-text-muted hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/40 rounded-lg transition-colors"
                                title="删除">
                            <i class="fas fa-trash-alt text-sm"></i>
                        </button>` : ''}
                    </div>
                </div>
            </div>
        `;
            container.appendChild(div);
        });

        // Add Sortable for both the modal list and the settings panel list
        const isSortableContainer = (containerId === 'custom-sources-list' || containerId === 'settings-custom-sources-list') && typeof Sortable !== 'undefined';
        if (isSortableContainer) {
            try {
                const oldSortable = Sortable.get(container);
                if (oldSortable) oldSortable.destroy();
            } catch (e) { }

            Sortable.create(container, {
                animation: 200,
                handle: '.custom-source-handle',
                ghostClass: 'sortable-ghost-solid',
                chosenClass: 'sortable-chosen-item',
                dragClass: 'sortable-drag-item',
                forceFallback: true,
                delay: 200,
                delayOnTouchOnly: true,
                onEnd: async function (evt) {
                    // 防止两个容器同时触发 onEnd 导致重复请求
                    if (window._reorderLock) return;
                    window._reorderLock = true;
                    setTimeout(() => { window._reorderLock = false; }, 500);

                    // DOM 已由 SortableJS 更新，直接读取新顺序
                    const items = Array.from(container.querySelectorAll('.source-item'));
                    const finalOrderIds = items.map(el => el.dataset.id);

                    // 同步另一个容器的 DOM 顺序（保持两者一致）
                    const otherId = containerId === 'custom-sources-list' ? 'settings-custom-sources-list' : 'custom-sources-list';
                    const otherContainer = document.getElementById(otherId);
                    if (otherContainer) {
                        finalOrderIds.forEach(id => {
                            const el = otherContainer.querySelector(`.source-item[data-id="${id}"]`);
                            if (el) otherContainer.appendChild(el);
                        });
                    }

                    try {
        const username = 'shared';
                        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };
                        const adminPass = localStorage.getItem('lx_admin_password');
                        if (adminPass) headers['x-frontend-auth'] = adminPass;

                        const response = await fetch('/api/custom-source/reorder', {
                            method: 'POST',
                            headers: headers,
                            body: JSON.stringify({ username, sourceIds: finalOrderIds })
                        });

                        if (response.status === 403) {
                            showError('权限限制：保存排序需要管理员身份。');
                            const authorized = await handleAdminAuth('保存排序需要管理员身份');
                            if (authorized) renderCustomSources();
                            else renderCustomSources();
                            return;
                        }
                        if (!response.ok) throw new Error('Reorder failed');
                        // 成功：DOM 已是正确顺序，无需重新拉取
                        showInfo('排序已保存');
                    } catch (error) {
                        console.error('Reorder error:', error);
                        showError('保存排序失败，已还原');
                        renderCustomSources();
                    }
                }
            });
        }
    });

    if (typeof applyMarqueeChecks === 'function') {
        applyMarqueeChecks();
    }
}

// 重新加载源 (强制重新启用)
async function reloadSource(sourceId) {
    try {
        const username = 'shared';
        const adminPass = localStorage.getItem('lx_admin_password');
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };
        if (adminPass) headers['x-frontend-auth'] = adminPass;

        const response = await fetch('/api/custom-source/toggle', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ username, sourceId, enabled: true }) // Force enable triggers reload
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        showInfo('正在重新加载...');
        // Wait a bit for server to process
        setTimeout(() => {
            renderCustomSources();
        }, 1000);

    } catch (error) {
        console.error('Reload failed:', error);
        showError(`重载请求失败: ${error.message}`);
    }
}

// 切换状态
async function toggleSource(sourceId, currentEnabled, allowUnsafeVM = false) {
    try {
        const username = 'shared';
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };
        const adminPass = localStorage.getItem('lx_admin_password');
        if (adminPass) headers['x-frontend-auth'] = adminPass;

        const response = await fetch('/api/custom-source/toggle', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ username, sourceId, enabled: !currentEnabled, allowUnsafeVM }) // Send new state
        });

        if (response.status === 403) {
            const data = await response.json();
            showError(data.error || '权限限制：需要管理员身份。');
            const authorized = await handleAdminAuth('修改自定义源状态需要管理员权限');
            if (authorized) return await toggleSource(sourceId, currentEnabled, allowUnsafeVM);
            return;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const result = await response.json();

        if (result.disabledVM) {
            showError(result.message || '已禁用VM');
            return;
        }

        // 处理 REQUIRE_UNSAFE_VM
        if (result.requireUnsafe) {
            const confirmed = await showSelect('安全风险确认', result.message || '该脚本需要原生 VM 模式运行，可能存在安全风险，是否继续？', { danger: true, confirmText: '依然启用' });
            if (confirmed) {
                return await toggleSource(sourceId, currentEnabled, true);
            } else {
                return;
            }
        }

        // 刷新列表
        await renderCustomSources();
        showSuccess(currentEnabled ? '已禁用' : '已启用');
    } catch (error) {
        console.error('[CustomSource] 切换状态失败:', error);
        showError(`操作失败: ${error.message}`);
    }
}

// 删除源
async function deleteSource(sourceId) {
    if (!(await showSelect('删除自定义源', '确定要删除这个自定义源吗？', { danger: true }))) return;

    try {
        const username = 'shared';
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };
        const adminPass = localStorage.getItem('lx_admin_password');
        if (adminPass) headers['x-frontend-auth'] = adminPass;

        const response = await fetch('/api/custom-source/delete', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ username, sourceId })
        });

        if (response.status === 403) {
            const data = await response.json();
            showError(data.error || '权限限制：需要管理员身份。');
            const authorized = await handleAdminAuth('删除自定义源需要管理员权限');
            if (authorized) return await deleteSource(sourceId);
            return;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        showSuccess('已删除');
        await renderCustomSources();
    } catch (error) {
        console.error('[CustomSource] 删除失败:', error);
        showError(`删除失败: ${error.message}`);
    }
}

// 模态框控制
function openCustomSourceModal() {
    const modal = document.getElementById('custom-source-modal');
    const content = document.getElementById('custom-source-modal-content');
    if (modal) modal.classList.remove('hidden');

    // 渲染列表
    renderCustomSources();

    setTimeout(() => {
        if (content) {
            content.classList.remove('scale-95', 'opacity-0');
            content.classList.add('scale-100', 'opacity-100');
        }
    }, 10);
}

function closeCustomSourceModal() {
    const modal = document.getElementById('custom-source-modal');
    const content = document.getElementById('custom-source-modal-content');

    if (content) {
        content.classList.remove('scale-100', 'opacity-100');
        content.classList.add('scale-95', 'opacity-0');
    }

    setTimeout(() => {
        if (modal) modal.classList.add('hidden');
    }, 300);
}


// ========================================
// Global Overrides
// ========================================

// ========================================
// Mobile Optimization Logic
// ========================================

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'lx-sidebar-collapsed';

function readSidebarCollapsedState() {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
    } catch (error) {
        console.warn('[Layout] 无法读取侧边栏状态:', error);
        return false;
    }
}

function writeSidebarCollapsedState(isCollapsed) {
    try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
    } catch (error) {
        console.warn('[Layout] 无法保存侧边栏状态:', error);
    }
}

function setSidebarCollapsed(isCollapsed, persist = true) {
    const sidebar = document.getElementById('main-sidebar');
    const button = document.getElementById('sidebar-collapse-button');
    const icon = document.getElementById('sidebar-collapse-icon');

    if (!sidebar || !button || window.innerWidth < 1025) return;

    sidebar.classList.toggle('is-collapsed', isCollapsed);
    button.setAttribute('aria-expanded', String(!isCollapsed));
    button.setAttribute('aria-label', isCollapsed ? '展开侧边栏' : '收起侧边栏');
    button.title = isCollapsed ? '展开侧边栏' : '收起侧边栏';

    if (icon) {
        icon.classList.toggle('fa-angle-double-right', isCollapsed);
        icon.classList.toggle('fa-angle-double-left', !isCollapsed);
    }

    if (persist) writeSidebarCollapsedState(isCollapsed);
}

function toggleSidebarCollapse() {
    const sidebar = document.getElementById('main-sidebar');
    if (!sidebar || window.innerWidth < 1025) return;
    setSidebarCollapsed(!sidebar.classList.contains('is-collapsed'));
}

function updateMobileSidebarButton(isOpen) {
    const button = document.getElementById('mobile-menu-button');
    if (button) button.setAttribute('aria-expanded', String(isOpen));
}

function initializeSidebarLayout() {
    updateMobileSidebarButton(false);
    if (window.innerWidth >= 1025) setSidebarCollapsed(readSidebarCollapsedState(), false);
}

// Mobile Sidebar Toggle
function toggleSidebar() {
    const sidebar = document.getElementById('main-sidebar');
    const backdrop = document.getElementById('mobile-sidebar-backdrop');
    if (!sidebar || !backdrop) return;

    if (sidebar.classList.contains('-translate-x-full')) {
        // Open
        sidebar.classList.remove('-translate-x-full');
        sidebar.classList.add('translate-x-0');
        backdrop.classList.remove('hidden');
        updateMobileSidebarButton(true);
    } else {
        // Close
        sidebar.classList.remove('translate-x-0');
        sidebar.classList.add('-translate-x-full');
        backdrop.classList.add('hidden');
        updateMobileSidebarButton(false);
    }
}

document.addEventListener('DOMContentLoaded', initializeSidebarLayout);

// Auto-adjust layout on resize
window.addEventListener('resize', () => {
    const sidebar = document.getElementById('main-sidebar');
    const backdrop = document.getElementById('mobile-sidebar-backdrop');

    if (sidebar && window.innerWidth >= 1025) {
        // Reset styles for desktop
        sidebar.classList.remove('-translate-x-full', 'translate-x-0');
        if (backdrop) backdrop.classList.add('hidden');
        updateMobileSidebarButton(false);
        setSidebarCollapsed(sidebar.classList.contains('is-collapsed') || readSidebarCollapsedState(), false);
    } else if (sidebar) {
        // Ensure default closed state for mobile if not explicitly open
        if (!sidebar.classList.contains('translate-x-0')) {
            sidebar.classList.add('-translate-x-full');
            updateMobileSidebarButton(false);
        }
    }
});

// 导出函数
window.updateSetting = updateSetting;

// --- Search Suggestions Logic ---
let searchTipsDebounceTimer = null;
let currentSelectedTipIndex = -1;
let currentTipAbortController = null;

function initSearchTips() {
    const searchInput = document.getElementById('search-input');
    const suggestionsContainer = document.getElementById('search-suggestions');

    if (!searchInput || !suggestionsContainer) return;

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        clearTimeout(searchTipsDebounceTimer);

        if (!query) {
            hideSearchSuggestions();
            return;
        }

        searchTipsDebounceTimer = setTimeout(() => {
            fetchSearchTips(query);
        }, 300);
    });

    searchInput.addEventListener('focus', () => {
        const query = searchInput.value.trim();
        if (query) {
            suggestionsContainer.classList.remove('hidden');
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        const list = document.getElementById('search-suggestions-list');
        const items = list ? list.querySelectorAll('.search-tip-item') : [];

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (items.length === 0) return;
            currentSelectedTipIndex = (currentSelectedTipIndex + 1) % items.length;
            updateTipSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (items.length === 0) return;
            currentSelectedTipIndex = (currentSelectedTipIndex - 1 + items.length) % items.length;
            updateTipSelection(items);
        } else if (e.key === 'Enter') {
            if (currentSelectedTipIndex >= 0 && items[currentSelectedTipIndex]) {
                e.preventDefault();
                const text = items[currentSelectedTipIndex].textContent.trim();
                searchInput.value = text;
                hideSearchSuggestions();
                doSearch();
            }
        } else if (e.key === 'Escape') {
            hideSearchSuggestions();
        }
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !suggestionsContainer.contains(e.target)) {
            hideSearchSuggestions();
        }
    });
}

function updateTipSelection(items) {
    items.forEach((item, index) => {
        if (index === currentSelectedTipIndex) {
            item.classList.add('t-bg-muted');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('t-bg-muted');
        }
    });
}

async function fetchSearchTips(query) {
    if (currentTipAbortController) currentTipAbortController.abort();
    currentTipAbortController = new AbortController();
    const signal = currentTipAbortController.signal;

    const source = (document.getElementById('search-source')) ? document.getElementById('search-source').value : 'kw';
    try {
        const resp = await fetch(`/api/music/tipSearch?name=${encodeURIComponent(query)}&source=${source}`, { signal });
        if (!resp.ok) return;
        const tips = await resp.json();
        renderSearchTips(tips);
    } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('[TipSearch] Fetch error:', err);
    } finally {
        if (currentTipAbortController && currentTipAbortController.signal === signal) {
            currentTipAbortController = null;
        }
    }
}

function renderSearchTips(tips) {
    const container = document.getElementById('search-suggestions');
    const list = document.getElementById('search-suggestions-list');
    const input = document.getElementById('search-input');
    if (!container || !list || !input) return;

    // 如果输入框已失去焦点（除非是操作建议列表），或者已经触发了正式搜索，则不再渲染
    if (document.activeElement !== input) {
        container.classList.add('hidden');
        return;
    }

    list.innerHTML = '';
    currentSelectedTipIndex = -1;

    if (!tips || tips.length === 0) {
        container.classList.add('hidden');
        return;
    }

    tips.forEach((tip, index) => {
        const div = document.createElement('div');
        div.className = 'search-tip-item px-4 py-2.5 hover:t-bg-muted cursor-pointer transition-colors text-sm flex items-center gap-3';
        div.innerHTML = `<i class="fas fa-search t-text-muted text-xs"></i><span class="truncate">${escapeHtmlText(tip)}</span>`;
        div.onclick = (e) => {
            e.stopPropagation(); // 防止触发 document click
            input.value = tip;
            hideSearchSuggestions();
            doSearch();
        };
        list.appendChild(div);
    });

    container.classList.remove('hidden');
}

function hideSearchSuggestions() {
    const container = document.getElementById('search-suggestions');
    if (container) container.classList.add('hidden');
    currentSelectedTipIndex = -1;

    // 清除待执行的防抖定时器
    if (searchTipsDebounceTimer) {
        clearTimeout(searchTipsDebounceTimer);
        searchTipsDebounceTimer = null;
    }

    // 中止正在进行的请求
    if (currentTipAbortController) {
        currentTipAbortController.abort();
        currentTipAbortController = null;
    }
}

// Ensure initSearchTips runs on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearchTips);
} else {
    initSearchTips();
}
// ── 全新自定义下拉框管理模块 ──
// ── 全新自定义下拉框管理模块 (Portal 模式版) ──
window.CustomSelectManager = {
    initAll() {
        document.querySelectorAll('select:not(.cs-hidden)').forEach(select => {
            this.init(select);
        });
    },
    init(select) {
        if (select.classList.contains('cs-hidden')) return;
        
        // 创建包装器，继承原 select 的布局类（如 flex-1, flex-shrink-0）
        const wrapper = document.createElement('div');
        wrapper.className = 'cs-wrapper';
        // 提取布局类
        const layoutClasses = Array.from(select.classList).filter(c =>
            c.startsWith('flex-') || c.startsWith('sm:flex-') || c.startsWith('md:flex-') ||
            c.startsWith('w-') || c.startsWith('sm:w-') || c.startsWith('md:w-') ||
            c.startsWith('shrink-') || c.startsWith('sm:shrink-') || c.startsWith('md:shrink-')
        );
        if (layoutClasses.length) wrapper.classList.add(...layoutClasses);
        if (select.id) wrapper.id = 'cs-w-' + select.id;
        
        const trigger = document.createElement('div');
        trigger.className = 'cs-trigger';
        
        // 精准克隆外观属性以防止大小不一致 (匹配 Tailwind 值)
        if (select.classList.contains('px-4')) { trigger.style.paddingLeft = '1rem'; trigger.style.paddingRight = '1rem'; }
        if (select.classList.contains('py-3')) { trigger.style.paddingTop = '0.75rem'; trigger.style.paddingBottom = '0.75rem'; }
        if (select.classList.contains('py-2')) { trigger.style.paddingTop = '0.5rem'; trigger.style.paddingBottom = '0.5rem'; }
        if (select.classList.contains('rounded-xl')) trigger.style.borderRadius = '0.75rem';
        if (select.classList.contains('text-sm')) trigger.style.fontSize = '0.875rem';
        if (select.classList.contains('font-medium')) trigger.style.fontWeight = '500';
        
        const text = document.createElement('span');
        text.className = 'cs-trigger-text truncate mr-2';
        
        const icon = document.createElement('i');
        icon.className = 'fas fa-chevron-down cs-trigger-icon';
        
        trigger.appendChild(text);
        trigger.appendChild(icon);
        wrapper.appendChild(trigger);
        
        // 隐藏原始 select
        select.classList.add('cs-hidden');
        select.style.display = 'none';
        select.parentNode.insertBefore(wrapper, select);
        
        trigger.onclick = (e) => {
            e.stopPropagation();
            const isActive = wrapper.classList.contains('active');
            if (isActive) {
                this.closeAll();
            } else {
                this.closeAll();
                this.open(select, wrapper, trigger);
            }
        };
        
        // 初始同步 UI
        this.syncUI(select, wrapper);

        // 劫持 value 属性以支持 JS 赋值同步
        try {
            const originalSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
            Object.defineProperty(select, 'value', {
                set: function(val) {
                    originalSetter.call(this, val);
                    window.CustomSelectManager.syncUI(this);
                },
                get: function() {
                    return Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').get.call(this);
                },
                configurable: true
            });
        } catch (e) { console.warn('[CustomSelect] Value hijack failed:', e); }
    },
    open(select, wrapper, trigger) {
        wrapper.classList.add('active');
        
        // 创建下拉菜单并存入 body
        const dropdown = document.createElement('div');
        dropdown.className = 'cs-dropdown custom-scrollbar portal-active';
        dropdown.id = 'cs-dropdown-' + (select.id || Math.random().toString(36).substr(2, 9));
        
        const optionsList = document.createElement('ul');
        optionsList.className = 'cs-options';
        
        Array.from(select.options).forEach(opt => {
            const li = document.createElement('li');
            li.className = 'cs-option' + (opt.selected ? ' selected' : '');
            li.innerHTML = `<span>${opt.text}</span><i class="fas fa-check"></i>`;
            
            li.onclick = (e) => {
                e.stopPropagation();
                select.value = opt.value;
                select.dispatchEvent(new Event('change'));
                this.syncUI(select, wrapper);
                this.closeAll();
            };
            optionsList.appendChild(li);
        });
        
        dropdown.appendChild(optionsList);
        document.body.appendChild(dropdown);
        
        // 计算位置
        this.reposition(trigger, dropdown);
        
        // 监听滚动以保持同步或关闭
        window.addEventListener('scroll', this.handleScrollOrResize, true);
        window.addEventListener('resize', this.handleScrollOrResize);
        
        requestAnimationFrame(() => {
            dropdown.classList.add('visible');
        });
    },
    reposition(trigger, dropdown) {
        const rect = trigger.getBoundingClientRect();
        dropdown.style.width = rect.width + 'px';
        dropdown.style.left = rect.left + 'px';
        
        // 检查空间，自动决定向上还是向下展开
        const spaceBelow = window.innerHeight - rect.bottom;
        const dropdownHeight = dropdown.offsetHeight || 260;
        
        if (spaceBelow < dropdownHeight && rect.top > dropdownHeight) {
            dropdown.style.top = (rect.top + window.scrollY - dropdownHeight - 6) + 'px';
            dropdown.classList.add('open-up');
        } else {
            dropdown.style.top = (rect.bottom + window.scrollY + 4) + 'px';
            dropdown.classList.remove('open-up');
        }
    },
    handleScrollOrResize(e) {
        if (e && e.target && e.target.closest && e.target.closest('.cs-dropdown')) {
            return;
        }
        window.CustomSelectManager.closeAll();
    },
    syncUI(select, wrapper) {
        if (!wrapper) wrapper = select.previousSibling;
        if (!wrapper || !wrapper.classList.contains('cs-wrapper')) return;
        
        const textEl = wrapper.querySelector('.cs-trigger-text');
        const selectedOpt = select.options[select.selectedIndex];
        if (selectedOpt) {
            textEl.innerText = selectedOpt.text;
            this.updateHighlight(select, wrapper);
        }
    },
    updateHighlight(select, wrapper) {
        const val = select.value;
        let isDefault = false;
        if (select.id && typeof SETTINGS_UI_MAP !== 'undefined' && typeof DEFAULT_SETTINGS !== 'undefined') {
            const key = Object.keys(SETTINGS_UI_MAP).find(k => SETTINGS_UI_MAP[k].id === select.id);
            if (key && DEFAULT_SETTINGS[key] !== undefined) {
                isDefault = (String(val) === String(DEFAULT_SETTINGS[key]));
            }
        }
        
        if (!select.id || isDefault || ['all', 'none', 'root', 'mtime', 'desc', 'wy', '20', 'song'].includes(val)) {
            wrapper.classList.remove('highlight');
        } else {
            wrapper.classList.add('highlight');
        }
    },
    closeAll() {
        document.querySelectorAll('.cs-wrapper.active').forEach(w => w.classList.remove('active'));
        document.querySelectorAll('.cs-dropdown.portal-active').forEach(d => {
            d.remove();
        });
        window.removeEventListener('scroll', this.handleScrollOrResize, true);
        window.removeEventListener('resize', this.handleScrollOrResize);
    }
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('.cs-wrapper') && !e.target.closest('.cs-dropdown')) {
        window.CustomSelectManager.closeAll();
    }
});

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    window.CustomSelectManager.initAll();
});
