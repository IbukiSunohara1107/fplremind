// FPL Deadline Reminder — Service Worker
// Handles: caching, Periodic Background Sync, push notifications

const CACHE_NAME = 'fpl-reminder-v5';
const FPL_API   = 'https://fantasy.premierleague.com/api/bootstrap-static/';

// CORS proxies — tried in order if the direct call is blocked
const CORS_PROXIES = [
  'https://corsproxy.io/?url=',
  'https://api.allorigins.win/raw?url=',
];

const CACHE_KEYS = {
  EVENTS:           'fpl-cached-events',
  LAST_NOTIFIED_GW: 'fpl-last-notified-gw',  // tracks GW id, not date
};

// Reminder window: notify when the deadline is between REMIND_MIN and REMIND_MAX hours away.
// With a ~6-hour periodic sync, the background check will hit this window for any deadline time.
const REMIND_MIN_HOURS = 3;
const REMIND_MAX_HOURS = 8;


// ─── Install ─────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log('[SW] Installing…');

  // Activate the new Service Worker immediately
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        './index.html',
        './manifest.json',
        './icon-192.png'
      ])
    )
  );
});


// ─── Activate ────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating…');

  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => clients.claim())
  );
});


// ─── Fetch (cache strategy) ──────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // ── FPL API: network-first, fall back to cache ──
  if (url.includes('fantasy.premierleague.com/api')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });

          return res;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );

    return;
  }

  // ── App files: cache-first ──
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request);
    })
  );
});


// ─── Periodic Background Sync ────────────────────────────────────────────────

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'fpl-deadline-check') {
    console.log('[SW] Periodic sync fired — checking deadlines…');

    event.waitUntil(
      checkAndNotify()
    );
  }
});


// ─── Push (if ever sent from a push server) ──────────────────────────────────

self.addEventListener('push', (event) => {
  const data = event.data
    ? event.data.json()
    : {};

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'FPL Reminder',
      {
        body:             data.body || 'Check your FPL team!',
        icon:             './icon-192.png',
        badge:            './icon-192.png',
        tag:              'fpl-push',
        requireInteraction: true,
      }
    )
  );
});


// ─── Notification click ──────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target =
    (event.notification.data &&
      event.notification.data.url) ||
    'https://fantasy.premierleague.com/transfers';

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then((list) => {

      for (const client of list) {
        if (
          client.url.includes('fantasy.premierleague.com') &&
          'focus' in client
        ) {
          return client.focus();
        }
      }

      return clients.openWindow(target);
    })
  );
});


// ─── Message from app page ───────────────────────────────────────────────────

