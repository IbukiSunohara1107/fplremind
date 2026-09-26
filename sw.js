// FPL Deadline Reminder — Service Worker v6
// Handles: caching, Periodic Background Sync, push notifications

const CACHE_NAME = 'fpl-reminder-v6';

const FPL_API = 'https://fantasy.premierleague.com/api/bootstrap-static/';

const CORS_PROXIES = [
  'https://corsproxy.io/?url=',
  'https://api.allorigins.win/raw?url=',
];

const CACHE_KEYS = {
  EVENTS: 'fpl-cached-events',
  LAST_NOTIFIED_GW: 'fpl-last-notified-gw',
};

const REMIND_MIN_HOURS = 3;
const REMIND_MAX_HOURS = 8;


// ============================================================
// INSTALL
// ============================================================

self.addEventListener('install', (event) => {
  console.log('[SW v6] Installing...');

  // 新しいService Workerをすぐwaitingからactiveへ
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // index.htmlはここではキャッシュしない
      // → 常に最新HTMLを取得できるようにする
      return cache.addAll([
        './manifest.json',
        './icon-192.png',
      ]);
    })
  );
});


// ============================================================
// ACTIVATE
// ============================================================

self.addEventListener('activate', (event) => {
  console.log('[SW v6] Activating...');

  event.waitUntil(
    caches.keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((key) => {
              // 古いFPLキャッシュを全部削除
              return key.startsWith('fpl-reminder-') &&
                     key !== CACHE_NAME;
            })
            .map((key) => {
              console.log('[SW v6] Deleting old cache:', key);
              return caches.delete(key);
            })
        );
      })
      .then(() => {
        // 既に開いているページにも新しいSWを適用
        return clients.claim();
      })
  );
});


// ============================================================
// FETCH
// ============================================================

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = request.url;

  // ----------------------------------------------------------
  // FPL API
  // ----------------------------------------------------------

  if (url.includes('fantasy.premierleague.com/api')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });

          return res;
        })
        .catch(() => {
          return caches.match(request);
        })
    );

    return;
  }


  // ----------------------------------------------------------
  // HTML navigation
  // ★ ここが今回の重要ポイント
  // ----------------------------------------------------------

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, {
        cache: 'no-cache',
      })
        .then((response) => {

          // 最新のindex.htmlをキャッシュにも保存
          const clone = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });

          return response;
        })
        .catch(async () => {

          // オフラインの場合だけキャッシュを使用
          const cached = await caches.match(request);

          if (cached) {
            return cached;
          }

          const indexCached = await caches.match('./index.html');

          if (indexCached) {
            return indexCached;
          }

          return new Response(
            'FPL Reminder is currently offline.',
            {
              status: 503,
              headers: {
                'Content-Type': 'text/plain',
              },
            }
          );
        })
    );

    return;
  }


  // ----------------------------------------------------------
  // その他の静的ファイル
  // ----------------------------------------------------------

  event.respondWith(
    caches.match(request).then((cached) => {
      return cached || fetch(request);
    })
  );
});


// ============================================================
// PERIODIC BACKGROUND SYNC
// ============================================================

self.addEventListener('periodicsync', (event) => {

  if (event.tag === 'fpl-deadline-check') {

    console.log(
      '[SW v6] Periodic sync fired — checking deadlines...'
    );

    event.waitUntil(
      checkAndNotify()
    );
  }
});


// ============================================================
// PUSH
// ============================================================

self.addEventListener('push', (event) => {

  let data = {};

  try {
    data = event.data
      ? event.data.json()
      : {};
  } catch (err) {
    console.warn('[SW v6] Push data parse failed:', err);
  }

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'FPL Reminder',
      {
        body: data.body || 'Check your FPL team!',
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'fpl-push',
        requireInteraction: true,
      }
    )
  );
});


// ============================================================
// NOTIFICATION CLICK
// ============================================================

