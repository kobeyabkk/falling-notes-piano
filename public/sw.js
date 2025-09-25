/* Falling Notes Piano - Service Worker */
const VERSION = "v1.0.1";
const CACHE_PREFIX = "fnp-static-";
const STATIC_CACHE = `${CACHE_PREFIX}${VERSION}`;

const STATIC_ASSETS = [
  "/",                   // ルート（Vercelのルーティング都合で残す）
  "/index.html",         // HTML本体
  "/manifest.webmanifest",
  "/icons/icon-192.png", // PWAアイコン（事前キャッシュ）
  "/icons/icon-512.png"
  // /assets/ 以下はハッシュ付きビルド資産なので動的にキャッシュ
];

// ---- install: 主要ファイルを事前キャッシュ ----
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ---- activate: 古いバージョンのキャッシュを削除 ----
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ---- fetch: ルーティング ----
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) HTML: Cache-First（オフライン殻を最優先）＋ 背景で最新に更新
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      caches.match("/index.html").then((cached) => {
        const updating = fetch(req)
          .then((res) => {
            // 次回用に index.html と / の両方を更新しておく
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => {
              c.put("/index.html", copy.clone());
              c.put("/", copy);
            });
            return res;
          })
          .catch(() => null);

        // まずはキャッシュを即返す（あれば）
        if (cached) return cached;

        // ない時だけネット（失敗したら最後にフォールバック）
        return updating.then((res) => res || caches.match("/") || Response.error());
      })
    );
    return;
  }

  // 2) Vite の静的アセット（/assets/…）: Cache First
  if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // 3) 外部CDN（例: 音源など）: Stale-While-Revalidate
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const fetching = fetch(req)
          .then((res) => {
            caches.open(STATIC_CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
            return res;
          })
          .catch(() => null);
        return hit || fetching || Response.error();
      })
    );
    return;
  }

  // 4) その他: キャッシュ → ネット → 最後に index.html
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match("/index.html")))
  );
});

