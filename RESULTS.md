# Request Capture — Test Results

**Date:** ____________________  
**Browser:** Chromium (Playwright)  
**Node version:** ____________________  
**OS:** ____________________

## Test 1: Full Page — Expected vs Observed

| # | Method | URL | Description | Status |
|---|--------|-----|-------------|--------|
| 1 | GET | /full | Main page | |
| 2 | GET | /icons/fav.png | Favicon | |
| 3 | GET | /icons/apple.png | Apple touch icon | |
| 4 | GET | /m.webmanifest | Web manifest | |
| 5 | GET | /js/preloaded.js | Preloaded script | |
| 6 | GET | /pf/next.html | Prefetched page | |
| 7 | GET | /js/mp.mjs | Module-preloaded script | |
| 8 | GET | /css/a.css | Main stylesheet | |
| 9 | GET | /css/b.css | Imported stylesheet | |
| 10 | GET | /img/bg.png | CSS background image | |
| 11 | GET | /fonts/f.woff2 | CSS font | |
| 12 | GET | /img/plain.png | Plain img | |
| 13 | GET | /img/1x.png | srcset 1x image | |
| 14 | GET | /img/2x.png | srcset 2x image | |
| 15 | GET | /img/src.webp | picture source webp | |
| 16 | GET | /img/fallback.png | picture fallback img | |
| 17 | GET | /img/poster.png | Video poster | |
| 18 | GET | /media/v.mp4 | Video source | |
| 19 | GET | /media/a.mp3 | Audio source | |
| 20 | GET | /bare | Iframe page | |
| 21 | GET | /obj/o.svg | Object SVG | |
| 22 | GET | /emb/e.svg | Embed SVG | |
| 23 | GET | /img/btn.png | Input image | |
| 24 | GET | /js/classic.js | Classic script | |
| 25 | GET | /js/main.mjs | Module script entry | |
| 26 | GET | /js/dep.mjs | Module dependency | |
| 27 | POST | /api/fetch | Fetch API call | |
| 28 | GET | /api/xhr | XMLHttpRequest | |
| 29 | POST | /api/beacon | sendBeacon | |
| 30 | OPTIONS | /api/cors | CORS preflight | |
| 31 | PUT | /api/cors | CORS actual request | |
| 32 | GET | /ws | WebSocket upgrade | |
| 33 | GET | /sw.js | Service worker | |

## Test 2: Bare Page — Extra Requests

| Method | URL | Expected? |
|--------|-----|-----------|
| GET | /bare | Yes |
| GET | /favicon.ico | Yes (browser default) |

## Summary

- **Present:** ____ / 33
- **Missing:** ____
- **Extra:** ____

## Notes

- srcset: browser picks 1x or 2x based on device pixel ratio; typically only one is fetched
- picture/source: browser picks webp or fallback based on support; typically only one is fetched  
- prefetch: may be deferred or skipped depending on browser heuristics
- preconnect/dns-prefetch: do not generate HTTP requests (TCP/DNS only)
- video/audio preload: behavior varies by browser; metadata vs auto affects request timing
