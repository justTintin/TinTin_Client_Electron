/**
 * extractors/weixin.ts —— 微信视频号 Web 抽取脚本
 *   运行在 channels.weixin.qq.com 真实 DOM 上下文
 *   支持 3 场景：视频号主页 / 视频详情 / 直播
 *
 *   URL 模式：
 *     profile: https://channels.weixin.qq.com/pages/profile?username=...
 *              https://channels.weixin.qq.com/plain/.../profile?finderUserName=...
 *     video:   https://channels.weixin.qq.com/pages/videodetail?vid=...
 *              https://channels.weixin.qq.com/plain/.../feed?objectId=...
 *     live:    https://channels.weixin.qq.com/pages/live?roomid=...
 *              https://channels.weixin.qq.com/plain/.../live?exportkey=...
 */
var C = window.__TIN_EX_COMMON__ || __TIN_EX_COMMON__
var __TIN_EXTRACT_RESULT__ = (function () {
  var PLATFORM = 'weixin'
  var PLATFORM_NAME = '视频号'

  try {
    // ───────── ① 前置检查 ─────────
    if (C.detectNeedLogin()) {
      return C.fail('NEED_LOGIN', '请先登录微信网页版/扫码授权', '打开 channels.weixin.qq.com 时，使用手机微信扫码登录；未登录时大多数主页/视频元信息会隐藏')
    }
    if (C.detectRiskCaptcha()) {
      return C.fail('RISK_CAPTCHA', PLATFORM_NAME + '触发风控/安全验证', '请完成当前页面弹出的安全验证（短信/滑块/登录态刷新），再重试抽取')
    }

    // ───────── ② 场景识别 ─────────
    var pathname = (location.pathname || '').toLowerCase()
    var search = location.search || ''
    var scene = detectWeixinScene(pathname, search)

    // ───────── ③ 场景抽取 ─────────
    var content = null
    switch (scene.kind) {
      case 'profile':
        content = extractWeixinProfile(scene)
        break
      case 'video':
        content = extractWeixinVideo(scene)
        break
      case 'live':
        content = extractWeixinLive(scene)
        break
      default:
        content = C.makeFallbackContent()
        content.kind = 'unknown'
    }
    if (!content) {
      content = C.makeFallbackContent()
      content.kind = scene.kind || 'unknown'
    }

    return C.succ({
      source: C.makeSource(PLATFORM, { scene: scene.kind, usernameHint: scene.username, vidHint: scene.vid, roomIdHint: scene.roomId }),
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
  function detectWeixinScene(pathname, search) {
    var out = { kind: 'unknown', pathname: pathname, search: search }
    try {
      out.vid      = C.regexFirst(/[?&]vid=([^&#]+)/, search)  || C.regexFirst(/[?&]objectId=([^&#]+)/, search)
      out.username = C.regexFirst(/[?&]finderUserName=([^&#]+)/, search) || C.regexFirst(/[?&]username=([^&#]+)/, search)
      out.roomId   = C.regexFirst(/[?&]roomid=([^&#]+)/i, search) || C.regexFirst(/[?&]live_id=([^&#]+)/, search) || C.regexFirst(/[?&]exportkey=([^&#]+)/, search)

      if (out.roomId || /live(\/|\?)/i.test(pathname + search)) { out.kind = 'live'; return out }
      if (out.vid || /videodetail|\/feed|video[_-]?detail/i.test(pathname + search)) { out.kind = 'video'; return out }
      if (out.username || /profile|finder(_-)?user/i.test(pathname + search)) { out.kind = 'profile'; return out }
      // 兜底启发式
      var s2 = C.detectScene(pathname + search)
      out.kind = s2.kind
    } catch (_) {}
    return out
  }

  // ───────── 场景 1：视频号主页 ─────────
  function extractWeixinProfile(scene) {
    var profile = {
      finderUserName: scene ? scene.username : '',
      nickname:  '',
      avatar:    '',
      signature: '',
      headImg:   '',
      location:  '',
      category:  '',
      followers: 0,
      follows:   0,
      worksCount: 0,
      likedCount: 0,
      verified:  false,
      verifiedInfo: '',
      links:     [],
      latestFeeds: [],
    }

    // 1) 微信把大量 state 注入在 window.__INITIAL_STATE__ 或 hidden input
    try {
      var w = window
      var state = w.__INITIAL_STATE__ || w.__INIT_PROPS__ || w.__NUXT__ || null
      if (!state) {
        var tags = document.querySelectorAll('script[type="application/json"]')
        for (var ti = 0; ti < tags.length; ti++) {
          try {
            var obj = JSON.parse(C.text(tags[ti]) || '{}')
            if (obj && (obj.finder || obj.profile || obj.user || obj.data)) { state = obj; break }
          } catch (_) {}
        }
      }
      if (state) {
        var p = dig(state, /profile|finder|user|account/i, /info|data|detail/i)
        if (!p) p = dig(state, /profile|finder/i)
        if (p) {
          profile.finderUserName = String(p.finderUserName || p.user_name || p.username || p.openFinderId || profile.finderUserName || '')
          profile.nickname       = String(p.nickname || p.nick_name || p.name || p.finderNickname || profile.nickname || '')
          profile.avatar         = String(p.avatarUrl || p.avatar || p.headImg || p.head_img || profile.avatar || '')
          profile.headImg        = profile.avatar || profile.headImg
          profile.signature      = String(p.signature || p.signatureText || p.intro || p.description || profile.signature || '')
          profile.location       = String(p.location || p.city || p.province || profile.location || '')
          profile.category       = String(p.category || p.type_label || profile.category || '')
          profile.followers      = C.parseNum(p.followerCount || p.followers || p.fans_count)
          profile.follows        = C.parseNum(p.followCount || p.follows || p.following_count)
          profile.worksCount     = C.parseNum(p.feedCount || p.totalVideo || p.total_works || p.works_count)
          profile.likedCount     = C.parseNum(p.totalLike || p.likes || p.liked_count)
          profile.verified       = !!p.verified || !!p.certified || !!p.enterprise_certified
          profile.verifiedInfo   = String(p.verifiedInfo || p.certified_desc || '')
        }
        var feeds = dig(state, /feedList|feeds|works|videos|timeline|mediaList/i)
        if (Array.isArray(feeds)) {
          profile.latestFeeds = feeds.slice(0, 20).map(function (f) {
            return normalizeFeed(f)
          })
        }
      }
    } catch (_) {}

    // 2) DOM 兜底
    if (!profile.nickname) {
      var n = C.$('[class*="nickname"], h1, [class*="name"]')
      profile.nickname = C.text(n, 60)
    }
    if (!profile.avatar) {
      var av = C.$('[class*="avatar"] img, [class*="Avatar"] img, img[class*="avatar"]')
      profile.avatar = C.attr(av, 'src') || profile.avatar
    }
    if (!profile.signature) {
      var sig = C.$('[class*="signature"], [class*="Signature"], [class*="intro"]')
      profile.signature = C.text(sig, 300)
    }
    // 关注/粉丝/作品 数字类兜底
    if (!profile.followers || !profile.worksCount) {
      var stats = C.$$('[class*="stat"] [class*="count"], [class*="Stat"] [class*="value"], [class*="metrics"] span[class*="num"]')
      if (stats.length >= 3) {
        var nums = stats.map(function (s) { return C.parseNum(C.text(s)) })
        if (!profile.worksCount) profile.worksCount = nums[0] || 0
        if (!profile.likedCount) profile.likedCount = nums[1] || 0
        if (!profile.followers && nums.length >= 3) profile.followers = nums[2] || 0
      }
    }

    return {
      kind: 'profile',
      profile: profile,
      _fallback: (profile.finderUserName === '' && profile.nickname === '') && true,
    }
  }

  // ───────── 场景 2：视频详情 ─────────
  function extractWeixinVideo(scene) {
    var v = {
      objectId: scene ? scene.vid : '',
      nonceId:  '',
      vid:      '',
      desc:     '',
      coverUrl: '',
      mediaUrl: '',
      hlsUrl:   '',
      mp4Url:   '',
      duration: 0,
      width:    0,
      height:   0,
      size:     0,
      createTime: 0,
      finder:   null,    // 视频号发布者
      statistics: { like: 0, comment: 0, share: 0, favorite: 0, watch: 0 },
      tags:     [],
      location: '',
      poi:      null,
      comments: [],
      products: [],   // 带货商品
      topicList: [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var feed = dig(state, /videoData|videoInfo|feed|objectInfo|mediaDetail/i)
        if (!feed && state.data && state.data.feed) feed = state.data.feed
        if (!feed && state.data && state.data.video) feed = state.data.video
        if (feed) {
          v.objectId   = String(feed.objectId || feed.object_id || feed.vid || feed.id || v.objectId || '')
          v.nonceId    = String(feed.nonceId || feed.nonce_id || v.nonceId || '')
          v.vid        = String(feed.vid || v.vid || '')
          v.desc       = String(feed.desc || feed.description || feed.title || v.desc || '')
          v.coverUrl   = String(feed.coverUrl || feed.cover || feed.thumb_url || v.coverUrl || '')
          v.mediaUrl   = String(feed.mediaUrl || feed.media_url || v.mediaUrl || '')
          v.hlsUrl     = String(feed.hlsUrl || feed.hls_url || '')
          v.mp4Url     = String(feed.mp4Url || feed.mp4_url || v.mp4Url || '')
          v.duration   = C.parseNum(feed.durationMs || feed.duration || 0)
          if (v.duration > 10000) v.duration = Math.round(v.duration / 1000)
          v.width      = C.parseNum(feed.width)
          v.height     = C.parseNum(feed.height)
          v.size       = C.parseNum(feed.size || feed.media_size)
          v.createTime = C.parseNum(feed.createTime || feed.timestamp || 0) * 1000 || 0
          v.location   = String(feed.location || feed.city || '')
          if (feed.finderUserName || feed.finder) {
            var fn = feed.finder || {}
            v.finder = {
              finderUserName: String(feed.finderUserName || fn.userName || fn.username || ''),
              nickname:       String(feed.finderNickname || fn.nickname || fn.nick_name || ''),
              avatar:         String(feed.finderAvatar || fn.avatar || fn.head_img || ''),
            }
          }
          var st = feed.statistics || feed.stats || feed.stat || {}
          v.statistics = {
            like:     C.parseNum(st.likeCount || st.likes || st.digg),
            comment:  C.parseNum(st.commentCount || st.comments),
            share:    C.parseNum(st.shareCount || st.shares),
            favorite: C.parseNum(st.favCount || st.favorites || st.collect),
            watch:    C.parseNum(st.readCount || st.watch || st.play),
          }
          if (Array.isArray(feed.topicList)) v.topicList = feed.topicList.slice(0, 50).map(function (t) { return String(t.title || t.name || t) })
          if (Array.isArray(feed.tagList || feed.tags)) {
            v.tags = (feed.tagList || feed.tags).slice(0, 50).map(function (t) { return typeof t === 'string' ? t : (t && (t.name || t.tag)) || '' })
          }
          if (feed.poiInfo || feed.poi) {
            var poi = feed.poiInfo || feed.poi
            v.poi = { name: String(poi.name || poi.poi_name || ''), address: String(poi.address || ''), lon: poi.lon || 0, lat: poi.lat || 0 }
          }
          if (Array.isArray(feed.commentList || feed.comments)) {
            var cs = feed.commentList || feed.comments
            v.comments = cs.slice(0, 30).map(function (c) {
              return {
                nickname: String(c.nickName || c.nickname || ''),
                avatar:   String(c.avatar || c.headImg || ''),
                content:  String(c.content || c.text || '').slice(0, 500),
                like:     C.parseNum(c.likeCount || c.likes),
                time:     C.parseNum(c.createTime || c.timestamp) * 1000 || 0,
              }
            })
          }
          if (Array.isArray(feed.productList || feed.goodsList)) {
            var ps = feed.productList || feed.goodsList
            v.products = ps.slice(0, 30).map(function (p) {
              return {
                productId: String(p.product_id || p.id || ''),
                title:     String(p.title || p.name || '').slice(0, 160),
                cover:     String(p.cover || p.img || ''),
                price:     C.parseNum(p.price || p.sale_price || 0),
              }
            })
          }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!v.desc) {
      var d = C.$('[class*="desc"], [class*="Desc"], [class*="video-desc"]')
      v.desc = C.text(d, 400)
    }
    if (!v.mp4Url) {
      var video = C.$('video[src]')
      if (video) v.mp4Url = C.attr(video, 'src')
    }
    if (!v.coverUrl) {
      var vp = C.$('video[poster]')
      if (vp) v.coverUrl = C.attr(vp, 'poster')
      if (!v.coverUrl) {
        var ci = C.$('[class*="cover"] img, img[class*="Cover"]')
        v.coverUrl = C.attr(ci, 'src') || v.coverUrl
      }
    }
    if (!v.finder || !v.finder.nickname) {
      var fBox = C.$('[class*="finder-user"], [class*="author"]')
      if (fBox) {
        v.finder = v.finder || {}
        if (!v.finder.nickname) {
          var nn = C.$('[class*="nickname"], [class*="name"]', fBox)
          v.finder.nickname = C.text(nn, 60)
        }
        if (!v.finder.avatar) {
          var av = C.$('img', fBox)
          v.finder.avatar = C.attr(av, 'src')
        }
      }
    }
    if (!v.statistics.like || !v.statistics.comment) {
      var act = C.$('[class*="action"], [class*="ActionBar"]')
      if (act) {
        var ls = C.$$('[class*="like"] span, [class*="Like"] [class*="count"]', act)
        var cs = C.$$('[class*="comment"] span, [class*="Comment"] [class*="count"]', act)
        var ss = C.$$('[class*="share"] span, [class*="Share"] [class*="count"]', act)
        v.statistics.like    = v.statistics.like    || C.parseNum(C.text(ls[0]))
        v.statistics.comment = v.statistics.comment || C.parseNum(C.text(cs[0]))
        v.statistics.share   = v.statistics.share   || C.parseNum(C.text(ss[0]))
      }
    }

    return {
      kind: 'video',
      video: v,
      _fallback: (v.objectId === '') && true,
    }
  }

  // ───────── 场景 3：直播 ─────────
  function extractWeixinLive(scene) {
    var live = {
      liveId:    scene ? scene.roomId : '',
      roomId:    scene ? scene.roomId : '',
      title:     '',
      cover:     '',
      status:    'live',
      startTime: 0,
      viewers:   0,
      totalViewers: 0,
      likes:     0,
      shares:    0,
      comments:  0,
      anchor:    null,
      replay:    false,
      productList: [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var r = dig(state, /liveInfo|liveRoom|liveRoomInfo|roomInfo|liveDetail/i)
        if (r) {
          live.liveId    = String(r.live_id || r.liveId || r.id || live.liveId || '')
          live.roomId    = live.liveId || live.roomId
          live.title     = String(r.title || r.name || live.title || '')
          live.cover     = String(r.coverUrl || r.cover || r.cover_img || live.cover || '')
          live.status    = r.status === 1 || r.status === 'living' ? 'live' : (r.status === 2 ? 'replay' : 'offline')
          live.replay    = live.status === 'replay'
          live.startTime = C.parseNum(r.start_time || r.createTime || r.startTime) * 1000 || 0
          live.viewers   = C.parseNum(r.viewer || r.online_users || r.onlineUserCount || r.current_viewers)
          live.totalViewers = C.parseNum(r.total_viewer || r.total_users || r.totalViewers)
          live.likes     = C.parseNum(r.like_count || r.likes)
          live.shares    = C.parseNum(r.share_count || r.shares)
          live.comments  = C.parseNum(r.comment_count || r.comments)
          if (r.anchor || r.finder || r.host) {
            var a = r.anchor || r.finder || r.host
            live.anchor = {
              finderUserName: String(a.finderUserName || a.user_name || a.username || ''),
              nickname:       String(a.nickname || a.nick_name || a.name || ''),
              avatar:         String(a.avatar || a.headImg || a.head_img || ''),
              followers:      C.parseNum(a.follower_count || a.fans || 0),
            }
          }
          if (Array.isArray(r.productList || r.goodsList)) {
            var ps = r.productList || r.goodsList
            live.productList = ps.slice(0, 30).map(function (p) {
              return {
                productId: String(p.product_id || p.id || ''),
                title:     String(p.title || p.name || '').slice(0, 160),
                cover:     String(p.cover || p.img || ''),
                price:     C.parseNum(p.price || p.sale_price || 0),
                priceYuan: null,
              }
            })
          }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!live.title) {
      var t = C.$('[class*="title"], h1, [class*="room-title"]')
      live.title = C.text(t, 200)
    }
    if (!live.viewers) {
      var v = C.$('[class*="viewer"], [class*="online"], [class*="user-count"]')
      live.viewers = C.parseNum(C.text(v))
    }
    if (!live.anchor || !live.anchor.nickname) {
      var ab = C.$('[class*="anchor"], [class*="host-name"]')
      if (ab) {
        live.anchor = live.anchor || {}
        live.anchor.nickname = live.anchor.nickname || C.text(C.$('[class*="name"]', ab) || ab, 60)
      }
    }

    return {
      kind: 'live',
      live: live,
      _fallback: (live.liveId === '' && live.title === '') && true,
    }
  }

  // ───────── 辅助 ─────────
  function digGlobalState() {
    try {
      var w = window
      var s = w.__INITIAL_STATE__ || w.__INIT_PROPS__ || w.__NUXT__ || w.__DATA__ || null
      if (s) return s
      var tags = document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__')
      for (var i = 0; i < tags.length; i++) {
        try {
          var raw = C.text(tags[i])
          if (!raw) continue
          var obj = JSON.parse(raw)
          if (obj && (obj.props || obj.data || obj.state || obj.finder || obj.profile || obj.videoInfo || obj.liveInfo)) {
            return obj.props ? (obj.props.pageProps || obj.props) : obj
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null
  }
  function dig(obj /*, ...patterns */) {
    try {
      var patterns = []
      for (var i = 1; i < arguments.length; i++) {
        if (arguments[i] instanceof RegExp) patterns.push(arguments[i])
      }
      if (patterns.length === 0) return obj
      return digRec(obj, patterns, 0)
    } catch (_) { return null }
  }
  function digRec(o, pats, d) {
    if (o == null || d > 8) return null
    if (Array.isArray(o)) {
      for (var ai = 0; ai < o.length; ai++) {
        var r = digRec(o[ai], pats, d)
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
          var deeper = digRec(hit, pats, d + 1)
          if (deeper != null) return deeper
        } else if (hit != null) return hit
      }
    }
    for (var ki2 = 0; ki2 < keys.length; ki2++) {
      var r2 = digRec(o[keys[ki2]], pats, d)
      if (r2 != null) return r2
    }
    return null
  }
  function normalizeFeed(f) {
    if (!f) return null
    return {
      objectId: String(f.objectId || f.object_id || f.vid || f.id || ''),
      nonceId:  String(f.nonceId || f.nonce_id || ''),
      desc:     String(f.desc || f.description || '').slice(0, 200),
      cover:    String(f.coverUrl || f.cover || f.thumb_url || ''),
      duration: C.parseNum(f.durationMs || f.duration || 0) > 10000 ? Math.round(C.parseNum(f.durationMs || f.duration || 0) / 1000) : C.parseNum(f.durationMs || f.duration || 0),
      statistics: f.statistics ? {
        like:    C.parseNum(f.statistics.likeCount),
        comment: C.parseNum(f.statistics.commentCount),
        share:   C.parseNum(f.statistics.shareCount),
      } : { like: C.parseNum(f.likeCount), comment: C.parseNum(f.commentCount), share: C.parseNum(f.shareCount) },
    }
  }
})()
