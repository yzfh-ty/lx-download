# lx-download

`lx-download` 是一个仅提供 Web 端的自托管音乐服务，支持音乐搜索、歌单浏览、独立音源管理、歌单订阅和服务端下载。

[项目仓库](https://github.com/yzfh-ty/lx-download) · [更新日志](changelog.md) · [English](README_EN.md) · [问题反馈](https://github.com/yzfh-ty/lx-download/issues)

## 当前项目提供什么

Web 端当前以“搜索、下载和管理”为核心，适合部署在个人电脑、家庭服务器或 Docker 环境中：

- 音乐搜索与管理：支持歌曲、歌手、专辑、网络歌单和排行榜浏览。
- 音源管理：通过独立的“音源管理”页面导入、启用、禁用、排序和删除自定义源脚本。
- 多音源搜索与解析：支持失败时自动切换可用音源。
- 服务端下载：支持单曲/批量下载、音质选择、下载队列、暂停/恢复、并发控制和任务恢复。
- 歌单订阅：服务端自动下载歌单/排行榜，按远端顺序生成独立目录和 M3U8，供 Navidrome 扫描导入，不需要保持浏览器开启。
- 音质选择：支持标准音质、高音质、无损音质和 `24bit无损`，解析失败时按规则自动降级。
- 设置同步：系统设置修改后实时保存到服务器，刷新或更换浏览器时从服务器读取配置。
- 缓存与文件管理：支持服务器缓存、独立歌词文件、独立下载目录、缓存命名格式、缓存空间限制和 LRU 清理。
- 音乐文件处理：支持本地音乐扫描、元数据/封面/歌词补全、歌词嵌入以及本地音乐洗版。
- 多种服务端部署：支持 Node.js 和 Docker，Web 界面可直接通过浏览器访问。
- 移动端适配：Web 界面可直接通过手机浏览器访问。

> 说明：本项目的核心用途是订阅网络歌单并自动下载新增歌曲，实际结果取决于音源和网络环境。

## 快速开始

### Docker Compose（推荐）

仓库中的 `docker-compose.yml` 使用当前 Dockerfile 本地构建镜像，并分别持久化数据库、缓存、下载文件和日志：

```bash
git clone https://github.com/yzfh-ty/lx-download.git
cd lx-download
# 编辑 docker-compose.yml，至少替换 WEBPLAYER_TOKEN 占位符
docker compose pull
docker compose up -d
```

如需使用 `.env` 管理配置，可改用环境变量版模板：

```bash
cp .env.example .env
# 编辑 .env，至少替换 WEBPLAYER_TOKEN
docker compose -f docker-compose.env.yml pull
docker compose -f docker-compose.env.yml up -d
```

启动后访问：

- Web 管理界面：`http://服务器地址:9527/`
使用主模板时，请将 `docker-compose.yml` 中的 `WEBPLAYER_TOKEN` 占位符替换为随机且足够长的值；使用环境变量版时，在 `.env` 中设置。请不要把包含真实 Token 的 `.env` 或配置文件提交到 Git。

Compose 默认将 `./data`、`./cache`、`./download` 和 `./logs` 分别挂载到容器。`data/` 只保存 SQLite 数据库和自定义音源；所有服务器缓存统一位于程序目录的 `cache/`，下载歌曲位于 `download/`。

### 直接运行源码

环境要求：Node.js `>=22.5.0`，npm `>=8.5.2`。项目使用 Node.js 内置 SQLite，无需额外数据库服务。

```bash
git clone https://github.com/yzfh-ty/lx-download.git
cd lx-download
npm ci
npm run build
npm start
```

开发模式：

```bash
npm run dev
```

如果使用 PM2，可执行：

```bash
npm run prd
```

## Navidrome 歌单自动同步

订阅歌单或排行榜后，服务端在下载目录下创建 `<订阅名>（<平台>）/<订阅名>（<平台>）.m3u8`，例如 `每日推荐（网易云）/每日推荐（网易云）.m3u8`。平台标识包含网易云、QQ音乐、酷狗、酷我和咪咕，同平台重名时继续增加稳定后缀。超长名称会保留平台标识，旧版自动名称会在目录空闲时安全迁移；手动设置的名称保持不变。只有已完成音频下载和元数据处理的本地歌曲才会写入；每次远端检查会更新歌曲顺序，下载完成后会自动补入新歌曲。订阅页面显示文件相对路径、累计发现/入队数量、当前本地可用/已写入数量，并提供“重新生成 M3U8”。“等待 Navidrome 扫描”表示本地文件已准备好，不表示 Navidrome 已确认导入。

未匹配任何订阅的本地歌曲会自动收录到 `未匹配/未匹配.m3u8`，没有网络订阅时也会生成。它通过相对路径引用原音频，不移动或复制音乐；同一歌曲的 ID、歌名与歌手、下载回退别名及已知歌单副本会合并去重。匹配范围包含暂停订阅的最近一次完整列表。新增订阅、远端更新、取消订阅、下载完成或本地扫描后会重新计算，每分钟也会刷新本地索引；匹配上的歌曲会从此 M3U8 移除，文件仍保留。订阅页面展示数量、文件路径和同步错误，并支持手动重新生成。同名用户目录会避让，不覆盖现有文件。

订阅中的歌曲会直接下载到对应歌单目录；普通下载仍使用下载根目录。同一首歌属于多个订阅时，先下载一份，其他歌单目录优先硬链接已有音频，文件系统不支持时复制；歌词单独复制。硬链接共享音频内容，修改其中一份的标签也会影响其他硬链接。取消订阅会保留整个目录和当前 M3U8；远端删歌只移除 M3U8 条目，不删除音频或歌词。暂停订阅会暂停远端更新和 M3U8 自动刷新，已进入下载队列的任务仍由下载页面管理。

在侧栏的 **Navidrome 设置** 页面可修改各订阅生成的歌单名称，也可修改“未匹配”的名称。保存会直接重命名文件夹和同名 M3U8，并更新本地文件索引；远端订阅名称独立保留。下载队列在执行时读取最新目录，所以等待中、恢复及重启后的订阅任务都会使用改名后的目录。目录正在下载或写入标签时需等待当前任务结束再改名；同名冲突和不安全的名称会显示错误，不覆盖文件。Navidrome 下一次扫描后读取新的歌单文件。

名字中的非法字符会被清理，同名目录会加稳定后缀。单独修改订阅名称会重命名目录和 M3U8，遇到已有目录会拒绝覆盖；同平台更换远端歌单时保留原目录；跨平台更换时，自动名称同步更新平台标识，手动名称保持不变。目录内的 `.lx-playlist.json` 用于识别归属，请保留。旧订阅会在启动后补取完整列表并生成文件，网络失败时保留原有数据；服务端每分钟检查本地文件是否仍存在。自动生成的 M3U8 会覆盖手工编辑内容。

将两个服务挂载到同一份下载目录，例如向现有 Compose 配置添加 Navidrome 服务：

```yaml
services:
  navidrome:
    image: deluan/navidrome:latest
    ports:
      - "4533:4533"
    volumes:
      - ./download:/music:ro
      - ./navidrome-data:/data
    environment:
      ND_MUSICFOLDER: /music
      ND_AUTOIMPORTPLAYLISTS: "true"
      ND_SCANNER_SCHEDULE: "@every 5m"
```

请先完成 Navidrome 管理员初始化，再扫描音乐库。如果设置了 `ND_PLAYLISTSPATH`，需要覆盖这些歌单子目录；保持默认空值即可搜索整个音乐库。自动导入与扫描配置见 [Navidrome 官方配置文档](https://www.navidrome.org/docs/usage/configuration/options/)。lx-download 不需要 Navidrome 账号，也不会修改它的数据库。

隔离回归验证：`npm run test:playlist-sync`。测试使用临时下载目录和内存数据库，不访问现有音乐或 SQLite。Navidrome 实际导入结果仍需在部署环境扫描验证。

## 配置 Web Token

Web 仅使用一个全局访问 Token，不区分用户或客户端；歌单、订阅、下载队列和索引均使用共享数据空间，并在服务端后台运行。

登录成功后使用 HttpOnly Cookie 维持会话，Cookie 固定 24 小时有效；服务重启后内存会话清空，需要重新登录。

导入歌单记录、设置、订阅、下载队列和缓存去重索引保存在 `DATA_PATH/lxserver.sqlite`。音频、独立歌词、封面和自定义源脚本仍以文件形式保存，SQLite 只负责结构化数据和文件索引，不把媒体文件塞进数据库。

## 配置

服务启动时会按以下顺序加载配置，优先级从高到低为：

1. 进程环境变量。
2. `CONFIG_PATH` 指定的配置文件。
3. 程序目录下的 `config.js`。
4. `src/defaultConfig.ts` 中的默认值。

服务启动后会生成或更新 `config.js`，并监控配置文件变化。配置文件通常不需要手动创建；如使用 Docker，推荐通过 `environment` 设置部署相关参数。

### 常用环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9527` | HTTP 服务端口 |
| `BIND_IP` | `0.0.0.0` | 监听地址 |
| `CONFIG_PATH` | 未设置 | 外部配置文件的绝对路径 |
| `DATA_PATH` | `./data` | 数据目录，包含 SQLite 数据库和自定义音源 |
| `LOG_PATH` | `./logs` | 日志目录；Docker 默认位于 `/server/logs` |
| `PLAYER_PATH` | `/` | Web 界面访问路径 |
| `WEBPLAYER_TOKEN` | 必填，无默认值 | Web 界面访问 Token |
| `ENABLE_CACHE_SIZE_LIMIT` | `false` | 是否启用服务器缓存目录容量限制（不清理下载目录） |
| `CACHE_SIZE_LIMIT` | `2000` | 服务器缓存目录容量上限，单位 MB |
| `PROXY_HEADER` | `x-real-ip` | 反向代理传递真实 IP 时使用的 Header |
| `PROXY_ALL_ENABLED` | `false` | 是否代理服务端发出的外部请求 |
| `PROXY_ALL_ADDRESS` | 未设置 | HTTP 或 SOCKS5 代理地址 |
| `SINGER_SOURCE_PRIORITY` | `tx,wy` | 歌手信息源优先级 |

### 配置文件中的高级选项

以下选项通常通过 `config.js` 或 Web 设置管理：

```js
module.exports = {
  // 歌手信息抓取和缓存命名
  'artist.maxFetchPages': 20,
  'cache.namingPattern': 'simple', // simple 或 standard

  // 纯下载模式目录，默认为程序目录下的 download
  downloadDir: 'download',

  // 默认关闭；只有确认自定义源脚本可信时才建议开启
  'system.allowUnsafeVM': false,
}
```

`system.allowUnsafeVM` 会允许运行 VM 模式的自定义源脚本，存在执行不可信脚本的安全风险，请仅在可信环境中启用。

## 反向代理

如果通过 Nginx 等反向代理对外提供服务，只需转发普通 HTTP 请求：

```nginx
server {
    listen 80;
    server_name music.example.com;

    location / {
        proxy_pass http://127.0.0.1:9527;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

如需让服务读取真实客户端 IP，可设置：

```bash
PROXY_HEADER=x-real-ip
```

## 项目结构

```text
src/
├─ server/       HTTP、下载、缓存、订阅和自定义源服务
├─ storage/      SQLite 数据库和共享持久化
├─ modules/      屏蔽规则和音乐处理模块
├─ common/       音乐元数据、歌词、下载等公共工具
└─ defaultConfig.ts
public/music/    Web 音乐管理界面
```

## 参考项目

本项目开发过程中参考了以下项目的实现思路与相关资料：

- [LX Music Desktop](https://github.com/lyswhut/lx-music-desktop)
- [lxserver](https://github.com/XCQ0607/lxserver)


## 许可证与版权

本项目采用 Apache License 2.0，完整协议见根目录 [LICENSE](LICENSE)。

参考项目的许可证与版权信息：

- [LX Music Desktop License](https://github.com/lyswhut/lx-music-desktop/blob/master/LICENSE)
- [lxserver License](https://github.com/XCQ0607/lxserver/blob/main/LICENSE)
