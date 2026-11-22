// Science proxy client runtime
// プロキシしたすべての HTML ページの先頭にインラインで埋め込まれ、
// ページの JS が行う通信・ページ移動・DOM 操作をプロキシ経由に書き換える。
;(function () {
  "use strict"
  if (window.__science__) return
  var currentScript = document.currentScript

  var PREFIX_PATH = "/proxy/"
  var ORIGIN = location.origin
  var PREFIX = ORIGIN + PREFIX_PATH
  var WS_PREFIX = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + PREFIX_PATH
  var ORIGIN_COOKIE = "science_origin"
  var SKIP_RE = /^(data|blob|javascript|about|mailto|tel|sms|intent|file|vbscript):/i
  var PROTO_RE = /^(https?|wss?):$/

  var desc = function (obj, prop) {
    return obj ? Object.getOwnPropertyDescriptor(obj, prop) : undefined
  }
  var safe = function (fn) {
    try {
      fn()
    } catch (e) {}
  }

  var nativeBaseURI = desc(Node.prototype, "baseURI").get
  var nativeGetAttr = Element.prototype.getAttribute
  var nativeSetAttr = Element.prototype.setAttribute

  // ---------- URL 変換 ----------
  var fixScheme = function (s) {
    return s.replace(/^(https?|wss?):\/+/i, function (m, p) {
      return p + "://"
    })
  }
  function isProxied(u) {
    return typeof u === "string" && (u.indexOf(PREFIX) === 0 || u.indexOf(PREFIX_PATH) === 0 || u.indexOf(WS_PREFIX) === 0)
  }
  // プロキシ URL -> 本来の URL
  function unproxy(u) {
    if (typeof u !== "string") return u
    if (u.indexOf(PREFIX) === 0) return fixScheme(u.slice(PREFIX.length))
    if (u.indexOf(WS_PREFIX) === 0) {
      return fixScheme(u.slice(WS_PREFIX.length)).replace(/^http/i, "ws")
    }
    if (u.indexOf(PREFIX_PATH) === 0) return fixScheme(u.slice(PREFIX_PATH.length))
    return u
  }
  function pageUrl() {
    return unproxy(location.href)
  }
  function baseUrl() {
    try {
      return unproxy(nativeBaseURI.call(document))
    } catch (e) {
      return pageUrl()
    }
  }
  function pageOrigin() {
    try {
      return new URL(pageUrl()).origin
    } catch (e) {
      return ORIGIN
    }
  }
  // 本来の宛先 URL を求める。書き換え不要なら null
  function resolve(u) {
    if (u == null) return null
    if (u instanceof URL) u = u.href
    u = String(u).trim()
    if (!u || u[0] === "#" || SKIP_RE.test(u) || isProxied(u)) return null
    var abs
    try {
      abs = new URL(u, baseUrl())
    } catch (e) {
      return null
    }
    if (!PROTO_RE.test(abs.protocol)) return null
    // location.origin + "/api" のように「プロキシ自身のオリジン」で組み立てられた URL
    if (abs.host === location.host) {
      if (abs.pathname.indexOf(PREFIX_PATH) === 0) return null
      abs = new URL(abs.pathname + abs.search + abs.hash, pageOrigin())
    }
    return abs
  }
  function proxify(u) {
    var abs = resolve(u)
    return abs ? PREFIX + abs.href : u
  }
  function proxifyWs(u) {
    var abs = resolve(u)
    if (!abs) return u
    if (abs.protocol === "wss:") abs.protocol = "https:"
    else if (abs.protocol === "ws:") abs.protocol = "http:"
    return WS_PREFIX + abs.href
  }
  // 属性取得用: 同じサイト内ならパス形式で返す ("/about" のまま見えるように)
  function unproxyForAttr(v) {
    if (!isProxied(v)) return v
    var real = unproxy(v)
    try {
      var u = new URL(real)
      if (u.origin === pageOrigin()) return u.pathname + u.search + u.hash
    } catch (e) {}
    return real
  }
  function mapSrcset(v, fn) {
    v = String(v)
    if (v.indexOf("data:") >= 0) return v
    return v
      .split(",")
      .map(function (part) {
        var m = /^(\s*)(\S+)([\s\S]*)$/.exec(part)
        return m ? m[1] + fn(m[2]) + m[3] : part
      })
      .join(",")
  }

  // ---------- 通信 API ----------
  safe(function () {
    var nativeFetch = window.fetch
    window.fetch = function fetch(input, init) {
      try {
        if (input instanceof Request) {
          var p = proxify(input.url)
          if (p !== input.url) input = new Request(p, input)
        } else {
          input = proxify(input)
        }
      } catch (e) {}
      return nativeFetch.call(window, input, init)
    }
  })

  safe(function () {
    var open = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments)
      args[1] = proxify(url)
      return open.apply(this, args)
    }
    hookGetter(XMLHttpRequest.prototype, "responseURL", unproxy)
  })

  safe(function () {
    hookGetter(Response.prototype, "url", unproxy)
  })

  safe(function () {
    var NativeWS = window.WebSocket
    var WS = function WebSocket(url, protocols) {
      return arguments.length > 1 ? new NativeWS(proxifyWs(url), protocols) : new NativeWS(proxifyWs(url))
    }
    WS.prototype = NativeWS.prototype
    ;["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
      WS[k] = NativeWS[k]
    })
    window.WebSocket = WS
    hookGetter(NativeWS.prototype, "url", unproxy)
  })

  ;["EventSource", "Worker", "SharedWorker"].forEach(function (name) {
    safe(function () {
      var Native = window[name]
      if (!Native) return
      var Wrapped = function (url, opts) {
        return arguments.length > 1 ? new Native(proxify(url), opts) : new Native(proxify(url))
      }
      Wrapped.prototype = Native.prototype
      if (name === "EventSource") {
        ;["CONNECTING", "OPEN", "CLOSED"].forEach(function (k) {
          Wrapped[k] = Native[k]
        })
        hookGetter(Native.prototype, "url", unproxy)
      }
      window[name] = Wrapped
    })
  })

  safe(function () {
    var beacon = Navigator.prototype.sendBeacon
    if (beacon) {
      Navigator.prototype.sendBeacon = function (url, data) {
        return beacon.call(this, proxify(url), data)
      }
    }
  })

  // ---------- ページ移動 ----------
  safe(function () {
    var nativeOpen = window.open
    window.open = function (url) {
      var args = Array.prototype.slice.call(arguments)
      if (url != null && url !== "") args[0] = proxify(url)
      return nativeOpen.apply(window, args)
    }
  })

  safe(function () {
    ;["pushState", "replaceState"].forEach(function (m) {
      var native = History.prototype[m]
      History.prototype[m] = function (state, title, url) {
        if (arguments.length < 3 || url == null) return native.call(this, state, title)
        return native.call(this, state, title, proxify(url))
      }
    })
  })

  // location.href = "..." などは Navigation API で捕まえる (Chrome / Edge / 新しい Firefox / Safari)
  safe(function () {
    if (!window.navigation || typeof navigation.addEventListener !== "function") return
    navigation.addEventListener("navigate", function (e) {
      try {
        if (!e.cancelable || e.navigationType === "traverse" || e.formData || e.downloadRequest != null) return
        var dest = e.destination.url
        if (isProxied(dest)) return
        var p = proxify(dest)
        if (p === dest) return
        e.preventDefault()
        if (e.navigationType === "replace") location.replace(p)
        else location.assign(p)
      } catch (err) {}
    })
  })

  // Navigation API が無いブラウザ向け: リンクのクリックとフォーム送信を直前に書き換え
  function fixLink(e) {
    var a = e.target && e.target.closest && e.target.closest("a[href],area[href]")
    if (!a) return
    var href = nativeGetAttr.call(a, "href")
    if (href && !isProxied(href)) {
      var p = proxify(href)
      if (p !== href) nativeSetAttr.call(a, "href", p)
    }
  }
  function fixForm(form, submitter) {
    try {
      var fa = submitter && nativeGetAttr.call(submitter, "formaction")
      if (fa && !isProxied(fa)) nativeSetAttr.call(submitter, "formaction", proxify(fa))
      var action = nativeGetAttr.call(form, "action")
      if (action && !isProxied(action)) nativeSetAttr.call(form, "action", proxify(action))
    } catch (e) {}
  }
  document.addEventListener("click", fixLink, true)
  document.addEventListener("auxclick", fixLink, true)
  document.addEventListener(
    "submit",
    function (e) {
      fixForm(e.target, e.submitter)
    },
    true
  )
  safe(function () {
    var submit = HTMLFormElement.prototype.submit
    HTMLFormElement.prototype.submit = function () {
      fixForm(this)
      return submit.call(this)
    }
  })

  // ---------- DOM の URL プロパティ ----------
  function hookGetter(proto, prop, fn) {
    var d = desc(proto, prop)
    if (!d || !d.get) return
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: function () {
        return fn(d.get.call(this))
      },
      set: d.set,
    })
  }
  function hookUrlProp(Ctor, prop, kind) {
    if (!Ctor) return
    var d = desc(Ctor.prototype, prop)
    if (!d || !d.get) return
    var toReal = kind === "srcset" ? function (v) { return mapSrcset(v, unproxy) } : unproxy
    var toProxy = kind === "srcset" ? function (v) { return mapSrcset(v, proxify) } : proxify
    Object.defineProperty(Ctor.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: function () {
        return toReal(d.get.call(this))
      },
      set: d.set
        ? function (v) {
            d.set.call(this, toProxy(v))
          }
        : undefined,
    })
  }
  ;[
    ["HTMLAnchorElement", "href"], ["HTMLAreaElement", "href"], ["HTMLLinkElement", "href"],
    ["HTMLBaseElement", "href"], ["HTMLScriptElement", "src"], ["HTMLImageElement", "src"],
    ["HTMLImageElement", "currentSrc"], ["HTMLIFrameElement", "src"], ["HTMLFrameElement", "src"],
    ["HTMLEmbedElement", "src"], ["HTMLSourceElement", "src"], ["HTMLTrackElement", "src"],
    ["HTMLMediaElement", "src"], ["HTMLMediaElement", "currentSrc"], ["HTMLInputElement", "src"],
    ["HTMLVideoElement", "poster"], ["HTMLObjectElement", "data"], ["HTMLFormElement", "action"],
    ["HTMLInputElement", "formAction"], ["HTMLButtonElement", "formAction"],
  ].forEach(function (p) {
    safe(function () {
      hookUrlProp(window[p[0]], p[1])
    })
  })
  ;[["HTMLImageElement", "srcset"], ["HTMLSourceElement", "srcset"], ["HTMLLinkElement", "imageSrcset"]].forEach(
    function (p) {
      safe(function () {
        hookUrlProp(window[p[0]], p[1], "srcset")
      })
    }
  )

  // a.hostname / a.pathname なども本来の URL を返す
  ;["HTMLAnchorElement", "HTMLAreaElement"].forEach(function (name) {
    ;["origin", "protocol", "host", "hostname", "port", "pathname", "search"].forEach(function (part) {
      safe(function () {
        var proto = window[name].prototype
        var d = desc(proto, part)
        if (!d) return
        Object.defineProperty(proto, part, {
          configurable: true,
          enumerable: d.enumerable,
          get: function () {
            try {
              var h = this.href
              if (h) return new URL(h)[part]
            } catch (e) {}
            return d.get.call(this)
          },
          set: d.set,
        })
      })
    })
  })

  // SRI はプロキシで内容が変わるため無効化
  ;["HTMLScriptElement", "HTMLLinkElement"].forEach(function (name) {
    safe(function () {
      var proto = window[name].prototype
      var d = desc(proto, "integrity")
      if (!d) return
      Object.defineProperty(proto, "integrity", {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function () {},
      })
    })
  })

  // setAttribute / getAttribute
  var URL_ATTRS = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, background: 1, cite: 1, longdesc: 1, manifest: 1, "xlink:href": 1, lowsrc: 1, icon: 1 }
  function attrKind(el, name) {
    name = String(name).toLowerCase()
    if (URL_ATTRS[name] || (name === "data" && el.tagName === "OBJECT")) return "url"
    if (name === "srcset" || name === "imagesrcset") return "srcset"
    if (name === "integrity" && (el.tagName === "SCRIPT" || el.tagName === "LINK")) return "integrity"
    return null
  }
  safe(function () {
    Element.prototype.setAttribute = function (name, value) {
      var k = attrKind(this, name)
      if (k === "integrity") return
      if (k === "url") value = proxify(value)
      else if (k === "srcset") value = mapSrcset(value, proxify)
      return nativeSetAttr.call(this, name, value)
    }
    Element.prototype.getAttribute = function (name) {
      var v = nativeGetAttr.call(this, name)
      if (v == null) return v
      var k = attrKind(this, name)
      if (k === "url") return unproxyForAttr(v)
      if (k === "srcset") return mapSrcset(v, unproxy)
      return v
    }
    var setNS = Element.prototype.setAttributeNS
    Element.prototype.setAttributeNS = function (ns, name, value) {
      var local = String(name).split(":").pop()
      if (attrKind(this, local) === "url") value = proxify(value)
      return setNS.call(this, ns, name, value)
    }
  })

  // ---------- document のプロパティ ----------
  safe(function () {
    hookGetter(Document.prototype, "URL", unproxy)
    hookGetter(Document.prototype, "documentURI", unproxy)
    hookGetter(Document.prototype, "referrer", unproxy)
    hookGetter(Node.prototype, "baseURI", unproxy)
  })
  safe(function () {
    var d = desc(Document.prototype, "domain")
    Object.defineProperty(Document.prototype, "domain", {
      configurable: true,
      enumerable: d ? d.enumerable : true,
      get: function () {
        try {
          return new URL(pageUrl()).hostname
        } catch (e) {
          return d.get.call(this)
        }
      },
      set: function () {},
    })
  })
  safe(function () {
    Object.defineProperty(window, "origin", { configurable: true, get: pageOrigin })
  })

  // document.cookie: サーバー側と同じ規則でサイトごとのパスに付け替える
  safe(function () {
    var d = desc(Document.prototype, "cookie")
    if (!d) return
    var secure = location.protocol === "https:"
    var NAME_MAP = [["__Host-", "__sci_host__"], ["__Secure-", "__sci_secure__"]]
    var encodeName = function (n) {
      for (var i = 0; i < NAME_MAP.length; i++) if (n.indexOf(NAME_MAP[i][0]) === 0) return NAME_MAP[i][1] + n.slice(NAME_MAP[i][0].length)
      return n
    }
    var decodeName = function (n) {
      for (var i = 0; i < NAME_MAP.length; i++) if (n.indexOf(NAME_MAP[i][1]) === 0) return NAME_MAP[i][0] + n.slice(NAME_MAP[i][1].length)
      return n
    }
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      enumerable: d.enumerable,
      get: function () {
        return d.get
          .call(this)
          .split(/;\s*/)
          .filter(function (c) {
            return c && c.indexOf(ORIGIN_COOKIE + "=") !== 0
          })
          .map(function (c) {
            var i = c.indexOf("=")
            return i < 0 ? c : decodeName(c.slice(0, i)) + c.slice(i)
          })
          .join("; ")
      },
      set: function (value) {
        var parts = String(value).split(";")
        var pair = parts.shift()
        var i = pair.indexOf("=")
        if (i >= 0) pair = encodeName(pair.slice(0, i).trim()) + pair.slice(i)
        var path = "/"
        var out = []
        parts.forEach(function (attr) {
          var j = attr.indexOf("=")
          var key = (j < 0 ? attr : attr.slice(0, j)).trim().toLowerCase()
          var val = j < 0 ? "" : attr.slice(j + 1).trim()
          if (!key || key === "domain") return
          if (key === "path") {
            if (val[0] === "/") path = val
            return
          }
          if (key === "secure" || key === "partitioned") {
            if (secure) out.push(key)
            return
          }
          if (key === "samesite" && !secure && val.toLowerCase() === "none") {
            out.push("SameSite=Lax")
            return
          }
          out.push(attr.trim())
        })
        out.unshift("Path=" + PREFIX_PATH + pageOrigin() + path)
        d.set.call(this, [pair].concat(out).join("; "))
      },
    })
  })

  // ---------- postMessage ----------
  // すべてのページがプロキシのオリジンになるため、targetOrigin 指定を緩め、
  // 受信側の event.origin は本来のサイトのオリジンに見せる
  safe(function () {
    var nativePost = window.postMessage
    window.postMessage = function (message, targetOrigin, transfer) {
      var self = this && this.postMessage ? this : window
      if (targetOrigin && typeof targetOrigin === "object") {
        var opts = Object.assign({}, targetOrigin)
        if (opts.targetOrigin && opts.targetOrigin !== "/") opts.targetOrigin = "*"
        return nativePost.call(self, message, opts)
      }
      if (typeof targetOrigin === "string" && targetOrigin !== "*" && targetOrigin !== "/") targetOrigin = "*"
      return transfer === undefined
        ? nativePost.call(self, message, targetOrigin)
        : nativePost.call(self, message, targetOrigin, transfer)
    }
  })
  safe(function () {
    var d = desc(MessageEvent.prototype, "origin")
    Object.defineProperty(MessageEvent.prototype, "origin", {
      configurable: true,
      enumerable: d.enumerable,
      get: function () {
        var o = d.get.call(this)
        if (o === ORIGIN) {
          try {
            var src = this.source
            if (src && src.location) return new URL(unproxy(src.location.href)).origin
          } catch (e) {}
        }
        return o
      },
    })
  })

  // ---------- Service Worker ----------
  // サイト独自の Service Worker は登録させない (プロキシの SW と衝突するため)
  safe(function () {
    var container = navigator.serviceWorker
    if (!container) return
    var proto = Object.getPrototypeOf(container)
    var register = proto.register
    if (window === window.top) register.call(container, "/sw.js", { scope: "/" }).catch(function () {})
    proto.register = function () {
      return Promise.reject(new DOMException("Service workers are not available through the proxy", "SecurityError"))
    }
    proto.getRegistrations = function () {
      return Promise.resolve([])
    }
    proto.getRegistration = function () {
      return Promise.resolve(undefined)
    }
    Object.defineProperty(proto, "ready", {
      configurable: true,
      get: function () {
        return new Promise(function () {})
      },
    })
    Object.defineProperty(proto, "controller", {
      configurable: true,
      get: function () {
        return null
      },
    })
  })

  Object.defineProperty(window, "__science__", {
    value: { proxify: proxify, unproxy: unproxy },
    enumerable: false,
  })
  if (currentScript) currentScript.remove()
})()
