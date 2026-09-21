// FPL Deadline Reminder — Service Worker
// Handles: caching, Periodic Background Sync, push notifications

const CACHE_NAME = 'fpl-reminder-v4';
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
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(['./index.html', './manifest.json', './icon-192.png'])
    )
  );
});

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => clients.claim())
  );
});

// ─── Fetch (cache strategy) ──────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // FPL API: network-first, fall back to cache
  if (url.includes('fantasy.premierleague.com/api')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App files: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// ─── Periodic Background Sync ────────────────────────────────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'fpl-deadline-check') {
    console.log('[SW] Periodic sync fired — checking deadlines…');
    event.waitUntil(checkAndNotify());
  }
});

// ─── Push (if ever sent from a push server) ──────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'FPL Reminder', {
      body:             data.body || 'Check your FPL team!',
      icon:             './icon-192.png',
      badge:            './icon-192.png',
      tag:              'fpl-push',
      requireInteraction: true,
    })
  );
});

// ─── Notification click ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) ||
    'https://fantasy.premierleague.com/transfers';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes('fantasy.premierleague.com') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});

// ─── Message from app page ────────────────────────────────────────────────────
self.addEventListener('message', async (event) => {
  if (!event.data) return;

  if (event.data.type === 'CHECK_NOW') {
    // Manual trigger from the app (for testing)
    await checkAndNotify({ forceNotify: true });
    event.source && event.source.postMessage({ type: 'CHECK_DONE' });
  }

  if (event.data.type === 'STORE_EVENTS') {
    // Page pushes its event list (including fallback) into SW cache so background
    // sync checks work even when the FPL API / CORS proxies are unavailable.
    const events = event.data.events;
    if (Array.isArray(events) && events.length > 0) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(
        CACHE_KEYS.EVENTS,
        new Response(JSON.stringify(events), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
      console.log(`[SW] Cached ${events.length} events from page.`);
    }
  }
});

// ─── Core notification logic ──────────────────────────────────────────────────

/**
 * Main check-and-notify function.
 * Called by Periodic Background Sync and optionally by the app page.
 *
 * Notification rule (works for ANY deadline time, any day):
 *   - Check if the next upcoming deadline is between REMIND_MIN and REMIND_MAX hours away.
 *   - Dedup by Gameweek ID so only one alert fires per GW even if sync runs multiple times.
 *
 * Why "hours until deadline" instead of "time of day":
 *   FPL deadlines vary week to week (Saturday afternoon, Tuesday evening, etc.).
 *   A fixed evening window would miss Saturday ~7:30 PM JST deadlines entirely.
 *   Checking hours-until-deadline covers every slot automatically.
 */
async function checkAndNotify({ forceNotify = false } = {}) {
  const now = new Date();

  console.log(`[SW] checkAndNotify called at ${now.toISOString()} (force=${forceNotify})`);

  // Fetch or use cached gameweek data
  const events = await fetchEvents();
  if (!events || events.length === 0) {
    console.log('[SW] No events data available.');
    return;
  }

  // Find the very next deadline that has not passed yet
  const futureEvents = events
    .filter((e) => !e.finished && new Date(e.deadline_time) > now)
    .sort((a, b) => new Date(a.deadline_time) - new Date(b.deadline_time));

  if (futureEvents.length === 0) {
    console.log('[SW] No upcoming deadlines found.');
    return;
  }

  const next        = futureEvents[0];
  const deadlineUTC = new Date(next.deadline_time);
  const hoursUntil  = (deadlineUTC - now) / (1000 * 60 * 60);

  // Convert deadline to JST for the notification message
  const deadlineJST = new Date(deadlineUTC.getTime() + 9 * 60 * 60 * 1000);
  const hh      = String(deadlineJST.getUTCHours()).padStart(2, '0');
  const mm      = String(deadlineJST.getUTCMinutes()).padStart(2, '0');
  const timeStr = `${hh}:${mm} JST`;

  console.log(
    `[SW] Next: ${next.name} — deadline at ${timeStr} — ${hoursUntil.toFixed(1)} hours away`
  );

  // Is the deadline within the reminder window?
  const inWindow = hoursUntil >= REMIND_MIN_HOURS && hoursUntil <= REMIND_MAX_HOURS;
  if (!forceNotify && !inWindow) {
    console.log(
      `[SW] ${hoursUntil.toFixed(1)}h until deadline — outside ${REMIND_MIN_HOURS}-${REMIND_MAX_HOURS}h window. Skipping.`
    );
    return;
  }

  // Dedup: only one notification per Gameweek (not per calendar day)
  if (!forceNotify) {
    const lastGW = await readCache(CACHE_KEYS.LAST_NOTIFIED_GW);
    if (lastGW === String(next.id)) {
      console.log(`[SW] Already notified for ${next.name}. Skipping.`);
      return;
    }
  }

  const hoursLabel = Math.round(hoursUntil) <= 1
    ? 'in about 1 hour'
    : `in about ${Math.round(hoursUntil)} hours`;

  await self.registration.showNotification('FPL Deadline Alert!', {
    body:             `${next.name} deadline is at ${timeStr} (${hoursLabel}). Update your team now!`,
    icon:             './icon-192.png',
    badge:            './icon-192.png',
    tag:              `fpl-deadline-${next.id}`,
    requireInteraction: true,
    vibrate:          [200, 100, 200, 100, 200],
    actions: [
      { action: 'open', title: 'Go to FPL' },
      { action: 'dismiss', title: 'Got it' },
    ],
    data: {
      gwId: next.id,
      url:  'https://fantasy.premierleague.com/transfers',
    },
  });

  console.log(`[SW] Notification sent for ${next.name}!`);

  // Record the GW so we do not double-fire
  if (!forceNotify) {
    await writeCache(CACHE_KEYS.LAST_NOTIFIED_GW, String(next.id));
  }
}

// ─── FPL API helpers ──────────────────────────────────────────────────────────

async function fetchEvents() {
  const cache = await caches.open(CACHE_NAME);

  // Build URL list: direct first, then each CORS proxy
  const urls = [FPL_API, ...CORS_PROXIES.map(p => p + encodeURIComponent(FPL_API))];

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) { console.warn(`[SW] Bad response from ${url}`); continue; }
      const data   = await res.json();
      const events = data.events || [];
      if (events.length === 0) continue;
      // Cache successful result for offline use
      await cache.put(
        CACHE_KEYS.EVENTS,
        new Response(JSON.stringify(events), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
      console.log(`[SW] Fetched ${events.length} events via ${url}`);
      return events;
    } catch (err) {
      console.warn(`[SW] Fetch failed for ${url}:`, err.message);
    }
  }

  // All network attempts failed — fall back to cache
  const cached = await cache.match(CACHE_KEYS.EVENTS);
  if (cached) {
    const events = await cached.json();
    console.log(`[SW] Loaded ${events.length} events from cache (offline fallback).`);
    return events;
  }

  console.error('[SW] No events available from network or cache.');
  return null;
}

// ─── Simple key-value cache helpers ──────────────────────────────────────────

async function readCache(key) {
  const cache = await caches.open(CACHE_NAME);
  const res   = await cache.match(key);
  return res ? res.text() : null;
}

async function writeCache(key, value) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(key, new Response(String(value)));
}
