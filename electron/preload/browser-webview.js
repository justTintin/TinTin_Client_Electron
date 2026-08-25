const { ipcRenderer } = require('electron')

// 仅在最外层主框架中执行，忽略子 iframe
if (window.self === window.top) {

  // 1. 注入 Main World 脚本，拦截 fetch/XHR/MSE
  function injectMainWorldScript() {
    const scriptContent = `
      (function() {
        const mediaSourceToBlobUrl = new Map();
        const originalCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function(obj) {
          const url = originalCreateObjectURL.call(this, obj);
          if (obj instanceof MediaSource) {
            mediaSourceToBlobUrl.set(obj, url);
          }
          return url;
        };

        const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function(mime) {
          const sb = originalAddSourceBuffer.call(this, mime);
          sb._mime = mime;
          sb._mediaSource = this;
          return sb;
        };

        const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
        SourceBuffer.prototype.appendBuffer = function(buf) {
          try {
            const url = buf ? (buf._url || (buf.buffer && buf.buffer._url)) : null;
            if (url) {
              const mime = this._mime || '';
              const type = mime.toLowerCase().includes('audio') ? 'audio' : 'video';
              const mediaSource = this._mediaSource;
              const blobUrl = mediaSourceToBlobUrl.get(mediaSource);
              if (blobUrl) {
                window.postMessage({
                  source: 'tintin-sniffer',
                  type: 'mse-segment-appended',
                  data: { url, type, blobUrl }
                }, '*');
              }
            }
          } catch (e) {}
          return originalAppendBuffer.call(this, buf);
        };

        function isMediaUrl(url) {
          if (!url || typeof url !== 'string') return false;
          if (url.startsWith('data:')) return false;
          const lower = url.toLowerCase();
          if (lower.includes('.mp4') || lower.includes('.m3u8') || lower.includes('.mp3') ||
              lower.includes('.flv') || lower.includes('.webm') || lower.includes('.ogg') ||
              lower.includes('.m4s') || lower.includes('.ts')) return true;
          if (lower.includes('video/tos') || lower.includes('sns-video') ||
              lower.includes('sns-img') || lower.includes('sns-webpic') ||
              lower.includes('v-code') || lower.includes('upos-sz-mirrstar') ||
              lower.includes('videoplayback') || lower.includes('.douyinvod.com')) return true;
          return false;
        }

        function getMediaTypeFromUrl(url) {
          const lower = url.toLowerCase();
          if (lower.includes('.mp3') || lower.includes('mime=audio') || lower.includes('media-audio') ||
              lower.includes('-30216') || lower.includes('-30232') || lower.includes('-30280') ||
              lower.includes('-30250') || lower.includes('audio')) return 'audio';
          return 'video';
        }

        function sendMediaNotification(url, type = 'video') {
          window.postMessage({ source: 'tintin-sniffer', type: 'media-detected', data: { url, type } }, '*');
        }

        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const url = args[0];
          const resPromise = originalFetch.apply(this, args);
          let urlStr = '';
          if (typeof url === 'string') urlStr = url;
          else if (url && url.url) urlStr = url.url;
          if (isMediaUrl(urlStr)) sendMediaNotification(urlStr, getMediaTypeFromUrl(urlStr));
          try {
            const response = await resPromise;
            response._url = urlStr;
            const clone = response.clone();
            if (urlStr.includes('api') || urlStr.includes('following') || urlStr.includes('subscribe') ||
                urlStr.includes('relation') || urlStr.includes('aweme/v1/web/aweme/post') ||
                urlStr.includes('members') || urlStr.includes('activities') || urlStr.includes('user_posted') ||
                urlStr.includes('collect') || urlStr.includes('fav') || urlStr.includes('youtubei') ||
                urlStr.includes('item_list') || urlStr.includes('hot/search') || urlStr.includes('hot-lists') ||
                urlStr.includes('ranking') || urlStr.includes('search/hot')) {
              clone.json().then(data => {
                window.postMessage({ source: 'tintin-sniffer', type: 'api-response', data: { url: urlStr, payload: data } }, '*');
              }).catch(() => {});
            }
            return response;
          } catch(e) { return resPromise; }
        };

        const originalResponseArrayBuffer = Response.prototype.arrayBuffer;
        Response.prototype.arrayBuffer = async function() {
          const buf = await originalResponseArrayBuffer.call(this);
          if (buf && this._url) buf._url = this._url;
          return buf;
        };

        const originalResponseClone = Response.prototype.clone;
        Response.prototype.clone = function() {
          const cloned = originalResponseClone.call(this);
          cloned._url = this._url;
          return cloned;
        };

        const originalResponseBlob = Response.prototype.blob;
        Response.prototype.blob = async function() {
          const b = await originalResponseBlob.call(this);
          if (b && this._url) b._url = this._url;
          return b;
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          this._url = url;
          return originalOpen.apply(this, [method, url, ...args]);
        };

        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(...args) {
          this.addEventListener('load', () => {
            const urlStr = this._url;
            if (isMediaUrl(urlStr)) sendMediaNotification(urlStr, getMediaTypeFromUrl(urlStr));
            if (urlStr.includes('api') || urlStr.includes('following') || urlStr.includes('subscribe') ||
                urlStr.includes('relation') || urlStr.includes('aweme/v1/web/aweme/post') ||
                urlStr.includes('members') || urlStr.includes('activities') || urlStr.includes('user_posted') ||
                urlStr.includes('collect') || urlStr.includes('fav') || urlStr.includes('youtubei') ||
                urlStr.includes('item_list') || urlStr.includes('hot/search') || urlStr.includes('hot-lists') ||
                urlStr.includes('ranking') || urlStr.includes('search/hot')) {
              try {
                const data = JSON.parse(this.responseText);
                window.postMessage({ source: 'tintin-sniffer', type: 'api-response', data: { url: urlStr, payload: data } }, '*');
              } catch(e){}
            }
          });
          return originalSend.apply(this, args);
        };

        const responseProp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
        if (responseProp && responseProp.get) {
          const originalResponseGet = responseProp.get;
          Object.defineProperty(XMLHttpRequest.prototype, 'response', {
            get: function() {
              const res = originalResponseGet.call(this);
              if (res && res instanceof ArrayBuffer && this._url) res._url = this._url;
              return res;
            },
            configurable: true,
            enumerable: true
          });
        }

        const originalBlobArrayBuffer = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = async function() {
          const buf = await originalBlobArrayBuffer.call(this);
          if (buf && this._url) buf._url = this._url;
          return buf;
        };

        const originalFileReaderReadAsArrayBuffer = FileReader.prototype.readAsArrayBuffer;
        FileReader.prototype.readAsArrayBuffer = function(blob, ...args) {
          if (blob && blob._url) this._url = blob._url;
          return originalFileReaderReadAsArrayBuffer.apply(this, [blob, ...args]);
        };

        const resultProp = Object.getOwnPropertyDescriptor(FileReader.prototype, 'result');
        if (resultProp && resultProp.get) {
          const originalResultGet = resultProp.get;
          Object.defineProperty(FileReader.prototype, 'result', {
            get: function() {
              const res = originalResultGet.call(this);
              if (res && res instanceof ArrayBuffer && this._url) res._url = this._url;
              return res;
            },
            configurable: true,
            enumerable: true
          });
        }

        const responseBodyDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, 'body');
        if (responseBodyDescriptor && responseBodyDescriptor.get) {
          const originalBodyGet = responseBodyDescriptor.get;
          Object.defineProperty(Response.prototype, 'body', {
            get: function() {
              const bodyStream = originalBodyGet.call(this);
              if (bodyStream && this._url) bodyStream._url = this._url;
              return bodyStream;
            },
            configurable: true,
            enumerable: true
          });
        }

        const originalGetReader = ReadableStream.prototype.getReader;
        ReadableStream.prototype.getReader = function(...args) {
          const reader = originalGetReader.apply(this, args);
          if (this._url) reader._url = this._url;
          return reader;
        };

        if (window.ReadableStreamDefaultReader) {
          const originalRead = ReadableStreamDefaultReader.prototype.read;
          ReadableStreamDefaultReader.prototype.read = function(...args) {
            const promise = originalRead.apply(this, args);
            const readerUrl = this._url;
            if (readerUrl) {
              return promise.then(result => {
                if (result && result.value && result.value.buffer) {
                  result.value.buffer._url = readerUrl;
                }
                return result;
              });
            }
            return promise;
          };
        }

        const TypedArrayProto = Object.getPrototypeOf(Uint8Array).prototype;
        const originalSet = TypedArrayProto.set;
        TypedArrayProto.set = function(source, offset) {
          try {
            if (source && source.buffer && source.buffer._url) {
              this.buffer._url = source.buffer._url;
            }
          } catch(e) {}
          return originalSet.call(this, source, offset);
        };

        const originalSlice = ArrayBuffer.prototype.slice;
        ArrayBuffer.prototype.slice = function(...args) {
          const sliced = originalSlice.apply(this, args);
          if (this._url) sliced._url = this._url;
          return sliced;
        };
      })();
    `;
    const script = document.createElement('script');
    script.textContent = scriptContent;
    const inject = () => {
      const target = document.head || document.documentElement;
      if (target) target.appendChild(script);
      else setTimeout(inject, 2);
    };
    inject();
  }

  // 2. DOM 扫描素材
  function scanDOM() {
    const assets = [];
    const currentUrl = window.location.href;
    const imgs = document.querySelectorAll('img');
    imgs.forEach(img => {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('original-src');
      if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
      const width = img.naturalWidth || img.clientWidth || 0;
      const height = img.naturalHeight || img.clientHeight || 0;
      if (width > 0 && height > 0 && (width < 150 || height < 150)) return;
      const title = img.alt || img.title || '图片素材';
      assets.push({
        url: src, type: 'image',
        name: title + (src.includes('.webp') ? '.webp' : src.includes('.png') ? '.png' : '.jpg'),
        sizeText: width > 0 ? `${width} x ${height}` : '未知尺寸'
      });
    });
    const videos = document.querySelectorAll('video');
    videos.forEach((video, index) => {
      let src = video.src || '';
      if (!src) {
        const source = video.querySelector('source');
        if (source) src = source.src || '';
      }
      if (src && !src.startsWith('blob:')) {
        assets.push({ url: src, type: 'video', name: `视频素材_${index + 1}.mp4`, sizeText: 'Direct MP4' });
      }
    });
    if (assets.length > 0) {
      const uniqueAssets = Array.from(new Map(assets.map(item => [item.url, item])).values());
      ipcRenderer.sendToHost('dom-assets-scanned', uniqueAssets);
    }
  }

  // 3. 提取当前视频标题
  function getActiveVideoTitle() {
    const url = window.location.href;
    let title = '';
    try {
      if (url.includes('douyin.com')) {
        const activeContainer = document.querySelector('div[data-e2e="feed-active-video"]') || document.querySelector('.active-slide');
        if (activeContainer) {
          const titleEl = activeContainer.querySelector('h1') || activeContainer.querySelector('.title') || activeContainer.querySelector('[class*="title"]');
          if (titleEl) title = titleEl.textContent.trim();
        }
        if (!title) { const h1 = document.querySelector('h1'); if (h1) title = h1.textContent.trim(); }
      } else if (url.includes('bilibili.com')) {
        const titleEl = document.querySelector('h1.video-title') || document.querySelector('h1');
        if (titleEl) title = titleEl.textContent.trim();
      } else if (url.includes('youtube.com')) {
        const titleEl = document.querySelector('h1.ytd-watch-metadata') || document.querySelector('h1');
        if (titleEl) title = titleEl.textContent.trim();
      }
    } catch(e) {}
    if (!title) title = document.title;
    if (title) {
      title = title.replace(/\s*-\s*YouTube/gi, '').replace(/\s*-\s*哔哩哔哩\s*-\s*bilibili/gi, '')
                   .replace(/\s*_\s*哔哩哔哩\s*_\s*bilibili/gi, '').replace(/\s*-\s*抖音/gi, '');
    }
    title = (title || '视频素材').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
    if (title.length > 60) title = title.substring(0, 60) + '...';
    return title;
  }

  // 4. 初始化
  injectMainWorldScript();

  document.addEventListener('play', (event) => {
    if (event.target && event.target.tagName === 'VIDEO') {
      ipcRenderer.sendToHost('video-active-changed', {
        src: event.target.src,
        title: getActiveVideoTitle(),
        currentUrl: window.location.href
      });
    }
  }, true);

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => { scanDOM(); }, 2000);
    setInterval(() => { scanDOM(); }, 2000);
  });

  // 5. 接收页面上下文嗅探消息
  window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'tintin-sniffer') {
      const { type, data } = event.data;
      if (type === 'media-detected') {
        const { url, type: mediaType } = data;
        let filename = '素材file';
        try {
          const parsed = new URL(url);
          filename = parsed.pathname.substring(parsed.pathname.lastIndexOf('/') + 1) || 'asset';
        } catch(e) {}
        if (!filename.includes('.')) filename += mediaType === 'audio' ? '.mp3' : '.mp4';
        ipcRenderer.sendToHost('network-media-sniffed', [{ url, type: mediaType, name: filename, sizeText: '网络流嗅探' }]);
      }
      if (type === 'mse-segment-appended') {
        ipcRenderer.sendToHost('mse-segment-appended', data);
      }
      if (type === 'api-response') {
        handleApiResponse(data.url, data.payload);
      }
    }
  });

  // 6. API 响应处理（关注列表、创作者视频列表、热榜等）
  function handleApiResponse(url, payload) {
    const list = [];
    // B站关注
    if (url.includes('api.bilibili.com/x/relation/followings') && payload?.data?.list) {
      payload.data.list.forEach(item => {
        list.push({ id: String(item.mid), name: item.uname, avatar: item.face, url: `https://space.bilibili.com/${item.mid}`, platform: 'bilibili' });
      });
    }
    // 抖音关注
    if (url.includes('aweme/v1/user/following/list') && payload?.followings) {
      payload.followings.forEach(user => {
        list.push({ id: user.sec_uid || user.uid, name: user.nickname, avatar: user.avatar_thumb?.url_list?.[0] || '', url: `https://www.douyin.com/user/${user.sec_uid || user.uid}`, platform: 'douyin' });
      });
    }
    if (list.length > 0) ipcRenderer.sendToHost('following-list-synced', list);

    // 抖音创作者视频列表
    if (url.includes('aweme/v1/web/aweme/post') && payload?.aweme_list) {
      const notes = payload.aweme_list.map(item => ({
        id: item.aweme_id, title: item.desc || '抖音视频',
        url: `https://www.douyin.com/video/${item.aweme_id}`,
        cover: item.video?.cover?.url_list?.[0] || '',
        date: item.create_time ? new Date(item.create_time * 1000).toLocaleString() : '',
        timestamp: item.create_time ? item.create_time * 1000 : 0,
        heat: item.statistics?.digg_count !== undefined ? (item.statistics.digg_count >= 10000 ? (item.statistics.digg_count / 10000).toFixed(1) + '万赞' : item.statistics.digg_count + '赞') : '',
        type: 'video'
      }));
      ipcRenderer.sendToHost('douyin-user-posted-intercepted', { secUid: url.match(/sec_user_id=([^&]+)/)?.[1] || '', notes });
    }
    // B站创作者视频列表
    if (url.includes('api.bilibili.com/x/space/wbi/arc/search') && payload?.data?.list?.vlist) {
      const notes = payload.data.list.vlist.map(item => ({
        id: item.bvid, title: item.title,
        url: `https://www.bilibili.com/video/${item.bvid}`,
        cover: item.pic ? (item.pic.startsWith('http') ? item.pic : 'https:' + item.pic) : '',
        date: item.created ? new Date(item.created * 1000).toLocaleString() : '',
        timestamp: item.created ? item.created * 1000 : 0,
        heat: item.play !== undefined ? (typeof item.play === 'number' && item.play >= 10000 ? (item.play / 10000).toFixed(1) + '万播放' : item.play + '播放') : '',
        type: 'video'
      }));
      ipcRenderer.sendToHost('bilibili-user-posted-intercepted', { userId: url.match(/mid=(\d+)/)?.[1] || '', notes });
    }
    // 抖音热榜
    if (url.includes('aweme/v1/web/hot/search/list') && payload) {
      const wl = (payload.data && (payload.data.word_list || payload.data.data)) || payload.word_list || [];
      const list = (wl || []).map((w, i) => ({
        platform: 'douyin', title: w.word || w.sentence || w.title || '',
        rank: (w.position !== undefined ? w.position + 1 : i + 1),
        hot: w.hot_value || 0,
        url: w.word ? `https://www.douyin.com/search/${encodeURIComponent(w.word)}` : ''
      })).filter(x => x.title);
      if (list.length) ipcRenderer.sendToHost('hotspot-items-synced', list);
    }
  }

  // 7. 手动触发嗅探
  ipcRenderer.on('trigger-manual-sniff', () => {
    try { scanDOM(); } catch (e) {}
  });
}
