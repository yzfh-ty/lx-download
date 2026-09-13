/**
 * LocalMusicManager (本地音乐模块)
 * 处理在本地音乐Tab下的列表加载、刷选、删除功能
 */

window.LocalMusicManager = {
    originalData: [],
    displayData: [],
    currentPage: 1,
    pageSize: 60,
    batchMode: false,
    batchActionsEventsBound: false,
    selectedItems: new Set(),
    filterQuality: new Set(), // 多选 Set，空集合 = 不限制
    filterStatus: new Set(),  // 多选 Set，空集合 = 不限制
    filterSource: new Set(),  // 多选 Set，空集合 = 不限制
    sortBy: 'mtime',
    sortOrder: 'desc',
    quickSearchKeyword: '',
    searchTimer: null,
    isFilterPanelOpen: false,
    cacheKey: 'lx_lm_filters',   // [New] localStorage key
    listEventsBound: false,
    remasterPollTimer: null,
    remasterResultOffset: 0,
    remasterResults: [],
    remasterResultFilter: 'all',
    remasterTaskId: '',
    remasterTargetQuality: 'flac24bit',
    remasterLastTerminalTaskId: '',
    remasterSelectedItems: new Set(),
    remasterSearchKeyword: '',
    remasterSelectionPage: 1,
    remasterSelectionPageSize: 50,
    remasterSelectionEventsBound: false,
    remasterQualityEventsBound: false,
    remasterTaskRunning: false,
    deduplicateInFlight: false,
    authExpired: false,
    authExpiredNotified: false,
    coverRenderTimer: null,

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        })[ch]);
    },

    escapeAttr(value) {
        return this.escapeHtml(value);
    },

    tokenizeSearchExpression(expression) {
        const tokens = [];
        let buffer = '';
        let quote = '';
        let escaped = false;
        const operatorTypes = {
            '&': 'and',
            '|': 'or',
            '!': 'not',
            '(': 'leftParen',
            ')': 'rightParen',
        };
        const flushTerm = () => {
            const value = buffer.trim();
            if (value) tokens.push({ type: 'term', value });
            buffer = '';
        };

        const str = String(expression || '');
        let i = 0;
        while (i < str.length) {
            const char = str[i];

            if (quote) {
                if (escaped) {
                    buffer += char;
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === quote) {
                    quote = '';
                } else {
                    buffer += char;
                }
                i++;
                continue;
            }

            if (char === '"' || char === "'") {
                quote = char;
                i++;
                continue;
            }

            // 1. 优先检测由 lm-op-tag 转换生成的 \u0001[op]\u0001 显式运算符标签
            if (char === '\u0001') {
                const nextMarker = str.indexOf('\u0001', i + 1);
                if (nextMarker !== -1) {
                    const op = str.substring(i + 1, nextMarker).trim();
                    const opType = operatorTypes[op];
                    if (opType) {
                        flushTerm();
                        tokens.push({ type: opType });
                        i = nextMarker + 1;
                        continue;
                    }
                }
            }

            // 2. 兜底检测：符号后紧跟空格或处于串尾的运算符
            const operatorType = operatorTypes[char];
            if (operatorType) {
                const nextChar = str[i + 1];
                const isFollowedBySpaceOrEnd = !nextChar || /\s/.test(nextChar);
                if (isFollowedBySpaceOrEnd) {
                    flushTerm();
                    tokens.push({ type: operatorType });
                    i++;
                    continue;
                }
            }

            // 普通字符（例如 R&B 中的 &）
            buffer += char;
            i++;
        }

        if (quote) return null;
        if (escaped) buffer += '\\';
        flushTerm();
        return tokens;
    },

    getRichInputValue(el) {
        if (!el) return '';
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            return el.value || '';
        }
        let result = '';
        const walk = (node) => {
            if (node.nodeType === 3) {
                result += node.nodeValue;
            } else if (node.nodeType === 1) {
                if (node.classList.contains('lm-op-tag')) {
                    const op = node.getAttribute('data-op') || node.textContent.trim();
                    result += `\u0001${op}\u0001 `;
                } else if (node.tagName === 'BR') {
                    result += ' ';
                } else {
                    for (let child of node.childNodes) walk(child);
                }
            }
        };
        walk(el);
        return result.replace(/[\u200B\u00A0]/g, ' ');
    },

    setRichInputValue(el, value) {
        if (!el) return;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value = value || '';
            return;
        }
        const str = String(value || '');
        if (!str.trim()) {
            el.innerHTML = '';
            return;
        }

        let html = '\u200B';
        let i = 0;
        const operatorSymbols = ['&', '|', '!', '(', ')'];

        while (i < str.length) {
            if (str[i] === '\u0001') {
                const nextMarker = str.indexOf('\u0001', i + 1);
                if (nextMarker !== -1) {
                    const op = str.substring(i + 1, nextMarker).trim();
                    if (operatorSymbols.includes(op)) {
                        html += `<span class="lm-op-tag" data-op="${this.escapeAttr(op)}" contenteditable="false">${this.escapeHtml(op)}</span>&nbsp;`;
                        i = nextMarker + 1;
                        if (i < str.length && str[i] === ' ') i++;
                        continue;
                    }
                }
            }
            const char = str[i];
            if (operatorSymbols.includes(char) && (i + 1 >= str.length || /\s/.test(str[i + 1]))) {
                html += `<span class="lm-op-tag" data-op="${this.escapeAttr(char)}" contenteditable="false">${this.escapeHtml(char)}</span>&nbsp;`;
                i += (str[i + 1] === ' ' ? 2 : 1);
                continue;
            }
            html += this.escapeHtml(char);
            i++;
        }
        el.innerHTML = html;
    },

    formatRichInput(el, force = false) {
        if (!el || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return false;

        const rawVal = this.getRichInputValue(el).replace(/[\u200B\u00A0]/g, '').trim();
        if (!rawVal) {
            el.innerHTML = '';
            this.updateSearchInputErrorState(el, '');
            return false;
        }

        let needsFormat = force;
        if (!needsFormat) {
            const walkCheck = (node) => {
                if (node.nodeType === 3) {
                    const text = node.nodeValue || '';
                    if (/([&|!()])(\s|\u00A0)/.test(text)) {
                        needsFormat = true;
                    }
                } else if (node.nodeType === 1 && !node.classList.contains('lm-op-tag')) {
                    for (let child of node.childNodes) walkCheck(child);
                }
            };
            walkCheck(el);
        }

        if (!needsFormat) return false;

        const caretOffset = this.getRichCaretOffset(el);
        const val = this.getRichInputValue(el);
        this.setRichInputValue(el, val);
        this.setRichCaretOffset(el, caretOffset);
        return true;
    },

    getRichCaretOffset(el) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return 0;
        const range = sel.getRangeAt(0);
        if (!el.contains(range.startContainer)) return 0;
        const preRange = range.cloneRange();
        preRange.selectNodeContents(el);
        preRange.setEnd(range.startContainer, range.startOffset);
        return preRange.toString().length;
    },

    setRichCaretOffset(el, offset) {
        const sel = window.getSelection();
        if (!sel) return;
        const range = document.createRange();
        let currentPos = 0;
        let nodeStack = [el], node, found = false;

        while (!found && (node = nodeStack.pop())) {
            if (node.nodeType === 3) {
                const nextPos = currentPos + node.length;
                if (offset >= currentPos && offset <= nextPos) {
                    const pos = Math.min(node.length, Math.max(0, offset - currentPos));
                    range.setStart(node, pos);
                    range.setEnd(node, pos);
                    found = true;
                }
                currentPos = nextPos;
            } else if (node.nodeType === 1 && node.classList.contains('lm-op-tag')) {
                const nextPos = currentPos + 1;
                if (offset === currentPos || offset === nextPos) {
                    range.setStartAfter(node);
                    range.setEndAfter(node);
                    found = true;
                }
                currentPos = nextPos;
            } else {
                let i = node.childNodes.length;
                while (i--) {
                    nodeStack.push(node.childNodes[i]);
                }
            }
        }
        if (!found) {
            range.selectNodeContents(el);
            range.collapse(false);
        }
        sel.removeAllRanges();
        sel.addRange(range);
    },

    handleRichKeydown(event, el) {
        if (event.key === 'Enter') {
            event.preventDefault();
            return;
        }
        if (event.key === 'Backspace') {
            const sel = window.getSelection();
            if (sel && sel.rangeCount) {
                const range = sel.getRangeAt(0);
                if (range.collapsed) {
                    const node = range.startContainer;
                    const offset = range.startOffset;
                    if (node.nodeType === 3 && offset === 0 && node.previousSibling && node.previousSibling.classList?.contains('lm-op-tag')) {
                        event.preventDefault();
                        node.previousSibling.remove();
                        this.triggerSearchFromElement(el);
                        return;
                    }
                    if (node.nodeType === 1 && offset > 0) {
                        const targetChild = node.childNodes[offset - 1];
                        if (targetChild && targetChild.classList?.contains('lm-op-tag')) {
                            event.preventDefault();
                            targetChild.remove();
                            this.triggerSearchFromElement(el);
                            return;
                        }
                    }
                }
            }
        }
    },

    handleRichCopy(event, el) {
        if (!el) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;

        const range = sel.getRangeAt(0);
        const fullText = this.getRichInputValue(el).replace(/[\u200B\u00A0]/g, ' ').trim();
        const selectedText = sel.toString().replace(/[\u200B\u00A0]/g, ' ').trim();

        // 当全选或选区从最开始节点延伸时，确保克隆包含首个标签在内的所有内容
        const isSelectAll = (selectedText.length >= fullText.length - 2) ||
                            (range.startContainer === el && range.startOffset <= 1) ||
                            (range.startContainer === el.firstChild) ||
                            (el.firstChild && el.firstChild.contains(range.startContainer));

        const container = document.createElement('div');
        if (isSelectAll) {
            container.innerHTML = el.innerHTML;
        } else {
            for (let i = 0; i < sel.rangeCount; i++) {
                container.appendChild(sel.getRangeAt(i).cloneContents());
            }
        }

        let text = '';
        const walk = (node) => {
            if (node.nodeType === 3) {
                text += node.nodeValue;
            } else if (node.nodeType === 1) {
                if (node.classList.contains('lm-op-tag')) {
                    const op = node.getAttribute('data-op') || node.textContent.trim();
                    text += `${op} `;
                } else {
                    for (let child of node.childNodes) walk(child);
                }
            }
        };
        walk(container);

        const cleanText = text.replace(/[\u200B\u00A0]/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanText) {
            event.preventDefault();
            (event.clipboardData || window.clipboardData)?.setData('text/plain', cleanText);
            if (event.type === 'cut') {
                if (isSelectAll) {
                    el.innerHTML = '';
                } else {
                    document.execCommand('delete');
                }
                this.formatRichInput(el, true);
                this.triggerSearchFromElement(el);
            }
        }
    },

    handleRichPaste(event, el) {
        if (!el) return;
        event.preventDefault();
        const text = (event.clipboardData || window.clipboardData)?.getData('text/plain') || '';
        if (!text) return;

        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const textNode = document.createTextNode(text);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.setEndAfter(textNode);
            sel.removeAllRanges();
            sel.addRange(range);
        } else {
            const curVal = this.getRichInputValue(el);
            this.setRichInputValue(el, curVal + text);
        }

        this.formatRichInput(el, true);
        this.triggerSearchFromElement(el);
    },

    triggerSearchFromElement(el) {
        if (!el) return;
        if (el.id === 'lm-quick-search') {
            this.handleQuickSearch({ target: el });
        } else if (el.id === 'lm-remaster-search') {
            this.setRemasterSearch(el);
        }
    },

    hasSearchSyntaxError(expression) {
        const rawStr = String(expression || '').trim();
        if (!rawStr) return false;
        const tokens = this.tokenizeSearchExpression(rawStr);
        if (!tokens || !tokens.length) return false;
        const hasOperators = tokens.some(t => t.type !== 'term');
        if (!hasOperators) return false;
        return this.parseSearchExpression(rawStr) === null;
    },

    updateSearchInputErrorState(el, keyword) {
        if (!el) return;
        const isError = this.hasSearchSyntaxError(keyword);
        if (isError) {
            el.classList.add('lm-search-input-error');
            el.title = '布尔表达式语法错误（例如：括号未闭合、缺少逻辑关键词等）';
        } else {
            el.classList.remove('lm-search-input-error');
            el.title = '';
        }
    },

    parseSearchExpression(expression) {
        const tokens = this.tokenizeSearchExpression(expression);
        if (!tokens || !tokens.length) return null;
        let position = 0;

        const parsePrimary = () => {
            const token = tokens[position];
            if (!token) return null;
            if (token.type === 'term') {
                position += 1;
                return { type: 'term', value: token.value };
            }
            if (token.type !== 'leftParen') return null;
            position += 1;
            const node = parseOr();
            if (!node || tokens[position]?.type !== 'rightParen') return null;
            position += 1;
            return node;
        };

        const parseNot = () => {
            if (tokens[position]?.type !== 'not') return parsePrimary();
            position += 1;
            const child = parseNot();
            return child ? { type: 'not', child } : null;
        };

        const parseAnd = () => {
            let node = parseNot();
            if (!node) return null;
            while (tokens[position]?.type === 'and') {
                position += 1;
                const right = parseNot();
                if (!right) return null;
                node = { type: 'and', left: node, right };
            }
            return node;
        };

        const parseOr = () => {
            let node = parseAnd();
            if (!node) return null;
            while (tokens[position]?.type === 'or') {
                position += 1;
                const right = parseAnd();
                if (!right) return null;
                node = { type: 'or', left: node, right };
            }
            return node;
        };

        const root = parseOr();
        return root && position === tokens.length ? root : null;
    },

    createSearchMatcher(expression) {
        const normalizedExpression = String(expression || '').trim().toLowerCase();
        if (!normalizedExpression) return () => true;
        const tree = this.parseSearchExpression(normalizedExpression);
        const fallbackTerm = normalizedExpression;

        const evaluate = (node, values) => {
            if (!node) return values.some(value => value.includes(fallbackTerm));
            switch (node.type) {
                case 'term':
                    return values.some(value => value.includes(node.value));
                case 'not':
                    return !evaluate(node.child, values);
                case 'and':
                    return evaluate(node.left, values) && evaluate(node.right, values);
                case 'or':
                    return evaluate(node.left, values) || evaluate(node.right, values);
                default:
                    return false;
            }
        };

        return rawValues => {
            const values = rawValues.map(value => String(value || '').toLowerCase());
            return evaluate(tree, values);
        };
    },

    getSearchValues(item, includeQuality = false) {
        const values = [item.name, item.singer, item.album, item.filename];
        if (includeQuality) values.push(item.quality);
        return values;
    },

    getItemKey(item) {
        return `${item.folder}\u0000${item.filename}`;
    },

    normalizeDedupText(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[、，,;；]/g, ',')
            .replace(/\s+/g, ' ');
    },

    getDeduplicationKey(item) {
        const name = this.normalizeDedupText(item?.name || item?.songInfo?.name);
        const singer = this.normalizeDedupText(item?.singer || item?.songInfo?.singer);
        if (name && singer && !['未知歌曲', 'unknown'].includes(name) && !['未知歌手', 'unknown'].includes(singer)) {
            return `metadata:${name}:${singer}`;
        }

        const source = this.normalizeDedupText(item?.source || item?.songInfo?.source);
        const songId = String(item?.songmid || item?.id || item?.songInfo?.songmid || item?.songInfo?.id || '').trim();
        const reliableId = songId && source && !['unknown', 'local', 'temp'].includes(source) && !songId.includes(' - ');
        return reliableId ? `id:${source}:${songId}` : `file:${this.getItemKey(item)}`;
    },

    getDedupQualityRank(item) {
        const quality = String(item?.quality || '').toLowerCase();
        if (quality === 'master' || quality === 'hires') return 5;
        if (quality === 'flac24bit') return 4;
        if (quality === 'flac') return 3;
        if (quality === '320k') return 2;
        if (quality === '192k') return 1;
        if (quality === '128k') return 0;
        return -1;
    },

    getDuplicateGroups() {
        const groups = new Map();
        this.originalData.forEach(item => {
            const key = this.getDeduplicationKey(item);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        });

        const compare = (left, right) => {
            const leftSource = this.normalizeDedupText(left?.source || left?.songInfo?.source);
            const rightSource = this.normalizeDedupText(right?.source || right?.songInfo?.source);
            const leftKnown = leftSource && !['unknown', 'local', 'temp'].includes(leftSource) ? 1 : 0;
            const rightKnown = rightSource && !['unknown', 'local', 'temp'].includes(rightSource) ? 1 : 0;
            return rightKnown - leftKnown
                || this.getDedupQualityRank(right) - this.getDedupQualityRank(left)
                || Number(right?.mtime || 0) - Number(left?.mtime || 0)
                || Number(right?.size || 0) - Number(left?.size || 0)
                || String(left?.filename || '').localeCompare(String(right?.filename || ''));
        };

        return Array.from(groups.values())
            .filter(items => items.length > 1)
            .map(items => items.slice().sort(compare));
    },

    async deduplicate() {
        if (this.deduplicateInFlight) return;
        const groups = this.getDuplicateGroups();
        const duplicates = groups.flatMap(items => items.slice(1));
        if (duplicates.length === 0) {
            if (typeof showInfo === 'function') showInfo('没有发现可去重的本地歌曲');
            return;
        }

        const message = `发现 ${groups.length} 组重复歌曲，共 ${duplicates.length} 个重复文件。\n\n每组将保留音质最高、元信息更完整且较新的 1 个文件，删除其余文件。\n\n其中 unknown 文件也会按歌名和歌手参与判断，是否继续？`;
        let confirmed = false;
        if (typeof showSelect === 'function') {
            confirmed = await showSelect('本地歌曲去重', message, { danger: true });
        } else {
            confirmed = confirm(message);
        }
        if (!confirmed) return;

        this.deduplicateInFlight = true;
        try {
            await this._executeDelete(duplicates);
        } finally {
            this.deduplicateInFlight = false;
        }
    },

    getSelectedEntries() {
        return this.originalData.filter(item => this.selectedItems.has(this.getItemKey(item)));
    },

    getSelectedFilenames() {
        return this.getSelectedEntries().map(item => item.filename);
    },

    bindListEvents() {
        if (this.listEventsBound) return;
        const container = document.getElementById('lm-list-container');
        if (!container) return;
        this.listEventsBound = true;
        container.addEventListener('click', (event) => {
            const target = event.target.closest('[data-lm-action]');
            if (!target || !container.contains(target)) return;
            const index = parseInt(target.dataset.lmIndex || '', 10);
            switch (target.dataset.lmAction) {
                case 'delete':
                    this.deleteSingle(index);
                    break;
                case 'login':
                    this.openUserLogin();
                    break;
            }
        });
        container.addEventListener('change', (event) => {
            const target = event.target;
            if (!target.matches('[data-lm-action="select"]')) return;
            this.toggleSelect(parseInt(target.dataset.lmIndex || '', 10), target.checked);
        });
    },

    saveFilters() {
        const filters = {
            filterQuality: Array.from(this.filterQuality),
            filterStatus: Array.from(this.filterStatus),
            filterSource: Array.from(this.filterSource),
            sortBy: this.sortBy,
            sortOrder: this.sortOrder,
        };
        localStorage.setItem(this.cacheKey, JSON.stringify(filters));
    },

    loadFilters() {
        try {
            const cached = localStorage.getItem(this.cacheKey);
            if (cached) {
                const filters = JSON.parse(cached);
                this.quickSearchKeyword = filters.searchKeyword || '';
                const toSet = (v) => {
                    if (!v || v === 'all') return new Set();
                    if (Array.isArray(v)) return new Set(v);
                    return new Set([v]);
                };
                this.filterQuality = toSet(filters.filterQuality);
                this.filterStatus = toSet(filters.filterStatus);
                this.filterSource = toSet(filters.filterSource);
                this.sortBy = filters.sortBy || 'mtime';
                this.sortOrder = filters.sortOrder || 'desc';

                // 将旧版筛选搜索迁移到顶部快速搜索，避免产生不可见筛选条件。
                const quickSearch = document.getElementById('lm-quick-search');
                if (quickSearch) {
                    this.setRichInputValue(quickSearch, this.quickSearchKeyword);
                    this.updateSearchInputErrorState(quickSearch, this.quickSearchKeyword);
                }
                if (document.getElementById('lm-sort-by')) document.getElementById('lm-sort-by').value = this.sortBy;
                if (document.getElementById('lm-sort-order')) document.getElementById('lm-sort-order').value = this.sortOrder;
                // 标签按钮 UI 更新
                this._syncTagUI('lm-quality-tags', this.filterQuality);
                this._syncTagUI('lm-source-tags', this.filterSource);
                this._syncTagUI('lm-status-tags', this.filterStatus);

            }
        } catch (e) {
            console.error('Failed to load cached filters:', e);
        }
    },

    // 同步标签按钮的激活状态
    _syncTagUI(containerId, filterSet) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll('[data-filter-value]').forEach(btn => {
            const val = btn.dataset.filterValue;
            if (filterSet.has(val)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    },

    // 切换某个筛选标签的选中状态
    toggleFilterTag(filterKey, value) {
        const setMap = {
            quality: 'filterQuality',
            source: 'filterSource',
            status: 'filterStatus'
        };
        const tagContainerMap = {
            quality: 'lm-quality-tags',
            source: 'lm-source-tags',
            status: 'lm-status-tags'
        };
        const prop = setMap[filterKey];
        if (!prop) return;
        const set = this[prop];
        if (set.has(value)) {
            set.delete(value);
        } else {
            set.add(value);
        }
        this._syncTagUI(tagContainerMap[filterKey], set);
        this.applyFilters();
    },

    // 同步 select 下拉框的激活状态样式
    _syncSelectActive(id) {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.value !== 'all' && el.value !== 'mtime' && el.value !== 'desc') {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    },

    init() {
        // Initialization can run when the tab is clicked, or immediately.
        this.resetFilters(false);
        this.bindListEvents();
        this.bindBatchActionsMenu();
        this.fetchData();
        this.syncRemasterVisibility();

        // Listen to tab switch to trigger refresh if we are on this tab
        const origSwitchTab = window.switchTab;
        window.switchTab = function (tabId, options) {
            const result = origSwitchTab(tabId, options);
            if (tabId === 'localmusic') {
                window.LocalMusicManager.resetFilters();
                window.LocalMusicManager.fetchData(true); // silent fetch
            } else {
                // Auto exit batch mode when leaving
                if (window.LocalMusicManager.batchMode) {
                    window.LocalMusicManager.toggleBatchMode();
                }
            }
            return result;
        };
    },

    toggleUnindexed() {
        const el = document.getElementById('lm-unindexed-filter');
        this.filterUnindexed = el.checked;
        this.applyFilters();
    },

    debounceSearch() {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
            const el = document.getElementById('lm-quick-search');
            this.quickSearchKeyword = el ? this.getRichInputValue(el).trim().toLowerCase() : '';
            this.applyFilters();
        }, 300);
    },

    async refresh() {
        const btn = document.querySelector('button[title="同步并刷新"] i');
        if (btn) btn.classList.add('fa-spin');

        try {
            // First trigger sync on server
            if (typeof showInfo === 'function') showInfo('正在同步物理文件...');
            const syncRes = await fetch('/api/music/cache/sync', {
                method: 'POST',
                headers: window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}
            });
            const syncResult = await syncRes.json();
            if (!syncResult.success) {
                console.warn('Sync failed:', syncResult.message);
            }
        } catch (e) {
            console.error('Sync request error:', e);
        }

        await this.fetchData();
        if (btn) btn.classList.remove('fa-spin');
    },

    toggleFilterPanel() {
        const panel = document.getElementById('lm-filter-panel');
        const btn = document.getElementById('lm-filter-toggle-btn');
        const label = document.getElementById('lm-filter-toggle-label');
        this.isFilterPanelOpen = !this.isFilterPanelOpen;

        if (this.isFilterPanelOpen) {
            if (panel) panel.classList.remove('hidden');
            if (btn) {
                btn.classList.add('t-bg-main', 'shadow-inner');
                btn.setAttribute('aria-expanded', 'true');
                btn.setAttribute('title', '收起筛选');
            }
            if (label) label.textContent = '收起筛选';
        } else {
            if (panel) panel.classList.add('hidden');
            if (btn) {
                btn.classList.remove('t-bg-main', 'shadow-inner');
                btn.setAttribute('aria-expanded', 'false');
                btn.setAttribute('title', '高级筛选');
            }
            if (label) label.textContent = '高级筛选';
        }
    },

    handleQuickSearch(e) {
        const el = e?.target || document.getElementById('lm-quick-search');
        if (el) this.formatRichInput(el);
        const val = this.getRichInputValue(el);
        this.updateSearchInputErrorState(el, val);
        this.quickSearchKeyword = val.trim().toLowerCase();
        this.applyFilters();
    },

    resetFilters(apply = true) {
        this.quickSearchKeyword = '';
        this.filterQuality = new Set();
        this.filterStatus = new Set();
        this.filterSource = new Set();
        this.sortBy = 'mtime';
        this.sortOrder = 'desc';

        const qs = document.getElementById('lm-quick-search');
        if (qs) {
            this.setRichInputValue(qs, '');
            this.updateSearchInputErrorState(qs, '');
        }
        const sortBy = document.getElementById('lm-sort-by');
        if (sortBy) sortBy.value = 'mtime';
        const sortOrder = document.getElementById('lm-sort-order');
        if (sortOrder) sortOrder.value = 'desc';

        // 清空所有标签按钮激活状态
        this._syncTagUI('lm-quality-tags', this.filterQuality);
        this._syncTagUI('lm-source-tags', this.filterSource);
        this._syncTagUI('lm-status-tags', this.filterStatus);

        localStorage.removeItem(this.cacheKey);
        const activeDot = document.getElementById('lm-filter-active-dot');
        if (activeDot) activeDot.classList.add('hidden');
        if (apply) this.applyFilters();
    },

    clearFilters() {
        this.resetFilters();
    },

    showNoPermissionState() {
        this.originalData = [];
        this.displayData = [];
        this.updatePagination();
        const countEl = document.getElementById('lm-total-count');
        if (countEl) countEl.innerText = '0 首';
        const container = document.getElementById('lm-list-container');
        if (container) {
            container.innerHTML = `
                <div class="text-center py-20 text-gray-500 animate-fade-in">
                    <i class="fas fa-lock text-4xl mb-4 text-amber-500/80"></i>
                    <p class="font-bold tracking-wider text-base t-text-main mb-1">您没有权限查看此目录，请联系管理员设置</p>
                </div>`;
        }
        const pagination = document.getElementById('lm-pagination');
        if (pagination) pagination.classList.add('hidden');
    },

    async fetchData(silent = false) {
        const isLoggedIn = typeof window.isUserLoggedIn === 'function' ? window.isUserLoggedIn() : false;
        const isAdmin = true;
        const enablePublicNonAdminLocalMusic = false;

        if (!isLoggedIn && !isAdmin && !enablePublicNonAdminLocalMusic) {
            this.showNoPermissionState();
            return;
        }

        if (!silent) {
            const container = document.getElementById('lm-list-container');
            if (container) {
                container.innerHTML = `
                    <div class="text-center py-20 text-gray-500 animate-fade-in">
                        <i class="fas fa-circle-notch fa-spin text-4xl mb-4 text-emerald-500"></i>
                        <p class="font-bold tracking-wider">正在加载本地音乐...</p>
                    </div>`;
            }
        }

        try {
            const requestList = () => {
                const headers = window.getUserAuthHeaders ? window.getUserAuthHeaders() : {};
                return fetch('/api/music/cache/list', { headers, cache: 'no-store' });
            };

            let res = await requestList();
            if (res.status === 401 && typeof window.ensureUserAuthToken === 'function') {
                const refreshed = await window.ensureUserAuthToken({ force: true });
                if (refreshed) res = await requestList();
            }

            if (res.status === 401) {
                this.showAuthExpiredState();
                return;
            }

            const result = await res.json();
            if (result.success) {
                this.authExpired = false;
                this.authExpiredNotified = false;
                this.originalData = result.data || [];
                // Sort by mtime initially descending
                this.originalData.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
                this.applyFilters();
                this.pruneRemasterSelection();
                if (document.getElementById('lm-remaster-modal')?.classList.contains('flex')) {
                    this.renderRemasterSelection();
                }

                // Attempt to auto-sync location switch UI if not selected manually
                // (Only works if we know somehow what the backend uses, but we can ignore for now)
            } else {
                throw new Error(result.message || 'Failed to fetch local music');
            }
        } catch (err) {
            if (typeof showError === 'function') showError('拉取本地列表失败');
            console.error('LocalMusic Fetch Error:', err);
        }
    },

    showAuthExpiredState() {
        this.authExpired = true;
        this.originalData = [];
        this.displayData = [];
        this.updatePagination();
        const countEl = document.getElementById('lm-total-count');
        if (countEl) countEl.innerText = '登录已失效';
        this.render();
        if (!this.authExpiredNotified && typeof showError === 'function') {
            showError('同步账户登录已失效，请重新登录');
            this.authExpiredNotified = true;
        }
    },

    openUserLogin() {
        window.location.replace('./login');
    },

    applyFilters() {
        let current = this.originalData;
        this.currentPage = 1;

        // 搜索统一由顶部快速搜索处理，筛选面板不再维护第二个搜索条件。
        const sortBySelect = document.getElementById('lm-sort-by');
        if (sortBySelect) this.sortBy = sortBySelect.value;
        const sortOrderSelect = document.getElementById('lm-sort-order');
        if (sortOrderSelect) this.sortOrder = sortOrderSelect.value;

        // [New] Save to localStorage
        this.saveFilters();

        const quickSearchMatcher = this.createSearchMatcher(this.quickSearchKeyword);

        // 3. Apply Filters（多选 Set，空集合表示不限制）
        current = current.filter(item => {
            // Quality check（多选）
            if (this.filterQuality.size > 0 && !this.filterQuality.has(item.quality)) return false;

            // Source check（多选）
            const displayedSource = item.downloadSource || item.source;
            if (this.filterSource.size > 0 && !this.filterSource.has(displayedSource)) return false;

            // Metadata Status check（多选：任意一个条件命中即显示）
            if (this.filterStatus.size > 0) {
                const isUnindexed = item.source === 'unknown' || (item.songmid && item.songmid.includes(' - '));
                const isNoTag = (n) => !n || n === '未知歌曲' || n === '未知歌手' || n.toLowerCase() === 'unknown';
                const missingID3 = isNoTag(item.name) || isNoTag(item.singer) || isUnindexed;
                const missingCover = !item.hasCover;
                const missingLyric = !item.hasLyric && !item.lyricFilename && !item.hasEmbedLyric;
                const missingEmbedLyric = !item.hasEmbedLyric;

                const statusMap = {
                    'unindexed': isUnindexed,
                    'missing_id3': missingID3,
                    'missing_cover': missingCover,
                    'missing_lyric': missingLyric,
                    'missing_lyric_file': missingLyric,
                    'missing_embed_lyric': missingEmbedLyric,
                };
                // 只要勾选的状态中任一命中即保留（OR 逻辑）
                const matched = Array.from(this.filterStatus).some(s => statusMap[s]);
                if (!matched) return false;
            }

            const searchValues = this.getSearchValues(item);
            if (!quickSearchMatcher(searchValues)) return false;

            return true;
        });

        // 3.1 Apply Sorting
        current.sort((a, b) => {
            let valA, valB;
            switch (this.sortBy) {
                case 'name':
                    valA = (a.name || a.filename || '').toLowerCase();
                    valB = (b.name || b.filename || '').toLowerCase();
                    break;
                case 'singer':
                    valA = (a.singer || '').toLowerCase();
                    valB = (b.singer || '').toLowerCase();
                    break;
                case 'album':
                    valA = (a.album || '').toLowerCase();
                    valB = (b.album || '').toLowerCase();
                    break;
                case 'source':
                    valA = (a.source || '').toLowerCase();
                    valB = (b.source || '').toLowerCase();
                    break;
                case 'size':
                    valA = a.size || 0;
                    valB = b.size || 0;
                    break;
                case 'mtime':
                default:
                    valA = a.mtime || 0;
                    valB = b.mtime || 0;
                    break;
            }

            if (valA < valB) return this.sortOrder === 'asc' ? -1 : 1;
            if (valA > valB) return this.sortOrder === 'asc' ? 1 : -1;
            return 0;
        });

        // 4. Update UI Indicator
        const dot = document.getElementById('lm-filter-active-dot');
        const hasActiveFilters = this.quickSearchKeyword || this.filterQuality.size > 0 || this.filterStatus.size > 0 || this.filterSource.size > 0;
        if (dot) {
            if (hasActiveFilters) dot.classList.remove('hidden');
            else dot.classList.add('hidden');
        }

        // 同步所有 select 的 active 状态（非 all 时背景高亮）
        this._syncSelectActive('lm-sort-by');
        this._syncSelectActive('lm-sort-order');

        const countEl = document.getElementById('lm-total-count');
        if (countEl) countEl.innerText = `共 ${current.length} 首`;

        this.displayData = current;

        // Clean up selected items that are no longer in display
        const displayIdentifiers = new Set(this.displayData.map(item => this.getItemKey(item)));
        for (const sel of this.selectedItems) {
            if (!displayIdentifiers.has(sel)) {
                this.selectedItems.delete(sel);
            }
        }
        this.updateBatchUI();

        this.render();
    },

    getTotalPages() {
        return Math.max(1, Math.ceil((this.displayData.length || 0) / this.pageSize));
    },

    getPageSlice() {
        const totalPages = this.getTotalPages();
        if (this.currentPage > totalPages) this.currentPage = totalPages;
        if (this.currentPage < 1) this.currentPage = 1;
        const start = (this.currentPage - 1) * this.pageSize;
        const end = Math.min(start + this.pageSize, this.displayData.length);
        return {
            start,
            end,
            list: this.displayData.slice(start, end),
            totalPages
        };
    },

    changePage(delta) {
        const totalPages = this.getTotalPages();
        const nextPage = Math.min(totalPages, Math.max(1, this.currentPage + delta));
        if (nextPage === this.currentPage) return;
        this.currentPage = nextPage;
        this.render();
        const container = document.getElementById('lm-list-container');
        if (container) container.scrollTop = 0;
    },

    updatePagination() {
        const pagination = document.getElementById('lm-pagination');
        const info = document.getElementById('lm-page-info');
        const prev = document.getElementById('lm-page-prev');
        const next = document.getElementById('lm-page-next');
        if (!pagination) return;

        const total = this.displayData.length;
        const totalPages = this.getTotalPages();
        if (this.currentPage > totalPages) this.currentPage = totalPages;
        if (this.currentPage < 1) this.currentPage = 1;
        if (total <= this.pageSize) {
            pagination.classList.add('hidden');
        } else {
            pagination.classList.remove('hidden');
        }

        if (info) info.textContent = `第 ${this.currentPage} / ${totalPages} 页 (${total} 首)`;
        if (prev) prev.disabled = this.currentPage <= 1;
        if (next) next.disabled = this.currentPage >= totalPages;
    },

    render() {
        const container = document.getElementById('lm-list-container');
        if (!container) return;
        this.bindListEvents();

        if (this.authExpired) {
            this.updatePagination();
            if (typeof window.unobserveLazyImages === 'function') {
                window.unobserveLazyImages(container);
            }
            container.innerHTML = `
                <div class='text-center py-20 text-gray-500'>
                    <i class='fas fa-user-lock text-4xl mb-4 opacity-50'></i>
                    <p class='font-bold t-text-main mb-2'>同步账户登录已失效</p>
                    <p class='text-xs mb-5'>请重新登录后加载本地音乐</p>
                    <button data-lm-action='login' class='h-9 px-4 rounded-md bg-emerald-500 text-white hover:bg-emerald-600 transition-colors'>
                        <i class='fas fa-sign-in-alt mr-1.5'></i>重新登录
                    </button>
                </div>`;
            return;
        }

        if (this.displayData.length === 0) {
            this.updatePagination();
            if (typeof window.unobserveLazyImages === 'function') {
                window.unobserveLazyImages(container);
            }
            container.innerHTML = `
                <div class="text-center py-20 text-gray-500">
                    <i class="fas fa-inbox text-4xl mb-4 opacity-50"></i>
                    <p>没有找到相关本地音乐</p>
                </div>`;
            return;
        }

        const username = 'shared';
        const page = this.getPageSlice();
        this.updatePagination();

        let html = '';
        page.list.forEach((item, pageIndex) => {
            const index = page.start + pageIndex;
            const safeName = this.escapeHtml(item.name || '未知歌曲');
            const safeSinger = this.escapeHtml(item.singer || '未知歌手');
            const safeAlbum = this.escapeHtml(item.album || '--');
            const displayedSource = item.downloadSource || item.source;
            const safeSource = this.escapeHtml(displayedSource === 'unknown' ? '未知' : (displayedSource || ''));
            const sourceTitle = item.downloadSource && item.downloadSource !== item.source
                ? `下载来源：${item.downloadSource}；歌曲平台：${item.source || '未知'}`
                : `歌曲平台：${item.source || '未知'}`;
            const safeSourceTitle = this.escapeAttr(sourceTitle);
            const isUnindexed = item.source === 'unknown' || (item.songmid && item.songmid.includes(' - '));
            const isNoTag = (n) => !n || n === '未知歌曲' || n === '未知歌手' || n.toLowerCase() === 'unknown';
            const missingID3 = isNoTag(item.name) || isNoTag(item.singer) || isUnindexed;
            const missingCover = !item.hasCover;
            const missingLyric = !item.hasLyric && !item.lyricFilename && !item.hasEmbedLyric;
            const metadataUnsupported = item.metadataWritable === false;
            const coverStatusTitle = item.coverType === 'embedded'
                ? '封面已嵌入音频标签'
                : item.coverType === 'cached'
                    ? '封面使用服务端持久缓存'
                    : item.coverType === 'remote'
                        ? '封面将在显示时从音源获取并缓存'
                        : '已有封面';
            const lyricStatusBadge = item.hasEmbedLyric
                ? '<span class="text-[10px] text-emerald-500 border border-gray-400/40 dark:border-gray-600/50 rounded px-1 scale-90 hidden sm:inline-block" title="已嵌入歌词标签">词</span>'
                : metadataUnsupported && item.hasLyric
                    ? `<span class="text-[10px] text-amber-500 border border-amber-400/40 rounded px-1 scale-90 hidden sm:inline-block" title="${this.escapeAttr(item.embedLyricError || item.metadataError || '音频容器不支持嵌入歌词，已保留外置歌词')}">外置词</span>`
                    : '';

            const isSelected = this.selectedItems.has(this.getItemKey(item));
            const qualityClass = window.QualityManager && window.QualityManager.getQualityColor ? window.QualityManager.getQualityColor(item.quality) : 'bg-gray-100 text-gray-600';
            const qualityName = window.QualityManager ? window.QualityManager.getQualityDisplayName(item.quality) : item.quality;

            let coverHtml = `<div class="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-gray-100/50 flex-shrink-0 flex items-center justify-center border t-border-main mr-2.5 md:mr-4 ml-0.5 md:ml-3">
                                <i class="fas fa-music t-text-muted text-xs"></i>
                             </div>`;
            if (item.hasCover) {
                const authToken = '';
                const coverVersion = [
                    item.coverCheckedVersion || 0,
                    Math.round(item.coverCheckedMtime || item.mtime || 0),
                    item.coverCheckedSize || item.size || 0,
                    1
                ].join('-');
                const coverUrl = `/api/music/cache/cover?filename=${encodeURIComponent(item.filename)}&user=${encodeURIComponent(username)}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}&v=${encodeURIComponent(coverVersion)}`;
                coverHtml = `<img data-src="${this.escapeAttr(coverUrl)}" data-lm-cover-index="${index}" src="./assets/logo.svg" loading="lazy" fetchpriority="low" class="lazy-image lm-cover-image is-placeholder w-10 h-10 md:w-12 md:h-12 rounded-lg object-cover shadow-sm flex-shrink-0 border t-border-main mr-2.5 md:mr-4 ml-0.5 md:ml-3">`;
            }

            const formatSize = (bytes) => {
                if (!bytes) return '--';
                return (bytes / 1024 / 1024).toFixed(1) + 'M';
            };

            const formatTime = (ts) => {
                if (!ts) return '';
                const d = new Date(ts);
                return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
            };

            const folderIcon = '<i class="fas fa-download text-blue-500 mr-1" title="下载目录"></i>';

            html += `
            <div class="grid grid-cols-12 gap-2 md:gap-4 p-3 md:p-2 items-center rounded-xl hover:t-bg-item-hover transition-all t-border-main border-b last:border-b-0 group relative ${isSelected ? 't-bg-item-hover ring-1 ring-emerald-500/30' : ''}" data-lm-row-index="${index}">
                <!-- # / Batch -->
                <div class="col-span-1 text-center text-xs font-mono t-text-muted flex-shrink-0 flex items-center justify-center">
                    <div class="${this.batchMode ? 'hidden' : 'block'}">${index + 1}</div>
                    <div class="${this.batchMode ? 'block' : 'hidden'}">
                        <label class="flex items-center justify-center w-full h-full cursor-pointer">
                            <input type="checkbox" data-lm-action="select" data-lm-index="${index}" ${isSelected ? 'checked' : ''}
                                class="w-4 h-4 rounded border-gray-300 text-emerald-500 focus:ring-emerald-500 mx-auto cursor-pointer transition-all">
                        </label>
                    </div>
                </div>

                <!-- Song & Cover -->
                <div class="col-span-8 sm:col-span-5 md:col-span-4 lg:col-span-4 flex items-center min-w-0 pr-2">
                    ${coverHtml}
                    <div class="min-w-0 flex-1 truncate">
                        <div class="font-bold text-sm md:text-base t-text-main truncate group-hover:text-emerald-500 transition-colors">
                            ${safeName}
                        </div>
                        <div class="text-[10px] md:text-xs t-text-muted mt-0.5 truncate flex items-center gap-1.5 flex-wrap">
                            <span class="sm:hidden font-medium text-emerald-600/70 mr-0.5">${safeSinger}</span>
                            <span class="px-1.5 py-[1px] rounded-md border t-border-main ${qualityClass} scale-90 origin-left inline-block">${this.escapeHtml(qualityName || '标准')}</span>
                            ${item.bitrate ? `<span class="text-[10px] opacity-60 font-mono hidden sm:inline-block">${Math.round(item.bitrate)}kbps</span>` : ''}
                            ${item.sampleRate ? `<span class="text-[10px] opacity-60 font-mono hidden sm:inline-block">${(item.sampleRate / 1000).toFixed(1)}kHz</span>` : ''}
                            ${item.bitDepth && item.bitDepth > 16 ? `<span class="text-[10px] opacity-60 font-mono hidden sm:inline-block">${item.bitDepth}bit</span>` : ''}
                            ${lyricStatusBadge}
                            ${item.hasCover ? `<span class="text-[10px] text-emerald-500 border border-gray-400/40 dark:border-gray-600/50 rounded px-1 scale-90 hidden sm:inline-block" title="${this.escapeAttr(coverStatusTitle)}">封</span>` : ''}
                        </div>
                        <!-- Mobile extra info (second row) -->
                        <div class="sm:hidden text-[9px] mt-1.5 flex items-center gap-1.5 flex-wrap">
                            <div class="flex items-center gap-1 px-1.5 py-0.5 bg-gray-100/80 dark:bg-gray-800/80 rounded-full t-text-muted">
                                ${folderIcon}
                                <span class="font-bold uppercase tracking-tighter" title="${safeSourceTitle}">${safeSource}</span>
                            </div>
                            
                            <div class="flex items-center gap-1">
                                ${missingID3 ? '<span class="px-1 py-0 bg-red-50 text-red-500 border border-red-100 dark:bg-red-900/20 dark:text-red-400 dark:border-red-900/30 rounded-sm font-medium">缺标签</span>' : ''}
                                ${missingCover ? '<span class="px-1 py-0 bg-orange-50 text-orange-500 border border-orange-100 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-900/30 rounded-sm font-medium">缺封面</span>' : ''}
                                ${missingLyric ? '<span class="px-1 py-0 bg-yellow-50 text-yellow-600 border border-yellow-100 dark:bg-yellow-900/20 dark:text-yellow-400 dark:border-yellow-900/30 rounded-sm font-medium">缺词</span>' : ''}
                                ${(!missingID3 && !missingCover && !missingLyric) ? '<span class="px-1 py-0 bg-emerald-50 text-emerald-600 border border-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-900/30 rounded-sm font-medium">完整</span>' : ''}
                            </div>

                            <div class="ml-auto flex items-center gap-1">
                                ${item.hasEmbedLyric ? '<span class="w-4 h-4 flex items-center justify-center bg-emerald-500 text-white rounded text-[8px] font-bold shadow-sm shadow-emerald-500/20" title="已嵌入歌词标签">词</span>' : (metadataUnsupported && item.hasLyric ? `<span class="h-4 px-1 flex items-center justify-center bg-amber-500 text-white rounded text-[8px] font-bold" title="${this.escapeAttr(item.embedLyricError || item.metadataError || '音频容器不支持嵌入歌词，已保留外置歌词')}">外置词</span>` : '')}
                                ${item.hasCover ? `<span class="w-4 h-4 flex items-center justify-center bg-blue-500 text-white rounded text-[8px] font-bold shadow-sm shadow-blue-500/20" title="${this.escapeAttr(coverStatusTitle)}">封</span>` : ''}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Singer -->
                <div class="hidden sm:block sm:col-span-4 md:col-span-3 lg:col-span-2 text-xs t-text-main truncate pr-2">
                    ${safeSinger}
                </div>

                <!-- Album -->
                <div class="hidden lg:block lg:col-span-2 text-xs t-text-muted truncate pr-2">
                    ${safeAlbum}
                </div>

                <!-- Source/Info with Metadata Status -->
                <div class="hidden md:flex flex-col md:col-span-2 lg:col-span-1 text-xs t-text-muted pr-2">
                    <div class="flex items-center gap-1 mb-1">
                        ${folderIcon}
                        <span class="truncate font-medium" title="${safeSourceTitle}">${safeSource}</span>
                    </div>
                    <div class="flex flex-wrap gap-1">
                        ${missingID3 ? '<span class="px-1 py-0 bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 rounded text-[9px] font-bold">缺标签</span>' : ''}
                        ${missingCover ? '<span class="px-1 py-0 bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400 rounded text-[9px] font-bold">缺封面</span>' : ''}
                        ${missingLyric ? '<span class="px-1 py-0 bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400 rounded text-[9px] font-bold">缺词</span>' : ''}
                        ${metadataUnsupported && !missingLyric ? `<span class="px-1 py-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 rounded text-[9px] font-bold" title="${this.escapeAttr(item.embedLyricError || item.metadataError || '音频容器不支持写入标签')}">仅外置词</span>` : ''}
                        ${(!missingID3 && !missingCover && !missingLyric) ? '<span class="px-1 py-0 bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400 rounded text-[9px] font-bold">完整</span>' : ''}
                    </div>
                    <div class="text-[9px] mt-1 opacity-70 scale-90 origin-left">${formatTime(item.mtime)}</div>
                </div>

                <!-- Action Button -->
                <div class="col-span-3 sm:col-span-2 md:col-span-2 lg:col-span-2 flex items-center justify-end gap-1 md:gap-2">
                    <div class="hidden lg:block text-xs text-right pr-2 font-mono t-text-muted shrink-0 mr-1">
                        ${formatSize(item.size)}
                    </div>
                    <!-- Deletion from single operations -->
                    <button data-lm-action="delete" data-lm-index="${index}"
                            class="w-8 h-8 md:w-7 md:h-7 flex items-center justify-center rounded-full t-bg-main border t-border-main t-text-muted hover:text-red-500 hover:border-red-300 transition-all shadow-sm shrink-0" title="删除">
                        <i class="far fa-trash-alt text-[10px]"></i>
                    </button>
                </div>
            </div>
            `;
        });

        if (typeof window.unobserveLazyImages === 'function') {
            window.unobserveLazyImages(container);
        }
        container.innerHTML = html;
        container.querySelectorAll('.lm-cover-image').forEach(img => {
            img.addEventListener('error', () => {
                const index = parseInt(img.dataset.lmCoverIndex || '', 10);
                this.handleCoverLoadError(index, img);
            }, { once: true });
        });
        if (typeof window.lazyLoadImages === 'function') {
            window.lazyLoadImages(container);
        }
    },

    handleCoverLoadError(index, img) {
        const item = this.displayData[index];
        if (!item) return;
        if (item.img && typeof item.img === 'string' && /^https?:\/\//i.test(item.img) && !img.dataset.lmFallbackTried) {
            img.dataset.lmFallbackTried = 'true';
            img.src = item.img;
            return;
        }
        item.hasCover = false;
        item.coverType = 'none';

        const placeholder = document.createElement('div');
        placeholder.className = 'w-10 h-10 md:w-12 md:h-12 rounded-lg bg-gray-100/50 flex-shrink-0 flex items-center justify-center border t-border-main mr-2.5 md:mr-4 ml-0.5 md:ml-3';
        placeholder.innerHTML = '<i class="fas fa-music t-text-muted text-xs"></i>';
        if (img && img.isConnected) img.replaceWith(placeholder);

        clearTimeout(this.coverRenderTimer);
        this.coverRenderTimer = setTimeout(() => {
            this.coverRenderTimer = null;
            this.render();
        }, 80);
    },

    toggleSelect(index, checked) {
        const item = this.displayData[index];
        if (!item) return;
        const key = this.getItemKey(item);
        if (checked) {
            this.selectedItems.add(key);
        } else {
            this.selectedItems.delete(key);
        }

        // Update DOM visually immediately if possible
        const row = document.querySelector(`[data-lm-row-index="${index}"]`);
        if (row) {
            if (checked) {
                row.classList.add('t-bg-item-hover', 'ring-1', 'ring-emerald-500/30');
            } else {
                row.classList.remove('t-bg-item-hover', 'ring-1', 'ring-emerald-500/30');
            }
        }

        this.updateBatchUI();
    },

    bindBatchActionsMenu() {
        if (this.batchActionsEventsBound) return;
        document.addEventListener('click', event => {
            const wrapper = document.getElementById('lm-batch-actions');
            if (wrapper && !wrapper.contains(event.target)) this.closeBatchActionsMenu();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.closeBatchActionsMenu();
        });
        this.batchActionsEventsBound = true;
    },

    toggleBatchActionsMenu(button) {
        const menu = document.getElementById('lm-batch-actions-menu');
        if (!menu || button?.disabled) return;
        const willOpen = menu.classList.contains('hidden');
        menu.classList.toggle('hidden', !willOpen);
        if (button) button.setAttribute('aria-expanded', String(willOpen));
    },

    closeBatchActionsMenu() {
        const menu = document.getElementById('lm-batch-actions-menu');
        const button = document.querySelector('#lm-batch-actions [aria-haspopup]');
        if (menu) menu.classList.add('hidden');
        if (button) button.setAttribute('aria-expanded', 'false');
    },

    toggleBatchMode() {
        this.batchMode = !this.batchMode;
        this.closeBatchActionsMenu();
        if (!this.batchMode) {
            this.selectedItems.clear();
        }

        const tb = document.getElementById('lm-batch-toolbar');
        const selectButton = document.getElementById('lm-batch-select-btn');
        if (tb) {
            if (this.batchMode) {
                tb.classList.remove('hidden');
                tb.classList.add('flex');

            } else {
                tb.classList.add('hidden');
                tb.classList.remove('flex');
            }
        }
        if (selectButton) {
            const icon = document.getElementById('lm-batch-select-icon');
            const label = document.getElementById('lm-batch-select-label');
            const activeClasses = [
                'bg-emerald-500', 'border-emerald-500', 'text-white',
                'hover:bg-emerald-600', 'hover:border-emerald-600'
            ];
            const idleClasses = [
                'bg-emerald-500/10', 'border-emerald-500/40', 'text-emerald-600', 'dark:text-emerald-400',
                'hover:bg-emerald-500/20', 'hover:border-emerald-500'
            ];
            selectButton.classList.remove(...(this.batchMode ? idleClasses : activeClasses));
            selectButton.classList.add(...(this.batchMode ? activeClasses : idleClasses));
            selectButton.title = this.batchMode ? '完成批量选择' : '选择本地音乐进行批量操作';
            selectButton.setAttribute('aria-label', this.batchMode ? '完成批量选择' : '批量选择');
            if (icon) icon.className = this.batchMode ? 'fas fa-check' : 'fas fa-tasks';
            if (label) label.textContent = this.batchMode ? '完成' : '批量选择';
        }

        this.updateBatchUI();
        this.render(); // Re-render to show/hide checkboxes globally
    },

    selectAll() {
        const allVisibleSelected = this.displayData.length > 0 && this.displayData.every(item => this.selectedItems.has(this.getItemKey(item)));
        if (allVisibleSelected) {
            this.displayData.forEach(item => this.selectedItems.delete(this.getItemKey(item)));
        } else {
            this.displayData.forEach(item => this.selectedItems.add(this.getItemKey(item)));
        }
        this.updateBatchUI();
        this.render();
    },

    deselectAll() {
        this.selectedItems.clear();
        this.updateBatchUI();
        this.render();
    },

    updateBatchUI() {
        const selectedCount = this.selectedItems.size;
        const totalCount = this.originalData.length;
        const visibleCount = this.displayData.length;
        const allVisibleSelected = visibleCount > 0 && this.displayData.every(item => this.selectedItems.has(this.getItemKey(item)));
        const count = document.getElementById('lm-batch-selected-count');
        const total = document.getElementById('lm-batch-total-count');
        const selectAllButton = document.getElementById('lm-batch-select-all-btn');
        const clearButton = document.getElementById('lm-batch-clear-btn');
        const deleteButton = document.getElementById('lm-batch-delete-btn');
        const actionsButton = document.getElementById('lm-batch-actions-trigger');

        if (count) count.textContent = String(selectedCount);
        if (total) total.textContent = String(totalCount);
        if (selectAllButton) {
            selectAllButton.textContent = allVisibleSelected ? '取消全选' : '全选';
            selectAllButton.disabled = visibleCount === 0;
            selectAllButton.setAttribute('aria-label', allVisibleSelected ? '取消全选' : '全选');
        }
        [clearButton, deleteButton, actionsButton].forEach(button => {
            if (!button) return;
            button.disabled = selectedCount === 0;
        });
        if (selectedCount === 0) this.closeBatchActionsMenu();
    },

    getPlaylistPlatformIdentity(item) {
        const songInfo = item?.songInfo || {};
        const meta = songInfo.meta || item?.meta || {};
        const source = String(songInfo.source || item?.source || meta.source || '').trim().toLowerCase();
        if (!source || source === 'unknown' || source === 'local' || source === 'temp') return null;

        const prefix = `${source}_`;
        const candidates = [
            songInfo.songmid,
            songInfo.id,
            item?.songmid,
            item?.id,
            meta.songId
        ];

        for (const candidate of candidates) {
            const value = String(candidate || '').trim();
            if (!value) continue;

            const platformId = value.startsWith(prefix)
                ? value.slice(prefix.length)
                : candidate === meta.songId
                    ? value
                    : '';
            if (!platformId || /\s/.test(platformId) || /^(unknown|local|temp|undefined|null)$/i.test(platformId)) continue;

            return {
                source,
                platformId,
                id: `${source}_${platformId}`
            };
        }

        return null;
    },

    isPlaylistCollectable(item) {
        return !!this.getPlaylistPlatformIdentity(item);
    },

    buildPlaylistSong(item) {
        const songInfo = item?.songInfo || {};
        const identity = this.getPlaylistPlatformIdentity(item);
        if (!identity) return null;
        const quality = item?.quality || songInfo.quality || songInfo.type || '128k';
        let types = songInfo.types;

        if (Array.isArray(types)) {
            types = types.map(type => typeof type === 'object' ? { ...type } : type);
            if (!types.some(type => (type?.type || type) === quality)) {
                types.push({ type: quality, size: item?.size || 0 });
            }
        } else {
            types = { ...(types || {}) };
            if (!types[quality]) types[quality] = { size: item?.size || 0 };
        }

        return {
            ...songInfo,
            id: identity.id,
            songmid: identity.platformId,
            songId: identity.platformId,
            name: item.name || songInfo.name,
            singer: item.singer || songInfo.singer,
            source: identity.source,
            albumName: item.album || songInfo.albumName || '',
            albumId: item.albumId || songInfo.albumId,
            img: item.img || songInfo.img,
            interval: item.interval || songInfo.interval,
            quality,
            type: quality,
            types,
            _localLibraryItem: true
        };
    },

    async deleteSingle(index) {
        const item = this.displayData[index];
        if (!item) {
            if (typeof showError === 'function') showError('文件信息已失效，请刷新后重试');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('删除本地文件', '确定要删除此文件吗?', { danger: true }))) return;
        } else {
            if (!confirm('确定要删除此文件吗?')) return;
        }

        this._executeDelete([item]);
    },

    async batchDelete() {
        if (this.selectedItems.size === 0) {
            if (typeof showError === 'function') showError('请先选择要删除的文件');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('删除本地文件', `确定要批量删除这 ${this.selectedItems.size} 个文件吗?`, { danger: true }))) return;
        } else {
            if (!confirm(`确定要删除 ${this.selectedItems.size} 个文件吗?`)) return;
        }

        this._executeDelete(this.getSelectedEntries());
    },

    async _executeDelete(items) {
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
            };
            const res = await fetch('/api/music/cache/remove', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    items: items.map(item => ({ filename: item.filename, folder: item.folder }))
                })
            });
            const result = await res.json();
            if (result.deletedCount > 0) {
                // Clear selection
                for (const item of items) this.selectedItems.delete(this.getItemKey(item));
                this.updateBatchUI();
                await this.refresh();
            }
            if (!res.ok || !result.success) throw new Error(result.message || 'Server returned error');
            if (typeof showInfo === 'function') showInfo(`成功删除了 ${result.deletedCount} 个文件`);
        } catch (e) {
            if (typeof showError === 'function') showError('删除失败: ' + e.message);
            console.error('Delete error:', e);
        }
    },

    async batchFetchLyrics() {
        // Find items that don't have lyrics
        const targets = this.getSelectedEntries().filter(item => !item.hasLyric && !item.lyricFilename && !item.hasEmbedLyric);

        if (targets.length === 0) {
            if (typeof showInfo === 'function') showInfo('选中的歌曲中没有需要下载歌词的项');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('下载歌词', `选中的文件中有 ${targets.length} 首没有对应的歌词，确定要下载歌词吗?`))) return;
        }

        let success = 0;
        let fail = 0;

        for (const item of targets) {
            if (!item.songInfo || !item.songInfo.source || item.songInfo.source === 'unknown') {
                fail++;
                continue;
            }
            try {
                // If single_song_ops exposes requestServerLyricCache
                if (typeof window.requestServerLyricCache === 'function') {
                    const synced = await window.requestServerLyricCache(item.songInfo, item.quality, true);
                    if (!synced) {
                        fail++;
                        continue;
                    }
                    success++;
                    if (typeof showInfo === 'function') showInfo(`[${success}/${targets.length}] 成功下载歌词: ${item.name}`);
                } else {
                    fail++;
                }
            } catch (e) {
                fail++;
            }
        }

        if (typeof showInfo === 'function') {
            showInfo(`下载歌词完成。成功 ${success} 项，失败/不支持 ${fail} 项`);
        }
        this.refresh();
    },

    async batchEmbedLyric() {
        const targetFilenames = this.getSelectedFilenames();
        if (targetFilenames.length === 0) {
            if (typeof showError === 'function') showError('请先选择要嵌入歌词的文件');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('嵌入歌词到文件',
                `将对选中的 ${targetFilenames.length} 首歌曲嵌入歌词到 USLT 标签。\n` +
                `• 已有歌词标签的歌曲将跳过\n` +
                `• 有 .lrc 文件的直接读取嵌入\n` +
                `• 没有 .lrc 文件的将尝试从网络获取\n\n确定继续吗?`
            ))) return;
        }

        try {
            if (typeof showInfo === 'function') showInfo('正在嵌入歌词，请稍候...');
            const res = await fetch('/api/music/cache/embedLyric', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                },
                body: JSON.stringify({ filenames: targetFilenames })
            });

            const result = await res.json();
            if (result.success) {
                const { successCount = 0, skippedCount = 0, failCount = 0 } = result;
                if (typeof showInfo === 'function') {
                    showInfo(`嵌入完成：成功 ${successCount} 首，跳过（已有） ${skippedCount} 首，失败 ${failCount} 首`);
                }
                // 打印详情供排查
                if (result.details && result.details.length > 0) {
                    const failed = result.details.filter(d => d.status === 'fail');
                    if (failed.length > 0) {
                        console.warn('[EmbedLyric] 失败详情:', failed);
                        const firstFailure = failed[0];
                        if (typeof showError === 'function') {
                            showError(`有 ${failed.length} 首无法嵌入：${firstFailure.filename} - ${firstFailure.reason || '未知原因'}`);
                        }
                    }
                }
                await this.refresh();
            } else {
                throw new Error(result.message || '服务器返回错误');
            }
        } catch (e) {
            if (typeof showError === 'function') showError('嵌入歌词失败: ' + e.message);
            console.error('[EmbedLyric] Error:', e);
        }
    },

    async batchUpdateMetadata() {
        const targets = this.getSelectedEntries();
        const targetFilenames = targets.map(item => item.filename);

        if (targets.length === 0) {
            if (typeof showInfo === 'function') showInfo('请先选择需要补全元信息的文件');
            return;
        }

        if (typeof showSelect === 'function') {
            if (!(await showSelect('补全元信息', `确定要向服务器请求补全这 ${targets.length} 个文件的元信息(包含封面与ID3标签)吗?`))) return;
        } else {
            if (!confirm(`确定要补全这 ${targets.length} 个文件的元信息吗?`)) return;
        }

        try {
            if (typeof showInfo === 'function') showInfo('正在处理，请稍候...');
            const res = await fetch('/api/music/cache/updateMetadata', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {})
                },
                body: JSON.stringify({ filenames: targetFilenames })
            });

            const result = await res.json();
            if (result.success) {
                if (typeof showInfo === 'function') showInfo(`元信息补全完成。成功 ${result.successCount} 项，失败 ${result.failCount} 项`);
                this.refresh();
            } else {
                throw new Error(result.message || 'Server returned error');
            }
        } catch (e) {
            if (typeof showError === 'function') showError('补全元信息失败: ' + e.message);
        }
    },



    syncRemasterVisibility() {
        const enabled = !!window.settings?.enableRemaster;
        ['lm-remaster-btn', 'lm-remaster-btn-mobile'].forEach(id => {
            const button = document.getElementById(id);
            if (!button) return;
            button.classList.toggle('hidden', !enabled);
            button.classList.toggle('flex', enabled);
        });
        if (!enabled) this.closeRemasterModal();
    },

    bindRemasterSelectionEvents() {
        if (!this.remasterSelectionEventsBound) {
            const container = document.getElementById('lm-remaster-song-list');
            if (container) {
                this.remasterSelectionEventsBound = true;
                container.addEventListener('change', (event) => {
                    const checkbox = event.target.closest('[data-remaster-filename]');
                    if (!checkbox || this.remasterTaskRunning) return;
                    this.toggleRemasterSelection(checkbox.dataset.remasterFilename || '', checkbox.checked);
                });
            }
        }
        if (!this.remasterQualityEventsBound) {
            const qualitySelect = document.getElementById('lm-remaster-quality');
            if (qualitySelect) {
                this.remasterQualityEventsBound = true;
                qualitySelect.addEventListener('change', () => this.saveRemasterTargetQuality(qualitySelect.value));
            }
        }
    },

    getRemasterQualityStorageKey() {
        return 'lx_remaster_target_quality:shared';
    },

    saveRemasterTargetQuality(quality) {
        const qualitySelect = document.getElementById('lm-remaster-quality');
        if (!qualitySelect) return;
        const supported = Array.from(qualitySelect.options).some(option => option.value === quality);
        if (supported) localStorage.setItem(this.getRemasterQualityStorageKey(), quality);
    },

    restoreRemasterTargetQuality() {
        const qualitySelect = document.getElementById('lm-remaster-quality');
        if (!qualitySelect) return;
        const stored = localStorage.getItem(this.getRemasterQualityStorageKey()) || '';
        const supported = Array.from(qualitySelect.options).some(option => option.value === stored);
        qualitySelect.value = supported ? stored : 'flac24bit';
    },

    getRemasterSelectableItems() {
        return this.originalData.filter(item => item.folder === 'music');
    },

    getRemasterFilteredItems() {
        const keyword = this.remasterSearchKeyword;
        const items = this.getRemasterSelectableItems();
        if (!keyword) return items;
        const searchMatcher = this.createSearchMatcher(keyword);
        return items.filter(item => searchMatcher(this.getSearchValues(item, true)));
    },

    pruneRemasterSelection() {
        const available = new Set(this.getRemasterSelectableItems().map(item => item.filename));
        for (const filename of this.remasterSelectedItems) {
            if (!available.has(filename)) this.remasterSelectedItems.delete(filename);
        }
    },

    setRemasterSearch(valueOrEl) {
        const el = typeof valueOrEl === 'string' ? null : (valueOrEl || document.getElementById('lm-remaster-search'));
        if (el) {
            this.formatRichInput(el);
            const val = this.getRichInputValue(el);
            this.updateSearchInputErrorState(el, val);
            this.remasterSearchKeyword = val.trim().toLowerCase();
        } else {
            this.remasterSearchKeyword = String(valueOrEl || '').trim().toLowerCase();
        }
        this.remasterSelectionPage = 1;
        this.renderRemasterSelection();
    },

    toggleRemasterSelection(filename, checked) {
        if (!filename || this.remasterTaskRunning) return;
        if (checked) this.remasterSelectedItems.add(filename);
        else this.remasterSelectedItems.delete(filename);
        this.updateRemasterSelectionControls();
    },

    selectAllRemasterResults() {
        if (this.remasterTaskRunning) return;
        this.getRemasterFilteredItems().forEach(item => this.remasterSelectedItems.add(item.filename));
        this.renderRemasterSelection();
    },

    clearRemasterSelection() {
        if (this.remasterTaskRunning) return;
        this.remasterSelectedItems.clear();
        this.renderRemasterSelection();
    },

    changeRemasterSelectionPage(delta) {
        const filtered = this.getRemasterFilteredItems();
        const totalPages = Math.max(1, Math.ceil(filtered.length / this.remasterSelectionPageSize));
        this.remasterSelectionPage = Math.min(totalPages, Math.max(1, this.remasterSelectionPage + delta));
        this.renderRemasterSelection();
    },

    updateRemasterSelectionControls() {
        const allItems = this.getRemasterSelectableItems();
        const filtered = this.getRemasterFilteredItems();
        const totalPages = Math.max(1, Math.ceil(filtered.length / this.remasterSelectionPageSize));
        const disabled = this.remasterTaskRunning;
        const selectedCount = document.getElementById('lm-remaster-selected-count');
        const availableCount = document.getElementById('lm-remaster-available-count');
        const pageInfo = document.getElementById('lm-remaster-selection-page-info');
        const prevButton = document.getElementById('lm-remaster-selection-prev');
        const nextButton = document.getElementById('lm-remaster-selection-next');
        const searchInput = document.getElementById('lm-remaster-search');
        const selectAllButton = document.getElementById('lm-remaster-select-all');
        const clearButton = document.getElementById('lm-remaster-clear-selection');
        const startButton = document.getElementById('lm-remaster-start');
        if (selectedCount) selectedCount.textContent = String(this.remasterSelectedItems.size);
        if (availableCount) availableCount.textContent = String(allItems.length);
        if (pageInfo) pageInfo.textContent = `${this.remasterSelectionPage} / ${totalPages}`;
        if (prevButton) prevButton.disabled = disabled || this.remasterSelectionPage <= 1;
        if (nextButton) nextButton.disabled = disabled || this.remasterSelectionPage >= totalPages;
        if (searchInput) searchInput.setAttribute('contenteditable', disabled ? 'false' : 'true');
        if (selectAllButton) selectAllButton.disabled = disabled || filtered.length === 0;
        if (clearButton) clearButton.disabled = disabled || this.remasterSelectedItems.size === 0;
        if (startButton) startButton.disabled = disabled || this.remasterSelectedItems.size === 0;
    },

    renderRemasterSelection() {
        const container = document.getElementById('lm-remaster-song-list');
        if (!container) return;
        this.pruneRemasterSelection();
        const filtered = this.getRemasterFilteredItems();
        const totalPages = Math.max(1, Math.ceil(filtered.length / this.remasterSelectionPageSize));
        this.remasterSelectionPage = Math.min(totalPages, Math.max(1, this.remasterSelectionPage));
        const start = (this.remasterSelectionPage - 1) * this.remasterSelectionPageSize;
        const pageItems = filtered.slice(start, start + this.remasterSelectionPageSize);
        const disabled = this.remasterTaskRunning;

        if (!pageItems.length) {
            container.innerHTML = '<div class="h-36 flex items-center justify-center text-xs t-text-muted">没有可选择的下载歌曲</div>';
        } else {
            container.innerHTML = pageItems.map(item => {
                const selected = this.remasterSelectedItems.has(item.filename);
                const qualityName = window.QualityManager?.getQualityDisplayName(item.quality) || item.quality || '未知音质';
                return `
                    <label class="min-h-12 px-3 py-2 flex items-center gap-3 border-b last:border-b-0 t-border-main ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:t-bg-track'}">
                        <input type="checkbox" data-remaster-filename="${this.escapeAttr(item.filename)}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}
                            class="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500 shrink-0">
                        <span class="min-w-0 flex-1">
                            <span class="block text-xs font-bold t-text-main truncate">${this.escapeHtml(item.name || item.filename)}</span>
                            <span class="block text-[10px] t-text-muted truncate">${this.escapeHtml(item.singer || '未知歌手')} · ${this.escapeHtml(item.album || '未知专辑')}</span>
                        </span>
                        <span class="shrink-0 text-[10px] t-text-muted">${this.escapeHtml(qualityName)}</span>
                    </label>`;
            }).join('');
        }

        this.updateRemasterSelectionControls();
    },

    async remasterRequest(path, options = {}) {
        const response = await fetch(path, {
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(window.getUserAuthHeaders ? window.getUserAuthHeaders() : {}),
                ...(options.headers || {})
            }
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) throw new Error(result.message || '洗版请求失败');
        return result.data;
    },

    async openRemasterModal() {
        if (!window.settings?.enableRemaster) {
            if (typeof showError === 'function') showError('请先在设置中启用歌曲洗版');
            return;
        }
        try {
            const modal = document.getElementById('lm-remaster-modal');
            if (!modal) return;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            document.body.style.overflow = 'hidden';
            this.bindRemasterSelectionEvents();
            this.restoreRemasterTargetQuality();
            this.renderRemasterSelection();
            await this.loadRemasterStatus(true);
        } catch (e) {
            if (typeof showError === 'function') showError(e.message || '无法打开洗版功能');
        }
    },

    closeRemasterModal() {
        const modal = document.getElementById('lm-remaster-modal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
        if (this.remasterPollTimer) {
            clearTimeout(this.remasterPollTimer);
            this.remasterPollTimer = null;
        }
        document.body.style.overflow = '';
    },

    async startRemaster() {
        const quality = document.getElementById('lm-remaster-quality')?.value || 'flac24bit';
        this.saveRemasterTargetQuality(quality);
        const qualityName = window.QualityManager?.getQualityDisplayName(quality) || quality;
        const filenames = Array.from(this.remasterSelectedItems);
        if (!filenames.length) {
            if (typeof showError === 'function') showError('请至少选择一首需要洗版的歌曲');
            return;
        }
        const confirmed = await showSelect(
            '确认开始洗版',
            `即将把已选择的 ${filenames.length} 首歌曲洗版为“${qualityName}”。此操作会替换原音频文件，建议先备份。确定继续吗？`,
            { danger: true, confirmText: '开始洗版' }
        );
        if (!confirmed) return;

        try {
            this.remasterResultOffset = 0;
            this.remasterResults = [];
            this.remasterResultFilter = 'all';
            this.remasterTaskId = '';
            this.renderRemasterResults();
            await this.remasterRequest('/api/music/remaster/start', {
                method: 'POST',
                body: JSON.stringify({ targetQuality: quality, filenames })
            });
            if (typeof showInfo === 'function') showInfo('洗版任务已启动，关闭页面后服务端仍会继续处理');
            await this.loadRemasterStatus(true);
        } catch (e) {
            if (typeof showError === 'function') showError(e.message || '启动洗版失败');
        }
    },

    async cancelRemaster() {
        const confirmed = await showSelect('停止洗版', '确定停止当前洗版任务吗？正在下载的歌曲会取消，已经完成替换的歌曲不会恢复。', {
            danger: true,
            confirmText: '停止任务'
        });
        if (!confirmed) return;
        try {
            await this.remasterRequest('/api/music/remaster/cancel', { method: 'POST' });
            await this.loadRemasterStatus(false);
        } catch (e) {
            if (typeof showError === 'function') showError(e.message || '停止洗版失败');
        }
    },

    async loadRemasterStatus(reset = false) {
        if (reset) {
            this.remasterResultOffset = 0;
            this.remasterResults = [];
            this.remasterTaskId = '';
        }
        if (this.remasterPollTimer) {
            clearTimeout(this.remasterPollTimer);
            this.remasterPollTimer = null;
        }

        const status = await this.remasterRequest(`/api/music/remaster/status?offset=${this.remasterResultOffset}&limit=200`);
        if (status.id && this.remasterTaskId && status.id !== this.remasterTaskId) {
            this.remasterResultOffset = 0;
            this.remasterResults = [];
            this.remasterTaskId = status.id;
            return this.loadRemasterStatus(false);
        }
        if (status.id) this.remasterTaskId = status.id;
        if (status.targetQuality) this.remasterTargetQuality = status.targetQuality;
        if (Array.isArray(status.results) && status.results.length) {
            this.remasterResults.push(...status.results);
        }
        this.remasterResultOffset = Number(status.nextOffset || this.remasterResultOffset);
        this.renderRemasterStatus(status);

        if (this.remasterResultOffset < Number(status.processed || 0)) {
            return this.loadRemasterStatus(false);
        }

        const modalOpen = document.getElementById('lm-remaster-modal')?.classList.contains('flex');
        if (status.status === 'running' && modalOpen) {
            this.remasterPollTimer = setTimeout(() => this.loadRemasterStatus(false).catch(e => {
                if (typeof showError === 'function') showError(e.message || '获取洗版进度失败');
            }), 1000);
        } else if (status.id && status.status !== 'idle' && this.remasterLastTerminalTaskId !== status.id) {
            this.remasterLastTerminalTaskId = status.id;
            await this.fetchData(true);
            if (status.status === 'completed' && typeof showSuccess === 'function') showSuccess('洗版任务已完成');
            if (status.status === 'error' && typeof showError === 'function') showError(status.errorMsg || '洗版任务异常终止');
        }
    },

    renderRemasterStatus(status) {
        const total = Number(status.total || 0);
        const processed = Number(status.processed || 0);
        const percent = total > 0 ? Math.min(100, Math.round(processed / total * 100)) : 0;
        const statusNames = {
            idle: '尚未开始',
            running: '正在洗版',
            completed: '处理完成',
            cancelled: '任务已停止',
            error: '任务异常'
        };
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(value);
        };
        setText('lm-remaster-status', statusNames[status.status] || status.status || '未知状态');
        setText('lm-remaster-progress-text', `${processed} / ${total}`);
        setText('lm-remaster-total', total);
        setText('lm-remaster-replaced', status.replaced || 0);
        setText('lm-remaster-downgraded', status.downgraded || 0);
        setText('lm-remaster-skipped', status.skipped || 0);
        setText('lm-remaster-failed', status.failed || 0);
        const progress = document.getElementById('lm-remaster-progress');
        if (progress) progress.style.width = `${percent}%`;

        const running = status.status === 'running';
        const runningChanged = this.remasterTaskRunning !== running;
        this.remasterTaskRunning = running;
        const startButton = document.getElementById('lm-remaster-start');
        const cancelButton = document.getElementById('lm-remaster-cancel');
        const qualitySelect = document.getElementById('lm-remaster-quality');
        if (startButton) startButton.classList.toggle('hidden', running);
        if (cancelButton) {
            cancelButton.classList.toggle('hidden', !running);
            cancelButton.classList.toggle('flex', running);
        }
        if (qualitySelect) qualitySelect.disabled = running;
        if (runningChanged) this.renderRemasterSelection();
        this.renderRemasterResults();
    },

    setRemasterResultFilter(filter) {
        const allowedFilters = new Set(['all', 'successful', 'downgraded', 'skipped', 'failed']);
        this.remasterResultFilter = allowedFilters.has(filter) ? filter : 'all';
        this.renderRemasterResults();
        document.getElementById('lm-remaster-results')?.scrollIntoView({ block: 'nearest' });
    },

    updateRemasterResultFilterUI() {
        const counts = {
            all: this.remasterResults.length,
            successful: this.remasterResults.filter(item => item.status === 'replaced' || item.status === 'downgraded').length,
            downgraded: this.remasterResults.filter(item => item.status === 'downgraded').length,
            skipped: this.remasterResults.filter(item => item.status === 'skipped').length,
            failed: this.remasterResults.filter(item => item.status === 'failed').length
        };
        document.querySelectorAll('[data-remaster-result-filter]').forEach(button => {
            const filter = button.dataset.remasterResultFilter;
            const active = filter === this.remasterResultFilter;
            button.disabled = !counts[filter];
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
            button.style.borderColor = active ? 'rgb(239 68 68)' : '';
            button.style.boxShadow = active ? 'inset 0 0 0 1px rgb(239 68 68)' : '';
        });
        return counts;
    },

    renderRemasterResults() {
        const container = document.getElementById('lm-remaster-results');
        if (!container) return;
        const counts = this.updateRemasterResultFilterUI();
        const filterConfig = {
            all: ['全部', item => true],
            successful: ['成功', item => item.status === 'replaced' || item.status === 'downgraded'],
            downgraded: ['发生降级', item => item.status === 'downgraded'],
            skipped: ['已跳过', item => item.status === 'skipped'],
            failed: ['失败', item => item.status === 'failed']
        };
        const activeFilter = filterConfig[this.remasterResultFilter] || filterConfig.all;
        const filteredResults = this.remasterResults.filter(activeFilter[1]);
        const title = document.getElementById('lm-remaster-results-title');
        if (title) title.textContent = `处理结果 · ${activeFilter[0]} (${counts[this.remasterResultFilter] || 0})`;
        if (!filteredResults.length) {
            container.innerHTML = '<div class="p-6 text-center text-xs t-text-muted">暂无结果</div>';
            return;
        }
        const statusConfig = {
            replaced: ['已替换', 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30'],
            downgraded: ['已降级', 'text-amber-700 bg-amber-50 dark:bg-amber-950/30'],
            skipped: ['已跳过', 'text-gray-600 bg-gray-100 dark:bg-gray-800'],
            failed: ['失败', 'text-red-700 bg-red-50 dark:bg-red-950/30']
        };
        container.innerHTML = filteredResults.map(item => {
            const config = statusConfig[item.status] || [item.status, 'text-gray-600 bg-gray-100'];
            const originalName = window.QualityManager?.getQualityDisplayName(item.originalQuality) || item.originalQuality;
            const actualName = item.actualQuality
                ? (window.QualityManager?.getQualityDisplayName(item.actualQuality) || item.actualQuality)
                : '-';
            return `
                <div class="p-3 flex items-start gap-3">
                    <span class="shrink-0 px-2 py-1 rounded text-[10px] font-bold ${config[1]}">${config[0]}</span>
                    <div class="min-w-0 flex-1">
                        <div class="text-xs font-bold t-text-main truncate">${this.escapeHtml(item.name)} · ${this.escapeHtml(item.singer)}</div>
                        <div class="text-[10px] t-text-muted mt-1">${this.escapeHtml(originalName)} → ${this.escapeHtml(actualName)}</div>
                        <div class="text-[10px] t-text-muted mt-1 break-words">${this.escapeHtml(item.message || '')}</div>
                    </div>
                </div>`;
        }).join('');
    },

};

window.toggleLmBatchMode = () => window.LocalMusicManager.toggleBatchMode();

// Auto init when script loads (if in scope), else done manually
setTimeout(() => {
    if (window.LocalMusicManager) {
        window.LocalMusicManager.init();
    }
}, 500);
