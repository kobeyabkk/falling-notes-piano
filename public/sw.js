/* Falling Notes Piano - Service Worker */
const VERSION = "v1.1.0";
const CACHE_PREFIX = "fnp-static-";
const STATIC_CACHE = `${CACHE_PREFIX}${VERSION}`;

const ROOT_URL = "/";
const HTML_URL = "/index.html";
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png"
];

const HTML_MATCH_OPTIONS = { ignoreSearch: true, ignoreVary: true };

self.__FNP_VERSION = VERSION;

self.addEventListener("install", (event) => {
  log("install", VERSION);
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cacheStaticShell(cache);
      await cacheStaticAssets(cache, STATIC_ASSETS);
      await broadcastOfflineStatus();
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  log("activate", VERSION);
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      );
      await broadcastOfflineStatus();
    })()
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(handleHtmlRequest(event, req));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
    event.respondWith(handleAssetRequest(req));
    return;
  }

  if (url.origin !== self.location.origin) {
    event.respondWith(handleExternalRequest(req));
    return;
  }

  event.respondWith(handleGenericRequest(req));
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const replyPort = event.ports && event.ports[0];

  if (data.type === "SKIP_WAITING") {
    log("message", "SKIP_WAITING");
    self.skipWaiting();
    return;
  }

  if (data.type === "PING_VERSION") {
    respond(replyPort, { type: "SW_VERSION", version: VERSION });
    return;
  }

  if (data.type === "OFFLINE_STATUS_REQUEST") {
    event.waitUntil(
      (async () => {
        const status = await computeOfflineStatus();
        respond(replyPort, { type: "OFFLINE_STATUS", status });
      })()
    );
    return;
  }

  if (data.type === "PRECACHE_URLS") {
    const urls = Array.isArray(data.urls) ? data.urls : [];
    log("message", "PRECACHE_URLS", urls.length);
    event.waitUntil(
      (async () => {
        const result = await precacheUrls(urls);
        respond(replyPort, { type: "PRECACHE_RESULT", result });
        await broadcastOfflineStatus();
      })()
    );
    return;
  }
});

async function handleHtmlRequest(event, req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(HTML_URL, HTML_MATCH_OPTIONS);

  const updatePromise = (async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copyA = res.clone();
        const copyB = res.clone();
        await cache.put(HTML_URL, copyA);
        await cache.put(ROOT_URL, copyB);
        await broadcastOfflineStatus();
      }
      return res;
    } catch (err) {
      log("fetch-html", "network failed", err);
      return null;
    }
  })();

  event.waitUntil(updatePromise);

  if (cached) {
    return cached;
  }

  const fresh = await updatePromise;
  if (fresh) {
    return fresh;
  }

  const fallback = await cache.match(ROOT_URL, HTML_MATCH_OPTIONS);
  if (fallback) {
    return fallback;
  }

  return Response.error();
}

async function handleAssetRequest(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      await cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    log("fetch-asset", "failed", req.url, err);
    return caches.match(HTML_URL, HTML_MATCH_OPTIONS);
  }
}

async function handleExternalRequest(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then(async (res) => {
      if (res && res.ok) {
        await cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => null);
  if (cached) {
    return cached;
  }
  const fresh = await fetchPromise;
  if (fresh) {
    return fresh;
  }
  return Response.error();
}

async function handleGenericRequest(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    return cached;
  }
  try {
    return await fetch(req);
  } catch {
    const fallback = await cache.match(HTML_URL, HTML_MATCH_OPTIONS);
    if (fallback) {
      return fallback;
    }
    throw new Error("offline");
  }
}

async function cacheStaticShell(cache) {
  try {
    const res = await fetch(HTML_URL, { cache: "no-store" });
    if (res && res.ok) {
      await cache.put(HTML_URL, res.clone());
      await cache.put(ROOT_URL, res.clone());
      return true;
    }
  } catch (err) {
    log("install", "html cache failed", err);
  }
  return false;
}

async function cacheStaticAssets(cache, urls) {
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res && res.ok) {
          await cache.put(url, res.clone());
        }
      } catch (err) {
        log("install", "asset cache failed", url, err);
      }
    })
  );
}

async function precacheUrls(urls) {
  if (!urls.length) {
    return { ok: false, cached: 0, skipped: [], errors: ["no-urls"] };
  }
  const unique = Array.from(
    new Set(
      urls
        .map((url) => {
          try {
            const abs = new URL(url, self.location.origin);
            if (abs.origin !== self.location.origin) {
              return null;
            }
            return abs.pathname + abs.search;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    )
  );
  const cache = await caches.open(STATIC_CACHE);
  const errors = [];
  let cached = 0;
  for (const url of unique) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res && res.ok) {
        await cache.put(url, res.clone());
        cached += 1;
      } else {
        errors.push({ url, status: res ? res.status : "no-response" });
      }
    } catch (err) {
      errors.push({ url, error: String(err) });
    }
  }
  return { ok: errors.length === 0, cached, total: unique.length, errors };
}

async function computeOfflineStatus() {
  const keys = await caches.keys();
  const active = keys.find((k) => k === STATIC_CACHE);
  if (!active) {
    return { ok: false, reason: "cache-missing", version: VERSION };
  }
  const cache = await caches.open(active);
  const essentials = [ROOT_URL, HTML_URL, ...STATIC_ASSETS];
  const missing = [];
  for (const url of essentials) {
    const hit = await cache.match(url, HTML_MATCH_OPTIONS);
    if (!hit) {
      missing.push(url);
    }
  }
  return {
    ok: missing.length === 0,
    cacheName: active,
    missing,
    version: VERSION,
    stored: essentials.length - missing.length,
    checked: essentials.length
  };
}

async function broadcastOfflineStatus() {
  const status = await computeOfflineStatus();
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) {
    client.postMessage({ type: "OFFLINE_STATUS", status });
  }
}

function respond(port, payload) {
  if (port) {
    port.postMessage(payload);
  } else if (payload) {
    self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((clients) => {
      clients.forEach((client) => client.postMessage(payload));
    });
  }
}

function log(...args) {
  try {
    console.log("[FNPWA]", ...args);
  } catch {
    /* noop */
  }
}
