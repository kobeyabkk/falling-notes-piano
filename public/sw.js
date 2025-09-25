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

  // 1) HTML: ネット優先 + オフライン時は index.html にフォールバック
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 次回のために index.html を更新
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() =>
          caches.match("/index.html").then((hit) => hit || caches.match("/"))
        )
    );
    return;
  }

  // 2) Vite の静的アセット（/assets/…）: キャッシュ優先（Cache First）
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

  // 3) 外部CDN（例: Salamander音源など）: Stale-While-Revalidate
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const fetching = fetch(req)
          .then((res) => {
            // opaque レスポンスでも put 可能
            caches.open(STATIC_CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
            return res;
          })
          .catch(() => null);
        return hit || fetching || Response.error();
      })
    );
    return;
  }

  // 4) その他: キャッシュ → ネット（簡易フォールバック）
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match("/index.html")))
  );
});
