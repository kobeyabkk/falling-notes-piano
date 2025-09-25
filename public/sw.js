/* simple service worker for FNPiano */
const VERSION = "v1.0.0";
const STATIC_CACHE = `fnp-static-${VERSION}`;

const STATIC_ASSETS = [
  "/",              // ルート
  "/index.html",
  "/manifest.webmanifest"
  // Viteのハッシュ付きassetsは動的にキャッシュする（明示列挙しない）
];

// ---- install: 主要ファイルを事前キャッシュ ----
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ---- activate: 古いキャッシュの整理 ----
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k.startsWith("fnp-") && k !== STATIC_CACHE) ? caches.delete(k) : null))
    )
  );
  self.clients.claim();
});

// ---- fetch: ルーティング ----
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) HTML: ネット優先（オフライン時のフォールバック）
  if (req.mode === "navigate" || (req.destination === "document")) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then((c) => c.put("/", copy));
        return res;
      }).catch(() => caches.match("/") || caches.match("/index.html"))
    );
    return;
  }

  // 2) Viteの静的アセット（/assets/）: キャッシュ優先
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
          return res;
        });
      })
    );
    return;
  }

  // 3) 外部CDN（Salamander等）は「実行時: stale-while-revalidate」
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          // opaqueでもput可能（CORS: no-corsレスポンス）
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => null);
        return hit || net || Response.error();
      })
    );
    return;
  }

  // 4) それ以外は「キャッシュ→ネット」の簡易フォールバック
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match("/")))
  );
});
