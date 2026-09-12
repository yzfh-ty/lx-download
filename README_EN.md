# lx-download

`lx-download` is a self-hosted Web music service for searching music, browsing playlists, managing custom sources, subscribing to network playlists, and downloading songs on the server.

[Repository](https://github.com/yzfh-ty/lx-download) · [中文文档](README.md) · [Changelog](changelog.md) · [Issues](https://github.com/yzfh-ty/lx-download/issues)

## Features

- Music search: search songs, artists, albums, network playlists, and charts.
- Custom source management: import, enable, disable, reorder, and remove source scripts from the standalone **Source Management** page.
- Playlist subscriptions: manage subscriptions from the standalone **Playlist Subscriptions** page; the server periodically checks for new songs and adds them to the download queue without keeping the browser open.
- Server-side downloads: single/batch downloads, download queue, pause/resume, concurrency limits, task recovery, and automatic source fallback.
- Quality selection: standard, high, lossless, and `24-bit lossless` quality. The resolver can automatically fall back when a requested quality is unavailable.
- Local music and cache management: scan local files, manage server cache, save standalone LRC files, embed metadata/cover/lyrics, and use a dedicated download directory.
- Real-time settings sync: settings changes are written to the server and loaded from the server on refresh or when using another browser.
- Web UI: search, playlists, charts, imported playlists, subscriptions, source management, local music, downloads, system settings, display settings, and logs.

## Quick Start

### Docker Compose

```bash
git clone https://github.com/yzfh-ty/lx-download.git
cd lx-download
docker compose up -d --build
```

Open `http://server-address:9527/` after startup. The default Web access Token is `123456`; change it before exposing the service.

### Run from source

Requirements: Node.js `>=22.5.0` and npm `>=8.5.2`.

```bash
git clone https://github.com/yzfh-ty/lx-download.git
cd lx-download
npm ci
npm run build
npm start
```

Use `npm run dev` during development.

## Authentication

The Web interface uses one shared access Token. After successful login, the server issues an HttpOnly Cookie named `lx_auth_token`.

- The Cookie expires after 24 hours.
- Restarting the service clears in-memory sessions and requires login again.
- Playlist data, subscriptions, settings, download queues, and cache indexes use the shared server data space.

## Configuration

Environment variables take precedence over `CONFIG_PATH`, `config.js`, and built-in defaults.

| Environment variable | Default | Description |
| --- | --- | --- |
| `PORT` | `9527` | HTTP service port |
| `BIND_IP` | `0.0.0.0` | Listening address |
| `CONFIG_PATH` | unset | Absolute path to an external config file |
| `DATA_PATH` | `./data` | SQLite database and custom source directory |
| `LOG_PATH` | `./logs` | Log directory |
| `PLAYER_PATH` | `/` | Web interface path |
| `WEBPLAYER_TOKEN` | `123456` | Web access Token |
| `ENABLE_CACHE_SIZE_LIMIT` | `false` | Limit server cache directory size |
| `CACHE_SIZE_LIMIT` | `2000` | Server cache limit in MB |
| `PROXY_HEADER` | `x-real-ip` | Reverse-proxy client IP header |
| `PROXY_ALL_ENABLED` | `false` | Proxy outgoing server requests |
| `PROXY_ALL_ADDRESS` | unset | HTTP or SOCKS5 proxy address |
| `SINGER_SOURCE_PRIORITY` | `tx,wy` | Artist information source priority |

Settings changed in the Web interface are synchronized to the server in real time. Media files remain on disk; structured data is stored in `DATA_PATH/lxserver.sqlite`.

## Project Structure

```text
src/
├─ server/       HTTP, download, cache, subscription, and source services
├─ storage/      SQLite persistence
├─ modules/      Music source and processing modules
├─ common/       Shared music, lyrics, and download utilities
└─ defaultConfig.ts
public/music/    Web management interface
```

## License

This project is released under the Apache License 2.0.
