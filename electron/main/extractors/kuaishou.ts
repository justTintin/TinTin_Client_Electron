/**
 * extractors/kuaishou.ts —— 快手 Web 抽取脚本
 *   运行在 www.kuaishou.com / shop.kuaishou.com 真实 DOM 上下文
 *   支持 3 场景：用户主页 / 视频详情 / 商品详情
 *
 *   URL 模式：
 *     profile:  https://www.kuaishou.com/profile/:userId
 *               https://www.kuaishou.com/u/:userId
 *     video:    https://www.kuaishou.com/short-video/:photoId
 *               https://www.kuaishou.com/fw/photo/:photoId
 *     product:  https://www.kuaishou.com/goods/:goodsId
 *               https://shop.kuaishou.com/pages/goods/detail?goodsId=xxx
 *               https://www.kuaishou.com/mall/goods/:goodsId
 */
var C = window.__TIN_EX_COMMON__ || __TIN_EX_COMMON__
var __TIN_EXTRACT_RESULT__ = (function () {
  var PLATFORM = 'kuaishou'
  var PLATFORM_NAME = '快手'

  try {
    // ───────── ① 前置检查 ─────────
    if (C.detectNeedLogin()) {
      return C.fail('NEED_LOGIN', '请先登录' + PLATFORM_NAME, '使用手机号/扫码登录；未登录时视频/主页的大部分字段会被降级处理')
    }
    if (C.detectRiskCaptcha()) {
      return C.fail('RISK_CAPTCHA', PLATFORM_NAME + '触发了风控/验证码', '请完成当前滑块/短信/扫码验证，等待 30 秒后再试，否则返回 DOM_MISMATCH')
    }

    // ───────── ② 场景识别 ─────────
    var pathname = (location.pathname || '').toLowerCase()
    var host = (location.hostname || '').toLowerCase()
    var search = location.search || ''
    var scene = detectKuaishouScene(pathname, host, search)

    // ───────── ③ 按场景抽取 ─────────
    var content = null
    switch (scene.kind) {
      case 'profile': content = extractKsProfile(scene); break
      case 'video':   content = extractKsVideo(scene);   break
      case 'product': content = extractKsProduct(scene); break
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
  function detectKuaishouScene(pathname, host, search) {
    var out = { kind: 'unknown', host: host, pathname: pathname }
    try {
      out.userId   = C.regexFirst(/\/profile\/([^/?#]+)/i, pathname) || C.regexFirst(/\/u\/([^/?#]+)/i, pathname)
      out.photoId  = C.regexFirst(/\/short-video\/([^/?#]+)/i, pathname) || C.regexFirst(/\/photo\/([^/?#]+)/i, pathname)
      out.goodsId  = C.regexFirst(/\/goods\/([^/?#]+)/i, pathname) || C.regexFirst(/[?&]goodsId=([^&#]+)/i, search) || C.regexFirst(/[?&]goods_id=([^&#]+)/i, search)

      if (out.goodsId || /goods|mall|shop|product|sku/i.test(pathname + search) || /shop\./.test(host)) { out.kind = 'product'; return out }
      if (out.photoId || /short-video|fw\/photo|\/v\//i.test(pathname)) { out.kind = 'video'; return out }
      if (out.userId || /profile|\/u\/|user\/homepage|creator/i.test(pathname)) { out.kind = 'profile'; return out }
      var s2 = C.detectScene(pathname + search)
      out.kind = s2.kind
    } catch (_) {}
    return out
  }

  // ───────── 场景 1：用户主页 ─────────
  function extractKsProfile(scene) {
    var p = {
      userId:   scene ? scene.userId : '',
      principalId: '',
      eid:      '',
      nickname: '',
      avatar:   '',
      cover:    '',
      signature: '',
      gender:   '',
      birthday: '',
      age:      0,
      location: '',
      verified: false,
      verifiedInfo: '',
      following: 0,
      followers: 0,
      fanCount: 0,
      followCount: 0,
      worksCount: 0,
      likes:    0,
      totalLikes: 0,
      momentsCount: 0,
      links:    [],
      worksSample: [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var user = dig(state, /profile|user|creator|author|homepage/i, /info|data|detail|userInfo/i)
        if (!user) user = dig(state, /userInfo|profileUser|user_profile/i)
        if (user) {
          p.userId      = String(user.userId || user.user_id || user.principalId || user.principal_id || p.userId || '')
          p.principalId = String(user.principalId || user.principal_id || p.principalId || '')
          p.eid         = String(user.eid || user.eid_id || p.eid || '')
          p.nickname    = String(user.nickname || user.nick_name || user.name || user.userName || p.nickname || '')
          p.avatar      = String(user.avatar || user.avatarUrl || user.avatar_url || user.headUrl || user.head_img || p.avatar || '')
          p.cover       = String(user.cover || user.coverUrl || user.banner || user.back_ground || '')
          p.signature   = String(user.signature || user.description || user.text || user.userProfile || p.signature || '')
          p.gender      = user.gender === 1 || user.gender === 'MALE' || user.gender === '男' ? '男' : (user.gender === 2 || user.gender === 'FEMALE' || user.gender === '女' ? '女' : '')
          p.birthday    = String(user.birthday || user.birth_day || '')
          p.location    = String(user.location || user.city || user.province || user.region || user.cityName || '')
          p.verified    = !!user.verified || !!user.verifiedInfo || !!user.certified
          p.verifiedInfo= String(user.verifiedInfo || user.verified_info || user.cert_desc || '')
          p.following   = C.parseNum(user.following || user.followingCount || user.follow_count)
          p.followers   = C.parseNum(user.follower || user.followerCount || user.fans || user.fans_count)
          p.fanCount    = p.followers
          p.followCount = p.following
          p.worksCount  = C.parseNum(user.work || user.worksCount || user.video_count || user.photo_count)
          p.likes       = C.parseNum(user.liked || user.like || user.likes_count)
          p.totalLikes  = p.likes || C.parseNum(user.totalLike || user.total_likes || 0)
          p.momentsCount= C.parseNum(user.moments || user.momentsCount || 0)
          p.age         = C.parseNum(user.age || 0)
        }
        var ws = dig(state, /feeds|photos|videos|works|pcFeedList|feedList/i)
        if (Array.isArray(ws)) {
          p.worksSample = ws.slice(0, 30).map(function (ph) { return normalizePhoto(ph) }).filter(Boolean)
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!p.nickname) {
      var n = C.$('h1, [class*="name"], [class*="nickname"]')
      p.nickname = C.text(n, 60)
    }
    if (!p.avatar) {
      var av = C.$('[class*="avatar"] img, img[class*="Avatar"]')
      p.avatar = C.attr(av, 'src')
    }
    if (!p.signature) {
      var sig = C.$('[class*="signature"], [class*="desc"]')
      p.signature = C.text(sig, 300)
    }
    if (!p.followers || !p.worksCount) {
      var stats = C.$$('[class*="Stat"] [class*="value"], [class*="stat"] span[class*="num"], [class*="metrics"] [class*="count"]')
      if (stats.length >= 3) {
        var nums = stats.map(function (s) { return C.parseNum(C.text(s)) })
        if (!p.following)   p.following   = nums[0] || 0
        if (!p.followers)   p.followers   = nums[1] || 0
        if (!p.likes && nums.length >= 3) p.likes = nums[2] || 0
        if (!p.worksCount && nums.length >= 4) p.worksCount = nums[3] || 0
      }
    }

    return {
      kind: 'profile',
      profile: p,
      _fallback: (p.userId === '' && p.nickname === '') && true,
    }
  }

  // ───────── 场景 2：视频详情 ─────────
  function extractKsVideo(scene) {
    var v = {
      photoId: scene ? scene.photoId : '',
      photoIdStr: '',
      shareId:  '',
      caption:  '',
      cover:    '',
      coverUrls: [],
      videoUrl: '',
      hlsUrl:   '',
      mp4Urls:  [],
      duration: 0,
      width:    0,
      height:   0,
      fileSize: 0,
      timestamp: 0,
      createTime: 0,
      author:   null,
      stats:    { viewCount: 0, likeCount: 0, commentCount: 0, shareCount: 0, collectCount: 0 },
      tags:     [],
      products: [],
      music:    null,
      location: '',
      comments: [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var ph = dig(state, /photoInfo|photoData|currentPhoto|videoInfo|feedDetail|currentWork/i)
        if (!ph && Array.isArray(state.feeds) && state.feeds.length) ph = state.feeds[0]
        if (ph) {
          v.photoId    = String(ph.photoId || ph.photo_id || ph.id || ph.objectId || v.photoId || '')
          v.photoIdStr = String(ph.photoIdStr || ph.photo_id_str || v.photoIdStr || '')
          v.shareId    = String(ph.shareId || ph.share_id || '')
          v.caption    = String(ph.caption || ph.captionText || ph.desc || ph.description || ph.title || v.caption || '')
          v.cover      = pickFirst(ph.cover || ph.coverUrl || ph.cover_url || ph.thumbnail)
          v.coverUrls  = toArr(ph.coverUrls || ph.cover_urls || (ph.cover && ph.cover.urls))
          v.videoUrl   = pickFirst(ph.mainMvUrls || ph.videoUrl || ph.video_url || ph.playUrl)
          v.hlsUrl     = pickFirst(ph.hlsUrl || ph.hls_url)
          v.mp4Urls    = toArr(ph.mp4Urls || ph.mainMvUrls || (ph.video && ph.video.urls))
          v.duration   = C.parseNum(ph.duration)
          if (v.duration > 10000) v.duration = Math.round(v.duration / 1000)
          v.width      = C.parseNum(ph.width || (ph.cover && ph.cover.width))
          v.height     = C.parseNum(ph.height || (ph.cover && ph.cover.height))
          v.fileSize   = C.parseNum(ph.fileSize || ph.file_size || 0)
          v.timestamp  = C.parseNum(ph.timestamp || ph.time) * 1000 || 0
          v.createTime = v.timestamp || C.parseNum(ph.createTime || ph.ctime) * 1000 || 0
          v.location   = String(ph.location || ph.city || ph.address || '')
          if (ph.user || ph.author || ph.creator) {
            var au = ph.user || ph.author || ph.creator
            v.author = {
              userId:   String(au.userId || au.user_id || au.principalId || au.uid || ''),
              eid:      String(au.eid || ''),
              nickname: String(au.nickname || au.nick_name || au.name || ''),
              avatar:   String(au.avatar || au.avatarUrl || au.headUrl || ''),
              fans:     C.parseNum(au.fan || au.follower || 0),
              following: !!au.is_follow || !!au.following,
            }
          }
          var st = ph.statistics || ph.stats || ph.countInfo || {}
          v.stats = {
            viewCount:    C.parseNum(st.viewCount || st.view_count || st.play || st.views),
            likeCount:    C.parseNum(st.likeCount || st.like || st.like_count),
            commentCount: C.parseNum(st.commentCount || st.comment || st.comment_count),
            shareCount:   C.parseNum(st.shareCount || st.share || st.share_count),
            collectCount: C.parseNum(st.collectCount || st.collect || st.collect_count || st.favourite),
          }
          if (Array.isArray(ph.tagList || ph.tags)) v.tags = (ph.tagList || ph.tags).slice(0, 50).map(function (t) { return typeof t === 'string' ? t : (t && (t.name || t.tag)) || '' })
          if (Array.isArray(ph.productList || ph.goodsList || ph.merchandiseList)) {
            v.products = (ph.productList || ph.goodsList || ph.merchandiseList || []).slice(0, 30).map(function (g) {
              return {
                goodsId: String(g.goodsId || g.goods_id || g.id || ''),
                title:   String(g.name || g.title || '').slice(0, 160),
                cover:   String(g.cover || g.cover_url || g.img || ''),
                price:   C.parseNum(g.price || g.sale_price || g.price_str || 0),
              }
            })
          }
          if (ph.music || ph.bgMusic) {
            var mu = ph.music || ph.bgMusic
            v.music = {
              id:     String(mu.id || mu.musicId || ''),
              title:  String(mu.title || mu.name || ''),
              author: String(mu.author || mu.singer || mu.artist || ''),
              cover:  pickFirst(mu.cover || mu.poster),
              url:    pickFirst(mu.url || mu.playUrl || mu.audioUrl),
            }
          }
          if (Array.isArray(ph.commentList || ph.comments)) {
            v.comments = (ph.commentList || ph.comments).slice(0, 30).map(function (c) {
              return {
                author:    String(c.authorName || c.nickname || ''),
                authorId:  String(c.authorId || c.user_id || ''),
                avatar:    String(c.headurl || c.avatar || ''),
                content:   String(c.content || c.text || '').slice(0, 500),
                likes:     C.parseNum(c.likeCount || c.likes),
                timestamp: C.parseNum(c.timestamp || c.ts || 0) * 1000 || 0,
              }
            })
          }
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!v.caption) {
      var cap = C.$('[class*="caption"], [class*="video-desc"], [class*="Caption"]')
      v.caption = C.text(cap, 400)
    }
    if (!v.videoUrl) {
      var el = C.$('video[src]')
      if (el) v.videoUrl = C.attr(el, 'src')
    }
    if (!v.cover) {
      var vp = C.$('video[poster]')
      if (vp) v.cover = C.attr(vp, 'poster')
      if (!v.cover) {
        var cv = C.$('[class*="cover"] img, img[class*="Cover"]')
        v.cover = C.attr(cv, 'src')
      }
    }
    if (!v.author || !v.author.nickname) {
      var aBox = C.$('[class*="user-info"], [class*="author"], [class*="profile-card"]')
      if (aBox) {
        v.author = v.author || {}
        if (!v.author.nickname) {
          var nn = C.$('[class*="name"], [class*="nickname"]', aBox)
          v.author.nickname = C.text(nn, 60)
        }
        if (!v.author.avatar) {
          var av = C.$('img', aBox)
          v.author.avatar = C.attr(av, 'src')
        }
      }
    }
    if (!v.stats.likeCount || !v.stats.commentCount) {
      var act = C.$('[class*="video-action"], [class*="like-comment"]')
      if (act) {
        var ls = C.$$('[class*="like"] [class*="count"], [class*="Like"] span', act)
        var cs = C.$$('[class*="comment"] [class*="count"], [class*="Comment"] span', act)
        var ss = C.$$('[class*="share"] [class*="count"], [class*="Share"] span', act)
        v.stats.likeCount    = v.stats.likeCount    || C.parseNum(C.text(ls[0]))
        v.stats.commentCount = v.stats.commentCount || C.parseNum(C.text(cs[0]))
        v.stats.shareCount   = v.stats.shareCount   || C.parseNum(C.text(ss[0]))
      }
    }

    return {
      kind: 'video',
      video: v,
      _fallback: (v.photoId === '') && true,
    }
  }

  // ───────── 场景 3：商品详情 ─────────
  function extractKsProduct(scene) {
    var p = {
      goodsId: scene ? scene.goodsId : '',
      itemId:  '',
      title:   '',
      subTitle: '',
      cover:   '',
      images:  [],
      video:   '',
      price:   0,
      originPrice: 0,
      sales:   0,
      stock:   0,
      currency: 'CNY',
      shop:    null,
      skus:    [],
      detail:  '',
      params:  [],
      descImages: [],
      tags:    [],
    }

    try {
      var state = digGlobalState()
      if (state) {
        var gd = dig(state, /goods|product|detail|item|skuInfo/i)
        if (gd) {
          p.goodsId    = String(gd.goodsId || gd.goods_id || gd.productId || gd.itemId || gd.id || p.goodsId || '')
          p.itemId     = String(gd.itemId || gd.item_id || p.itemId || '')
          p.title      = String(gd.title || gd.name || gd.goodsName || p.title || '')
          p.subTitle   = String(gd.subtitle || gd.sub_title || gd.slogan || (gd.tagList && gd.tagList[0]) || '').slice(0, 200)
          p.cover      = pickFirst(gd.cover || gd.coverUrl || gd.image_url || gd.img)
          p.images     = toArr(gd.imageUrls || gd.images || gd.imgList || (gd.picList && gd.picList.map(function (x) { return x.url || x })))
          p.video      = pickFirst(gd.video || gd.videoUrl || gd.videos)
          p.price      = C.parseNum(gd.price || gd.salePrice || gd.current_price || gd.price_info && (gd.price_info.price || gd.price_info.finalPrice) || 0)
          p.originPrice= C.parseNum(gd.originPrice || gd.original_price || gd.market_price || gd.price_info && (gd.price_info.original_price || gd.price_info.originalPrice) || 0)
          p.sales      = C.parseNum(gd.sales || gd.soldCount || gd.sold_count)
          p.stock      = C.parseNum(gd.stock || gd.stockCount || gd.remain || 0)
          p.currency   = String(gd.currency || gd.price_info && gd.price_info.currency || 'CNY')
          if (gd.shop || gd.store || gd.shopInfo) {
            var shop = gd.shop || gd.store || gd.shopInfo
            p.shop = {
              shopId:   String(shop.shopId || shop.id || shop.shop_id || ''),
              name:     String(shop.name || shop.shop_name || ''),
              logo:     String(shop.logo || shop.shop_logo || shop.avatar || ''),
              type:     String(shop.type || shop.shop_type || ''),
              ratings:  shop.ratings || shop.score_info || null,
            }
          }
          if (Array.isArray(gd.skuList || gd.skus || gd.specs)) {
            var sk = gd.skuList || gd.skus || gd.specs
            p.skus = sk.slice(0, 200).map(function (s) {
              return {
                skuId: String(s.skuId || s.id || s.sku_id || ''),
                name:  String(s.skuName || s.name || s.title || ''),
                price: C.parseNum(s.price || s.sale_price || 0),
                stock: C.parseNum(s.stock || s.remain || 0),
                cover: pickFirst(s.cover || s.img || s.image),
                attrs: s.attrs || s.specs || null,
              }
            })
          }
          p.detail = ''
          if (Array.isArray(gd.detailImages || gd.descImages || gd.detailImgs)) {
            var di = gd.detailImages || gd.descImages || gd.detailImgs
            p.descImages = di.map(function (x) { return typeof x === 'string' ? x : (x && (x.url || x.src)) || '' }).filter(Boolean)
            p.detail = p.descImages.map(function (src) { return '<img src="' + src + '"/>' }).join('')
          }
          if (Array.isArray(gd.params || gd.productParams || gd.propList)) {
            p.params = (gd.params || gd.productParams || gd.propList).slice(0, 200).map(function (x) {
              return typeof x === 'object' ? { name: String(x.name || x.key || x.prop || ''), value: String(x.value || x.val || '') } : String(x)
            })
          }
          if (Array.isArray(gd.tagList || gd.tags)) p.tags = (gd.tagList || gd.tags).slice(0, 50).map(String)
        }
      }
    } catch (_) {}

    // DOM 兜底
    if (!p.title) {
      var t = C.$('h1, [class*="Title"], [class*="goods-title"], [class*="product-name"]')
      p.title = C.text(t, 180)
    }
    if (!p.price) {
      var pr = C.$('[class*="price"], [class*="Price"]')
      p.price = C.parseNum(C.text(pr))
    }
    if (!p.cover) {
      var img = C.$('[class*="cover"] img, [class*="main-image"] img, [class*="gallery-main"] img')
      p.cover = C.attr(img, 'src')
    }
    if (p.images.length === 0) {
      var all = C.$$('[class*="swiper"] img, [class*="gallery"] img, [class*="thumb"] img').slice(0, 30)
      p.images = all.map(function (x) { return C.attr(x, 'src') }).filter(Boolean)
    }
    if (!p.shop) {
      var sb = C.$('[class*="shop-info"], [class*="store-card"]')
      if (sb) {
        var nm = C.$('[class*="name"]', sb)
        var lg = C.$('img', sb)
        p.shop = { shopId: '', name: C.text(nm, 60), logo: C.attr(lg, 'src'), type: '', ratings: null }
      }
    }

    return {
      kind: 'product',
      product: p,
      _fallback: (p.goodsId === '' && p.title === '') && true,
    }
  }

  // ───────── 辅助 ─────────
  function digGlobalState() {
    try {
      var w = window
      var s = w.__INITIAL_STATE__ || w.__INIT_PROPS__ || w.__NEXT_DATA__ || w.__NUXT__ || w.__APOLLO_STATE__ || null
      if (s) return s
      var tags = document.querySelectorAll('script[type="application/json"], script[id*="DATA"], script#state, script#__NEXT_DATA__')
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
  function pickFirst(x) {
    if (x == null) return ''
    if (typeof x === 'string') return x
    if (Array.isArray(x)) {
      if (!x.length) return ''
      return typeof x[0] === 'string' ? x[0] : ((x[0] && (x[0].url || x[0].src || x[0].path)) || '')
    }
    if (typeof x === 'object') {
      if (x.url) return x.url
      if (x.src) return x.src
      if (x.urls && Array.isArray(x.urls)) return pickFirst(x.urls)
      if (x.url_list && Array.isArray(x.url_list)) return pickFirst(x.url_list)
      return ''
    }
    return ''
  }
  function toArr(x) {
    if (!x) return []
    if (Array.isArray(x)) {
      return x.slice(0, 100).map(function (y) {
        if (typeof y === 'string') return y
        return y && (y.url || y.src || y.path || '') || ''
      }).filter(Boolean)
    }
    var s = pickFirst(x)
    return s ? [s] : []
  }
  function normalizePhoto(ph) {
    if (!ph) return null
    return {
      photoId: String(ph.photoId || ph.photo_id || ph.id || ''),
      caption: String(ph.caption || ph.desc || '').slice(0, 200),
      cover:   pickFirst(ph.cover || ph.coverUrl),
      videoUrl: pickFirst(ph.mainMvUrls || ph.videoUrl),
      duration: (function () {
        var d = C.parseNum(ph.duration)
        if (d > 10000) return Math.round(d / 1000)
        return d
      })(),
      stats: ph.statistics ? {
        like:    C.parseNum(ph.statistics.likeCount),
        comment: C.parseNum(ph.statistics.commentCount),
        share:   C.parseNum(ph.statistics.shareCount),
        view:    C.parseNum(ph.statistics.viewCount),
      } : { like: C.parseNum(ph.likeCount), comment: C.parseNum(ph.commentCount), share: C.parseNum(ph.shareCount), view: C.parseNum(ph.viewCount) },
    }
  }
})()
