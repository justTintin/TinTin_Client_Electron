/**
 * extractors/bilibili.ts —— B 站 Web 抽取脚本
 *   运行在 www.bilibili.com 真实 DOM 上下文
 *   支持 4 场景：视频详情 / UP 主页 / 番剧 / 专栏
 *
 *   URL 模式：
 *     video:    https://www.bilibili.com/video/BVxxxxxxxx
 *               https://www.bilibili.com/video/avxxxxxx
 *               https://m.bilibili.com/bangumi/play/epxxx → 仍按番剧处理
 *     profile:  https://space.bilibili.com/:mid
 *               https://www.bilibili.com/space/:mid
 *     bangumi:  https://www.bilibili.com/bangumi/play/epxxx
 *               https://www.bilibili.com/bangumi/play/ssxxxx
 *     article:  https://www.bilibili.com/read/cvxxxxxx
 *               https://www.bilibili.com/opus/xxxx（动态图文，按专栏近似处理）
 */
var C = window.__TIN_EX_COMMON__ || __TIN_EX_COMMON__
var __TIN_EXTRACT_RESULT__ = (function () {
  var PLATFORM = 'bilibili'
  var PLATFORM_NAME = 'B站'

  try {
    // ───────── ① 前置检查 ─────────
    if (C.detectNeedLogin()) {
      return C.fail('NEED_LOGIN', '请先登录' + PLATFORM_NAME, '扫码或密码登录后重试；未登录时部分清晰度/番剧/专栏内容会被限制或降级')
    }
    if (C.detectRiskCaptcha()) {
      return C.fail('RISK_CAPTCHA', PLATFORM_NAME + '触发了风控/验证码', '请完成当前页面弹出的极验/滑块验证，稍后再重试')
    }

    // ───────── ② 场景识别 ─────────
    var pathname = (location.pathname || '').toLowerCase()
    var host = (location.hostname || '').toLowerCase()
    var scene = detectBiliScene(pathname, host)

    // ───────── ③ 按场景抽取 ─────────
    var content = null
    switch (scene.kind) {
      case 'video':    content = extractBiliVideo(scene);    break
      case 'profile':  content = extractBiliProfile(scene);  break
      case 'bangumi':  content = extractBiliBangumi(scene);  break
      case 'article':  content = extractBiliArticle(scene);  break
      default:
        content = C.makeFallbackContent()
        content.kind = 'unknown'
    }
    if (!content) {
      content = C.makeFallbackContent()
      content.kind = scene.kind || 'unknown'
    }

    return C.succ({
      source: C.makeSource(PLATFORM, { scene: scene.kind, host: host }),
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
  function detectBiliScene(pathname, host) {
    var out = { kind: 'unknown', host: host, pathname: pathname }
    try {
      out.bvid  = C.regexFirst(/\/video\/(BV[a-zA-Z0-9]+)/i, pathname)
      out.aid   = C.regexFirst(/\/video\/(av\d+)/i, pathname)
      out.mid   = C.regexFirst(/space\.bilibili\.com\/(\d+)/i, host + pathname) || C.regexFirst(/\/space\/(\d+)/i, pathname)
      out.epId  = C.regexFirst(/\/bangumi\/play\/(ep\d+)/i, pathname)
      out.ssId  = C.regexFirst(/\/bangumi\/play\/(ss\d+)/i, pathname)
      out.cvId  = C.regexFirst(/\/read\/(cv\d+)/i, pathname)
      out.opusId= C.regexFirst(/\/opus\/(\d+)/i, pathname)

      // 番剧优先于普通视频（/bangumi/play/ 路径）
      if (out.epId || out.ssId || /\/bangumi\//i.test(pathname)) { out.kind = 'bangumi'; return out }
      if (out.cvId) { out.kind = 'article'; return out }
      if (out.opusId) { out.kind = 'article'; out.articleType = 'opus'; return out }
      if (out.bvid || out.aid || /\/video\//i.test(pathname)) { out.kind = 'video'; return out }
      if (out.mid || /space\.bilibili\.com/i.test(host) || /\/space\//i.test(pathname)) { out.kind = 'profile'; return out }
      var s2 = C.detectScene(pathname)
      out.kind = s2.kind
    } catch (_) {}
    return out
  }

  // ───────── 场景 1：视频详情（/video/BVxxx） ─────────
  function extractBiliVideo(scene) {
    var v = {
      bvid:    scene ? scene.bvid : '',
      aid:     0,
      title:   '',
      desc:    '',
      cover:   '',
      duration: 0,   // 秒
      pubdate: 0,    // ms
      ctime:   0,
      owner:   null, // UP 主
      stat:    { aid: 0, view: 0, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0, nowRank: 0, hisRank: 0 },
      pages:   [],   // 分 P
      videos:  1,
      tid:     0,
      tname:   '',
      tags:    [],
      cid:     0,
      videoUrl: '',
      upInfo:  null, // 合集/系列信息（如果有）
      staff:   [],   // 联合投稿成员
      rights:  null,
    }

    try {
      var state = digGlobalState()
      if (state) {
        var vd = dig(state, /videoData|videoInfo|viewData/i)
        if (!vd) vd = dig(state, /data/i, /view/i)
        if (vd && (vd.bvid || vd.aid || vd.title)) {
          v.bvid     = String(vd.bvid || v.bvid || '')
          v.aid      = C.parseNum(vd.aid)
          v.title    = String(vd.title || v.title || '')
          v.desc     = String(vd.desc || v.desc || '')
          v.cover    = String(vd.pic || vd.cover || v.cover || '')
          v.duration = C.parseNum(vd.duration)
          v.pubdate  = C.parseNum(vd.pubdate) * 1000 || 0
          v.ctime    = C.parseNum(vd.ctime) * 1000 || 0
          v.tid      = C.parseNum(vd.tid)
          v.tname    = String(vd.tname || '')
          v.cid      = C.parseNum(vd.cid)
          v.videos   = C.parseNum(vd.videos || 1)
          if (vd.owner) {
            v.owner = {
              mid:      C.parseNum(vd.owner.mid),
              name:     String(vd.owner.name || ''),
              face:     String(vd.owner.face || ''),
              follower: C.parseNum(vd.owner.follower || 0),
            }
          }
          if (vd.stat) {
            v.stat = {
              aid:     C.parseNum(vd.stat.aid),
              view:    C.parseNum(vd.stat.view),
              danmaku: C.parseNum(vd.stat.danmaku),
              reply:   C.parseNum(vd.stat.reply),
              favorite:C.parseNum(vd.stat.favorite),
              coin:    C.parseNum(vd.stat.coin),
              share:   C.parseNum(vd.stat.share),
              like:    C.parseNum(vd.stat.like),
              nowRank: C.parseNum(vd.stat.now_rank),
              hisRank: C.parseNum(vd.stat.his_rank),
            }
          }
          if (Array.isArray(vd.pages)) {
            v.pages = vd.pages.slice(0, 200).map(function (p) {
              return { cid: C.parseNum(p.cid), page: C.parseNum(p.page), part: String(p.part || ''), duration: C.parseNum(p.duration) }
            })
          }
          if (Array.isArray(vd.staff)) {
            v.staff = vd.staff.map(function (s) {
              return { mid: C.parseNum(s.mid), name: String(s.name || ''), face: String(s.face || ''), title: String(s.title || '') }
            })
          }
          if (vd.rights) v.rights = { bp: !!vd.rights.bp, elec: !!vd.rights.elec, download: !!vd.rights.download, movie: !!vd.rights.movie, pay: !!vd.rights.pay }
        }
        // 标签
        var tags = dig(state, /tags|tagList/i)
        if (Array.isArray(tags)) {
          v.tags = tags.slice(0, 50).map(function (t) { return { tagId: C.parseNum(t.tag_id || t.id), tagName: String(t.tag_name || t.name || '') } })
        }
        // 合集/系列
        var upg = dig(state, /ugcSeason|ugc_season|sections/i)
        if (upg && upg.sections) {
          v.upInfo = { seasonTitle: String(upg.title || ''), episodesCount: C.parseNum(upg.episodes_count || 0) }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!v.title) {
      var t = C.$('h1.video-title, h1[title], .video-title, [class*="video-title"]')
      v.title = C.text(t, 200) || C.attr(t, 'title')
    }
    if (!v.cover) {
      var img = C.$('[class*="video-cover"] img, .bpx-player-cover img, meta[itemprop="thumbnailUrl"]')
      v.cover = C.attr(img, 'src') || C.attr(img, 'content')
    }
    if (!v.desc) {
      var d = C.$('[class*="desc-info"], .basic-desc-info, [class*="video-desc"]')
      v.desc = C.text(d, 2000)
    }
    if (!v.owner || !v.owner.name) {
      var uBox = C.$('[class*="up-name"], .up-detail-top a, [class*="upinfo"] a')
      if (uBox) {
        v.owner = v.owner || {}
        v.owner.name = v.owner.name || C.text(uBox, 60)
        v.owner.mid  = v.owner.mid  || C.parseNum(C.regexFirst(/space\.bilibili\.com\/(\d+)/, C.attr(uBox, 'href')))
      }
    }
    if (!v.stat.view || !v.stat.like) {
      var viewEl = C.$('[class*="view-text"], .video-data [class*="view"], [class*="play-count"]')
      var dmEl   = C.$('[class*="dm-text"], .video-data [class*="dm"]')
      if (viewEl) v.stat.view    = v.stat.view    || C.parseNum(C.text(viewEl))
      if (dmEl)   v.stat.danmaku = v.stat.danmaku || C.parseNum(C.text(dmEl))
      var likeEl = C.$('[class*="like-text"], .like-info, [class*="like"] [class*="count"]')
      var coinEl = C.$('[class*="coin-text"], .coin-info')
      var favEl  = C.$('[class*="collect-text"], .collect-info')
      var shareEl= C.$('[class*="share-text"], .share-info')
      if (likeEl)  v.stat.like     = v.stat.like     || C.parseNum(C.text(likeEl))
      if (coinEl)  v.stat.coin     = v.stat.coin     || C.parseNum(C.text(coinEl))
      if (favEl)   v.stat.favorite = v.stat.favorite || C.parseNum(C.text(favEl))
      if (shareEl) v.stat.share    = v.stat.share    || C.parseNum(C.text(shareEl))
    }
    if (!v.duration) {
      var durEl = C.$('[class*="duration"], .video-duration')
      v.duration = C.parseNum(C.text(durEl))
    }
    if (v.tags.length === 0) {
      var tagEls = C.$$('[class*="tag-link"], .tag-item a, .tag-panel a').slice(0, 50)
      v.tags = tagEls.map(function (el) { return { tagId: 0, tagName: C.text(el, 40) } })
    }

    return {
      kind: 'video',
      video: v,
      _fallback: (v.bvid === '' && v.title === '') && true,
    }
  }

  // ───────── 场景 2：UP 主页（space.bilibili.com/:mid） ─────────
  function extractBiliProfile(scene) {
    var p = {
      mid:       scene ? C.parseNum(scene.mid) : 0,
      name:      '',
      face:      '',
      sign:      '',
      level:     0,
      sex:       '',
      birthday:  '',
      fans:      0,
      friend:    0,      // 关注数
      attention: 0,
      archiveCount: 0,   // 投稿数
      articleCount: 0,
      likesTotal: 0,     // 获赞
      viewTotal:  0,     // 总播放（如果有）
      officialVerify: '',
      vipType:   0,
      vipLabel:  '',
      following: false,
      videos:    [],
      live:      null,   // 直播间信息（若有）
    }

    try {
      var state = digGlobalState()
      if (state) {
        var card = dig(state, /spaceHeaderData|userInfo|masterInfo|cardData/i)
        if (!card) card = dig(state, /card/i, /master/i)
        if (card) {
          p.mid      = C.parseNum(card.mid) || p.mid
          p.name     = String(card.name || p.name || '')
          p.face     = String(card.face || card.avatar || p.face || '')
          p.sign     = String(card.sign || card.description || p.sign || '')
          p.level    = C.parseNum(card.level || (card.level_info && card.level_info.current_level))
          p.sex      = String(card.sex || '')
          p.birthday = String(card.birthday || '')
          p.fans     = C.parseNum(card.fans || (card.follower || 0) || (card.fans_num))
          p.friend   = C.parseNum(card.friend || card.following || 0)
          p.attention= p.friend || C.parseNum(card.attention || 0)
          p.likesTotal = C.parseNum(card.likes_total || card.likeNum || card.likes)
          if (card.Official || card.official) {
            var of = card.Official || card.official
            p.officialVerify = String((of.title || of.desc || '') + (of.type === 0 ? '' : (of.type === 1 ? '（官方认证）' : '（个人认证）')))
          }
          p.vipType  = C.parseNum(card.vipType || card.vip_type || 0)
          p.vipLabel = String(card.vipLabel || card.vip_label || '')
        }
        // 投稿数
        var arc = dig(state, /archiveStat|archive/i)
        if (arc && typeof arc === 'object' && !arc.bvid) {
          p.archiveCount = C.parseNum(arc.archive_count || arc.archiveCount || arc.current_archive || 0)
          p.articleCount = C.parseNum(arc.article_count || arc.articleCount || 0)
          p.viewTotal    = C.parseNum(arc.total_view || arc.view_count || 0)
        }
        // 视频列表
        var vids = dig(state, /videoList|videos|arcList|newVideoList/i)
        if (Array.isArray(vids)) {
          p.videos = vids.slice(0, 60).map(function (x) {
            if (!x) return null
            return {
              bvid:     String(x.bvid || x.bv_id || ''),
              title:    String(x.title || ''),
              cover:    String(x.pic || x.cover || ''),
              duration: C.parseNum(x.duration || x.length && (typeof x.length === 'string' ? parseTime(x.length) : x.length)),
              play:     C.parseNum(x.play || (x.stat && x.stat.view) || 0),
              created:  C.parseNum(x.created || x.create_time || 0) * 1000 || 0,
              desc:     String(x.description || x.desc || '').slice(0, 200),
            }
          }).filter(Boolean)
        }
        // 直播间
        var lv = dig(state, /liveInfo|liveRoom/i)
        if (lv && (lv.roomid || lv.liveStatus)) {
          p.live = {
            roomid:    C.parseNum(lv.roomid || lv.roomId || 0),
            url:       String(lv.url || ''),
            title:     String(lv.title || ''),
            liveStatus: C.parseNum(lv.liveStatus || 0),
          }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!p.name) {
      var n = C.$('h1.h-name, [class*="h-name"], .user-name, h1')
      p.name = C.text(n, 60)
    }
    if (!p.face) {
      var av = C.$('[class*="h-avatar"] img, .avatar img, [class*="avatar"] img')
      p.face = C.attr(av, 'src')
    }
    if (!p.sign) {
      var sig = C.$('[class*="h-sign"], .user-sign')
      p.sign = C.text(sig, 300)
    }
    if (!p.fans || !p.archiveCount) {
      var nums = C.$$('[class*="n-statistics"] [class*="n-data-v"], .n-data-v, [class*="stat"] [class*="value"]')
      if (nums.length >= 2) {
        var ns = nums.map(function (s) { return C.parseNum(C.text(s)) })
        if (!p.fans)        p.fans        = ns[0] || 0
        if (!p.archiveCount && ns.length >= 2) p.archiveCount = ns[1] || 0
      }
    }
    if (p.videos.length === 0) {
      var cards = C.$$('[class*="small-item"], .video-card, [class*="cube-list"] li').slice(0, 30)
      p.videos = cards.map(function (el) {
        var img = C.$('img', el)
        var t = C.$('[class*="title"], a[title]', el)
        var pl = C.$('[class*="play"], [class*="view"]', el)
        return {
          bvid: C.regexFirst(/(BV[a-zA-Z0-9]+)/, C.attr(C.$('a[href]', el), 'href')),
          title: C.text(t, 120) || C.attr(t, 'title'),
          cover: C.attr(img, 'src') || C.attr(img, 'data-src'),
          duration: 0,
          play: C.parseNum(C.text(pl)),
          created: 0,
          desc: '',
        }
      })
    }

    return {
      kind: 'profile',
      profile: p,
      _fallback: (p.mid === 0 && p.name === '') && true,
    }
  }

  // ───────── 场景 3：番剧（/bangumi/play/epxxx 或 ssxxx） ─────────
  function extractBiliBangumi(scene) {
    var b = {
      epId:      scene ? (scene.epId || '') : '',
      ssId:      scene ? (scene.ssId || '') : '',
      mediaId:   0,
      seasonId:  0,
      title:     '',
      longTitle: '',     // 当前集标题
      cover:     '',
      evaluate:  '',     // 简介
      areas:     [],
      styles:    [],
      pubTime:   '',
      newestEp:  '',
      totalEps:  0,
      rating:    null,   // { score, count }
      episodes:  [],     // 分集
      staff:     [],     // 制作人员/声优
      actor:     [],
      watchStatus: '',
      progress:  '',     // 观看进度（如果有）
      stat:      { follow: 0, play: 0 },
      badge:     '',
    }

    try {
      var state = digGlobalState()
      if (state) {
        var m = dig(state, /mediaInfo|mediainfo|seasonInfo|bangumiInfo/i)
        if (!m) m = dig(state, /media/i, /info/i)
        if (m && (m.media_id || m.season_id || m.title)) {
          b.mediaId  = C.parseNum(m.media_id || m.mediaId)
          b.seasonId = C.parseNum(m.season_id || m.seasonId)
          b.ssId     = String(m.season_id || b.ssId || '')
          b.title    = String(m.title || b.title || '')
          b.cover    = String(m.cover || m.horizontal_cover || b.cover || '')
          b.evaluate = String(m.evaluate || m.description || b.evaluate || '')
          if (Array.isArray(m.areas))  b.areas  = m.areas.map(function (x) { return String(x.name || x) })
          if (Array.isArray(m.styles)) b.styles = m.styles.map(function (x) { return String(x.name || x) })
          b.pubTime  = String(m.pub_time || m.publish_date || '')
          b.newestEp = String(m.newest_ep && (m.newest_ep.desc || m.newest_ep.index) || '')
          b.totalEps = C.parseNum(m.total_ep || m.newest_ep && m.newest_ep.index || 0)
          if (m.rating && m.rating.score) {
            b.rating = { score: C.parseNum(m.rating.score), count: C.parseNum(m.rating.count) }
          }
          if (m.stat && typeof m.stat === 'object') {
            b.stat.follow = C.parseNum(m.stat.follow || m.stat.views)
            b.stat.play   = C.parseNum(m.stat.play || m.stat.views || 0)
          }
          b.badge = String(m.badge || m.badge_info && m.badge_info.text || '')
          if (Array.isArray(m.staff)) {
            b.staff = m.staff.slice(0, 50).map(function (s) { return { title: String(s.title || ''), name: String(s.name || '') } })
          }
          if (Array.isArray(m.actor)) {
            b.actor = m.actor.slice(0, 50).map(function (s) { return { title: String(s.title || ''), name: String(s.name || '') } })
          }
          if (Array.isArray(m.episodes)) {
            b.episodes = m.episodes.slice(0, 200).map(function (e) {
              return {
                epId:   String(e.ep_id || e.id || ''),
                title:  String(e.title || ''),
                longTitle: String(e.long_title || ''),
                cover:  String(e.cover || ''),
                duration: C.parseNum(e.duration || 0),
                badge:  String(e.badge || ''),
                status: C.parseNum(e.status || 0),
              }
            })
          }
        }
        // 当前播放的集
        var ep = dig(state, /epInfo|currentEpisode|ep_info/i)
        if (ep && (ep.ep_id || ep.id)) {
          b.epId      = String(ep.ep_id || ep.id || b.epId || '')
          b.longTitle = String(ep.long_title || ep.title || b.longTitle || '')
        }
        // 观看进度
        var pg = dig(state, /progress|watchProgress/i)
        if (pg && pg.last_ep_index) {
          b.progress = String(pg.last_ep_index || '')
          b.watchStatus = String(pg.watch_status_text || '')
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!b.title) {
      var t = C.$('h1[title], [class*="media-title"], h1')
      b.title = C.text(t, 200) || C.attr(t, 'title')
    }
    if (!b.longTitle) {
      var lt = C.$('[class*="episode-title"], .player-title, h2')
      b.longTitle = C.text(lt, 120)
    }
    if (!b.cover) {
      var img = C.$('[class*="media-banner"] img, [class*="cover"] img')
      b.cover = C.attr(img, 'src')
    }
    if (!b.evaluate) {
      var ev = C.$('[class*="evaluate"], [class*="media-desc"]')
      b.evaluate = C.text(ev, 500)
    }
    if (b.episodes.length === 0) {
      var eps = C.$$('[class*="ep-item"], [class*="episode-item"]').slice(0, 100)
      b.episodes = eps.map(function (el) {
        var tEl = C.$('[class*="title"], [class*="long-title"]', el)
        return {
          epId: C.attr(el, 'data-ep-id') || '',
          title: C.text(el, 40),
          longTitle: C.text(tEl, 120),
          cover: '',
          duration: 0,
          badge: C.text(C.$('[class*="badge"]', el), 20),
          status: 0,
        }
      })
    }
    if (!b.rating) {
      var rt = C.$('[class*="media-score"], [class*="score"]')
      var sc = C.parseNum(C.text(C.$('[class*="score-num"], [class*="scoreValue"]', rt) || rt))
      if (sc > 0) b.rating = { score: sc, count: 0 }
    }

    return {
      kind: 'bangumi',
      bangumi: b,
      _fallback: (b.epId === '' && b.ssId === '' && b.title === '') && true,
    }
  }

  // ───────── 场景 4：专栏（/read/cvxxx 或 /opus/xxx） ─────────
  function extractBiliArticle(scene) {
    var a = {
      cvId:       scene ? (scene.cvId || '') : '',
      opusId:     scene && scene.articleType === 'opus' ? (scene.opusId || '') : '',
      articleType: scene && scene.articleType === 'opus' ? 'opus' : 'cv',
      title:      '',
      author:     null,
      pubdate:    0,
      words:      0,
      readCount:  0,
      likeCount:  0,
      replyCount: 0,
      shareCount: 0,
      favoriteCount: 0,
      coinCount:  0,
      contentHTML: '',
      contentText: '',
      images:     [],
      categories: [],
      tags:       [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var ar = dig(state, /articleInfo|readInfo|opusInfo|articleData/i)
        if (!ar) ar = dig(state, /article/i, /info/i)
        if (ar && (ar.id || ar.title)) {
          a.cvId   = String(ar.id || ar.cv_id || a.cvId || '')
          a.title  = String(ar.title || a.title || '')
          a.pubdate= C.parseNum(ar.publish_time || ar.pubdate || ar.ptime) * 1000 || 0
          a.words  = C.parseNum(ar.words || ar.word_num)
          if (ar.author || ar.mid) {
            var au = ar.author || {}
            a.author = {
              mid:  C.parseNum(au.mid || ar.mid || ar.author_mid),
              name: String(au.name || ar.author_name || ''),
              face: String(au.face || ar.author_face || ''),
              followers: C.parseNum(au.follower || 0),
            }
          }
          var st = ar.stats || ar.stat || {}
          a.readCount     = C.parseNum(st.view || st.read || ar.read)
          a.likeCount     = C.parseNum(st.like || ar.like)
          a.replyCount    = C.parseNum(st.reply || ar.reply)
          a.shareCount    = C.parseNum(st.share || ar.share)
          a.favoriteCount = C.parseNum(st.favorite || st.fav || ar.favorite)
          a.coinCount     = C.parseNum(st.coin || ar.coin)
          a.contentHTML   = String(ar.content || ar.content_html || '')
          if (Array.isArray(ar.categories)) a.categories = ar.categories.map(function (x) { return String(x.name || x) })
          if (Array.isArray(ar.tags))       a.tags       = ar.tags.map(function (x) { return String(x.name || x) })
          // 从 HTML 里抽图片
          if (a.contentHTML) {
            var mImg
            var re = /<img[^>]+src="([^"]+)"/g
            while ((mImg = re.exec(a.contentHTML)) !== null) {
              if (a.images.length >= 100) break
              a.images.push(mImg[1])
            }
          }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!a.title) {
      var t = C.$('h1.title, h1[title], .opus-module-title, h1')
      a.title = C.text(t, 200)
    }
    if (!a.author || !a.author.name) {
      var uBox = C.$('[class*="author-name"], .up-name, [class*="up-name"]')
      if (uBox) {
        a.author = a.author || {}
        a.author.name = a.author.name || C.text(uBox, 60)
      }
    }
    if (!a.contentHTML) {
      var ct = C.$('.article-content, .opus-module-content, [class*="article-content"], [class*="ql-editor"]')
      if (ct) {
        a.contentHTML = C.html(ct, 200000)
        var imgs = C.$$('img', ct).slice(0, 100)
        a.images = imgs.map(function (i) { return C.attr(i, 'src') || C.attr(i, 'data-src') }).filter(Boolean)
      }
    }
    if (!a.contentText) {
      var txt = C.$('.article-content, .opus-module-content, [class*="article-content"]')
      a.contentText = C.text(txt, 30000)
    }
    if (!a.readCount) {
      var re = C.$('[class*="read"], .view-count, [class*="view"]')
      a.readCount = C.parseNum(C.text(re))
    }
    if (!a.likeCount) {
      var lk = C.$('[class*="like"] [class*="count"], [class*="like-count"]')
      a.likeCount = C.parseNum(C.text(lk))
    }
    if (a.words === 0 && a.contentText) {
      a.words = a.contentText.replace(/\s+/g, '').length
    }

    return {
      kind: 'article',
      article: a,
      _fallback: (a.cvId === '' && a.title === '') && true,
    }
  }

  // ───────── 辅助 ─────────
  function digGlobalState() {
    try {
      var w = window
      // B 站视频页：window.__INITIAL_STATE__（含 videoData/stat/owner/tags）
      var s = w.__INITIAL_STATE__ || w.__INIT_PROPS__ || w.__NEXT_DATA__ || w.__NUXT__ || null
      if (s) return s
      var tags = document.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"], script#state')
      for (var i = 0; i < tags.length; i++) {
        try {
          var raw = C.text(tags[i])
          if (!raw) continue
          var obj = JSON.parse(raw)
          if (obj && (obj.props || obj.state || obj.data)) {
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
    if (o == null || d > 8) return null
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
  // "12:34" 或 "1:02:03" → 秒
  function parseTime(str) {
    try {
      var parts = String(str || '').split(':').map(function (x) { return C.parseNum(x) })
      if (!parts.length) return 0
      var sec = 0
      for (var i = 0; i < parts.length; i++) sec = sec * 60 + parts[i]
      return sec
    } catch (_) { return 0 }
  }
})()
