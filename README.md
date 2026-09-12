# lx-download

`lx-download` 是一个仅提供 Web 端的自托管音乐服务，支持音乐搜索、歌单浏览、独立音源管理、歌单订阅和服务端下载。

[项目仓库](https://github.com/yzfh-ty/lx-download) · [更新日志](changelog.md) · [English](README_EN.md) · [问题反馈](https://github.com/yzfh-ty/lx-download/issues)

## 当前项目提供什么

Web 端当前以“搜索、下载和管理”为核心，适合部署在个人电脑、家庭服务器或 Docker 环境中：

- 音乐搜索与管理：支持歌曲、歌手、专辑、网络歌单和排行榜浏览。
- 音源管理：通过独立的“音源管理”页面导入、启用、禁用、排序和删除自定义源脚本。
- 多音源搜索与解析：支持失败时自动切换可用音源。
- 服务端下载：支持单曲/批量下载、音质选择、下载队列、暂停/恢复、并发控制和任务恢复。
- 歌单订阅：通过独立的“订阅歌单”页面管理订阅；服务端定时检查新增歌曲并加入下载队列，不需要保持浏览器开启。
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
docker compose up -d --build
```

启动后访问：

- Web 管理界面：`http://服务器地址:9527/`
默认 Web 访问 Token 为 `123456`，首次启动后请立即修改。生产环境建议通过环境变量设置 Token，并不要把包含 Token 的配置文件提交到 Git。

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
| `WEBPLAYER_TOKEN` | `123456` | Web 界面访问 Token |
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
