// PDFlip service worker: keeps a copy of the site on the device so it opens without internet.
// The build (vite.config.ts) fills in the version and the list of files below.
// Only the site's own files are cached, never anything the user opens or creates.

/** Cache names sort by build time, so the newest versions come last. */
const CACHE = 'pdflip-__VERSION__'
const FILES = __FILES__
/** The current version plus the one before, so a page still loading the old files can finish. */
const KEEP = 2

self.addEventListener('install', (event) => {
  // Fetch every file fresh from the server, not from the browser's HTTP cache.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(FILES.map((f) => new Request(new URL(f, self.registration.scope), { cache: 'reload' })))),
  )
  // No skipWaiting and no clients.claim: a new version takes over the next time the app is opened,
  // so a running or loading page never mixes files from two versions.
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const ours = keys.filter((k) => k.startsWith('pdflip-') && k <= CACHE).sort()
      const stale = [...keys.filter((k) => k.startsWith('pdflip-') && k > CACHE), ...ours.slice(0, -KEEP)]
      return Promise.all(stale.map((k) => caches.delete(k)))
    }),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  event.respondWith(
    req.mode === 'navigate'
      ? // page loads get this version's index.html
        caches
          .open(CACHE)
          .then((cache) => cache.match(new URL('index.html', self.registration.scope).href, { ignoreVary: true }))
          .then((hit) => hit ?? fetch(req))
      : // File names include a content hash, so a match in any kept version is the right file. The
        // server marks files "Vary: Origin", but script requests send an Origin header and the
        // cached copies were fetched without one, so headers must not take part in the match.
        caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit ?? fetch(req)),
  )
})
