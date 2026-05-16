// ============================================================
// TOKIWA-HUB Service Worker (WWWW-2)
// - 静的アセットを Cache First で配信 (爆速起動)
// - GAS API 等のネットワーク呼び出しは Network First (失敗時のみキャッシュ)
// - キャッシュ名の version を上げると自動で旧キャッシュを掃除
// ============================================================

const CACHE_VERSION = 'tokiwa-hub-v1';
const RUNTIME_CACHE = 'tokiwa-hub-runtime-v1';

// 起動時に最低限プリキャッシュするアセット (任意で増やせる)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ─── install: 静的アセットを事前キャッシュ ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // 失敗しても無視 (個別ファイルが無い環境でも install を成功させる)
      return Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] precache miss:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ─── activate: 古いキャッシュを削除 ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── fetch: リクエスト処理 ───
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET 以外はキャッシュしない
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // GAS API (Google Apps Script) や Anthropic API はネットワーク優先
  // 失敗時のみキャッシュフォールバック (= オフラインでも最後のデータが見える)
  const isApi =
    url.host.includes('script.google.com') ||
    url.host.includes('googleusercontent.com') ||
    url.host.includes('api.anthropic.com') ||
    url.host.includes('googleapis.com');

  if (isApi) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 成功レスポンスのみキャッシュ
          if (res && res.status === 200 && res.type !== 'opaque') {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 静的アセットは Cache First → 失敗時 Network → 同期で更新
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // バックグラウンドで再取得 (stale-while-revalidate)
        fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, res.clone()));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => {
          // オフライン + 未キャッシュ → index.html を返してナビゲーションを救う
          if (req.mode === 'navigate') return caches.match('./index.html');
          return new Response('Offline', { status: 503 });
        });
    })
  );
});

// ─── message: アプリ側からの skipWaiting / バージョンチェック ───
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_VERSION });
  }
});
