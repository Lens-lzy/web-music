const { createApp } = Vue

const PLATFORM_NAMES = { kw: '酷我', kg: '酷狗', tx: 'QQ音乐', wy: '网易云', mg: '咪咕' }

// ---- API helper with token ----
let TOKEN = localStorage.getItem('token') || ''
const authHeaders = () => TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}
const api = {
  async get(url) {
    const r = await fetch(url, { headers: authHeaders() })
    if (r.status === 401) { handle401(); throw new Error('未登录') }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText)
    return r.json()
  },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body || {}) })
    if (r.status === 401) { handle401(); throw new Error('未登录') }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText)
    return r.json()
  },
  async put(url, body) {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body || {}) })
    if (r.status === 401) { handle401(); throw new Error('未登录') }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText)
    return r.json()
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE', headers: authHeaders() })
    if (r.status === 401) { handle401(); throw new Error('未登录') }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText)
    return r.json()
  },
}
let _app = null
function handle401() { TOKEN = ''; localStorage.removeItem('token'); if (_app) { _app.user = null; _app.playlists = []; _app.results = []; _app.current = null; _app.queue = [] } }

const parseLrc = (lrc) => {
  if (!lrc) return []
  const lines = []
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/\[(\d+):(\d+)(?:\.(\d+))?\]/)
    if (!m) continue
    const time = (+m[1]) * 60 + (+m[2]) + (m[3] ? +('0.' + m[3]) : 0)
    const text = raw.replace(/\[.*?\]/g, '').trim()
    if (text) lines.push({ time, text })
  }
  return lines.sort((a, b) => a.time - b.time)
}

