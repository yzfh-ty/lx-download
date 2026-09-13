# lx-download

`lx-download` 是一个仅提供 Web 端的自托管音乐服务，支持音乐搜索、歌单浏览、独立音源管理、歌单订阅和服务端下载。

[项目仓库](https://github.com/yzfh-ty/lx-download) · [问题反馈](https://github.com/yzfh-ty/lx-download/issues)

## 当前项目提供什么

Web 端当前以“搜索、下载和管理”为核心，适合部署在个人电脑、家庭服务器或 Docker 环境中：

- 音乐搜索与管理：支持歌曲、歌手、专辑、网络歌单和排行榜浏览。
- 音源管理：通过独立的“音源管理”页面导入、启用、禁用、排序和删除自定义源脚本。
- 多音源搜索与解析：支持失败时自动切换可用音源。
- 服务端下载：支持单曲/批量下载、音质选择、下载队列、暂停/恢复、并发控制和任务恢复。
- 歌单订阅：服务端自动下载歌单/排行榜，按远端顺序维护独立目录和清单，不需要保持浏览器开启。
- Navidrome 集成：支持固定歌单 ID 的 API 同步、真实路径诊断和旧歌单清理，也保留 M3U8 文件导入模式。
- 音质选择：支持标准音质、高音质、无损音质和 `24bit无损`，解析失败时按规则自动降级。
- 设置同步：系统设置修改后实时保存到服务器，刷新或更换浏览器时从服务器读取配置。
- 缓存与文件管理：支持服务器缓存、独立歌词文件、独立下载目录、缓存命名格式、缓存空间限制和 LRU 清理。
- 音乐文件处理：支持本地音乐扫描、元数据/封面/歌词补全、歌词嵌入以及本地音乐洗版。
- 多种服务端部署：支持 Node.js 和 Docker，Web 界面可直接通过浏览器访问。
- 移动端适配：Web 界面可直接通过手机浏览器访问。

> 说明：本项目的核心用途是订阅网络歌单并自动下载新增歌曲，实际结果取决于音源和网络环境。

## 快速开始

### Docker Compose（推荐）

仓库中的 `docker-compose.yml` 从当前源码构建镜像，并分别持久化数据库、缓存、下载文件和日志：

```bash
git clone https://github.com/yzfh-ty/lx-download.git
cd lx-download
# 编辑 docker-compose.yml，至少替换 WEBPLAYER_TOKEN 占位符
docker compose up -d --build
```

如需使用 `.env` 管理配置，可改用环境变量版模板：

```bash
cp .env.example .env
# 编辑 .env，至少替换 WEBPLAYER_TOKEN
docker compose -f docker-compose.env.yml up -d --build
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

推荐在侧栏 **Navidrome 设置** 中使用固定歌单 ID 的 API 同步，避免目录或歌单文件改名后被重复导入：

1. 填写 Navidrome 地址、拥有歌单的账号及密码，点击“测试连接”。程序不保存密码原文，只在服务器 SQLite 中保存认证用的 token/salt；接口不向浏览器返回这些认证值。
2. 在 Navidrome 的播放器设置中找到当前账号的 `lx-download` 播放器，启用“报告真实路径”（Report real path）。默认情况下，Navidrome 的 Subsonic API 会根据歌手、专辑和歌名生成虚拟路径，即使歌曲已经扫描也无法据此匹配实际文件。参见 [Navidrome 路径生成逻辑](https://github.com/navidrome/navidrome/blob/v0.64.0/server/subsonic/helpers.go#L227)。
3. 设置下载目录在 **Navidrome 容器中**的真实路径前缀。若下载目录挂载为 `/music`，填写 `/music`；若挂载到 `/music/download`，填写 `/music/download`。LX 容器内的 `/server/download` 和宿主机路径不用于此字段。匹配使用真实文件路径，不根据歌名猜测；旧版本的 `music` 等不带开头斜杠的前缀仍兼容。
4. 如需沿用已有歌单，可先保存连接配置，再在对应歌单下填写 Navidrome 歌单 ID 并绑定。只能绑定当前账号拥有的可编辑歌单；文件导入歌单应先在 Navidrome 解除文件同步。绑定后该歌单名称和内容由 lx-download 维护。
5. 勾选“启用固定歌单 ID 的 API 同步”并保存。后台每分钟同步，下载完成和本地变更也会触发同步；可点击“立即同步”查看结果。

两端挂载同一个宿主机目录时，路径填写示例：

| lx-download 挂载 | Navidrome 挂载 | lx-download 中填写的路径前缀 |
| --- | --- | --- |
| `./download:/server/download` | `./download:/music:ro` | `/music` |
| `./download:/server/download` | `./download:/music/download:ro` | `/music/download` |

以上两种情况都需要为 `lx-download` 播放器开启 **Report real path**。Navidrome 的只读音乐目录挂载与 API 歌单同步兼容。

启用后，每个本地歌单与远端 ID 的对应关系会持久保存。改名、增删歌曲、调整顺序和服务重启都复用同一个 ID。路径未匹配时会保留已有远端歌曲，并显示本地文件、当前查找路径和接口路径示例；这可能是路径设置问题，也可能是扫描尚未完成。接口返回虚拟路径时会明确提示开启“报告真实路径”，连接测试也会检查此项。真正的空歌单会清空远端条目。暂停订阅会停止该歌单的 API 同步，取消订阅会保留远端歌单和音乐。切换服务器或账号时，绑定关系按连接分别保存。

为避免双重导入，启用 API 后，本程序管理的 M3U8 会保留为 `.m3u8.lx-export` 导出清单，Navidrome 不再把这些文件作为 M3U8 导入。暂停 API 同步不会恢复旧的 M3U8 文件模式。建议同时设置 `ND_AUTOIMPORTPLAYLISTS=false`，避免音乐库内的历史遗留文件继续导入。

清理历史重复记录时，在 **Navidrome 设置 → 清理旧歌单** 点击“读取远端歌单”，核对名称、ID 和歌曲数，勾选旧记录后确认删除。每次最多选择 100 个，仅删除当前连接账号拥有的所选歌单；音乐文件和本地清单保留。已绑定或创建结果待确认的歌单不能删除。同名只作为核对提示，不会自动删除所有同名记录。切换账号后需重新读取列表；部分删除失败会逐项显示原因，可刷新后重试。

若连接中断或认证失效，本批次会停止继续删除，尚未执行的记录也会显示在失败结果中。重新读取列表后再选择需要重试的记录。

| 常见情况 | 处理方式 |
| --- | --- |
| Navidrome 中能搜索到歌曲，但同步全部未匹配 | 为当前账号的 `lx-download` 播放器开启真实路径，再按上述挂载示例填写路径前缀 |
| 本地清单后缀是 `.m3u8.lx-export` | 这是 API 模式的正常导出文件；远端歌单通过 API 更新 |
| 绑定成功后仍有历史重复歌单 | 使用“清理旧歌单”选择删除多余的远端记录 |
| 删除旧歌单后又出现 | 检查历史 M3U8 是否仍在被自动导入；API 模式下将 Navidrome 的 `ND_AUTOIMPORTPLAYLISTS` 设为 `false` |

首次创建若遇到响应丢失，程序会查找具有唯一临时名称的远端歌单并恢复 ID；若仍无法确认结果，则停止重复创建并提示绑定现有 ID。远端歌单被删除时也不会擅自新建，需绑定正确的歌单。API 回归测试运行 `npm run test:navidrome`，使用隔离的本地模拟服务，不接触真实 Navidrome。

需要排查现有容器的路径匹配时，将 [scripts/diagnose-navidrome.cjs](scripts/diagnose-navidrome.cjs) 复制到 Docker 主机的当前目录，然后运行：

```bash
docker exec -i lx-download-server node < diagnose-navidrome.cjs
```

脚本以只读方式读取已保存的连接配置，并使用与同步程序相同的 `lx-download` 客户端标识，输出本地路径、接口路径、服务器版本和扫描状态；不输出认证值。最多读取前 500 首歌曲，因此样本中的匹配数量不代表完整音乐库的匹配数量。

文件导入模式下，订阅歌单或排行榜后，服务端在下载目录下创建 `<订阅名>（<平台>）/<订阅名>（<平台>）.m3u8`，例如 `每日推荐（网易云）/每日推荐（网易云）.m3u8`。平台标识包含网易云、QQ音乐、酷狗、酷我和咪咕，同平台重名时继续增加稳定后缀。超长名称会保留平台标识，旧版自动名称会在目录空闲时安全迁移；手动设置的名称保持不变。只有已完成音频下载和元数据处理的本地歌曲才会写入；每次远端检查会更新歌曲顺序，下载完成后会自动补入新歌曲。订阅页面显示文件相对路径、累计发现/入队数量、当前本地可用/已写入数量，并提供“重新生成 M3U8”。清单已生成只表示本地文件准备完成，实际导入结果需在 Navidrome 中确认。

未匹配任何订阅的本地歌曲会自动收录到 `未匹配/未匹配.m3u8`，没有网络订阅时也会生成。它通过相对路径引用原音频，不移动或复制音乐；同一歌曲的 ID、歌名与歌手、下载回退别名及已知歌单副本会合并去重。匹配范围包含暂停订阅的最近一次完整列表。新增订阅、远端更新、取消订阅、下载完成或本地扫描后会重新计算，每分钟也会刷新本地索引；匹配上的歌曲会从此 M3U8 移除，文件仍保留。订阅页面展示数量、文件路径和同步错误，并支持手动重新生成。同名用户目录会避让，不覆盖现有文件。

订阅中的歌曲会直接下载到对应歌单目录；普通下载仍使用下载根目录。同一首歌属于多个订阅时，先下载一份，其他歌单目录优先硬链接已有音频，文件系统不支持时复制；歌词单独复制。硬链接共享音频内容，修改其中一份的标签也会影响其他硬链接。取消订阅会保留整个目录和当前 M3U8；远端删歌只移除 M3U8 条目，不删除音频或歌词。暂停订阅会暂停远端更新和 M3U8 自动刷新，已进入下载队列的任务仍由下载页面管理。

在侧栏的 **Navidrome 设置** 页面可修改各订阅生成的歌单名称，也可修改“未匹配”的名称。保存会直接重命名文件夹和同名 M3U8，并更新本地文件索引；远端订阅名称独立保留。下载队列在执行时读取最新目录，所以等待中、恢复及重启后的订阅任务都会使用改名后的目录。目录正在下载或写入标签时需等待当前任务结束再改名；同名冲突和不安全的名称会显示错误，不覆盖文件。文件导入模式通过扫描生效；API 模式通过原有歌单 ID 更新名称，不会因文件夹改名而新建歌单。

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
      ND_AUTOIMPORTPLAYLISTS: "false"
      ND_SCANNER_SCHEDULE: "@every 5m"
```

请先完成 Navidrome 管理员初始化，再扫描音乐库。上面的配置适用于 API 同步；如果继续使用旧的 M3U8 文件导入模式，需将 `ND_AUTOIMPORTPLAYLISTS` 改为 `true`，并让 `ND_PLAYLISTSPATH` 覆盖相应目录。自动导入与扫描配置见 [Navidrome 官方配置文档](https://www.navidrome.org/docs/usage/configuration/options/)。API 同步需要 Navidrome 账号，通过 Subsonic 接口操作歌单，不直接访问 Navidrome 数据库文件。

隔离回归验证：`npm run test:playlist-sync`。测试使用临时下载目录和内存数据库，不访问现有音乐或 SQLite。Navidrome 实际导入结果仍需在部署环境扫描验证。

## 配置 Web Token

Web 仅使用一个全局访问 Token，不区分用户或客户端；歌单、订阅、下载队列和索引均使用共享数据空间，并在服务端后台运行。

登录成功后使用 HttpOnly Cookie 维持会话，Cookie 固定 24 小时有效；服务重启后内存会话清空，需要重新登录。

导入歌单记录、设置、订阅、下载队列和缓存去重索引保存在 `DATA_PATH/lx-download.sqlite`。音频、独立歌词、封面和自定义源脚本仍以文件形式保存，SQLite 只负责结构化数据和文件索引，不把媒体文件塞进数据库。

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

## Docker 内存排查

出现持续增长时，先记录容器和主进程的占用：

```bash
docker stats --no-stream lx-download-server
docker exec lx-download-server cat /proc/1/status
docker exec lx-download-server cat /sys/fs/cgroup/memory.stat
```

`VmRSS` 是主进程常驻内存；`RssAnon` 和 cgroup 的 `anon` 可帮助区分进程内存与文件缓存。`CACHE_SIZE_LIMIT` 管理的是磁盘缓存容量，不能限制 Node 进程内存。

需要区分 JavaScript 堆、Buffer 和原生内存时，将 [scripts/diagnose-memory.cjs](scripts/diagnose-memory.cjs) 复制到 Docker 主机的当前目录，然后运行：

```bash
docker exec -i lx-download-server node < diagnose-memory.cjs
```

脚本读取容器内正在运行的 PID 1，输出以 MiB 为单位的 `rss`、`heapUsed`、`external` 和 `arrayBuffers`，以及 VM 上下文和活动资源数量。它临时启用容器内部的回环调试接口，采样后关闭自己开启的接口；已有调试接口会保留。输出不包含音源内容、访问 Token 或歌曲数据。`arrayBuffers` 已包含在 `external` 中，不能重复相加。可间隔几分钟采样，比较哪些指标持续增长。

封面内存回归验证：`npm run test:memory`，使用临时 MP3 和 1 MiB 内嵌封面重复读取 400 次。音源资源清理回归验证：`npm run test:resources`。

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
