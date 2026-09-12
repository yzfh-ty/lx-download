/**
 * 歌单订阅管理
 * 在歌单详情页可"订阅"网络歌单：服务端按设定间隔定时拉取远端歌单，
 * 与快照对比后自动将新增歌曲加入服务端下载队列（无需浏览器保持开启）。
 */
(function () {
  'use strict'

  const API_BASE = '/api/music'
  const SOURCE_NAMES = { wy: '网易云', tx: 'QQ音乐', kg: '酷狗', kw: '酷我', mg: '咪咕' }

  const SubscriptionManager = {
    cache: [],
    settings: { intervalMinutes: 360 },
    loaded: false,

    async _api(path, method = 'GET', body = null) {
      const headers = { 'Content-Type': 'application/json' }
      if (typeof getUserAuthHeaders === 'function') Object.assign(headers, getUserAuthHeaders())

      const res = await fetch(API_BASE + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) throw new Error(data.message || ('HTTP ' + res.status))
      return data
    },

    async load(force = false) {
      if (this.loaded && !force) return this.cache
      try {
        const data = await this._api('/subscriptions')
        this.cache = Array.isArray(data.data) ? data.data : []
        if (data.settings && data.settings.intervalMinutes) this.settings.intervalMinutes = data.settings.intervalMinutes
        this.loaded = true
      } catch (e) {
        console.error('[Subscription] 加载订阅失败:', e)
        this.cache = []
      }
      return this.cache
    },

    find(source, sourceListId) {
      return this.cache.find(s => s.source === source && String(s.sourceListId) === String(sourceListId)) || null
    },

    // ===== 歌单详情页入口 =====

    updateDetailButton(source, sourceListId) {
      const btn = document.getElementById('sl-detail-subscribe')
      if (!btn) return
      const label = btn.querySelector('span')
      const sub = this.loaded ? this.find(source, sourceListId) : null
      if (sub) {
        btn.title = '已订阅（自动下载新增歌曲，点击管理）'
        btn.classList.add('text-emerald-500')
        btn.classList.remove('t-text-muted')
        if (label) label.textContent = '管理订阅'
      } else {
        btn.title = '订阅歌单：定时自动同步并下载新增歌曲'
        btn.classList.remove('text-emerald-500')
        btn.classList.add('t-text-muted')
        if (label) label.textContent = '订阅歌单'
      }
    },

    async handleDetailButton() {
      if (typeof window.SongListManager === 'undefined') return
      const detail = window.SongListManager.getCurrentDetail()
      if (!detail || !detail.id || !detail.source) {
        if (window.showError) showError('请先打开一个网络歌单')
        return
      }
      await this.load(true)

      const sub = this.find(detail.source, detail.id)
      if (sub) {
        await this.manageExisting(sub)
      } else {
        await this.subscribeFlow(detail)
      }
      this.updateDetailButton(detail.source, detail.id)
      this.renderSettingsPanel()
    },

    async _chooseQuality() {
      if (typeof getSelectableQualityOrder !== 'function' || typeof showOptions !== 'function') return null
      const available = getSelectableQualityOrder()
      const names = available.map(q => window.QualityManager ? window.QualityManager.getQualityDisplayName(q) : q)
      const picked = await showOptions('选择订阅下载音质', '订阅检测到的新增歌曲将按此音质自动下载\n(解析失败时按全局自动降级设置处理)', names)
      if (!picked) return null
      return available[names.indexOf(picked)]
    },

    _showEditDialog(sub) {
      return new Promise(resolve => {
        const sources = Object.keys(SOURCE_NAMES)
        const qualities = typeof getSelectableQualityOrder === 'function'
          ? getSelectableQualityOrder()
          : ['128k', '320k', 'flac', 'flac24bit']
        const modal = document.createElement('div')
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm'
        modal.setAttribute('role', 'dialog')
        modal.setAttribute('aria-modal', 'true')
        modal.setAttribute('aria-labelledby', 'subscription-edit-title')

        const panel = document.createElement('div')
        panel.className = 't-bg-panel rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border t-border-main'
        panel.innerHTML = `
          <div class="px-5 py-4 border-b border-emerald-100/50 flex justify-between items-center bg-emerald-50/50 dark:bg-emerald-900/10">
            <h3 id="subscription-edit-title" class="text-base font-bold t-text-main">编辑订阅</h3>
            <button type="button" data-sub-edit-close class="p-1 t-text-muted hover:text-emerald-500 transition-colors" aria-label="关闭">
              <i class="fas fa-times text-lg"></i>
            </button>
          </div>
          <form data-sub-edit-form class="p-5 space-y-4">
            <div>
              <label for="subscription-edit-source" class="block text-xs font-bold t-text-main mb-1.5">订阅平台</label>
              <select id="subscription-edit-source" class="w-full rounded-xl border t-border-main px-3 py-2.5 text-sm t-bg-main focus:outline-none focus:ring-2 focus:ring-emerald-500"></select>
            </div>
            <div>
              <label for="subscription-edit-id" class="block text-xs font-bold t-text-main mb-1.5">歌单 ID</label>
              <input id="subscription-edit-id" type="text" required autocomplete="off" spellcheck="false"
                class="w-full rounded-xl border t-border-main px-3 py-2.5 text-sm t-bg-main focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label for="subscription-edit-name" class="block text-xs font-bold t-text-main mb-1.5">显示名称</label>
              <input id="subscription-edit-name" type="text" maxlength="120" autocomplete="off"
                class="w-full rounded-xl border t-border-main px-3 py-2.5 text-sm t-bg-main focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label for="subscription-edit-quality" class="block text-xs font-bold t-text-main mb-1.5">下载音质</label>
              <select id="subscription-edit-quality" class="w-full rounded-xl border t-border-main px-3 py-2.5 text-sm t-bg-main focus:outline-none focus:ring-2 focus:ring-emerald-500"></select>
            </div>
            <label class="flex items-center gap-2 text-sm t-text-main cursor-pointer">
              <input id="subscription-edit-enabled" type="checkbox" class="h-4 w-4 accent-emerald-500" />
              <span>启用自动检测和下载</span>
            </label>
            <div class="flex justify-end gap-2 pt-2">
              <button type="button" data-sub-edit-cancel class="px-4 py-2 rounded-xl border t-border-main t-text-muted hover:t-bg-track text-sm">取消</button>
              <button type="submit" class="px-4 py-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 text-sm font-medium">保存修改</button>
            </div>
          </form>`

        const sourceSelect = panel.querySelector('#subscription-edit-source')
        for (const source of sources) {
          const option = document.createElement('option')
          option.value = source
          option.textContent = `${SOURCE_NAMES[source]} (${source})`
          option.selected = source === sub.source
          sourceSelect.appendChild(option)
        }
        if (!sources.includes(sub.source)) {
          const option = document.createElement('option')
          option.value = sub.source
          option.textContent = `${sub.source} (当前平台)`
          option.selected = true
          sourceSelect.appendChild(option)
        }

        const qualitySelect = panel.querySelector('#subscription-edit-quality')
        for (const quality of qualities) {
          const option = document.createElement('option')
          option.value = quality
          option.textContent = window.QualityManager ? window.QualityManager.getQualityDisplayName(quality) : quality
          option.selected = quality === sub.quality
          qualitySelect.appendChild(option)
        }
        if (!qualities.includes(sub.quality)) {
          const option = document.createElement('option')
          option.value = sub.quality
          option.textContent = sub.quality
          option.selected = true
          qualitySelect.appendChild(option)
        }

        panel.querySelector('#subscription-edit-id').value = sub.sourceListId || ''
        panel.querySelector('#subscription-edit-name').value = sub.name || ''
        panel.querySelector('#subscription-edit-enabled').checked = sub.enabled !== false

        let settled = false
        const close = result => {
          if (settled) return
          settled = true
          modal.remove()
          resolve(result)
        }
        const cancel = () => close(null)
        panel.querySelector('[data-sub-edit-close]').addEventListener('click', cancel)
        panel.querySelector('[data-sub-edit-cancel]').addEventListener('click', cancel)
        modal.addEventListener('click', event => {
          if (event.target === modal) cancel()
        })
        modal.addEventListener('keydown', event => {
          if (event.key === 'Escape') cancel()
        })
        panel.querySelector('[data-sub-edit-form]').addEventListener('submit', event => {
          event.preventDefault()
          const sourceListId = panel.querySelector('#subscription-edit-id').value.trim()
          if (!sourceListId) {
            panel.querySelector('#subscription-edit-id').focus()
            return
          }
          close({
            source: sourceSelect.value,
            sourceListId,
            name: panel.querySelector('#subscription-edit-name').value.trim() || sub.name,
            quality: qualitySelect.value,
            enabled: panel.querySelector('#subscription-edit-enabled').checked
          })
        })

        modal.appendChild(panel)
        document.body.appendChild(modal)
        panel.querySelector('#subscription-edit-id').focus()
      })
    },

    async subscribeFlow(detail) {
      const quality = await this._chooseQuality()
      if (!quality) return

      try {
        if (window.showInfo) showInfo('正在拉取歌单并加入下载队列，请稍候...')
        const data = await this._api('/subscriptions', 'POST', {
          source: detail.source,
          sourceListId: detail.id,
          name: (detail.info && (detail.info.name || detail.info.title)) || '',
          cover: (detail.info && detail.info.img) || '',
          quality
        })
        this.cache.push(data.data)
        const count = data.data.knownCount || 0
        const enqueued = data.data.stats?.enqueued || 0
        if (window.showSuccess) showSuccess(`订阅成功！已记录 ${count} 首歌曲，已加入下载队列 ${enqueued} 首，之后将定时检测并自动下载新增歌曲`)
      } catch (e) {
        if (window.showError) showError('订阅失败: ' + e.message)
      }
    },

    async manageExisting(sub) {
      const options = ['立即检查更新', '编辑订阅', '修改下载音质', '取消订阅']
      const picked = await showOptions(`管理订阅：${sub.name || sub.sourceListId}`, `歌单 ID: ${sub.sourceListId}\n音质: ${sub.quality} | 已收录 ${sub.knownCount} 首`, options)
      if (!picked) return

      try {
        if (picked === '立即检查更新') {
          if (window.showInfo) showInfo('正在检测歌单更新...')
          const data = await this._api('/subscriptions/check', 'POST', { id: sub.id })
          const r = Array.isArray(data.data) ? data.data[0] : null
          if (!r) throw new Error('无检测结果')
          if (r.error) throw new Error(r.error)
          if (r.isBaseline) {
            if (window.showSuccess) showSuccess(`已将当前歌单加入下载队列 ${r.enqueued || 0} 首，之后仅检测新增歌曲`)
          } else if (r.addedCount > 0) {
            const msg = `检测到 ${r.addedCount} 首新增歌曲` + (r.enqueued > 0 ? `，已加入下载队列 ${r.enqueued} 首` : '')
            if (window.showSuccess) showSuccess(msg)
          } else {
            if (window.showSuccess) showSuccess('歌单暂无更新')
          }
          await this.load(true)
        } else if (picked === '编辑订阅') {
          await this.edit(sub.id)
        } else if (picked === '修改下载音质') {
          const quality = await this._chooseQuality()
          if (!quality) return
          const data = await this._api('/subscriptions/update', 'POST', { id: sub.id, quality })
          this._replace(data.data)
          if (window.showSuccess) showSuccess('下载音质已更新为 ' + quality)
        } else if (picked === '取消订阅') {
          await this._api('/subscriptions/delete', 'POST', { id: sub.id })
          this.cache = this.cache.filter(s => s.id !== sub.id)
          if (window.showSuccess) showSuccess('已取消订阅')
        }
      } catch (e) {
        if (window.showError) showError('操作失败: ' + e.message)
      }
    },

    async edit(id) {
      const sub = this.cache.find(item => item.id === id)
      if (!sub || typeof showInput !== 'function') return

      const values = await this._showEditDialog(sub)
      if (!values) return

      try {
        if (window.showInfo) showInfo('正在重新拉取歌单并更新订阅，请稍候...')
        const data = await this._api('/subscriptions/update', 'POST', {
          id,
          ...values
        })
        this._replace(data.data)
        if (window.showSuccess) showSuccess('订阅已修改；如果更换了歌单，当前歌曲已重新加入下载队列')
      } catch (e) {
        if (window.showError) showError('修改订阅失败: ' + e.message)
      }
      await this.renderSettingsPanel()
    },

    _replace(sub) {
      const i = this.cache.findIndex(s => s.id === sub.id)
      if (i >= 0) this.cache[i] = sub
    },

    // ===== 设置页面板 =====

    _formatTime(ts) {
      if (!ts) return '从未'
      const diff = Date.now() - ts
      if (diff < 60 * 1000) return '刚刚'
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
      return Math.floor(diff / 86400000) + ' 天前'
    },

    async renderSettingsPanel() {
      const container = document.getElementById('subscription-page') || document.getElementById('subscription-panel')
      if (!container) return
      await this.load(true)

      const rows = this.cache.map(sub => {
        const sourceName = SOURCE_NAMES[sub.source] || sub.source
        const statusColor = sub.stats.lastError ? 'text-red-500' : (sub.enabled ? 'text-emerald-500' : 'text-gray-400')
        const statusText = sub.stats.lastError
          ? `检测失败: ${this._escape(sub.stats.lastError)}`
          : `已收录 ${sub.knownCount} 首 | 上次检测 ${this._formatTime(sub.lastCheckedAt)}`
        return `
          <div class="flex items-center justify-between gap-3 py-2 border-b t-border-main" data-sub-id="${sub.id}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 t-text-muted font-mono">${sourceName}</span>
                <span class="text-sm font-bold t-text-main truncate">${this._escape(sub.name || sub.sourceListId)}</span>
              </div>
              <div class="text-[10px] t-text-muted mt-0.5 font-mono truncate" title="歌单 ID: ${this._escape(sub.sourceListId)}">歌单 ID: ${this._escape(sub.sourceListId)}</div>
              <div class="text-xs t-text-muted mt-1 truncate ${sub.enabled ? '' : 'opacity-50'}">${statusText}</div>
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">
              <button onclick="window.SubscriptionManager.edit('${sub.id}')" class="p-1.5 t-text-muted hover:text-violet-500 rounded-lg hover:t-bg-track" title="编辑订阅"><i class="fas fa-edit text-xs"></i></button>
              <button onclick="window.SubscriptionManager.checkOne('${sub.id}')" class="p-1.5 t-text-muted hover:text-emerald-500 rounded-lg hover:t-bg-track" title="立即检查更新"><i class="fas fa-sync-alt text-xs"></i></button>
              <button onclick="window.SubscriptionManager.toggleEnabled('${sub.id}')" class="p-1.5 t-text-muted hover:text-blue-500 rounded-lg hover:t-bg-track" title="${sub.enabled ? '暂停订阅' : '恢复订阅'}"><i class="fas ${sub.enabled ? 'fa-pause' : 'fa-play'} text-xs"></i></button>
              <button onclick="window.SubscriptionManager.remove('${sub.id}')" class="p-1.5 t-text-muted hover:text-red-500 rounded-lg hover:t-bg-track" title="取消订阅"><i class="fas fa-trash text-xs"></i></button>
            </div>
          </div>`
      }).join('')

      container.innerHTML = `
        <div class="t-bg-panel rounded-2xl shadow-sm border t-border-main p-4 sm:p-8 w-full min-h-full space-y-4">
          <p class="text-xs t-text-muted mb-4">在歌单详情页点击“订阅歌单”按钮订阅网络歌单。服务端会按以下间隔定时拉取远端歌单，自动对比并将新增歌曲加入下载队列，无需保持浏览器开启。</p>
          <div class="flex items-center justify-between pb-3 border-b t-border-main">
            <div>
              <div class="text-sm font-bold t-text-main">订阅检测间隔</div>
              <div class="text-xs t-text-muted mt-1">每隔该时长自动检测所有订阅歌单的远端更新。</div>
            </div>
            <div class="flex items-center gap-2">
              <input id="setting-sub-interval" type="text" value="${this.settings.intervalMinutes}"
                class="w-24 rounded-xl border t-border-main px-3 py-2 text-sm bg-transparent focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              <span class="text-xs t-text-muted">分钟</span>
              <button onclick="window.SubscriptionManager.saveInterval()" class="px-3 py-2 rounded-xl bg-emerald-500 text-white text-xs font-medium hover:bg-emerald-600">保存</button>
            </div>
          </div>
          ${this.cache.length === 0
            ? '<div class="py-6 text-center text-xs t-text-muted">暂无订阅，前往「歌单」页打开任意网络歌单，点击右上角“订阅歌单”按钮开始订阅</div>'
            : `<div class="mt-1">${rows}</div>`}
        </div>`

      const intervalInput = document.getElementById('setting-sub-interval')
      if (intervalInput) {
        intervalInput.addEventListener('keydown', e => {
          if (e.key === 'Enter') this.saveInterval()
        })
      }
    },

    _escape(text) {
      return String(text || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    },

    async saveInterval() {
      const input = document.getElementById('setting-sub-interval')
      if (!input) return
      const value = Number.parseInt(input.value, 10)
      if (!Number.isFinite(value) || value < 5) {
        if (window.showError) showError('间隔不能小于 5 分钟')
        return
      }
      try {
        const data = await this._api('/subscriptions/settings', 'POST', { intervalMinutes: value })
        this.settings.intervalMinutes = data.data.intervalMinutes
        if (window.showSuccess) showSuccess(`订阅检测间隔已保存为 ${this.settings.intervalMinutes} 分钟`)
      } catch (e) {
        if (window.showError) showError('保存失败: ' + e.message)
      }
    },

    async checkOne(id) {
      if (window.showInfo) showInfo('正在检测歌单更新...')
      try {
        const data = await this._api('/subscriptions/check', 'POST', { id })
        const r = Array.isArray(data.data) ? data.data[0] : null
        if (!r) throw new Error('无检测结果')
        if (r.error) throw new Error(r.error)
        if (r.addedCount > 0) {
          const msg = `「${r.name}」检测到 ${r.addedCount} 首新增歌曲` + (r.enqueued > 0 ? `，已加入下载队列 ${r.enqueued} 首` : '（自动下载已关闭）')
          if (window.showSuccess) showSuccess(msg)
        } else {
          if (window.showSuccess) showSuccess('「' + r.name + '」暂无更新')
        }
      } catch (e) {
        if (window.showError) showError('检测失败: ' + e.message)
      }
      await this.renderSettingsPanel()
    },

    async toggleEnabled(id) {
      const sub = this.cache.find(s => s.id === id)
      if (!sub) return
      try {
        const data = await this._api('/subscriptions/update', 'POST', { id, enabled: !sub.enabled })
        this._replace(data.data)
      } catch (e) {
        if (window.showError) showError('操作失败: ' + e.message)
      }
      await this.renderSettingsPanel()
    },

    async remove(id) {
      const sub = this.cache.find(s => s.id === id)
      if (!sub) return
      if (typeof showSelect !== 'function') return
      const confirmed = await showSelect('取消订阅', `确定取消订阅「${sub.name || sub.sourceListId}」？\n（不会删除已下载的歌曲文件）`, {
        danger: true,
        confirmText: '确认取消'
      })
      if (!confirmed) return
      try {
        await this._api('/subscriptions/delete', 'POST', { id })
        this.cache = this.cache.filter(s => s.id !== id)
        if (window.showSuccess) showSuccess('已取消订阅')
      } catch (e) {
        if (window.showError) showError('操作失败: ' + e.message)
      }
      await this.renderSettingsPanel()
    }
  }

  window.SubscriptionManager = SubscriptionManager

  // 歌单详情打开/切换时刷新订阅按钮状态
  document.addEventListener('DOMContentLoaded', () => {
    SubscriptionManager.load().then(() => SubscriptionManager.renderSettingsPanel()).catch(() => {})
    if (window.SongListManager && typeof window.SongListManager.openDetail === 'function') {
      const origOpenDetail = window.SongListManager.openDetail
      window.SongListManager.openDetail = function (id, source, options) {
        SubscriptionManager.updateDetailButton(source, id)
        return origOpenDetail.call(this, id, source, options)
      }
    }
  })
})()
