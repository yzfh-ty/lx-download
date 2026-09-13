(function () {
  'use strict'
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const manager = {
    playlists: [],
    settings: {},
    statuses: {},
    busy: false,
    cleanupCatalog: null,
    cleanupSelection: new Set(),
    cleanupMessage: '',
    resetCleanup() {
      this.cleanupCatalog = null
      this.cleanupSelection.clear()
      this.cleanupMessage = ''
    },
    async load() {
      if (this.busy) return
      const container = document.getElementById('navidrome-page')
      if (!container) return
      this.busy = true
      container.setAttribute('aria-busy', 'true')
      container.innerHTML = '<p class="text-sm t-text-muted p-4" role="status">正在加载歌单…</p>'
      try {
        const [result, config] = await Promise.all([
          window.SubscriptionManager._api('/navidrome/playlists'),
          window.SubscriptionManager._api('/navidrome/settings')
        ])
        this.playlists = Array.isArray(result.data) ? result.data : []
        this.settings = config.data || {}
        this.statuses = config.statuses || {}
        this.resetCleanup()
        this.render(container)
      } catch (err) {
        container.innerHTML = `<p class="text-sm text-red-500 p-4" role="alert">加载失败：${escape(err.message)}</p><button type="button" class="min-h-[44px] px-4 t-text-main border t-border-main rounded-xl">重试</button>`
        container.querySelector('button').addEventListener('click', () => this.load())
      } finally {
        this.busy = false
        container.setAttribute('aria-busy', 'false')
        this.renderCleanup(container)
      }
    },
    render(container) {
      container.innerHTML = `
        <section class="t-bg-panel border t-border-main rounded-2xl p-4 md:p-6 mb-4 space-y-4">
          <h3 class="text-lg font-bold t-text-main">Navidrome API 连接</h3>
          <p class="text-sm t-text-muted leading-relaxed">每个本地歌单绑定一个固定的 Navidrome 歌单 ID，改名或增删歌曲会更新同一个歌单。请使用拥有这些歌单的账号，并确保 Navidrome 能扫描到下载目录。</p>
          <form id="navidrome-connection" class="space-y-3">
            <label for="navidrome-url" class="block text-sm t-text-main">服务器地址</label>
            <input id="navidrome-url" type="url" required value="${escape(this.settings.url || '')}" placeholder="http://192.168.1.10:4533" class="w-full min-h-[44px] px-3 py-2 bg-transparent border t-border-main rounded-xl t-text-main" />
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><label for="navidrome-user" class="block text-sm t-text-main mb-2">用户名</label><input id="navidrome-user" autocomplete="username" required value="${escape(this.settings.username || '')}" class="w-full min-h-[44px] px-3 py-2 bg-transparent border t-border-main rounded-xl t-text-main" /></div>
              <div><label for="navidrome-password" class="block text-sm t-text-main mb-2">密码</label><input id="navidrome-password" type="password" autocomplete="current-password" placeholder="${this.settings.hasPassword ? '已保存，留空保持不变' : '请输入 Navidrome 密码'}" class="w-full min-h-[44px] px-3 py-2 bg-transparent border t-border-main rounded-xl t-text-main" /></div>
            </div>
            <label for="navidrome-prefix" class="block text-sm t-text-main">下载目录在 Navidrome 中的真实路径前缀</label>
            <input id="navidrome-prefix" value="${escape(this.settings.pathPrefix || '')}" placeholder="例如 /music，或 /music/download" class="w-full min-h-[44px] px-3 py-2 bg-transparent border t-border-main rounded-xl t-text-main" />
            <p class="text-sm t-text-muted">请先在 Navidrome 的播放器设置中，为当前账号的 lx-download 播放器启用“报告真实路径”（Report real path）。此处填写下载目录在 Navidrome 容器中的路径，例如 /music；不填写 lx-download 容器内的 /server/download 或宿主机路径。</p>
            <label class="flex items-center gap-3 min-h-[44px] text-sm t-text-main"><input id="navidrome-enabled" type="checkbox" ${this.settings.enabled ? 'checked' : ''} />启用固定歌单 ID 的 API 同步</label>
            <p class="text-sm t-text-muted">首次启用后，本程序的 M3U8 会改为不参与自动导入的导出清单；暂停 API 同步也不会恢复文件导入。可绑定现有可编辑歌单，并在下方“清理旧歌单”中选择删除历史记录。</p>
            <div class="flex flex-wrap gap-3">
              <button type="submit" class="min-h-[44px] px-4 py-2 rounded-xl bg-emerald-600 text-white">保存连接配置</button>
              <button type="button" data-connection-action="test" class="min-h-[44px] px-4 py-2 rounded-xl border t-border-main t-text-main">测试连接</button>
              <button type="button" data-connection-action="sync" class="min-h-[44px] px-4 py-2 rounded-xl border t-border-main t-text-main">立即同步</button>
            </div>
            <p id="navidrome-connection-message" role="status" class="text-sm t-text-main break-words">${escape(this.settings.lastError || '')}</p>
          </form>
        </section>
        <section class="t-bg-panel border t-border-main rounded-2xl p-4 md:p-6 space-y-4">
          <p class="text-sm t-text-muted leading-relaxed">保存名称后会重命名本地文件夹，后续订阅下载使用新目录。启用 API 后，远端歌单名称和内容通过固定 ID 更新；歌曲需先被 Navidrome 扫描识别。</p>
          <p class="text-sm t-text-muted">所有目录均位于下载目录内。同名目录不会覆盖；目录中有歌曲正在下载或写入标签时，请等待当前任务完成后再改名。</p>
          <div id="navidrome-status" class="text-sm t-text-main" role="status" aria-live="polite"></div>
          <div class="space-y-4">${this.playlists.map((playlist, index) => `
            <form class="border t-border-main rounded-xl p-4 space-y-3" data-playlist-index="${index}">
              <div class="text-sm t-text-muted">${playlist.kind === 'unmatched' ? '自动收录未匹配歌曲' : `订阅：${escape(playlist.subscriptionName)}`} · ${Number(playlist.playlistTrackCount || 0)} 首</div>
              <label for="navidrome-name-${index}" class="block text-sm font-medium t-text-main">歌单名称</label>
              <div class="flex flex-col sm:flex-row gap-3">
                <input id="navidrome-name-${index}" name="name" type="text" required maxlength="64" value="${escape(playlist.name)}"
                  class="min-w-0 w-full flex-1 min-h-[44px] px-3 py-2 bg-transparent t-text-main border t-border-main rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                <button type="submit" class="min-h-[44px] px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-emerald-500">保存名称</button>
              </div>
              <p class="text-sm t-text-muted break-all">当前目录：${escape(playlist.directoryName || '等待创建')}</p>
              <p class="text-sm t-text-muted break-all">本地清单：${escape(playlist.playlistPath || '等待创建')}</p>
              <p class="text-sm t-text-muted break-all">Navidrome 歌单 ID：${escape(this.statuses[playlist.id]?.playlistId || '尚未绑定')} · 已同步 ${Number(this.statuses[playlist.id]?.syncedCount || 0)} 首</p>
              <p class="text-sm text-red-500 break-words" role="alert">${escape(this.statuses[playlist.id]?.lastError || '')}</p>
              ${this.statuses[playlist.id]?.pathExamples ? `<details class="text-sm t-text-muted break-all"><summary class="cursor-pointer min-h-[44px] flex items-center">查看匹配路径</summary>
                <p>本地文件：${escape(this.statuses[playlist.id].pathExamples.local)}</p>
                <p>当前查找路径：${escape(this.statuses[playlist.id].pathExamples.expected)}</p>
                <p>Navidrome 路径示例：${escape(this.statuses[playlist.id].pathExamples.remote || '接口未返回歌曲路径')}</p>
              </details>` : ''}
              <details class="text-sm t-text-muted"><summary class="cursor-pointer min-h-[44px] flex items-center">绑定现有歌单</summary>
                <label for="navidrome-bind-${index}" class="block mb-2">现有 Navidrome 歌单 ID（绑定后内容由本程序维护）</label>
                <div class="flex flex-col sm:flex-row gap-3"><input id="navidrome-bind-${index}" value="${escape(this.statuses[playlist.id]?.playlistId || '')}" class="min-w-0 flex-1 min-h-[44px] px-3 py-2 bg-transparent border t-border-main rounded-xl t-text-main" /><button type="button" data-bind="${index}" class="min-h-[44px] px-4 rounded-xl border t-border-main t-text-main">绑定此歌单</button></div>
                <p class="mt-2">仅可绑定当前账号拥有的可编辑歌单；文件导入歌单需先在 Navidrome 解除文件同步。其他重复记录可在下方选择清理。</p>
              </details>
              <p class="text-sm text-red-500 break-words" role="alert" data-error>${escape(playlist.playlistLastError || '')}</p>
            </form>`).join('') || '<p class="text-sm t-text-muted">暂无自动生成的歌单。</p>'}</div>
        </section>
        <div id="navidrome-cleanup" class="mt-4"></div>`
      container.querySelectorAll('form[data-playlist-index]').forEach(form => {
        form.addEventListener('submit', event => { event.preventDefault(); void this.save(form, container) })
      })
      container.querySelector('#navidrome-connection').addEventListener('submit', event => { event.preventDefault(); void this.connectionAction('settings', container) })
      container.querySelectorAll('[data-connection-action]').forEach(button => button.addEventListener('click', () => this.connectionAction(button.dataset.connectionAction, container)))
      container.querySelectorAll('[data-bind]').forEach(button => button.addEventListener('click', () => this.connectionAction('bind', container, Number(button.dataset.bind))))
      this.renderCleanup(container)
    },
    renderCleanup(container) {
      const panel = container.querySelector('#navidrome-cleanup')
      if (!panel) return
      const playlists = this.cleanupCatalog?.playlists || []
      panel.innerHTML = `
        <section class="t-bg-panel border t-border-main rounded-2xl p-4 md:p-6 space-y-3">
          <h3 class="text-lg font-bold t-text-main">清理旧歌单</h3>
          <p class="text-sm t-text-muted">读取当前连接账号的远端歌单，按名称、ID 和歌曲数核对后勾选旧记录，每次最多 100 个。已绑定的歌单受到保护；删除歌单记录会保留音乐文件。</p>
          <p class="text-sm t-text-muted">使用 API 同步时，建议在 Navidrome 关闭自动导入歌单（ND_AUTOIMPORTPLAYLISTS=false），避免历史 M3U8 再次导入。</p>
          <div class="flex flex-wrap gap-3">
            <button type="button" data-cleanup-load ${this.busy ? 'disabled' : ''} class="min-h-[44px] px-4 rounded-xl border t-border-main t-text-main disabled:opacity-50">${this.cleanupCatalog ? '刷新远端歌单' : '读取远端歌单'}</button>
            <button type="button" data-cleanup-delete ${this.busy || !this.cleanupSelection.size ? 'disabled' : ''} class="min-h-[44px] px-4 rounded-xl bg-red-600 text-white disabled:opacity-50">删除所选歌单（${this.cleanupSelection.size}）</button>
          </div>
          <p class="text-sm t-text-main whitespace-pre-line break-words" role="status">${escape(this.cleanupMessage)}</p>
          ${this.cleanupCatalog ? `<div class="max-h-96 overflow-y-auto space-y-2">${playlists.map((playlist, index) => `
            <label class="flex items-start gap-3 rounded-xl border t-border-main p-3 min-h-[44px] ${playlist.bound || playlist.pendingCreation ? 'opacity-60' : 'cursor-pointer'}">
              <input type="checkbox" class="mt-1" data-cleanup-index="${index}" ${playlist.bound || playlist.pendingCreation || this.busy ? 'disabled' : ''} ${this.cleanupSelection.has(playlist.id) ? 'checked' : ''} />
              <span class="min-w-0 text-sm t-text-main break-all">
                <span>${escape(playlist.name)} · ${Number(playlist.songCount || 0)} 首</span>
                <span class="block t-text-muted">ID：${escape(playlist.id)}</span>
                <span class="block ${playlist.bound ? 'text-emerald-500' : 't-text-muted'}">${playlist.bound ? '已绑定，保留' : playlist.pendingCreation ? '创建结果待确认，保留' : playlist.sameName ? '与本地歌单同名，请核对是否为旧记录' : '未绑定，请核对是否需要保留'}</span>
              </span>
            </label>`).join('') || '<p class="text-sm t-text-muted">当前账号没有可显示的远端歌单。</p>'}</div>` : ''}
        </section>`
      panel.querySelector('[data-cleanup-load]').addEventListener('click', () => this.cleanupAction('load', container))
      panel.querySelector('[data-cleanup-delete]').addEventListener('click', () => this.cleanupAction('delete', container))
      panel.querySelectorAll('[data-cleanup-index]').forEach(input => input.addEventListener('change', () => {
        const playlist = playlists[Number(input.dataset.cleanupIndex)]
        if (!playlist || playlist.bound || playlist.pendingCreation || this.busy) return
        if (input.checked) this.cleanupSelection.add(playlist.id)
        else this.cleanupSelection.delete(playlist.id)
        const button = panel.querySelector('[data-cleanup-delete]')
        button.disabled = !this.cleanupSelection.size
        button.textContent = `删除所选歌单（${this.cleanupSelection.size}）`
      }))
    },
    async cleanupAction(action, container) {
      if (this.busy) return
      this.busy = true
      container.querySelectorAll('button').forEach(button => { button.disabled = true })
      const refresh = async () => {
        const response = await window.SubscriptionManager._api('/navidrome/remote-playlists')
        this.cleanupCatalog = response.data
        this.cleanupSelection.clear()
      }
      try {
        if (action === 'load') {
          this.cleanupMessage = '正在读取远端歌单…'
          this.renderCleanup(container)
          await refresh()
          this.cleanupMessage = `已读取 ${this.cleanupCatalog.playlists.length} 个歌单，请勾选需要清理的旧记录。`
        } else {
          const selected = (this.cleanupCatalog?.playlists || []).filter(item => !item.bound && !item.pendingCreation && this.cleanupSelection.has(item.id))
          if (!selected.length || selected.length > 100) throw new Error('请选择 1 至 100 个需要删除的歌单')
          if (typeof showSelect !== 'function') throw new Error('删除确认窗口不可用，请刷新页面后重试')
          const names = selected.slice(0, 10).map(item => `${item.name}（${item.id}）`).join('\n')
          const confirmed = await showSelect('删除旧歌单', `将删除以下 ${selected.length} 个 Navidrome 歌单记录：\n${names}${selected.length > 10 ? '\n…' : ''}\n音乐文件保留。`, { danger: true, confirmText: '确认删除歌单' })
          if (!confirmed) return
          this.cleanupMessage = '正在删除所选歌单…'
          this.renderCleanup(container)
          const response = await window.SubscriptionManager._api('/navidrome/remote-playlists/delete', 'POST', { scope: this.cleanupCatalog.scope, playlistIds: selected.map(item => item.id) })
          const result = response.data
          this.cleanupMessage = `已删除 ${result.deleted.length} 个歌单。${result.missing.length ? ` ${result.missing.length} 个歌单已不存在。` : ''}`
          if (result.failed.length) this.cleanupMessage += `\n${result.failed.length} 个删除失败：\n` + result.failed.map(item => `${item.name}：${item.message}`).join('\n')
          try { await refresh() } catch {
            this.cleanupCatalog = null
            this.cleanupSelection.clear()
            this.cleanupMessage += '\n列表刷新失败，请重新读取远端歌单。'
          }
        }
      } catch (err) { this.cleanupMessage = err.message || '清理失败，请重新读取远端歌单' }
      finally {
        this.busy = false
        container.querySelectorAll('button').forEach(button => { button.disabled = false })
        this.renderCleanup(container)
      }
    },
    async connectionAction(action, container, index) {
      if (this.busy) return
      const read = id => container.querySelector('#navidrome-' + id).value
      const message = container.querySelector('#navidrome-connection-message')
      const body = action === 'sync' ? {} : action === 'bind'
        ? { id: this.playlists[index].id, playlistId: read('bind-' + index) }
        : { url: read('url'), username: read('user'), password: read('password'), pathPrefix: read('prefix'), enabled: container.querySelector('#navidrome-enabled').checked }
      this.busy = true
      container.querySelectorAll('button').forEach(button => { button.disabled = true })
      message.textContent = action === 'sync' ? '正在同步，请稍候…' : '正在处理…'
      try {
        const result = await window.SubscriptionManager._api('/navidrome/' + action, 'POST', body)
        if (action !== 'test') {
          const [config, playlists] = await Promise.all([window.SubscriptionManager._api('/navidrome/settings'), window.SubscriptionManager._api('/navidrome/playlists')])
          this.settings = config.data || {}; this.statuses = config.statuses || {}; this.playlists = playlists.data || []
          this.resetCleanup()
          this.render(container)
        }
        const hasErrors = this.settings.lastError || Object.values(this.statuses).some(status => status.lastError)
        container.querySelector('#navidrome-connection-message').textContent = action === 'test' ? result.data.message
          : action === 'sync' ? (hasErrors ? '同步检查完成，部分歌单等待扫描或发生错误，详见下方状态。' : '同步完成。')
            : action === 'bind' ? '绑定已保存，后续同步更新此歌单。' : '连接配置已保存。'
      } catch (err) { message.textContent = err.message || '操作失败' }
      finally { this.busy = false; container.querySelectorAll('button').forEach(button => { button.disabled = false }); this.renderCleanup(container) }
    },
    async save(form, container) {
      if (this.busy) return
      const playlist = this.playlists[Number(form.dataset.playlistIndex)]
      if (!playlist) return
      const input = form.querySelector('input')
      const button = form.querySelector('button')
      const error = form.querySelector('[data-error]')
      const name = input.value.trim()
      if (!name) { error.textContent = '请输入歌单名称'; input.focus(); return }
      this.busy = true
      button.disabled = true
      button.textContent = '正在保存…'
      error.textContent = ''
      container.querySelector('#navidrome-status').textContent = ''
      try {
        const result = await window.SubscriptionManager._api('/navidrome/playlists/rename', 'POST', { id: playlist.id, name })
        const drafts = Array.from(container.querySelectorAll('form[data-playlist-index]')).map(row => ({ index: row.dataset.playlistIndex, value: row.querySelector('input').value }))
        this.playlists = this.playlists.map(item => item.id === playlist.id ? result.data : item)
        this.resetCleanup()
        this.render(container)
        for (const draft of drafts) {
          if (Number(draft.index) === Number(form.dataset.playlistIndex)) continue
          container.querySelector(`#navidrome-name-${Number(draft.index)}`).value = draft.value
        }
        container.querySelector('#navidrome-status').textContent = `已保存为「${result.data.name}」，后续同步使用新目录。`
        window.SubscriptionManager.loaded = false
      } catch (err) {
        error.textContent = err.message || '保存失败'
      } finally {
        this.busy = false
        button.disabled = false
        button.textContent = '保存名称'
        this.renderCleanup(container)
      }
    }
  }
  window.NavidromeManager = manager
})()
