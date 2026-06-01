# web-music — 网页版私人 FM

一个自托管的网页音乐播放器：Node 后端复用 [lx-music](https://github.com/lyswhut/lx-music-desktop) 的音源脚本与 musicSdk 取链/搜索，前端是网易云风格的单页界面。浏览器打开即可搜索、播放在线音乐，支持多用户、收藏、歌单、歌词。可一键部署到 Ubuntu/Debian，并通过 Cloudflare Tunnel 暴露到外网。

> ⚠️ **仅供个人自用 / 学习研究**。音源来自第三方公开脚本（见下方[音源说明](#音源说明与致谢)），稳定性随第三方服务波动，请勿公开运营或商用。

## 功能特性

- 🔎 **多平台搜索**：内置酷狗（kg）/ 酷我（kw）musicSdk，服务端请求无 CORS 限制
- 🎵 **多源取链 + 自动容错**：按优先级依次尝试 7 个音源脚本，**服务端校验返回链接确为音频**，被运营商拦截/失效自动换下一个
- 🛡️ **源脚本沙箱**：第三方 `latest.js` 跑在 Node `vm` 沙箱里，单个源初始化失败不会拖垮进程
- 🔊 **音频代理**：补 Referer、跟随 CDN 302、转发 Range（支持拖动进度）
- 👤 **多用户**：注册/登录、按用户隔离的收藏 / 歌单 / 播放队列 / 历史
- 📝 歌词、封面、网易云风格 UI（Vue3）

## 快速开始

> ⚠️ **本仓库不内置第三方音源脚本**（见[音源说明](#音源说明与致谢)）。克隆后请先获取音源：
> ```bash
> bash scripts/fetch-sources.sh   # 从上游拉取到 lx-music-source-main/（该目录已被 .gitignore 忽略）
> ```

### 本地运行（开发 / 试用）

```bash
git clone <this-repo> web-music && cd web-music
bash scripts/fetch-sources.sh      # 获取音源
npm install
npm start                          # 默认 http://localhost:9277
```

需要 Node 18+。

### 部署到服务器（Ubuntu/Debian）

```bash
sudo git clone <this-repo> /opt/web-music/app
cd /opt/web-music/app
sudo bash scripts/fetch-sources.sh
sudo npm ci --omit=dev
# 配置环境变量与 systemd（模板见 deploy/）：
sudo install -Dm640 deploy/web-music.env.example /etc/web-music/web-music.env   # 然后按需编辑
sudo cp deploy/web-music.service /etc/systemd/system/web-music.service
sudo systemctl daemon-reload && sudo systemctl enable --now web-music
```

首次启动会按 `WEB_MUSIC_ADMIN_USER/PASSWORD` 创建超级管理员，**生产务必改默认密码**。

> 可选 — 单文件自解压安装包：在本地（已 `fetch-sources.sh` 获取音源后）运行
> `bash scripts/build-installer.sh` 会生成 `install-web-music.sh`，把代码 + 音源打包成一个文件，
> 适合无 git 环境/离线机器：`sudo bash install-web-music.sh`（脚本会自动装 Node、建服务、生成随机密码）。
> 该产物因内嵌音源不纳入版本控制。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `9277` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；线上建议 `127.0.0.1`（只给 Tunnel/Nginx 访问） |
| `WEB_MUSIC_DATA_DIR` | `./data` | 用户数据持久化目录 |
| `LX_SOURCE_DIR` | `./lx-music-source-main` | 音源脚本目录 |
| `LX_SOURCE_PRIORITY` | `juhe,lx,grass,flower,huibq,sixyin,ikun` | 取链源尝试顺序 |
| `WEB_MUSIC_ADMIN_USER` | `admin` | 首次启动创建的超级管理员用户名 |
| `WEB_MUSIC_ADMIN_PASSWORD` | `password` | 超级管理员初始密码（**生产务必改**） |

## 外网访问

应用建议只监听 `127.0.0.1`，外网默认进不来。两种暴露方式：

- **Cloudflare Tunnel（推荐）**：无需公网 IP、无需开端口。在 Cloudflare Zero Trust 建隧道，新增 Public Hostname：`你的域名` → `HTTP` → `localhost:9277`，DNS 由 Cloudflare 自动创建。
- **Nginx + 域名**：见 [`deploy/nginx.example.conf`](deploy/nginx.example.conf)，需服务器有公网 IP 并开放 80/443。

## 架构

```
浏览器 (public/ 网易云风格 UI, Vue3)
   │  HTTP
   ▼
Node 后端 (server/, Express)
   ├─ lib/sandbox.js   把 lx 的 user-API 沙箱移植到 Node vm，跑第三方 latest.js 源脚本取播放直链
   ├─ lib/sources.js   从 ./lx-music-source-main 加载 flower/grass/huibq/ikun/juhe/lx/sixyin
   ├─ lib/request.js   needle 风格的 http 客户端（源脚本用）
   ├─ lib/store.js     用户/收藏/歌单/历史 的 JSON 持久化
   ├─ lib/auth.js      注册登录、会话、密码哈希
   ├─ musicSdk/kg.js   酷狗 搜索/歌词/封面
   ├─ musicSdk/kw.js   酷我 搜索/歌词/封面
   └─ index.js         REST 接口 + 音频代理 + 静态托管
```

数据流：`搜索(musicSdk)` → 拿到 `musicInfo` → `取链(源脚本)` → 第三方直链 → `音频代理`（补 Referer、支持 Range） → 浏览器 `<audio>` 播放。

### 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/platforms` | 可搜索平台（musicSdk） |
| GET | `/api/sources` | 已加载的取链源脚本及就绪状态 |
| GET | `/api/search?keyword=&platform=kg&page=1&limit=30` | 搜索 |
| POST | `/api/url` `{musicInfo, quality, sourceScript?}` | 取播放直链（不指定源则按优先级依次尝试） |
| POST | `/api/lyric` `{musicInfo}` | 歌词 |
| POST | `/api/pic` `{musicInfo}` | 封面 |
| GET | `/api/proxy/audio?url=&referer=` | 音频代理 |

## 目录结构

```
.
├─ server/                 Node 后端
├─ public/                 前端静态资源
├─ lx-music-source-main/   第三方音源脚本（不在仓库内，由 fetch-sources.sh 获取）
├─ deploy/                 systemd / nginx / env 模板
├─ scripts/
│  ├─ fetch-sources.sh        从上游获取音源脚本到 lx-music-source-main/
│  ├─ server-update.sh        服务器上一键更新：git pull + 装依赖 + 重启
│  ├─ deploy-ubuntu.sh        从开发机 rsync 推送部署
│  ├─ installer-head.sh       自解压安装脚本的逻辑部分
│  └─ build-installer.sh      用源码树（含已获取的音源）生成 install-web-music.sh
├─ package.json
└─ README.md
```

> `lx-music-source-main/` 与本地构建的 `install-web-music.sh` 都被 `.gitignore` 排除，不会进入仓库。

## 音源说明与致谢

- **搜索/歌词/封面（musicSdk）**：移植自 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) 的 `src/renderer/utils/musicSdk`。
- **取链音源脚本（`lx-music-source-main/`）**：来自第三方公开仓库 **[pdone/lx-music-source](https://github.com/pdone/lx-music-source)**（"洛雪音乐源，内容源于网络"）。**本仓库不包含这些脚本**，请用 `scripts/fetch-sources.sh` 从上游获取（或用 `LX_SOURCE_DIR` 指向你自己的脚本目录）。这些脚本**版权与维护均归原作者所有**，本项目不分发、不背书。

感谢上述项目作者。

## 免责声明

本项目是个人学习用的技术 Demo：

- 仅供**个人自用与学习研究**，**请勿公开运营、商用或大规模分发**。
- 音源与搜索接口均依赖第三方服务，随时可能失效或被风控，本项目不保证可用性。
- 第三方音源脚本的合规性由其原作者与使用者自行负责；如有侵权请提 issue，将及时移除。
- 使用本项目所产生的一切后果由使用者自行承担。
