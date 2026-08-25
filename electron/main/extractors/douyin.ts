/**
 * extractors/douyin.ts —— 抖音 Web 抽取脚本
 *   运行在 douyin.com 真实 DOM 上下文，公共工具已被 thickShell prepend
 *   支持 4 场景：用户主页 / 视频详情 / 直播间 / 商品详情页
 *
 *   URL 模式：
 *     profile:  https://www.douyin.com/user/:secUid
 *               https://www.douyin.com/user/profile
 *     video:    https://www.douyin.com/video/:videoId
 *     live:     https://live.douyin.com/:roomId
 *               https://www.douyin.com/live/:roomId
 *     product:  https://www.douyin.com/product/:productId
 *               https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=xxx
 */
var C = window.__TIN_EX_COMMON__ || __TIN_EX_COMMON__
;(function () {
  var PLATFORM = 'douyin'
  var PLATFORM_NAME = '抖音'

  try {
    // ───────── ① 统一前置检查：登录 / 风控 ─────────
    if (C.detectNeedLogin()) {
      return C.fail('NEED_LOGIN', '请先登录' + PLATFORM_NAME, '扫码或手机号登录后再抽取，视频/直播/用户信息等多数内容登录后才可看到完整字段')
    }
    if (C.detectRiskCaptcha()) {
      return C.fail('RISK_CAPTCHA', PLATFORM_NAME + '触发了风控/验证码', '请在本页手动完成滑块或验证码，等待 30 秒后再重试；如频繁出现，建议先关闭本 Tab 稍后访问')
    }

    // ───────── ② 场景识别（URL 优先，兜底 detectScene）─────────
    var pathname = (location.pathname || '').toLowerCase()
    var host = (location.hostname || '').toLowerCase()
    var scene = detectDouyinScene(pathname, host)
    if (scene.kind === 'unknown') {
      // 兜底：公共启发式
      scene = C.detectScene()
    }

    // ───────── ③ 按场景抽取 ─────────
    var content = null
    switch (scene.kind) {
      case 'profile':
        content = extractDouyinProfile()
        break
      case 'video':
        content = extractDouyinVideo()
        break
      case 'live':
        content = extractDouyinLive()
        break
      case 'product':
        content = extractDouyinProduct()
        break
      default:
        // 兜底：给出页面通用摘要，仍然判定为成功
        content = C.makeFallbackContent()
        content.kind = 'unknown'
    }

    // 关键字段都为 null / 空 → 仍走 fallback（保持 data 非空，方便 Workbench 展示）
    if (!content || (typeof content === 'object' && Object.keys(content).length === 0)) {
      content = C.makeFallbackContent()
      content.kind = scene.kind || 'unknown'
    }

    return C.succ({
      source: C.makeSource(PLATFORM, { scene: scene.kind, host: host }),
      meta:   C.makeMeta(),
      content: content,
    })
  } catch (e) {
    // 任何未捕获异常 → DOM_MISMATCH，同时尝试给出 fallback 摘要让用户至少看到点东西
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
      return C.fail('DOM_MISMATCH', PLATFORM_NAME + ' DOM 结构已变更: ' + e.message, '等待脚本升级或使用"服务端解析"兜底')
    }
  }

  // ───────── 场景识别 ─────────
  function detectDouyinScene(pathname, host) {
    var out = { kind: 'unknown', host: host, pathname: pathname }
    try {
      if (/live\./.test(host) || /\/live(\/|$)/.test(pathname)) {
        out.kind = 'live'
        return out
      }
      if (/\/product\//i.test(pathname) || /haohuo\.jinritemai/i.test(host) || /\/goods\//i.test(pathname) || /\/mall\//i.test(pathname)) {
        out.kind = 'product'
        return out
      }
      if (/\/video\/\d+/.test(pathname) || /\/v\//.test(pathname)) {
        out.kind = 'video'
        return out
      }
      if (/\/user\/?/i.test(pathname) || /\/profile\/?/i.test(pathname) || /sec_uid/i.test(pathname + location.search)) {
        out.kind = 'profile'
        return out
      }
    } catch (_) {}
    return out
  }

  // ───────── 场景 1：用户主页（/user/:secUid） ─────────
  function extractDouyinProfile() {
    var user = {
      secUid:       '',
      uid:          '',
      nickname:     '',
      uniqueId:     '', // 抖音号
      avatar:       '',
      cover:        '',
      signature:    '',
      location:     '',
      gender:       '',
      following:    0,
      followers:    0,
      likes:        0, // 获赞数
      worksCount:   0, // 作品数
      likesCount:   0, // 喜欢数
      verified:     false,
      verifiedInfo: '',
      links:        [], // 主页上的外链
      worksSample:  [], // 前若干作品预览
    }

    // 1) 从 RENDER_DATA / SSR_DATA 里拿（最可靠来源）
    try {
      var w = window
      var state = w.__INIT_PROPS__ || w.__INITIAL_STATE__ || w.__NUXT__ || null
      if (!state) {
        var rd = C.$('script#RENDER_DATA') || C.$('script[id*="RENDER"]')
        if (rd) {
          try {
            var raw = decodeURIComponent(C.text(rd))
            state = JSON.parse(raw)
          } catch (_) {}
        }
      }
      if (state) {
        var u = dig(state, /user|profile|account/i, /info|user|data/i)
        if (u) {
          user.secUid   = String(u.sec_uid  || u.secUid  || user.secUid  || '')
          user.uid      = String(u.uid      || u.userId  || user.uid     || '')
          user.nickname = String(u.nickname || u.nick_name || u.name     || user.nickname || '')
          user.uniqueId = String(u.unique_id || u.uniqueId || u.short_id || user.uniqueId || '')
          user.avatar   = String(u.avatar_larger || u.avatar_medium || u.avatar_thumb || u.avatar_url || u.avatar || user.avatar || '')
          user.signature= String(u.signature || u.description || user.signature || '')
          user.location = String(user.location || u.province || u.city || u.location || u.region || '')
          user.gender   = u.gender != null ? (u.gender === 1 ? '男' : u.gender === 2 ? '女' : '') : ''
          user.following= C.parseNum(u.following_count || u.followings || u.following) || 0
          user.followers= C.parseNum(u.follower_count  || u.followers  || u.mplatform_followers_count) || 0
          user.likes    = C.parseNum(u.total_favorited || u.favorited_count || u.likes) || 0
          user.worksCount= C.parseNum(u.aweme_count || u.video_count || u.works) || 0
          user.likesCount= C.parseNum(u.following_count_fav || u.liked_count || 0) || 0
          user.verified = !!u.custom_verify || !!u.enterprise_verify_reason || !!u.verification_type
          user.verifiedInfo = String(u.custom_verify || u.enterprise_verify_reason || user.verifiedInfo || '')
        }
        // 作品列表示例
        var works = dig(state, /aweme|videos|works|posts|list/i)
        if (Array.isArray(works)) works = works.slice(0, 20)
        if (Array.isArray(works)) {
          for (var wi = 0; wi < works.length; wi++) {
            var wItem = works[wi]
            if (!wItem) continue
            var aweme = wItem.aweme_info || wItem
            user.worksSample.push({
              awemeId:    String(aweme.aweme_id || aweme.id || ''),
              desc:       String(aweme.desc || aweme.description || '').slice(0, 200),
              cover:      pickFirstCover(aweme.video),
              playAddr:   pickFirstUrl(aweme.video && aweme.video.play_addr),
              duration:   C.parseNum(aweme.video && aweme.video.duration, 0) / 1000 | 0,
              statistics: aweme.statistics ? {
                comment: C.parseNum(aweme.statistics.comment_count),
                digg:    C.parseNum(aweme.statistics.digg_count),
                share:   C.parseNum(aweme.statistics.share_count),
                play:    C.parseNum(aweme.statistics.play_count),
                collect: C.parseNum(aweme.statistics.collect_count),
              } : null,
            })
          }
        }
      }
    } catch (_) {}

    // 2) DOM 兜底填充
    if (!user.nickname) {
      var nickEl = C.$('[class*="nickname"], h1, span[class*="name"]')
      user.nickname = C.text(nickEl, 60)
    }
    if (!user.avatar) {
      var av = C.$('img[class*="avatar"], img[class*="Avatar"]')
      user.avatar = C.attr(av, 'src')
    }
    if (!user.signature) {
      var sig = C.$('[class*="signature"], [class*="Signature"]')
      user.signature = C.text(sig, 300)
    }
    // 数字类字段（粉丝/关注/获赞/作品）DOM 兜底
    var statEls = C.$$('[class*="follow"] [class*="count"], [class*="stat"] span[class*="num"], [class*="Stats"] [class*="value"]')
    if (statEls.length >= 3) {
      var nums = statEls.map(function (s) { return C.parseNum(C.text(s)) })
      if (!user.following) user.following = nums[0] || 0
      if (!user.followers) user.followers = nums[1] || 0
      if (!user.likes && nums.length >= 3) user.likes = nums[2] || 0
    }

    return {
      kind: 'profile',
      user: user,
      _fallback: (state == null) && true,
    }
  }

  // ───────── 场景 2：视频详情（/video/:videoId） ─────────
  function extractDouyinVideo() {
    var video = {
      awemeId:  '',
      desc:     '',
      cover:    '',
      dynamicCover: '',
      playAddr: '',
      downloadAddr: '',
      duration: 0,
      width:    0,
      height:   0,
      ratio:    '',
      bitrate:  0,
      format:   '',
      author:   null,   // { secUid, uid, nickname, avatar, uniqueId }
      music:    null,   // { id, title, author, cover, playUrl }
      statistics: { comment: 0, digg: 0, share: 0, play: 0, collect: 0 },
      tags:     [],
      challengeList: [],
      poi:      null,   // { name, address, lon, lat }
      createTime: 0,
      images:   [],     // 图文作品会有图片列表
    }

    try {
      var state = digGlobalState()
      if (state) {
        var aw = dig(state, /aweme|video|detail/i)
        // 如果是数组，取第一个
        if (Array.isArray(aw)) aw = aw[0]
        if (aw && (aw.aweme_id || aw.desc)) {
          fillAweme(video, aw)
        }
      }
    } catch (_) {}

    // DOM 兜底填充
    if (!video.desc) {
      var desc = C.$('[class*="desc"], [class*="DetailDesc"], [data-e2e*="desc"], [class*="video-desc"]')
      video.desc = C.text(desc, 400)
    }
    if (!video.playAddr) {
      var v = C.$('video[src]')
      if (v) video.playAddr = C.attr(v, 'src')
    }
    if (!video.cover) {
      var poster = C.$('video[poster]')
      if (poster) video.cover = C.attr(poster, 'poster')
      if (!video.cover) {
        var img = C.$('[class*="cover"] img, img[class*="Cover"]')
        video.cover = C.attr(img, 'src')
      }
    }
    if (!video.statistics || (!video.statistics.digg && !video.statistics.comment)) {
      var statBox = C.$('[class*="BottomContainer"], [class*="ActionBar"], [data-e2e*="action-bar"]')
      if (statBox) {
        var ds = C.$$('[class*="DiggCount"], [data-e2e*="digg"], [class*="like"] span[class*="count"]', statBox)
        var cs = C.$$('[class*="CommentCount"], [data-e2e*="comment"], [class*="comment"] span[class*="count"]', statBox)
        var ss = C.$$('[class*="ShareCount"], [data-e2e*="share"], [class*="share"] span[class*="count"]', statBox)
        video.statistics = video.statistics || {}
        video.statistics.digg    = video.statistics.digg    || C.parseNum(C.text(ds[0]))
        video.statistics.comment = video.statistics.comment || C.parseNum(C.text(cs[0]))
        video.statistics.share   = video.statistics.share   || C.parseNum(C.text(ss[0]))
      }
    }
    if (!video.author || !video.author.nickname) {
      var aBox = C.$('[class*="author"], [data-e2e*="user-info"]')
      if (aBox) {
        video.author = video.author || {}
        if (!video.author.nickname) {
          var nn = C.$('[class*="name"], [class*="nickname"]', aBox)
          video.author.nickname = C.text(nn, 60)
        }
        if (!video.author.avatar) {
          var av = C.$('img', aBox)
          video.author.avatar = C.attr(av, 'src')
        }
      }
    }
    // 标签
    if (!video.tags || video.tags.length === 0) {
      var tagList = C.$$('a[href*="tag/"], a[href*="challenge"], [class*="tag"]')
      video.tags = tagList.map(function (t) { return { name: C.text(t, 40), href: C.attr(t, 'href') } })
    }

    return {
      kind: 'video',
      video: video,
      _fallback: (video.awemeId === '') && true,
    }
  }

  // ───────── 场景 3：直播间（live.douyin.com/:roomId） ─────────
  function extractDouyinLive() {
    var live = {
      roomId:  '',
      title:   '',
      cover:   '',
      status:  'live',  // live | replay | offline
      viewers: 0,       // 在线观众
      totalViewers: 0,  // 累计观看
      likes:   0,
      shares:  0,
      comments: 0,
      anchor:  null,    // { id, nickname, avatar, followers, secUid, roomId }
      productList: [],  // 带货商品（前 20）
      startTime: 0,
      replay:  false,
      roomTags: [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var r = dig(state, /room|roomStore|liveRoom|live_info/i)
        if (r) {
          live.roomId = String(r.id_str || r.room_id || r.roomId || live.roomId || '')
          live.title  = String(r.title || r.room_title || live.title || '')
          live.cover  = String(r.cover || r.cover_url || r.cover_img || live.cover || '')
          live.status = r.status === 2 ? 'live' : (r.status === 3 ? 'replay' : 'offline')
          live.replay = live.status === 'replay'
          live.viewers = C.parseNum(r.user_count_str || r.user_count || r.current_users)
          live.totalViewers = C.parseNum(r.total_user || r.total_user_count || live.totalViewers)
          live.likes  = C.parseNum(r.digg_count || r.like_count)
          live.shares = C.parseNum(r.share_count)
          live.comments = C.parseNum(r.comment_count)
          live.startTime = C.parseNum(r.create_time || r.start_time) * 1000 || 0
          var owner = r.owner || r.owner_user || r.anchor || null
          if (owner) {
            live.anchor = {
              id:        String(owner.id_str || owner.uid || owner.id || ''),
              secUid:    String(owner.sec_uid || owner.secUid || ''),
              nickname:  String(owner.nickname || owner.nick_name || ''),
              avatar:    String(owner.avatar_larger || owner.avatar_medium || owner.avatar_thumb || owner.avatar || ''),
              followers: C.parseNum(owner.follower_count || owner.followers),
              roomId:    live.roomId,
            }
          }
          var cart = r.goods_list || r.shop || r.product_list || r.shopping_cart || null
          if (Array.isArray(cart)) {
            for (var gi = 0; gi < Math.min(cart.length, 30); gi++) {
              var g = cart[gi]
              if (!g) continue
              live.productList.push({
                pid:       String(g.id || g.product_id || g.goods_id || ''),
                title:     String(g.title || g.name || '').slice(0, 120),
                price:     C.parseNum(g.price || g.price_info || g.sale_price || 0),
                cover:     String(g.cover || g.cover_url || g.pic || ''),
                sales:     C.parseNum(g.sales || g.sold_count || 0),
                originPrice: C.parseNum(g.market_price || g.origin_price || 0),
              })
            }
          }
          if (r.room_tabs || r.tags) {
            var rt = r.room_tabs || r.tags
            if (Array.isArray(rt)) {
              live.roomTags = rt.slice(0, 20).map(function (t) { return typeof t === 'string' ? t : (t && t.name ? t.name : '') }).filter(Boolean)
            }
          }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!live.title) {
      var t = C.$('[class*="Title"], [data-e2e*="live-title"], h1, [class*="room-title"]')
      live.title = C.text(t, 180)
    }
    if (!live.viewers) {
      var v = C.$('[class*="viewer"], [class*="online"], [data-e2e*="user-count"], [class*="people-num"]')
      live.viewers = C.parseNum(C.text(v))
    }
    if (!live.anchor || !live.anchor.nickname) {
      var a = C.$('[class*="anchor-name"], [data-e2e*="anchor"], [class*="host-name"]')
      if (a) {
        live.anchor = live.anchor || {}
        live.anchor.nickname = live.anchor.nickname || C.text(a, 60)
      }
    }

    return {
      kind: 'live',
      live: live,
      _fallback: (live.roomId === '') && true,
    }
  }

  // ───────── 场景 4：商品详情页（/product/:id / haohuo） ─────────
  function extractDouyinProduct() {
    var p = {
      productId:  '',
      title:      '',
      subTitle:   '',
      cover:      '',
      images:     [],
      price:      0,   // 现价（单位：分，若 <10000 且带小数点则视作元）
      originPrice: 0,  // 原价
      sales:      0,
      stock:      0,
      currency:   'CNY',
      shop:       null,  // { id, name, logo, url, ratings }
      skuList:    [],
      detailHTML: '',
      detailText: [],
      params:     [],
      shipping:   '',
      returnPolicy: '',
      couponText: '',
    }

    try {
      var state = digGlobalState()
      if (state) {
        var prod = dig(state, /product|detail|goods|sku/i)
        if (prod) {
          p.productId   = String(prod.product_id || prod.id || prod.goods_id || prod.sku_id || p.productId || '')
          p.title       = String(prod.title || prod.name || p.title || '')
          p.subTitle    = String(prod.subtitle || prod.sub_title || prod.description || p.subTitle || '').slice(0, 200)
          p.cover       = pickFirstCover(prod)
          if (Array.isArray(prod.images) || Array.isArray(prod.imgs)) {
            p.images = (prod.images || prod.imgs || []).slice(0, 30).map(function (x) {
              return typeof x === 'string' ? x : (x && (x.url || x.src)) || ''
            }).filter(Boolean)
          }
          var pi = prod.price_info || prod.price || 0
          if (typeof pi === 'object') {
            p.price       = C.parseNum(pi.price || pi.sale_price || pi.current_price)
            p.originPrice = C.parseNum(pi.market_price || pi.origin_price || pi.original_price)
            p.currency    = String(pi.currency || p.currency)
          } else {
            p.price = C.parseNum(pi)
          }
          p.sales  = C.parseNum(prod.sales || prod.sold_count || prod.sold || 0)
          p.stock  = C.parseNum(prod.stock || prod.inventory || prod.remain || 0)
          if (prod.shop || prod.store || prod.shop_info) {
            var shop = prod.shop || prod.store || prod.shop_info
            p.shop = {
              id:     String(shop.id || shop.shop_id || ''),
              name:   String(shop.name || shop.shop_name || ''),
              logo:   String(shop.logo || shop.shop_logo || ''),
              url:    String(shop.url || shop.shop_url || ''),
              ratings: shop.ratings || null,
            }
          }
          if (Array.isArray(prod.skus)) {
            p.skuList = prod.skus.slice(0, 200).map(function (s) {
              return {
                skuId:  String(s.sku_id || s.id || ''),
                name:   String(s.name || s.sku_name || ''),
                price:  C.parseNum(s.price || s.sale_price || 0),
                stock:  C.parseNum(s.stock || s.inventory || 0),
                cover:  String(s.cover || s.cover_url || s.img || ''),
                specs:  s.specs || s.sku_spec || null,
              }
            })
          }
          if (prod.detail_imgs || Array.isArray(prod.detail_images)) {
            var di = prod.detail_imgs || prod.detail_images
            p.detailHTML = di.map(function (x) {
              var src = typeof x === 'string' ? x : (x && x.url) || ''
              return src ? '<img src="' + src + '"/>' : ''
            }).join('')
          }
          if (Array.isArray(prod.params) || Array.isArray(prod.product_params)) {
            var pa = prod.params || prod.product_params
            p.params = pa.map(function (x) { return typeof x === 'object' ? { name: x.name || x.key || '', value: x.value || '' } : String(x) })
          }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!p.title) {
      var h = C.$('h1, [class*="Title"], [class*="product-name"], [data-e2e*="title"]')
      p.title = C.text(h, 180)
    }
    if (!p.price) {
      var pr = C.$('[class*="Price"], [class*="price"], [data-e2e*="price"]')
      p.price = C.parseNum(C.text(pr))
    }
    if (!p.cover) {
      var img = C.$('[class*="cover"] img, [class*="main-pic"] img, img[class*="Cover"]')
      p.cover = C.attr(img, 'src')
    }
    if (p.images.length === 0) {
      var imgs = C.$$('[class*="swiper"] img, [class*="gallery"] img, [class*="main-pic"] img').slice(0, 30)
      p.images = imgs.map(function (x) { return C.attr(x, 'src') }).filter(Boolean)
    }
    if (!p.shop) {
      var shop = C.$('[class*="shop"], [class*="store"]')
      if (shop) {
        var nm = C.$('[class*="name"]', shop)
        var lg = C.$('img', shop)
        p.shop = { name: C.text(nm, 60), logo: C.attr(lg, 'src'), id: '', url: '', ratings: null }
      }
    }

    return {
      kind: 'product',
      product: p,
      _fallback: (p.productId === '') && true,
    }
  }

  // ───────── 公共辅助：从 window 里挖全局 state ─────────
  function digGlobalState() {
    try {
      var w = window
      var s = w.__INIT_PROPS__ || w.__INITIAL_STATE__ || w.__NUXT__ || w.__RENDER_DATA__ || null
      if (s) return s
      var rd = C.$('script#RENDER_DATA') || C.$('script[type="application/json"][id*="RENDER"]')
      if (rd) {
        try {
          var raw = decodeURIComponent(C.text(rd))
          return JSON.parse(raw)
        } catch (_) {
          try { return JSON.parse(C.text(rd) || '{}') } catch (_) { return null }
        }
      }
    } catch (_) {}
    return null
  }

  // 在 obj 里按 key regex 递归找第一个符合条件的值（不做深度保护，防止爆栈做 8 层限制）
  function dig(obj) {
    try {
      var patterns = []
      for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] instanceof RegExp) patterns.push(arguments[i])
      }
      if (patterns.length === 0) return obj
      return digRecursive(obj, patterns, 0)
    } catch (_) { return null }
  }
  function digRecursive(obj, patterns, depth) {
    if (obj == null) return null
    if (depth > 8) return null
    if (Array.isArray(obj)) {
      // 数组：如果第一个 pattern 是 list/array 类，直接返回
      for (var ai = 0; ai < obj.length; ai++) {
        var r = digRecursive(obj[ai], patterns, depth + 1)
        if (r != null) return r
      }
      return null
    }
    if (typeof obj !== 'object') return null
    var keys = Object.keys(obj)
    var levelPattern = patterns[depth] || patterns[patterns.length - 1]
    // 先尝试 key 命中当前层 pattern
    var hit = null
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki]
      if (levelPattern.test(k)) {
        hit = obj[k]
        // 有下一层 pattern → 继续下钻
        if (depth + 1 < patterns.length) {
          var deeper = digRecursive(hit, patterns, depth + 1)
          if (deeper != null) return deeper
        } else if (hit != null) {
          return hit
        }
      }
    }
    // 本层没命中 → 递归往下（保持原 pattern 位置）
    for (var ki2 = 0; ki2 < keys.length; ki2++) {
      var r2 = digRecursive(obj[keys[ki2]], patterns, depth)
      if (r2 != null) return r2
    }
    return null
  }

  function pickFirstCover(videoOrProduct) {
    if (!videoOrProduct) return ''
    var covers = videoOrProduct.cover || videoOrProduct.cover_url || videoOrProduct.cover_img || videoOrProduct.dynamic_cover || null
    if (!covers) return ''
    if (typeof covers === 'string') return covers
    if (Array.isArray(covers.url_list || covers.urls || covers)) {
      var arr = covers.url_list || covers.urls || covers
      if (arr && arr.length) return typeof arr[0] === 'string' ? arr[0] : (arr[0] && (arr[0].url || arr[0].src) || '')
    }
    return ''
  }
  function pickFirstUrl(addr) {
    if (!addr) return ''
    if (typeof addr === 'string') return addr
    var arr = addr.url_list || addr.urls || addr
    if (Array.isArray(arr) && arr.length) return typeof arr[0] === 'string' ? arr[0] : (arr[0] && (arr[0].url || '') || '')
    return ''
  }
  function fillAweme(video, aw) {
    video.awemeId  = String(aw.aweme_id || aw.id || video.awemeId || '')
    video.desc     = String(aw.desc || aw.description || video.desc || '')
    video.createTime = C.parseNum(aw.create_time) * 1000 || 0
    if (aw.video) {
      video.cover = pickFirstCover(aw.video.cover || aw.video.origin_cover) || video.cover
      video.dynamicCover = pickFirstCover(aw.video.dynamic_cover) || video.dynamicCover
      video.playAddr = pickFirstUrl(aw.video.play_addr) || video.playAddr
      video.downloadAddr = pickFirstUrl(aw.video.download_addr) || video.downloadAddr
      video.duration = C.parseNum(aw.video.duration, 0) / 1000 | 0
      video.width  = C.parseNum(aw.video.width || 0)
      video.height = C.parseNum(aw.video.height || 0)
      video.ratio  = String(aw.video.ratio || video.ratio || '')
      video.bitrate= C.parseNum(aw.video.bit_rate || 0)
      video.format = String(aw.video.video_format || video.format || '')
    }
    if (aw.author) {
      var a = aw.author
      video.author = {
        secUid:   String(a.sec_uid || a.secUid || ''),
        uid:      String(a.uid || a.id || a.user_id || ''),
        nickname: String(a.nickname || a.nick_name || ''),
        avatar:   String(a.avatar_larger || a.avatar_medium || a.avatar_thumb || a.avatar || ''),
        uniqueId: String(a.unique_id || a.uniqueId || a.short_id || ''),
      }
    }
    if (aw.music) {
      var m = aw.music
      video.music = {
        id:       String(m.id || m.mid || ''),
        title:    String(m.title || m.music_name || ''),
        author:   String(m.author || m.owner_name || m.singer || ''),
        cover:    pickFirstCover(m.cover_hd || m.cover_large || m.cover_medium || m.cover_thumb),
        playUrl:  pickFirstUrl(m.play_url || m.url),
      }
    }
    if (aw.statistics) {
      video.statistics = {
        comment: C.parseNum(aw.statistics.comment_count),
        digg:    C.parseNum(aw.statistics.digg_count),
        share:   C.parseNum(aw.statistics.share_count),
        play:    C.parseNum(aw.statistics.play_count),
        collect: C.parseNum(aw.statistics.collect_count),
      }
    }
    if (aw.text_extra && Array.isArray(aw.text_extra)) {
      video.tags = aw.text_extra.filter(function (t) { return t && t.hashtag_name }).map(function (t) {
        return { name: '#' + t.hashtag_name, href: '' }
      })
    }
    if (aw.challenges && Array.isArray(aw.challenges)) {
      video.challengeList = aw.challenges.slice(0, 50).map(function (c) {
        return { cid: String(c.cid || c.id || ''), name: String(c.challenge_name || c.title || ''), desc: String(c.desc || '') }
      })
    }
    if (aw.aweme_type === 2 && aw.images && aw.images.length) {
      // 图文作品
      video.images = aw.images.map(function (im) {
        var url = pickFirstUrl(im.url_list || im.download_url_list || im)
        return { src: url, width: C.parseNum(im.width), height: C.parseNum(im.height) }
      })
    }
    if (aw.poi_info || aw.poi) {
      var p = aw.poi_info || aw.poi
      video.poi = {
        name: String(p.poi_name || p.name || ''),
        address: String(p.address || ''),
        lon:  p.longitude || 0,
        lat:  p.latitude || 0,
      }
    }
  }
})()
