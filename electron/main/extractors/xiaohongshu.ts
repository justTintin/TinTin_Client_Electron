/**
 * extractors/xiaohongshu.ts —— 小红书 Web 抽取脚本
 *   运行在 www.xiaohongshu.com 真实 DOM 上下文
 *   支持 3 场景：笔记详情 / 用户主页 / 搜索结果
 *
 *   URL 模式：
 *     note:    https://www.xiaohongshu.com/explore/:noteId
 *              https://www.xiaohongshu.com/discovery/item/:noteId
 *     profile: https://www.xiaohongshu.com/user/profile/:userId
 *              https://www.xiaohongshu.com/profile/:userId
 *     search:  https://www.xiaohongshu.com/search_result?keyword=xxx
 *              https://www.xiaohongshu.com/search?keyword=xxx
 */
var C = window.__TIN_EX_COMMON__ || __TIN_EX_COMMON__
;(function () {
  var PLATFORM = 'xiaohongshu'
  var PLATFORM_NAME = '小红书'

  try {
    // ───────── ① 前置检查 ─────────
    if (C.detectNeedLogin()) {
      return C.fail('NEED_LOGIN', '请先登录' + PLATFORM_NAME, '未登录时笔记内容/用户主页/搜索部分字段会被强制降级；请扫码或手机号登录后重试')
    }
    if (C.detectRiskCaptcha()) {
      return C.fail('RISK_CAPTCHA', PLATFORM_NAME + '触发了风控/验证码', '请完成当前弹出的滑块/拼图/短信验证，避免被反爬拦截；等待 60 秒后重试效果更好')
    }

    // ───────── ② 场景识别 ─────────
    var pathname = (location.pathname || '').toLowerCase()
    var search = location.search || ''
    var scene = detectXhsScene(pathname, search)

    // ───────── ③ 按场景抽取 ─────────
    var content = null
    switch (scene.kind) {
      case 'note':    content = extractXhsNote(scene);    break
      case 'profile': content = extractXhsProfile(scene); break
      case 'search':  content = extractXhsSearch(scene);  break
      default:
        content = C.makeFallbackContent()
        content.kind = 'unknown'
    }
    if (!content) {
      content = C.makeFallbackContent()
      content.kind = scene.kind || 'unknown'
    }

    return C.succ({
      source: C.makeSource(PLATFORM, { scene: scene.kind }),
      meta:   C.makeMeta(),
      content: content,
    })
  } catch (e) {
    try {
      var fb = C.makeFallbackContent(40, 30, 15)
      return C.succ({
        source: C.makeSource(PLATFORM, { scene: 'unknown', errorInjected: true }),
        meta:   C.makeMeta(),
        content: Object.assign(fb, {
          kind: 'unknown',
          errorMessage: String(e.message || e),
          _fallbackBecauseOfError: true,
        }),
      })
    } catch (_) {
      return C.fail('DOM_MISMATCH', PLATFORM_NAME + ' DOM 结构已变更: ' + e.message, '等待脚本升级或改用服务端解析')
    }
  }

  // ───────── 场景识别 ─────────
  function detectXhsScene(pathname, search) {
    var out = { kind: 'unknown', pathname: pathname }
    try {
      out.noteId  = C.regexFirst(/\/explore\/([a-f0-9]+)/i, pathname) || C.regexFirst(/\/item\/([a-f0-9]+)/i, pathname)
      out.userId  = C.regexFirst(/\/profile\/([^/?#]+)/i, pathname) || C.regexFirst(/\/user\/profile\/([^/?#]+)/i, pathname)
      out.keyword = decodeURIComponent(C.regexFirst(/[?&]keyword=([^&#]+)/i, search) || C.regexFirst(/[?&]query=([^&#]+)/i, search) || '')

      if (out.keyword || /search(_result)?|\/s\//i.test(pathname + search)) { out.kind = 'search'; return out }
      if (out.userId  || /\/user\/profile|\/profile\//i.test(pathname)) { out.kind = 'profile'; return out }
      if (out.noteId  || /\/explore|\/discovery\/item|\/post\//i.test(pathname)) { out.kind = 'note'; return out }
      var s2 = C.detectScene(pathname + search)
      out.kind = s2.kind
    } catch (_) {}
    return out
  }

  // ───────── 场景 1：笔记详情 ─────────
  function extractXhsNote(scene) {
    var n = {
      noteId: scene ? scene.noteId : '',
      xsecToken: '',
      title:  '',
      desc:   '',
      type:   '',    // normal | video
      cover:  '',
      images: [],
      videoUrl: '',
      videoInfo: null,
      tags:   [],
      atUsers:[],
      user:   null,  // 作者
      interact: { liked: false, collected: false, commentCount: 0, likeCount: 0, collectCount: 0, shareCount: 0 },
      time:   0,     // timestamp ms
      lastUpdateTime: 0,
      ipLocation: '',
      comments: [],
      relatedNotes: [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var note = dig(state, /note|noteDetail|noteData|noteDetailMap/i)
        // noteDetailMap 的结构是 { noteId: { note: {...} } }
        if (note && typeof note === 'object' && !note.noteId) {
          var keys = Object.keys(note)
          if (keys.length && note[keys[0]] && note[keys[0]].note) note = note[keys[0]].note
        }
        if (!note) note = dig(state, /noteDetail/i, /note/i)
        if (note) {
          n.noteId    = String(note.noteId || note.note_id || note.id || n.noteId || '')
          n.xsecToken = String(note.xsecToken || note.xsec_token || '')
          n.title     = String(note.title || n.title || '')
          n.desc      = String(note.desc || note.description || n.desc || '')
          n.type      = String(note.type || n.type || '')  // 'normal' 图文 / 'video' 视频
          n.cover     = pickFirst(note.cover || note.imageList && note.imageList[0])
          if (Array.isArray(note.imageList || note.images)) {
            var il = note.imageList || note.images
            n.images = il.slice(0, 50).map(function (i) {
              var url = pickFirst(i.urlDefault || i.url || i.urlPre || i)
              return {
                url:    url,
                width:  C.parseNum(i.width  || (i.info && i.info.width)),
                height: C.parseNum(i.height || (i.info && i.info.height)),
                fileId: String(i.fileId || i.file_id || ''),
                traceId:String(i.traceId || ''),
              }
            })
          }
          if (note.video) {
            n.videoUrl = pickFirst(note.video.media || note.video.stream || note.video.videoUrl || note.video.url)
            n.videoInfo = {
              duration:   C.parseNum(note.video.duration),
              width:      C.parseNum(note.video.width  || note.video.mediaWidth),
              height:     C.parseNum(note.video.height || note.video.mediaHeight),
              thumbnail:  pickFirst(note.video.cover || note.video.frame || note.video.poster),
            }
          }
          if (Array.isArray(note.tagList || note.tags)) {
            n.tags = (note.tagList || note.tags).slice(0, 50).map(function (t) {
              return typeof t === 'string' ? t : { name: String(t.name || t.tag || ''), type: String(t.type || ''), id: String(t.id || '') }
            })
          }
          if (Array.isArray(note.atUserList || note.atuserList || note.atUsers)) {
            n.atUsers = (note.atUserList || note.atuserList || note.atUsers || []).slice(0, 50).map(function (u) {
              return { userId: String(u.user_id || u.userId || u.id || ''), nickname: String(u.nickname || u.nick_name || '') }
            })
          }
          if (note.user || note.creator || note.author) {
            var u = note.user || note.creator || note.author
            n.user = {
              userId:   String(u.userId || u.user_id || u.uid || u.id || ''),
              nickname: String(u.nickname || u.nick_name || u.name || ''),
              avatar:   pickFirst(u.avatar || u.images || u.avatar_url || u.avatar_img),
              desc:     String(u.desc || u.signature || ''),
              gender:   String(u.gender || ''),
              location: String(u.location || u.ip_location || ''),
              followed: !!u.followed || !!u.following,
              fans:     C.parseNum(u.fans || u.follower_count || 0),
              interaction: u.interaction || null,
            }
          }
          if (note.interactInfo || note.interact_info || note.count) {
            var it = note.interactInfo || note.interact_info || note.count
            n.interact = n.interact || {}
            n.interact.liked         = !!it.liked
            n.interact.collected     = !!it.collected
            n.interact.commentCount  = C.parseNum(it.commentCount  || it.comment_count || it.comments)
            n.interact.likeCount     = C.parseNum(it.likeCount     || it.like_count    || it.likes)
            n.interact.collectCount  = C.parseNum(it.collectCount  || it.collect_count || it.stars || it.collects)
            n.interact.shareCount    = C.parseNum(it.shareCount    || it.share_count   || it.shares)
          }
          n.time           = C.parseNum(note.time || note.create_time || note.created) * 1000 || 0
          n.lastUpdateTime = C.parseNum(note.lastUpdateTime || note.update_time || note.last_update_time) * 1000 || 0
          n.ipLocation     = String(note.ipLocation || note.ip_location || note.ip || note.ipLoc || '')
          if (Array.isArray(note.comments || note.commentList)) {
            n.comments = (note.comments || note.commentList).slice(0, 30).map(function (c) { return normalizeComment(c) })
          }
          if (Array.isArray(note.relatedNotes)) {
            n.relatedNotes = note.relatedNotes.slice(0, 30).map(function (x) {
              return {
                noteId:   String(x.noteId || x.note_id || x.id || ''),
                title:    String(x.title || x.display_title || ''),
                cover:    pickFirst(x.cover || x.coverUrl || x.imageList && x.imageList[0]),
                type:     String(x.type || ''),
                userId:   String(x.user && (x.user.userId || x.user.user_id) || ''),
                nickname: String(x.user && (x.user.nickname || x.user.nick_name) || ''),
                likes:    C.parseNum(x.interactInfo && x.interactInfo.likeCount || x.likes),
              }
            })
          }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!n.title) {
      var t = C.$('[class*="title"], h1, #detail-title')
      n.title = C.text(t, 200)
    }
    if (!n.desc) {
      var d = C.$('[class*="desc"], [class*="content"], [id*="desc"], .note-content')
      n.desc = C.text(d, 4000)
    }
    if (!n.user || !n.user.nickname) {
      var uBox = C.$('[class*="user"], [class*="author-card"]')
      if (uBox) {
        n.user = n.user || {}
        if (!n.user.nickname) {
          var nn = C.$('[class*="name"], [class*="nickname"]', uBox)
          n.user.nickname = C.text(nn, 60)
        }
        if (!n.user.avatar) {
          var av = C.$('img', uBox)
          n.user.avatar = pickFirst(C.attr(av, 'src'))
        }
      }
    }
    if (n.images.length === 0 && !n.videoUrl) {
      var swiperImgs = C.$$('[class*="swiper"] img, [class*="image-container"] img, [class*="note-card"] img').slice(0, 50)
      n.images = swiperImgs.map(function (x) { return { url: C.attr(x, 'src'), width: 0, height: 0, fileId: '', traceId: '' } }).filter(function (x) { return x.url })
    }
    if (!n.interact.likeCount || !n.interact.commentCount) {
      var panel = C.$('[class*="interact"], [class*="like-bar"], [class*="bottom-bar"]')
      if (panel) {
        var ls = C.$$('[class*="like"] [class*="count"], [class*="Like"] span', panel)
        var cs = C.$$('[class*="comment"] [class*="count"], [class*="Comment"] span', panel)
        var ss = C.$$('[class*="star"] [class*="count"], [class*="Collect"] span', panel)
        n.interact.likeCount    = n.interact.likeCount    || C.parseNum(C.text(ls[0]))
        n.interact.commentCount = n.interact.commentCount || C.parseNum(C.text(cs[0]))
        n.interact.collectCount = n.interact.collectCount || C.parseNum(C.text(ss[0]))
      }
    }

    return {
      kind: 'note',
      note: n,
      _fallback: (n.noteId === '' && n.title === '' && n.desc === '') && true,
    }
  }

  // ───────── 场景 2：用户主页 ─────────
  function extractXhsProfile(scene) {
    var p = {
      userId:   scene ? scene.userId : '',
      nickname: '',
      avatar:   '',
      avatarBackground: '',
      desc:     '',
      gender:   '',
      location: '',
      ipLocation: '',
      birthday: '',
      tags:     [],
      follows:  0,   // 关注
      fans:     0,   // 粉丝
      interaction: 0, // 获赞与收藏
      liked:    0,
      collected:0,
      notesCount: 0,
      collectNotesCount: 0,
      followed: false,
      officialVerified: false,
      verifiedInfo: '',
      tabFeedList: [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var user = dig(state, /userPageData|userInfo|userProfile|profileUser|user_info_map|userInfoMap/i)
        if (user && typeof user === 'object' && !user.userId && !user.nickname) {
          // user_info_map 是 { userId: {...} } 的字典
          var ks = Object.keys(user)
          if (ks.length) user = user[ks[0]]
        }
        if (user) {
          p.userId     = String(user.userId || user.user_id || user.uid || user.id || p.userId || '')
          p.nickname   = String(user.nickname || user.nick_name || user.name || p.nickname || '')
          p.avatar     = pickFirst(user.avatar || user.image || user.avatar_url || user.head_url)
          p.avatarBackground = pickFirst(user.avatarBackground || user.userHeaderBackgroundImage || user.banner || user.cover)
          p.desc       = String(user.desc || user.signature || user.description || p.desc || '')
          p.gender     = String(user.gender === 'FEMALE' || user.gender === 2 ? '女' : user.gender === 'MALE' || user.gender === 1 ? '男' : (user.gender || ''))
          p.location   = String(user.location || user.city || user.province || p.location || '')
          p.ipLocation = String(user.ipLocation || user.ip_location || '')
          p.birthday   = String(user.birthday || user.birth_day || '')
          if (Array.isArray(user.tags || user.tagList)) {
            p.tags = (user.tags || user.tagList).map(function (t) { return typeof t === 'string' ? t : String(t.name || t.tag || '') }).slice(0, 50)
          }
          var st = user.statistics || user.stats || user.counts || user
          p.follows       = C.parseNum(st.follows || st.following || st.followCount || 0)
          p.fans          = C.parseNum(st.fans || st.followers || st.fansCount || 0)
          p.interaction   = C.parseNum(st.interaction || st.likedAndCollected || st.likeAndCollect || st.totalLikes || 0)
          p.liked         = C.parseNum(st.likedCount || st.liked)
          p.collected     = C.parseNum(st.collectedCount || st.collected)
          p.notesCount    = C.parseNum(st.notes || st.notesCount || st.publish || st.publishCount)
          p.collectNotesCount = C.parseNum(st.collect || st.collectNoteCount)
          p.followed      = !!user.followed || !!user.following
          p.officialVerified = !!user.officialVerified || !!user.verified || !!user.official_verify
          p.verifiedInfo  = String(user.verifiedInfo || user.verified_desc || user.officialVerifyInfo || '')
        }
        // 用户主页下的笔记列表
        var notes = dig(state, /notes|feedList|userNotes|publishedNotes|tabFeedList|userFeeds/i)
        if (Array.isArray(notes)) {
          p.tabFeedList = notes.slice(0, 60).map(function (x) {
            if (!x) return null
            return {
              noteId:   String(x.noteId || x.note_id || x.id || ''),
              title:    String(x.displayTitle || x.title || x.display_title || ''),
              cover:    pickFirst(x.cover || x.imageList && x.imageList[0]),
              type:     String(x.type || ''),
              likes:    C.parseNum(x.interactInfo && x.interactInfo.likeCount || x.likeCount || x.likes || 0),
            }
          }).filter(Boolean)
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!p.nickname) {
      var n = C.$('[class*="username"], [class*="nickname"], h1')
      p.nickname = C.text(n, 60)
    }
    if (!p.avatar) {
      var av = C.$('[class*="avatar"] img, .user-avatar img, img[class*="Avatar"]')
      p.avatar = C.attr(av, 'src')
    }
    if (!p.desc) {
      var des = C.$('[class*="user-desc"], [class*="signature"], [class*="intro"]')
      p.desc = C.text(des, 300)
    }
    var ss = C.$$('[class*="stats"] [class*="value"], [class*="Stat"] [class*="num"], [class*="data-info"] [class*="count"]')
    if (ss.length >= 3) {
      var nums = ss.map(function (s) { return C.parseNum(C.text(s)) })
      if (!p.follows)    p.follows    = nums[0] || 0
      if (!p.fans)       p.fans       = nums[1] || 0
      if (!p.interaction && nums.length >= 3) p.interaction = nums[2] || 0
    }
    if (p.tabFeedList.length === 0) {
      var cards = C.$$('[class*="note-item"], [class*="note-card"], [class*="feed-item"]').slice(0, 30)
      p.tabFeedList = cards.map(function (el) {
        var img = C.$('img', el)
        var t = C.$('[class*="title"], [class*="desc"]', el)
        var lk = C.$('[class*="like"], [class*="count"]', el)
        return {
          noteId: '',
          title:  C.text(t, 80),
          cover:  C.attr(img, 'src') || '',
          type:   img ? 'normal' : '',
          likes:  C.parseNum(C.text(lk)),
        }
      })
    }

    return {
      kind: 'profile',
      profile: p,
      _fallback: (p.userId === '' && p.nickname === '') && true,
    }
  }

  // ───────── 场景 3：搜索结果 ─────────
  function extractXhsSearch(scene) {
    var s = {
      keyword: scene ? scene.keyword : '',
      sortType: '',
      filters: [],
      notes: [],
      users: [],
      relatedSearches: [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        s.keyword  = s.keyword || String(state.keyword || state.query || '')
        s.sortType = String(state.sortType || state.sort || '')
        if (Array.isArray(state.filters || state.filterList)) {
          s.filters = (state.filters || state.filterList).slice(0, 50).map(function (f) {
            return typeof f === 'string' ? f : { name: String(f.name || ''), values: f.values || f.options || null }
          })
        }
        var notes = dig(state, /notes|noteResult|noteList|feeds|items|searchNotes|noteResults/i)
        if (Array.isArray(notes)) {
          s.notes = notes.slice(0, 100).map(function (x) {
            if (!x) return null
            var xu = x.user || x.creator || null
            var xi = x.interactInfo || x.interact_info || x.count || {}
            return {
              noteId:   String(x.noteId || x.note_id || x.id || ''),
              title:    String(x.displayTitle || x.title || x.display_title || ''),
              desc:     String(x.desc || x.description || '').slice(0, 200),
              cover:    pickFirst(x.cover || x.imageList && x.imageList[0]),
              type:     String(x.type || ''),
              userId:   xu ? String(xu.userId || xu.user_id || xu.id || '') : '',
              nickname: xu ? String(xu.nickname || xu.nick_name || '') : '',
              likeCount: C.parseNum(xi.likeCount || xi.likes || x.likeCount),
            }
          }).filter(Boolean)
        }
        var users = dig(state, /users|userResult|userList|searchUsers|userResults/i)
        if (Array.isArray(users)) {
          s.users = users.slice(0, 50).map(function (u) {
            return {
              userId:   String(u.userId || u.user_id || u.id || ''),
              nickname: String(u.nickname || u.nick_name || u.name || ''),
              avatar:   pickFirst(u.avatar || u.image || u.avatar_url),
              desc:     String(u.desc || u.signature || '').slice(0, 200),
              fans:     C.parseNum(u.fans || u.follower_count || u.fansCount),
              verified: !!u.officialVerified || !!u.verified,
            }
          })
        }
        var related = dig(state, /relatedSearches|suggestQueries|related|hotwords/i)
        if (Array.isArray(related)) {
          s.relatedSearches = related.slice(0, 50).map(function (r) { return typeof r === 'string' ? r : String(r.keyword || r.word || r.query || r.name || '') }).filter(Boolean)
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!s.keyword) {
      var ki = C.$('[class*="search"] input, input[placeholder*="搜索"]')
      s.keyword = C.attr(ki, 'value') || s.keyword
    }
    if (s.notes.length === 0) {
      var cards = C.$$('[class*="note-item"], [class*="note-card"], [class*="result"] [class*="item"]').slice(0, 60)
      s.notes = cards.map(function (el) {
        var img = C.$('img', el)
        var t = C.$('[class*="title"], [class*="desc"]', el)
        var lb = C.$('[class*="like-bar"], [class*="count"]', el)
        return {
          noteId:   '',
          title:    C.text(t, 120),
          desc:     '',
          cover:    C.attr(img, 'src') || '',
          type:     img ? 'normal' : '',
          userId:   '',
          nickname: '',
          likeCount: C.parseNum(C.text(lb)),
        }
      })
    }
    if (s.users.length === 0) {
      var userCards = C.$$('[class*="user-card"], [class*="search-user"]').slice(0, 30)
      s.users = userCards.map(function (el) {
        var av = C.$('img', el)
        var nn = C.$('[class*="name"], [class*="nickname"]', el)
        var ds = C.$('[class*="desc"]', el)
        return {
          userId:   '',
          nickname: C.text(nn, 60),
          avatar:   C.attr(av, 'src') || '',
          desc:     C.text(ds, 200),
          fans:     0,
          verified: false,
        }
      })
    }

    return {
      kind: 'search',
      search: s,
      _fallback: (s.notes.length === 0 && s.users.length === 0) && true,
    }
  }

  // ───────── 辅助 ─────────
  function digGlobalState() {
    try {
      var w = window
      var s = w.__INITIAL_STATE__ || w.__INIT_PROPS__ || w.__NEXT_DATA__ || w.__NUXT__ || w.__REDUX_STATE__ || null
      if (s) return s
      var tags = document.querySelectorAll('script[type="application/json"], script#state, script#__NEXT_DATA__, script[id*="INIT"]')
      for (var i = 0; i < tags.length; i++) {
        try {
          var raw = C.text(tags[i])
          if (!raw) continue
          var obj = JSON.parse(raw)
          if (obj && (obj.props || obj.state || obj.data || obj.note || obj.user)) {
            return obj.props ? (obj.props.pageProps || obj.props) : obj
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null
  }
  function dig(o /*, ...patterns */) {
    try {
      var ps = []
      for (var i = 1; i < arguments.length; i++) if (arguments[i] instanceof RegExp) ps.push(arguments[i])
      if (ps.length === 0) return o
      return digR(o, ps, 0)
    } catch (_) { return null }
  }
  function digR(o, pats, d) {
    if (o == null || d > 9) return null
    if (Array.isArray(o)) {
      for (var ai = 0; ai < o.length; ai++) {
        var r = digR(o[ai], pats, d)
        if (r != null) return r
      }
      return null
    }
    if (typeof o !== 'object') return null
    var keys = Object.keys(o)
    var lp = pats[d] || pats[pats.length - 1]
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki]
      if (lp.test(k)) {
        var hit = o[k]
        if (d + 1 < pats.length) {
          var dp = digR(hit, pats, d + 1)
          if (dp != null) return dp
        } else if (hit != null) return hit
      }
    }
    for (var ki2 = 0; ki2 < keys.length; ki2++) {
      var r2 = digR(o[keys[ki2]], pats, d)
      if (r2 != null) return r2
    }
    return null
  }
  function pickFirst(x) {
    if (x == null) return ''
    if (typeof x === 'string') return x
    if (Array.isArray(x)) {
      if (!x.length) return ''
      var first = x[0]
      if (typeof first === 'string') return first
      if (first && (first.url || first.url_default || first.urlDefault || first.src)) {
        return first.url || first.url_default || first.urlDefault || first.src || ''
      }
      return ''
    }
    if (typeof x === 'object') {
      if (x.url) return x.url
      if (x.url_default) return x.url_default
      if (x.urlDefault) return x.urlDefault
      if (x.src) return x.src
      if (Array.isArray(x.urls)) return pickFirst(x.urls)
      return ''
    }
    return ''
  }
  function normalizeComment(c) {
    if (!c) return null
    var sub = Array.isArray(c.subComments || c.sub_comments || c.subs) ? (c.subComments || c.sub_comments || c.subs).slice(0, 20).map(normalizeComment) : []
    return {
      id:        String(c.id || c.comment_id || ''),
      noteId:    String(c.noteId || c.note_id || ''),
      userId:    String(c.user && (c.user.userId || c.user.user_id) || c.user_id || ''),
      nickname:  String(c.user && (c.user.nickname || c.user.nick_name) || c.nick_name || ''),
      avatar:    pickFirst(c.user && (c.user.avatar || c.user.image) || c.avatar || c.head_url),
      content:   String(c.content || c.text || '').slice(0, 1000),
      likeCount: C.parseNum(c.likeCount || c.like_count || c.likes),
      time:      C.parseNum(c.createTime || c.create_time || 0) * 1000 || 0,
      ip:        String(c.ipLocation || c.ip_location || ''),
      subComments: sub,
    }
  }
})()
