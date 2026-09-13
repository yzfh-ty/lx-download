declare namespace LX {
  type AddMusicLocationType = 'top' | 'bottom'

  interface Config {
    /**
     * 是否使用代理转发请求到本服务器
     */
    'proxy.enabled': boolean

    /**
     * 代理转发的请求头 原始IP
     */
    'proxy.header': string

    /**
     * 绑定IP
     */
    bindIP: string

    /**
     * 端口
     */
    port: number

    /**
     * 是否启用服务器缓存目录容量限制
     */
    'user.enableCacheSizeLimit'?: boolean
    /**
     * 服务器缓存目录容量限制 (MB)
     */
    'user.cacheSizeLimit'?: number

    /**
     * Web single access token
     */
    'player.token'?: string

    /**
     * 是否启用针对所有外发请求的代理 (目前主要用于 Music SDK)
     */
    'proxy.all.enabled'?: boolean

    /**
     * 代理地址 (支持 http:// 或 socks5://)
     */
    'proxy.all.address'?: string

    /**
     */
    'player.path'?: string

    /**
     * 歌手信息源优先级
     */
    'singer.sourcePriority': Array<'tx' | 'wy'>
    /**
     * 歌手歌曲最大抓取页数
     */
    'artist.maxFetchPages'?: number
    /**
     * 缓存命名规则
     */
    'cache.namingPattern'?: string
    /** 纯下载模式保存目录；默认使用程序目录下的 download */
    downloadDir?: string
    /**
     * 是否允许运行 VM 模式自定义源脚本
     */
    'system.allowUnsafeVM'?: boolean
  }
}