self.addEventListener('notificationclick', (event) => {

  event.notification.close();

  const target =
    (event.notification.data &&
     event.notification.data.url)
      ||
    'https://fantasy.premierleague.com/transfers';

  event.waitUntil(

    clients
      .matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      .then((list) => {

        for (const client of list) {

          if (
            client.url.includes(
              'fantasy.premierleague.com'
            ) &&
            'focus' in client
          ) {
            return client.focus();
          }
        }

        return clients.openWindow(target);
      })
  );
});


// ============================================================
// MESSAGE
// ============================================================

self.addEventListener('message', async (event) => {

  if (!event.data) {
    return;
  }


  // ----------------------------------------------------------
  // CHECK_NOW
  // ----------------------------------------------------------

  if (event.data.type === 'CHECK_NOW') {

    console.log(
      '[SW v6] CHECK_NOW received'
    );

    await checkAndNotify({
      forceNotify: true,
    });

    if (event.source) {
      event.source.postMessage({
        type: 'CHECK_DONE',
      });
    }

    return;
  }


  // ----------------------------------------------------------
  // STORE_EVENTS
  // ----------------------------------------------------------

  if (event.data.type === 'STORE_EVENTS') {

    const events = event.data.events;

    if (
      Array.isArray(events) &&
      events.length > 0
    ) {

      const cache =
        await caches.open(CACHE_NAME);

      await cache.put(
        CACHE_KEYS.EVENTS,
        new Response(
          JSON.stringify(events),
          {
            headers: {
              'Content-Type':
                'application/json',
            },
          }
        )
      );

      console.log(
        `[SW v6] Cached ${events.length} events from page.`
      );
    }

    return;
  }


  // ----------------------------------------------------------
  // SKIP_WAITING
  // ----------------------------------------------------------

  if (event.data.type === 'SKIP_WAITING') {

    console.log(
      '[SW v6] SKIP_WAITING received'
    );

    await self.skipWaiting();

    return;
  }
});


// ============================================================
// CHECK AND NOTIFY
// ============================================================