self.addEventListener('message', async (event) => {
  if (!event.data) return;

  // Manual trigger from the app (for testing)
  if (event.data.type === 'CHECK_NOW') {
    await checkAndNotify({
      forceNotify: true
    });

    if (event.source) {
      event.source.postMessage({
        type: 'CHECK_DONE'
      });
    }
  }


  // Page pushes its event list into SW cache
  if (event.data.type === 'STORE_EVENTS') {
    const events = event.data.events;

    if (Array.isArray(events) && events.length > 0) {
      const cache = await caches.open(CACHE_NAME);

      await cache.put(
        CACHE_KEYS.EVENTS,
        new Response(
          JSON.stringify(events),
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      );

      console.log(
        `[SW] Cached ${events.length} events from page.`
      );
    }
  }
});


// ─── Core notification logic ─────────────────────────────────────────────────

/**
 * Main check-and-notify function.
 *
 * Called by:
 *   - Periodic Background Sync
 *   - Manual CHECK_NOW message
 *
 * Notification rule:
 *   - Check if the next upcoming deadline is between
 *     REMIND_MIN and REMIND_MAX hours away.
 *
 * Dedup:
 *   - Only one notification per Gameweek.
 */

async function checkAndNotify({
  forceNotify = false
} = {}) {

  const now = new Date();

  console.log(
    `[SW] checkAndNotify called at ${now.toISOString()} (force=${forceNotify})`
  );


  // Fetch or use cached gameweek data
  const events = await fetchEvents();

  if (!events || events.length === 0) {
    console.log(
      '[SW] No events data available.'
    );

    return;
  }


  // Find the next deadline that has not passed
  const futureEvents = events
    .filter(
      (event) =>
        !event.finished &&
        new Date(event.deadline_time) > now
    )
    .sort(
      (a, b) =>
        new Date(a.deadline_time) -
        new Date(b.deadline_time)
    );


  if (futureEvents.length === 0) {
    console.log(
      '[SW] No upcoming deadlines found.'
    );

    return;
  }


  const next = futureEvents[0];

  const deadlineUTC =
    new Date(next.deadline_time);

  const hoursUntil =
    (deadlineUTC - now) /
    (1000 * 60 * 60);


  // Convert deadline to JST
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


  console.log(
    `[SW] Next: ${next.name} — ` +
    `deadline at ${timeStr} — ` +
    `${hoursUntil.toFixed(1)} hours away`
  );


  // Check reminder window
  const inWindow =
    hoursUntil >= REMIND_MIN_HOURS &&
    hoursUntil <= REMIND_MAX_HOURS;


  if (!forceNotify && !inWindow) {
    console.log(
      `[SW] ${hoursUntil.toFixed(1)}h until deadline — ` +
      `outside ${REMIND_MIN_HOURS}-${REMIND_MAX_HOURS}h window. ` +
      `Skipping.`
    );

    return;
  }


  // Prevent duplicate notification
  if (!forceNotify) {

    const lastGW =
      await readCache(
        CACHE_KEYS.LAST_NOTIFIED_GW
      );

    if (lastGW === String(next.id)) {
      console.log(
        `[SW] Already notified for ${next.name}. Skipping.`
      );

      return;
    }
  }


  const roundedHours =
    Math.round(hoursUntil);

  const hoursLabel =
    roundedHours <= 1
      ? 'in about 1 hour'
      : `in about ${roundedHours} hours`;


  // Send notification
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
        200
      ],

      actions: [
        {
          action: 'open',
          title: 'Go to FPL'
        },
        {
          action: 'dismiss',
          title: 'Got it'
        }
      ],

      data: {
        gwId: next.id,
        url:
          'https://fantasy.premierleague.com/transfers'
      }
    }
  );


  console.log(
    `[SW] Notification sent for ${next.name}!`
  );


  // Record notified Gameweek
  if (!forceNotify) {
    await writeCache(
      CACHE_KEYS.LAST_NOTIFIED_GW,
      String(next.id)
    );
  }
}


// ─── FPL API helpers ──────────────────────────────────────────────────────────

async function fetchEvents() {

  const cache =
    await caches.open(CACHE_NAME);


  // Build URL list:
  // direct first, then CORS proxies
  const urls = [
    FPL_API,
    ...CORS_PROXIES.map(
      (proxy) =>
        proxy +
        encodeURIComponent(FPL_API)
    )
  ];


  for (const url of urls) {

    try {

      const res =
        await fetch(
          url,
          {
            cache: 'no-cache'
          }
        );


      if (!res.ok) {
        console.warn(
          `[SW] Bad response from ${url}`
        );

        continue;
      }


      const data =
        await res.json();

      const events =
        data.events || [];


      if (events.length === 0) {
        continue;
      }


      // Cache successful result
      await cache.put(
        CACHE_KEYS.EVENTS,
        new Response(
          JSON.stringify(events),
          {
            headers: {
              'Content-Type':
                'application/json'
            }
          }
        )
      );


      console.log(
        `[SW] Fetched ${events.length} events via ${url}`
      );


      return events;

    } catch (err) {

      console.warn(
        `[SW] Fetch failed for ${url}:`,
        err.message
      );

    }
  }


  // All network attempts failed
  // → fall back to cached events
  const cached =
    await cache.match(
      CACHE_KEYS.EVENTS
    );


  if (cached) {

    const events =
      await cached.json();

    console.log(
      `[SW] Loaded ${events.length} events ` +
      `from cache (offline fallback).`
    );

    return events;
  }


  console.error(
    '[SW] No events available from network or cache.'
  );

  return null;
}


// ─── Simple key-value cache helpers ──────────────────────────────────────────

async function readCache(key) {

  const cache =
    await caches.open(CACHE_NAME);

  const res =
    await cache.match(key);

  return res
    ? res.text()
    : null;
}


async function writeCache(key, value) {

  const cache =
    await caches.open(CACHE_NAME);

  await cache.put(
    key,
    new Response(
      String(value)
    )
  );
}
