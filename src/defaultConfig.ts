
const config: LX.Config = {
  'proxy.enabled': false, // 是否使用代理转发请求到本服务器
  'proxy.header': 'x-real-ip', // 代理转发的请求头 原始IP
  bindIP: '0.0.0.0', // 绑定IP
  port: 9527, // 端口
  'user.enableCacheSizeLimit': false, // 是否启用服务器缓存目录容量限制
  'user.cacheSizeLimit': 2000, // 服务器缓存目录容量限制 (MB)

  // Web 单 Token 访问配置
  'player.token': '123456',

  // 代理配置
  'proxy.all.enabled': false,
  'proxy.all.address': '',

  // 访问路径配置
  'player.path': '/', // 播放器路径
  'singer.sourcePriority': ['tx', 'wy'], // 歌手信息源优先级
  'artist.maxFetchPages': 20, // 歌手歌曲最大抓取页数
  'cache.namingPattern': 'simple', // 缓存命名规则
  downloadDir: 'download', // 纯下载模式保存目录（相对路径以程序目录为基准）
  'system.allowUnsafeVM': false, // 是否允许运行 VM 模式自定义源脚本
}

export default config
