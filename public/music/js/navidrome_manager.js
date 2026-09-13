(function () {
  'use strict'
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const manager = {
    playlists: [],
    busy: false,
    async load() {
      if (this.busy) return
      const container = document.getElementById('navidrome-page')
      if (!container) return
      this.busy = true
      container.setAttribute('aria-busy', 'true')
      container.innerHTML = '<p class="text-sm t-text-muted p-4" role="status">正在加载歌单…</p>'
      try {
        const result = await window.SubscriptionManager._api('/navidrome/playlists')
        this.playlists = Array.isArray(result.data) ? result.data : []
        this.render(container)
      } catch (err) {
        container.innerHTML = `<p class="text-sm text-red-500 p-4" role="alert">加载失败：${escape(err.message)}</p><button type="button" class="min-h-[44px] px-4 t-text-main border t-border-main rounded-xl">重试</button>`
        container.querySelector('button').addEventListener('click', () => this.load())
      } finally {
        this.busy = false
        container.setAttribute('aria-busy', 'false')
      }
    },
    render(container) {
      container.innerHTML = `
        <section class="t-bg-panel border t-border-main rounded-2xl p-4 md:p-6 space-y-4">
          <p class="text-sm t-text-muted leading-relaxed">保存名称后，会同时重命名歌单文件夹和 M3U8 文件。后续订阅下载会使用新的文件夹，多个歌单共享的歌曲会自动复用。Navidrome 扫描音乐库后生效。</p>
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
              <p class="text-sm t-text-muted break-all">歌单文件：${escape(playlist.playlistPath || '等待创建')}</p>
              <p class="text-sm text-red-500 break-words" role="alert" data-error>${escape(playlist.playlistLastError || '')}</p>
            </form>`).join('') || '<p class="text-sm t-text-muted">暂无自动生成的歌单。</p>'}</div>
        </section>`
      container.querySelectorAll('form').forEach(form => {
        form.addEventListener('submit', event => { event.preventDefault(); void this.save(form, container) })
      })
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
        const drafts = Array.from(container.querySelectorAll('form')).map(row => ({ index: row.dataset.playlistIndex, value: row.querySelector('input').value }))
        this.playlists = this.playlists.map(item => item.id === playlist.id ? result.data : item)
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
      }
    }
  }
  window.NavidromeManager = manager
})()