async function checkAndNotify({
  forceNotify = false,
} = {}) {

  const now = new Date();

  console.log(
    `[SW v6] checkAndNotify called at ${now.toISOString()} ` +
    `(force=${forceNotify})`
  );


  const events = await fetchEvents();


  if (!events || events.length === 0) {

    console.log(
      '[SW v6] No events data available.'
    );

    return;
  }


  // ----------------------------------------------------------
  // Find next deadline
  // ----------------------------------------------------------

  const futureEvents = events

    .filter((e) => {

      return (
        !e.finished &&
        new Date(e.deadline_time) > now
      );

    })

    .sort((a, b) => {

      return (
        new Date(a.deadline_time) -
        new Date(b.deadline_time)
      );

    });


  if (futureEvents.length === 0) {

    console.log(
      '[SW v6] No upcoming deadlines found.'
    );

    return;
  }


  const next = futureEvents[0];

  const deadlineUTC =
    new Date(next.deadline_time);


  const hoursUntil =
    (deadlineUTC - now) /
    (1000 * 60 * 60);


  console.log(
    `[SW v6] Next deadline: ${next.name}`
  );

  console.log(
    `[SW v6] Hours until deadline: ${hoursUntil}`
  );


  // ----------------------------------------------------------
  // JST time
  // ----------------------------------------------------------

  const deadlineJST =
    new Date(
      deadlineUTC.getTime() +
      9 * 60 * 60 * 1000
    );


  const hh =
    String(
      deadlineJST.getUTCHours()
    ).padStart(2, '0');


  const mm =
    String(
      deadlineJST.getUTCMinutes()
    ).padStart(2, '0');


  const timeStr =
    `${hh}:${mm} JST`;


  // ----------------------------------------------------------
  // Notification window
  // ----------------------------------------------------------

  const inWindow =
    hoursUntil >= REMIND_MIN_HOURS &&
    hoursUntil <= REMIND_MAX_HOURS;


  if (
    !forceNotify &&
    !inWindow
  ) {

    console.log(
      `[SW v6] Outside notification window: ` +
      `${hoursUntil.toFixed(2)}h`
    );

    return;
  }


  // ----------------------------------------------------------
  // Duplicate prevention
  // ----------------------------------------------------------

  if (!forceNotify) {

    const lastGW =
      await readCache(
        CACHE_KEYS.LAST_NOTIFIED_GW
      );


    if (
      lastGW === String(next.id)
    ) {

      console.log(
        `[SW v6] Already notified for GW ${next.id}`
      );

      return;
    }
  }


  // ----------------------------------------------------------
  // Notification text
  // ----------------------------------------------------------

  const roundedHours =
    Math.round(hoursUntil);


  const hoursLabel =
    roundedHours <= 1
      ? 'in about 1 hour'
      : `in about ${roundedHours} hours`;


  // ----------------------------------------------------------
  // SHOW NOTIFICATION
  // ----------------------------------------------------------

  await self.registration.showNotification(
    'FPL Deadline Alert!',
    {
      body:
        `${next.name} deadline is at ` +
        `${timeStr} (${hoursLabel}). ` +
        `Update your team now!`,

      icon: './icon-192.png',

      badge: './icon-192.png',

      tag:
        `fpl-deadline-${next.id}`,

      requireInteraction: true,

      vibrate: [
        200,
        100,
        200,
        100,
        200,
      ],

      actions: [
        {
          action: 'open',
          title: 'Go to FPL',
        },
        {
          action: 'dismiss',
          title: 'Got it',
        },
      ],

      data: {
        gwId: next.id,

        url:
          'https://fantasy.premierleague.com/transfers',
      },
    }
  );


  // ----------------------------------------------------------
  // Save notification state
  // ----------------------------------------------------------

  if (!forceNotify) {

    await writeCache(
      CACHE_KEYS.LAST_NOTIFIED_GW,
      String(next.id)
    );
  }
}


// ============================================================
// FETCH EVENTS
// ============================================================

async function fetchEvents() {

  const cache =
    await caches.open(CACHE_NAME);


  const urls = [
    FPL_API,
    ...CORS_PROXIES.map(
      (p) =>
        p +
        encodeURIComponent(FPL_API)
    ),
  ];


  // ----------------------------------------------------------
  // Try live API
  // ----------------------------------------------------------

  for (const url of urls) {

    try {

      const res =
        await fetch(
          url,
          {
            cache: 'no-cache',
          }
        );


      if (!res.ok) {
        continue;
      }


      const data =
        await res.json();


      const events =
        data.events || [];


      if (
        events.length === 0
      ) {
        continue;
      }


      // Save latest events
      await cache.put(
        CACHE_KEYS.EVENTS,
        new Response(
          JSON.stringify(events),
          {
            headers: {
              'Content-Type':
                'application/json',
            },
          }
        )
      );


      return events;

    } catch (err) {

      console.log(
        '[SW v6] API fetch failed:',
        err
      );
    }
  }


  // ----------------------------------------------------------
  // Fallback to cached events
  // ----------------------------------------------------------

  const cached =
    await cache.match(
      CACHE_KEYS.EVENTS
    );


  if (cached) {

    try {
      return await cached.json();
    } catch (err) {
      console.warn(
        '[SW v6] Cached events parse failed:',
        err
      );
    }
  }


  return null;
}


// ============================================================
// CACHE HELPERS
// ============================================================

async function readCache(key) {

  const cache =
    await caches.open(CACHE_NAME);


  const res =
    await cache.match(key);


  return res
    ? res.text()
    : null;
}


async function writeCache(
  key,
  value
) {

  const cache =
    await caches.open(CACHE_NAME);


  await cache.put(
    key,
    new Response(
      String(value)
    )
  );
}