_app = createApp({
  data() {
    return {
      // auth
      user: null,
      authMode: 'login',                 // 'login' | 'register'
      allowRegister: true,
      login: { username: '', password: '', error: '' },
      reg: { username: '', password: '', password2: '', inviteCode: '', error: '' },
      loggingIn: false,
      userMenuOpen: false,
      // admin
      adminOpen: false, users: [], adminMsg: '',
      newUser: { username: '', password: '', isAdmin: false },
      invites: [],                       // 邀请码列表
      lastReset: null,                   // {username, password} 最近一次重置出的临时密码
      pwdOpen: false, pwd: { old: '', new: '', msg: '', force: false },
      // playlists
      playlists: [],              // [{id,name,isDefault,count,createdAt}]
      activePlaylist: null,       // {id,name,isDefault,songs:[...]} when viewing one
      newPlaylistName: '', showNewPl: false,
      likedKeys: [],              // song keys in the default "我喜欢的" playlist
      addMenu: { open: false, song: null, x: 0, y: 0 }, // "加入歌单" popover
      ctxMenu: { open: false, song: null, list: null, x: 0, y: 0 }, // 右键菜单
      replaceDialog: { open: false, song: null, list: null, label: '' }, // 双击替换确认
      // music
      keyword: '', lastKeyword: '', platform: 'kg',
      platforms: ['kg'], sources: [], sourceScript: '',
      view: 'featured', loading: false, loadingMore: false,   // view: 'featured' | 'search' | 'playlist'
      results: [], searchPage: 1, searchTotal: 0, searchHasMore: false,
      searchHistory: [], searchFocused: false,
      featured: { updatedAt: 0, cards: [] }, featuredLoading: false,
      recommend: { day: '', daily: [], cards: [] }, recommendLoading: false,
      shuffling: false,
      // playback
      current: null, playing: false,
      queue: [], queueIdx: -1,    // the actual play queue (drives 连播)
      queuePanelOpen: false,
      _playToken: 0, playError: '', toastMsg: '', npOpen: false,
      curTime: 0, duration: 0, seekPos: 0, seeking: false, volume: 0.8,
      lyricLines: [], curLyricIdx: -1,
      defaultCover: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="%23eee"/><text x="60" y="66" font-size="40" text-anchor="middle" fill="%23ccc">♪</text></svg>',
    }
  },
  computed: {
    // the list currently shown in the content area
    contentList() { return this.view === 'playlist' && this.activePlaylist ? this.activePlaylist.songs : this.results },
    defaultPlaylist() { return this.playlists.find(p => p.isDefault) },
  },
  async mounted() {
    document.addEventListener('click', () => { this.userMenuOpen = false; this.addMenu.open = false; this.ctxMenu.open = false; this.searchFocused = false })
    try { this.allowRegister = (await api.get('/api/config')).allowRegister !== false } catch (e) {}
    if (TOKEN) { try { const r = await api.get('/api/me'); this.user = r.user; await this.initMusic(); this.maybeForceChangePwd() } catch (e) {} }
  },
  methods: {
    // ---- auth ----
    async doLogin() {
      this.login.error = ''
      if (!this.login.username || !this.login.password) { this.login.error = '请输入用户名和密码'; return }
      this.loggingIn = true
      try {
        const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: this.login.username, password: this.login.password }) })
        const d = await r.json()
        if (!r.ok) { this.login.error = d.error || '登录失败'; return }
        TOKEN = d.token; localStorage.setItem('token', TOKEN)
        this.user = d.user
        this.login.password = ''
        await this.initMusic()
        this.maybeForceChangePwd()
      } catch (e) { this.login.error = '网络错误：' + e.message }
      finally { this.loggingIn = false }
    },
    async doRegister() {
      this.reg.error = ''
      const { username, password, password2, inviteCode } = this.reg
      if (!username || !password) { this.reg.error = '请输入用户名和密码'; return }
      if (!inviteCode || !inviteCode.trim()) { this.reg.error = '请输入邀请码'; return }
      if (password.length < 4) { this.reg.error = '密码至少 4 位'; return }
      if (password !== password2) { this.reg.error = '两次输入的密码不一致'; return }
      this.loggingIn = true
      try {
        const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, inviteCode: inviteCode.trim() }) })
        const d = await r.json()
        if (!r.ok) { this.reg.error = d.error || '注册失败'; return }
        TOKEN = d.token; localStorage.setItem('token', TOKEN)
        this.user = d.user
        this.reg = { username: '', password: '', password2: '', inviteCode: '', error: '' }
        await this.initMusic()
      } catch (e) { this.reg.error = '网络错误：' + e.message }
      finally { this.loggingIn = false }
    },
    switchAuth(mode) { this.authMode = mode; this.login.error = ''; this.reg.error = '' },
    // 管理员重置后，被要求改密的用户登录时强制弹出改密框
    maybeForceChangePwd() {
      if (this.user && this.user.mustChangePassword) {
        this.pwd = { old: '', new: '', msg: '管理员已重置你的密码，请设置一个新密码后继续使用。', force: true }
        this.pwdOpen = true
      }
    },
    doLogout() { handle401(); this.userMenuOpen = false },
    async initMusic() {
      try { this.platforms = (await api.get('/api/platforms')).platforms || ['kg'] } catch (e) {}
      try { this.sources = (await api.get('/api/sources')).sources || [] } catch (e) {}
      await this.loadPlaylists()
      this.loadFeatured()
      this.loadRecommend()
      this.loadSearchHistory()
      if (this.platforms.length && !this.platforms.includes(this.platform)) this.platform = this.platforms[0]
      this.$nextTick(() => {
        const a = this.$refs.audio; if (!a) return
        a.volume = this.volume
        a.addEventListener('timeupdate', () => { if (!this.seeking) { this.curTime = a.currentTime; this.seekPos = a.currentTime } this.updateLyric() })
        a.addEventListener('loadedmetadata', () => { this.duration = a.duration })
        a.addEventListener('ended', () => this.next())
        a.addEventListener('play', () => { this.playing = true })
        a.addEventListener('pause', () => { this.playing = false })
      })
      // restore persisted play queue (do NOT autoplay — show current track, paused)
      try {
        const q = await api.get('/api/queue')
        if (q.songs && q.songs.length) {
          this.queue = q.songs
          this.queueIdx = (q.idx >= 0 && q.idx < q.songs.length) ? q.idx : 0
          this.current = this.queue[this.queueIdx]
          if (this.current) this.loadLyric(this.current)
        }
      } catch (e) {}
    },
    // persist the current queue to the server (debounced-ish, fire and forget)
    async saveQueue() {
      try { await api.put('/api/queue', { songs: this.queue, idx: this.queueIdx }) } catch (e) {}
    },
    // ---- admin ----
    async openAdmin() {
      this.userMenuOpen = false; this.adminMsg = ''
      try {
        this.users = (await api.get('/api/admin/users')).users
        await this.loadInvites()
        this.adminOpen = true
      } catch (e) { alert(e.message) }
    },
    async loadInvites() {
      try { this.invites = (await api.get('/api/admin/invites')).invites || [] } catch (e) {}
    },
    async genInvite() {
      this.adminMsg = ''
      try { await api.post('/api/admin/invites', {}); await this.loadInvites() } catch (e) { this.adminMsg = e.message }
    },
    async delInvite(code) {
      try { await api.del('/api/admin/invites/' + encodeURIComponent(code)); await this.loadInvites() } catch (e) { this.adminMsg = e.message }
    },
    copyText(t) {
      try { navigator.clipboard.writeText(String(t)); this.toast('已复制：' + t) } catch (e) {}
    },
    async addUser() {
      this.adminMsg = ''
      try {
        await api.post('/api/admin/users', { ...this.newUser })
        this.newUser = { username: '', password: '', isAdmin: false }
        this.users = (await api.get('/api/admin/users')).users
        this.adminMsg = '已添加'
      } catch (e) { this.adminMsg = e.message }
    },
    async removeUser(u) {
      if (!confirm(`确定删除成员 ${u.username}？`)) return
      try { await api.del('/api/admin/users/' + u.id); this.users = (await api.get('/api/admin/users')).users } catch (e) { this.adminMsg = e.message }
    },
    // 重置为随机临时密码：弹出确认 → 后端生成随机密码 → 显示给管理员转告该用户
    async resetPwd(u) {
      if (!confirm(`为「${u.username}」生成一个随机临时密码？\n该用户下次登录后需自行修改。`)) return
      this.adminMsg = ''; this.lastReset = null
      try {
        const r = await api.post('/api/admin/users/' + u.id + '/password', {}) // 不传密码 -> 随机
        this.lastReset = { username: u.username, password: r.password }
        this.users = (await api.get('/api/admin/users')).users
      } catch (e) { this.adminMsg = e.message }
    },
    async toggleAdmin(u, val) {
      try { await api.post('/api/admin/users/' + u.id + '/admin', { isAdmin: val }); this.users = (await api.get('/api/admin/users')).users } catch (e) { this.adminMsg = e.message }
    },
    openChangePwd() { this.userMenuOpen = false; this.pwd = { old: '', new: '', msg: '', force: false }; this.pwdOpen = true },
    async changePwd() {
      this.pwd.msg = ''
      if (!this.pwd.old || !this.pwd.new) { this.pwd.msg = '请填写原密码和新密码'; return }
      try {
        await api.post('/api/me/password', { oldPassword: this.pwd.old, newPassword: this.pwd.new })
        if (this.user) this.user.mustChangePassword = false
        this.pwd.msg = '修改成功'
        setTimeout(() => { this.pwdOpen = false; this.pwd.force = false }, 800)
      } catch (e) { this.pwd.msg = e.message }
    },
    closeAdmin() { this.adminOpen = false; this.lastReset = null; this.adminMsg = '' },
    // ---- playlists ----
    async loadPlaylists() {
      try { this.playlists = (await api.get('/api/playlists')).playlists || [] } catch (e) { this.playlists = [] }
      await this.refreshLikedKeys()
    },
    async refreshLikedKeys() {
      const d = this.defaultPlaylist
      if (!d) { this.likedKeys = []; return }
      try { const p = (await api.get('/api/playlists/' + d.id)).playlist; this.likedKeys = p.songs.map(s => this.keyOf(s)) } catch (e) {}
    },
    async openPlaylist(p) {
      this.view = 'playlist'
      try {
        this.activePlaylist = (await api.get('/api/playlists/' + p.id)).playlist
        this.fetchCovers(this.activePlaylist.songs)
      } catch (e) { alert(e.message) }
    },
    // 为缺少封面的歌曲批量补封面（限制并发，避免打爆音源）
    async fetchCovers(songs) {
      const todo = (songs || []).filter(s => s && !s.img)
      if (!todo.length) return
      const CONCURRENCY = 4
      let i = 0
      const worker = async () => {
        while (i < todo.length) { const s = todo[i++]; await this.loadPic(s) }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
    },
    toggleNewPl() {
      this.showNewPl = !this.showNewPl
      if (this.showNewPl) this.$nextTick(() => { if (this.$refs.newPl) this.$refs.newPl.focus() })
    },
    async createPlaylist() {
      const name = (this.newPlaylistName || '').trim(); if (!name) return
      try { await api.post('/api/playlists', { name }); this.newPlaylistName = ''; this.showNewPl = false; await this.loadPlaylists() } catch (e) { alert(e.message) }
    },
    async deletePlaylist(p) {
      if (p.isDefault) return
      if (!confirm(`删除歌单「${p.name}」？`)) return
      try {
        await api.del('/api/playlists/' + p.id)
        if (this.activePlaylist && this.activePlaylist.id === p.id) { this.activePlaylist = null; this.view = 'search' }
        await this.loadPlaylists()
      } catch (e) { alert(e.message) }
    },
    // "加入歌单" popover
    openAddMenu(song, ev) {
      this.addMenu = { open: true, song, x: ev.clientX, y: ev.clientY }
    },
    async addSongToPlaylist(playlistId) {
      const song = this.addMenu.song; this.addMenu.open = false
      if (!song) return
      try {
        await api.post('/api/playlists/' + playlistId + '/songs', { song })
        await this.loadPlaylists()
        if (this.activePlaylist && this.activePlaylist.id === playlistId) this.activePlaylist = (await api.get('/api/playlists/' + playlistId)).playlist
      } catch (e) { alert(e.message) }
    },
    // quick toggle for the default playlist (heart icon)
    isLiked(s) { return this.likedKeys.includes(this.keyOf(s)) },
    async toggleLike(s) {
      const d = this.defaultPlaylist; if (!d) return
      const key = this.keyOf(s)
      try {
        if (this.likedKeys.includes(key)) await api.del('/api/playlists/' + d.id + '/songs?key=' + encodeURIComponent(key))
        else await api.post('/api/playlists/' + d.id + '/songs', { song: s })
        await this.loadPlaylists()
        if (this.activePlaylist && this.activePlaylist.id === d.id) this.activePlaylist = (await api.get('/api/playlists/' + d.id)).playlist
      } catch (e) { alert(e.message) }
    },
    async removeFromCurrentPlaylist(s) {
      const p = this.activePlaylist; if (!p) return
      try {
        await api.del('/api/playlists/' + p.id + '/songs?key=' + encodeURIComponent(this.keyOf(s)))
        this.activePlaylist = (await api.get('/api/playlists/' + p.id)).playlist
        await this.loadPlaylists()
      } catch (e) { alert(e.message) }
    },
    // ---- featured (精选首页) ----
    async loadFeatured() {
      this.featuredLoading = true
      try { this.featured = await api.get('/api/featured') } catch (e) {}
      finally { this.featuredLoading = false }
    },
    featuredTime() {
      if (!this.featured.updatedAt) return ''
      const d = new Date(this.featured.updatedAt)
      return `更新于 ${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    },
    // 个性化推荐
    async loadRecommend(force = false) {
      this.recommendLoading = true
      try { this.recommend = await api.get('/api/recommend' + (force ? '?force=1' : '')) } catch (e) {}
      finally { this.recommendLoading = false }
    },
    // 随便听听：拉 30 首随机歌并立即作为队列播放
    async shufflePlay() {
      if (this.shuffling) return
      this.shuffling = true
      try {
        const r = await api.get('/api/shuffle')
        if (r.songs && r.songs.length) this.replaceQueueAndPlay(r.songs[0], r.songs)
      } catch (e) { alert('随便听听失败：' + e.message) }
      finally { this.shuffling = false }
    },
    // 整张卡片作为队列播放
    playCard(card) {
      if (card.songs && card.songs.length) this.replaceQueueAndPlay(card.songs[0], card.songs)
    },
    // 点击卡片里某首：以该卡片为队列从这首开始
    playCardSong(card, song) {
      if (!this.queue.length) { this.replaceQueueAndPlay(song, card.songs); return }
      this.replaceDialog = { open: true, song, list: card.songs.slice(), label: `「${card.title}」` }
    },
    // ---- music ----
    platformName(p) { return PLATFORM_NAMES[p] || p },
    // 封面图：经图片代理（避免 http 混合内容），无图返回默认占位
    cover(s) {
      if (!s || !s.img) return this.defaultCover
      return '/api/proxy/img?token=' + encodeURIComponent(TOKEN) + '&url=' + encodeURIComponent(s.img)
    },
    fmt(s) { if (!s || isNaN(s)) return '00:00'; s = Math.floor(s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') },
    async doSearch(kw) {
      if (typeof kw === 'string') this.keyword = kw
      kw = this.keyword.trim(); if (!kw) return
      this.searchFocused = false
      this.view = 'search'; this.activePlaylist = null; this.loading = true; this.lastKeyword = kw
      this.searchPage = 1; this.results = []; this.searchTotal = 0; this.searchHasMore = false
      try {
        const r = await api.get(`/api/search?keyword=${encodeURIComponent(kw)}&platform=${this.platform}&page=1&limit=30`)
        this.results = r.list || []
        this.searchTotal = r.total || this.results.length
        this.searchHasMore = this.results.length < this.searchTotal
        this.loadSearchHistory() // 搜索后刷新历史
      } catch (e) { if (this.user) alert('搜索失败：' + e.message); this.results = [] }
      finally { this.loading = false }
    },
    // 搜索历史
    async loadSearchHistory() {
      try { this.searchHistory = (await api.get('/api/search/history')).history || [] } catch (e) {}
    },
    onSearchFocus() { this.searchFocused = true; if (!this.searchHistory.length) this.loadSearchHistory() },
    pickHistory(kw) { this.doSearch(kw) },
    async removeHistory(kw) {
      try { this.searchHistory = (await api.del('/api/search/history?keyword=' + encodeURIComponent(kw))).history || [] } catch (e) {}
    },
    async clearHistory() {
      try { this.searchHistory = (await api.del('/api/search/history')).history || [] } catch (e) {}
    },
    async loadMore() {
      if (this.loadingMore || !this.searchHasMore) return
      this.loadingMore = true
      const next = this.searchPage + 1
      try {
        const r = await api.get(`/api/search?keyword=${encodeURIComponent(this.lastKeyword)}&platform=${this.platform}&page=${next}&limit=30`)
        const more = r.list || []
        // de-dup against existing results (some sources return overlaps)
        const seen = new Set(this.results.map(s => this.keyOf(s)))
        for (const s of more) if (!seen.has(this.keyOf(s))) this.results.push(s)
        this.searchPage = next
        if (r.total) this.searchTotal = r.total
        this.searchHasMore = more.length > 0 && this.results.length < this.searchTotal
      } catch (e) { alert('加载更多失败：' + e.message) }
      finally { this.loadingMore = false }
    },
    keyOf(s) { return (s.source || '') + ':' + (s.songmid || s.songId || s.name + s.singer) },
    isCurrent(s) { return this.current && this.keyOf(s) === this.keyOf(this.current) },

    // 双击歌曲：弹窗询问是否用「当前列表」替换整个播放列表
    onDblClick(song, list) {
      // 队列为空时无需询问，直接用当前列表作为队列播放
      if (!this.queue.length) { this.replaceQueueAndPlay(song, list); return }
      const label = (this.view === 'playlist' && this.activePlaylist) ? `歌单「${this.activePlaylist.name}」` : '当前搜索结果'
      this.replaceDialog = { open: true, song, list: (list || []).slice(), label }
    },
    // 替换整个队列为该列表，并从 song 开始播
    replaceQueueAndPlay(song, list) {
      const q = (list || this.contentList || []).slice()
      const idx = q.findIndex(s => this.keyOf(s) === this.keyOf(song))
      this.queue = q.length ? q : [song]
      this.queueIdx = idx >= 0 ? idx : 0
      this.saveQueue()
      this.playAt(this.queueIdx)
    },
    // 只播这一首：插到队列最前面并立即播放（不动其余）
    playOneNow(song) {
      const key = this.keyOf(song)
      const existing = this.queue.findIndex(s => this.keyOf(s) === key)
      if (existing >= 0) this.queue.splice(existing, 1)
      this.queue.unshift(song)
      this.queueIdx = 0
      this.saveQueue()
      this.playAt(0)
    },
    // 下一首播放：插到当前曲之后
    playNext(song) {
      const key = this.keyOf(song)
      const existing = this.queue.findIndex(s => this.keyOf(s) === key)
      if (existing >= 0) { if (existing <= this.queueIdx) this.queueIdx--; this.queue.splice(existing, 1) }
      const at = this.queueIdx >= 0 ? this.queueIdx + 1 : this.queue.length
      this.queue.splice(at, 0, song)
      if (this.queueIdx < 0) { this.queueIdx = 0; this.saveQueue(); this.playAt(0); return }
      this.saveQueue()
    },
    // 替换确认弹窗的两个选择
    dialogReplace() { const d = this.replaceDialog; this.replaceDialog.open = false; this.replaceQueueAndPlay(d.song, d.list) },
    dialogOnlyOne() { const d = this.replaceDialog; this.replaceDialog.open = false; this.playOneNow(d.song) },

    // 右键菜单
    openCtxMenu(song, list, ev) {
      this.ctxMenu = { open: true, song, list: (list || []).slice(), x: ev.clientX, y: ev.clientY }
      this.addMenu.open = false
    },
    ctxPlay() { const c = this.ctxMenu; this.ctxMenu.open = false; this.playOneNow(c.song) },
    ctxPlayNext() { const c = this.ctxMenu; this.ctxMenu.open = false; this.playNext(c.song) },
    ctxLike() { const c = this.ctxMenu; this.ctxMenu.open = false; if (!this.isLiked(c.song)) this.toggleLike(c.song) },
    ctxAddToPlaylist(ev) { const c = this.ctxMenu; this.ctxMenu.open = false; this.openAddMenu(c.song, ev) },
    async playAt(idx, attempt = 0) {
      if (idx < 0 || idx >= this.queue.length) return
      this.queueIdx = idx
      this.saveQueue()
      const s = this.queue[idx]
      this.current = s; this.lyricLines = []; this.curLyricIdx = -1
      // 用 token 防止快速切歌时旧请求覆盖新播放
      const token = ++this._playToken
      const a = this.$refs.audio
      this.playError = ''
      try {
        const r = await api.post('/api/url', { musicInfo: s, quality: '128k', sourceScript: this.sourceScript || undefined })
        if (token !== this._playToken) return // 用户已切到别的歌
        a.src = r.proxied + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '')
        await a.play()
      } catch (e) {
        if (token !== this._playToken) return
        // 第三方源常瞬时超时/抽风：先自动重试一次当前歌
        if (attempt === 0) {
          this.playError = `「${s.name}」加载较慢，重试中…`
          await new Promise(r => setTimeout(r, 600))
          if (token !== this._playToken) return
          return this.playAt(idx, 1)
        }
        // 重试仍失败 → 顶部提示并自动跳下一首（不再用阻塞弹窗）
        this.toast(`「${s.name}」暂时无法播放，已跳到下一首`)
        if (this.queue.length > 1) this.next()
        return
      }
      this.playError = ''
      this.loadLyric(s); this.loadPic(s)
      this.recordHistory(s)
    },
    // 轻提示（非阻塞），3 秒自动消失
    toast(msg) {
      this.toastMsg = msg
      clearTimeout(this._toastTimer)
      this._toastTimer = setTimeout(() => { this.toastMsg = '' }, 3000)
    },
    // 记录播放历史（用于个性化推荐，失败静默）
    async recordHistory(s) { try { await api.post('/api/history', { song: s }) } catch (e) {} },
    async loadLyric(s) { try { const r = await api.post('/api/lyric', { musicInfo: s }); this.lyricLines = parseLrc(r.lyric) } catch (e) {} },
    async loadPic(s) { if (s.img) return; try { const r = await api.post('/api/pic', { musicInfo: s }); if (r.pic) { s.img = r.pic; if (this.current && this.keyOf(this.current) === this.keyOf(s)) this.current.img = r.pic } } catch (e) {} },
    updateLyric() {
      if (!this.lyricLines.length) return
      const t = this.curTime; let idx = -1
      for (let i = 0; i < this.lyricLines.length; i++) { if (this.lyricLines[i].time <= t) idx = i; else break }
      if (idx !== this.curLyricIdx) {
        this.curLyricIdx = idx
        this.$nextTick(() => { const box = this.$refs.lyricBox; if (!box) return; const el = box.querySelectorAll('p')[idx]; if (el) box.scrollTop = el.offsetTop - box.clientHeight / 2 })
      }
    },
    togglePlay() {
      const a = this.$refs.audio
      // restored-but-not-yet-started queue: start the current track on first press
      if (!a.src) { if (this.queue.length && this.queueIdx >= 0) this.playAt(this.queueIdx); return }
      a.paused ? a.play() : a.pause()
    },
    next() { if (!this.queue.length) return; this.playAt((this.queueIdx + 1) % this.queue.length) },
    prev() { if (!this.queue.length) return; this.playAt((this.queueIdx - 1 + this.queue.length) % this.queue.length) },
    // play queue panel: remove a song; if it's the current, advance
    removeFromQueue(idx) {
      if (idx < 0 || idx >= this.queue.length) return
      const wasCurrent = idx === this.queueIdx
      this.queue.splice(idx, 1)
      if (this.queue.length === 0) { this.queueIdx = -1; const a = this.$refs.audio; a.pause(); a.removeAttribute('src'); this.current = null; this.saveQueue(); return }
      if (idx < this.queueIdx) this.queueIdx--
      else if (wasCurrent) { if (this.queueIdx >= this.queue.length) this.queueIdx = 0; this.playAt(this.queueIdx) }
      this.saveQueue()
    },
    clearQueue() { const a = this.$refs.audio; a.pause(); a.removeAttribute('src'); this.queue = []; this.queueIdx = -1; this.current = null; this.saveQueue() },
    seekTo() { const a = this.$refs.audio; a.currentTime = this.seekPos; this.seeking = false },
    setVolume() { this.$refs.audio.volume = this.volume },
  },
}).mount('#app')
