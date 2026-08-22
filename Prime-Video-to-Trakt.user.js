// ==UserScript==
// @name         Prime Video to Trakt
// @namespace    https://github.com/Bandit/userscripts
// @version      1.0.0
// @description  Sync your Amazon Prime Video watch history to Trakt.tv
// @author       Bandit
// @homepageURL  https://github.com/Bandit/userscripts/blob/main/Prime-Video-to-Trakt.user.js
// @supportURL   https://github.com/Bandit/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/Bandit/userscripts/main/Prime-Video-to-Trakt.user.js
// @downloadURL  https://raw.githubusercontent.com/Bandit/userscripts/main/Prime-Video-to-Trakt.user.js
// @match        *://*.primevideo.com/*/settings/watch-history*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.trakt.tv
// @connect      trakt.tv
// @connect      www.themoviedb.org
// ==/UserScript==

/*
  SETUP INSTRUCTIONS:
  1. Go to https://trakt.tv/oauth/applications/new
  2. Create a new app with any name (e.g. "Prime Video Sync")
  3. Set Redirect URI to: urn:ietf:wg:oauth:2.0:oob
  4. Save and copy your Client ID and Client Secret
  5. Click the "Sync to Trakt" button on your Prime watch history page
  6. Follow the prompts to authorize the app
*/

(function () {
  'use strict';

  // ── Constants ──
  const TRAKT_API = 'https://api.trakt.tv';
  const SCRIPT_PREFIX = 'pvt_';

  // ── Storage helpers ──
  const store = {
    get: (key, def) => GM_getValue(SCRIPT_PREFIX + key, def),
    set: (key, val) => GM_setValue(SCRIPT_PREFIX + key, val),
    del: (key) => GM_deleteValue(SCRIPT_PREFIX + key),
  };

  function cacheSet(cacheKey, value) {
    store.set(cacheKey, value);
    const keys = store.get('cache_keys', []);
    if (!keys.includes(cacheKey)) {
      keys.push(cacheKey);
      store.set('cache_keys', keys);
    }
  }

  // ── Trakt API wrapper (uses GM_xmlhttpRequest to bypass CORS) ──
  function traktFetch(method, path, body) {
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': store.get('client_id', ''),
      };
      const token = store.get('access_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;

      GM_xmlhttpRequest({
        method,
        url: `${TRAKT_API}${path}`,
        headers,
        data: body ? JSON.stringify(body) : undefined,
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            resolve({ status: res.status, data: res.responseText ? JSON.parse(res.responseText) : null });
          } else {
            reject({ status: res.status, data: res.responseText });
          }
        },
        onerror(err) {
          reject({ status: 0, data: err });
        },
      });
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── HTML parsing ──

  function parseDate(dateStr) {
    // "May 9, 2026" → ISO date string
    const d = new Date(dateStr);
    if (isNaN(d)) return null;
    // Set to noon UTC to avoid timezone edge issues
    d.setUTCHours(12, 0, 0, 0);
    return d.toISOString();
  }

  function parseShowTitle(rawTitle) {
    // "Solos - Season 1" → { showName: "Solos", season: 1 }
    // "Landman, Season 2" → { showName: "Landman", season: 2 }
    // "Engineering Space" → { showName: "Engineering Space", season: 1 }
    const match = rawTitle.match(/^(.+?)\s*[-–,]\s*Season\s+(\d+)\s*$/i);
    if (match) {
      return { showName: match[1].trim(), season: parseInt(match[2], 10) };
    }
    return { showName: rawTitle.trim(), season: 1 };
  }

  function parseEpisodeText(text) {
    // "Episode 3: JENNY" → { number: 3, title: "JENNY" }
    // "Episode 2: PEG" → { number: 2, title: "PEG" }
    const match = text.match(/Episode\s+(\d+)(?:\s*:\s*(.+))?/i);
    if (match) {
      return { number: parseInt(match[1], 10), title: match[2]?.trim() || '' };
    }
    return null;
  }

  async function expandEpisodeAccordion(watchItem, debugLog) {
    // Check if episode elements are already in the DOM
    let episodeEls = watchItem.querySelectorAll('[data-testid^="wh-episode-"]');
    if (episodeEls.length > 0) return;

    const episodeContainer = watchItem.querySelector('[data-testid^="wh-episodes-watched-"]');
    if (!episodeContainer) return;

    const checkbox = episodeContainer.querySelector('input[type="checkbox"]');
    const label = episodeContainer.querySelector('label');
    if (!checkbox) return;

    // Scroll into view so any virtual/lazy rendering hydrates this item
    watchItem.scrollIntoView({ behavior: 'instant', block: 'center' });
    await sleep(300);

    // Set up MutationObserver BEFORE clicking, to catch dynamically rendered episodes
    const waitForEpisodes = () => new Promise((resolve) => {
      // Check immediately in case they already appeared
      const existing = watchItem.querySelectorAll('[data-testid^="wh-episode-"]');
      if (existing.length > 0) { resolve(true); return; }

      const timeout = setTimeout(() => { observer.disconnect(); resolve(false); }, 3000);
      const observer = new MutationObserver(() => {
        if (watchItem.querySelectorAll('[data-testid^="wh-episode-"]').length > 0) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve(true);
        }
      });
      observer.observe(watchItem, { childList: true, subtree: true });
    });

    // Strategy 1: Click the checkbox directly (.click() produces a trusted event)
    // The label and checkbox share the same id (Amazon bug), so clicking the label
    // causes a double-toggle. Clicking the checkbox directly should toggle once.
    const promise1 = waitForEpisodes();
    checkbox.click();
    let found = await promise1;
    if (found) {
      if (debugLog) debugLog(`    ✓ Accordion expanded (checkbox.click)`);
      return;
    }

    // Strategy 2: If checkbox.click toggled it on but episodes didn't appear,
    // try clicking the label instead — Amazon's handler might be on the label.
    // First reset checkbox state if it was toggled.
    if (label) {
      if (checkbox.checked) {
        // checkbox.click opened it but no episodes rendered — close first
        checkbox.checked = false;
        await sleep(100);
      }
      const promise2 = waitForEpisodes();
      label.click();
      found = await promise2;
      if (found) {
        if (debugLog) debugLog(`    ✓ Accordion expanded (label.click)`);
        return;
      }
    }

    // Strategy 3: Dispatch pointer/mouse events to simulate a real user interaction
    // Some frameworks ignore .click() but respond to full pointer event sequences
    if (!checkbox.checked) {
      const evtOpts = { bubbles: true, cancelable: true, composed: true };
      const target = label || checkbox;
      const promise3 = waitForEpisodes();
      target.dispatchEvent(new PointerEvent('pointerdown', evtOpts));
      target.dispatchEvent(new MouseEvent('mousedown', evtOpts));
      target.dispatchEvent(new PointerEvent('pointerup', evtOpts));
      target.dispatchEvent(new MouseEvent('mouseup', evtOpts));
      target.dispatchEvent(new MouseEvent('click', evtOpts));
      found = await promise3;
      if (found) {
        if (debugLog) debugLog(`    ✓ Accordion expanded (synthetic pointer events)`);
        return;
      }
    }

    if (debugLog) debugLog(`    ⚠ Accordion expansion failed — episodes not in DOM`);
  }

  async function parseWatchHistory(debugLog) {
    const items = [];

    // Find all date groups - each is a top-level <li> containing a date header and items
    const dateHeaders = document.querySelectorAll('[data-automation-id^="wh-date-"]');
    if (debugLog) debugLog(`Found ${dateHeaders.length} date groups`);

    for (const dateHeader of dateHeaders) {
      const dateText = dateHeader.querySelector('h3')?.textContent?.trim();
      if (!dateText) continue;
      const watchedAt = parseDate(dateText);
      if (!watchedAt) continue;

      // The date header's parent <li> contains a <ul> with the actual watch items
      const dateGroup = dateHeader.closest('li');
      if (!dateGroup) continue;

      const watchItems = dateGroup.querySelectorAll('[data-automation-id^="wh-item-"]');

      for (const watchItem of watchItems) {
        // Get the title link (skip the image link which has no text content)
        const allLinks = watchItem.querySelectorAll('[data-testid="activity-history-item"] a[href*="/detail/"]');
        let rawTitle = '';
        let posterUrl = '';
        for (const link of allLinks) {
          const text = link.textContent?.trim();
          if (text) { rawTitle = text; }
          else if (!posterUrl) { posterUrl = link.querySelector('img')?.src || ''; }
        }
        if (!rawTitle) {
          if (debugLog) debugLog(`⚠ Item has no title text. Links found: ${allLinks.length}. innerHTML snippet: ${watchItem.innerHTML.substring(0, 300)}`);
          continue;
        }

        // Determine type by the delete button text: "Delete episodes from Watch History" vs "Delete movie from Watch History"
        const form = watchItem.querySelector('form[data-automation-id^="wh-delete-"]');
        const deleteBtn = form?.querySelector('button');
        const deleteBtnText = deleteBtn?.textContent?.trim().toLowerCase() || '';
        const isShow = deleteBtnText.includes('episode');

        if (isShow) {
          const { showName, season } = parseShowTitle(rawTitle);

          // Expand this specific show's episode accordion before parsing
          await expandEpisodeAccordion(watchItem, debugLog);

          // Parse actual episode elements from the expanded list
          const episodeEls = watchItem.querySelectorAll('[data-testid^="wh-episode-"]');

          if (debugLog) {
            debugLog(`📌 "${rawTitle}" | isShow: true | episodeEls: ${episodeEls.length}`);
          }

          if (episodeEls.length > 0) {
            for (const epEl of episodeEls) {
              const epText = epEl.querySelector('[data-testid="activity-history-item-episode"] p')?.textContent?.trim() || '';
              const parsed = parseEpisodeText(epText);
              items.push({
                type: 'episode',
                showTitle: showName,
                season,
                episodeNumber: parsed ? parsed.number : 0,
                episodeTitle: parsed ? parsed.title : epText,
                watchedAt,
                posterUrl,
              });
              if (debugLog) debugLog(`    → Episode ${parsed ? parsed.number : '?'}: ${parsed ? parsed.title : epText}`);
            }
          } else {
            // Episodes not in DOM — use titleIds count as fallback
            const titleIdsInput = form?.querySelector('input[name="titleIds"]');
            const titleIdsValue = titleIdsInput?.value || '';
            const episodeCount = titleIdsValue ? titleIdsValue.split('_').length : 1;
            if (debugLog) debugLog(`    ⚠ Episodes not in DOM, using titleIds count: ${episodeCount}`);
            for (let i = 0; i < episodeCount; i++) {
              items.push({
                type: 'episode',
                showTitle: showName,
                season,
                episodeNumber: 0, // Unknown
                episodeTitle: '',
                watchedAt,
                posterUrl,
              });
            }
          }
        } else {
          // Movie
          if (debugLog) debugLog(`📌 "${rawTitle}" | isShow: false`);
          items.push({
            type: 'movie',
            title: rawTitle,
            watchedAt,
            posterUrl,
          });
        }
      }
    }

    return items;
  }

  // ── Auto-scroll to load all history ──

  async function autoScrollToBottom(onProgress, stopAfterDate) {
    let lastHeight = 0;
    let stableCount = 0;
    const maxStable = 5; // Stop after height unchanged for 5 checks

    while (stableCount < maxStable) {
      // Early stop: if we've scrolled past the cutoff date, no need to continue
      if (stopAfterDate) {
        const dateHeaders = document.querySelectorAll('[data-automation-id^="wh-date-"] h3');
        if (dateHeaders.length > 0) {
          const lastDateText = dateHeaders[dateHeaders.length - 1]?.textContent?.trim();
          if (lastDateText) {
            const lastDate = new Date(lastDateText);
            if (!isNaN(lastDate) && lastDate < stopAfterDate) break;
          }
        }
      }

      const trigger = document.querySelector('[data-automation-id="infinite-scroll-trigger"]');
      if (trigger) {
        trigger.scrollIntoView({ behavior: 'instant' });
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }

      await sleep(1500);
      const currentHeight = document.body.scrollHeight;

      if (currentHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = currentHeight;
      }

      const itemCount = document.querySelectorAll('[data-automation-id^="wh-item-"]').length;
      if (onProgress) onProgress(itemCount);
    }

    // Scroll back to top
    window.scrollTo(0, 0);
  }

  // ── Trakt search (with caching and title scoring) ──

  function titleSimilarity(query, candidate) {
    const q = query.toLowerCase().trim();
    const c = candidate.toLowerCase().trim();
    if (q === c) return 1.0; // Exact match

    // Normalize: strip parenthetical info like "(4K UHD)", smart quotes, punctuation
    const normalize = (s) => s
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^\w\s']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const qn = normalize(query);
    const cn = normalize(candidate);
    if (qn && cn && qn === cn) return 0.95; // Match after normalization

    // Word-level overlap (ignoring common stop words)
    const stopWords = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'it']);
    const getRawWords = (s) => s.split(/\s+/).filter(w => w.length > 1);
    const qRaw = getRawWords(qn);
    const cRaw = getRawWords(cn);
    // Only strip stop words if we have >2 words — for short titles like "The Home",
    // articles are significant and stripping them causes false matches with "Home"
    const qWords = qRaw.length > 2 ? qRaw.filter(w => !stopWords.has(w)) : qRaw;
    const cWords = cRaw.length > 2 ? cRaw.filter(w => !stopWords.has(w)) : cRaw;

    if (qWords.length === 0 || cWords.length === 0) return 0;

    const overlap = qWords.filter(w => cWords.includes(w)).length;
    return overlap / Math.max(qWords.length, cWords.length);
  }

  function fetchPoster(type, ids) {
    const tmdbId = ids?.tmdb;
    if (!tmdbId) return Promise.resolve(null);
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://www.themoviedb.org/${tmdbType}/${tmdbId}`,
        onload(res) {
          const match = res.responseText?.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/);
          resolve(match ? match[1] : null);
        },
        onerror() { resolve(null); },
      });
    });
  }

  function showDisambiguationDialog(title, type, candidates, amazonPoster) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'pvt-disambig-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center';

      const box = document.createElement('div');
      box.style.cssText = 'background:#1a1a2e;color:#e0e0e0;border-radius:12px;width:560px;max-width:90vw;max-height:80vh;overflow-y:auto;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:system-ui,sans-serif';

      const typeLabel = type === 'movie' ? 'Movie' : 'Show';
      const posterHtml = amazonPoster
        ? `<div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;padding:10px;background:#0f0f23;border-radius:6px;border:1px solid #333">
            <img src="${amazonPoster}" style="width:60px;min-width:60px;height:90px;object-fit:cover;border-radius:4px" alt="Amazon poster">
            <div><span style="color:#999;font-size:11px">From Prime Video:</span><br><strong>${title}</strong></div>
          </div>`
        : '';
      box.innerHTML = `
        <h3 style="margin:0 0 8px;color:#ed1d24;font-size:16px">Multiple matches for "${title}"</h3>
        ${posterHtml}
        <p style="font-size:13px;color:#999;margin:0 0 12px">Select the correct ${typeLabel.toLowerCase()}:</p>
        <div id="pvt-disambig-list"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button class="pvt-btn-secondary" id="pvt-disambig-manual">None of these — search manually</button>
          <button class="pvt-btn-secondary" id="pvt-disambig-skip">Skip for now</button>
          <button class="pvt-btn-secondary" id="pvt-disambig-skip-synced" style="color:#f1fa8c">Skip & mark synced</button>
        </div>
      `;

      const list = box.querySelector('#pvt-disambig-list');
      for (const item of candidates) {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:flex;gap:12px;width:100%;text-align:left;background:#0f0f23;border:1px solid #333;border-radius:6px;padding:10px 12px;margin-bottom:8px;color:#e0e0e0;cursor:pointer;font-size:13px;font-family:inherit;align-items:flex-start';
        btn.onmouseenter = () => btn.style.borderColor = '#ed1d24';
        btn.onmouseleave = () => btn.style.borderColor = '#333';

        // Poster placeholder
        const img = document.createElement('img');
        img.style.cssText = 'width:60px;min-width:60px;height:90px;object-fit:cover;border-radius:4px;background:#222';
        img.alt = item.title;
        img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="90"><rect width="60" height="90" fill="%23222"/><text x="30" y="50" fill="%23555" font-size="10" text-anchor="middle">...</text></svg>');

        // Fetch poster async
        if (item.ids?.tmdb) {
          fetchPoster(type, item.ids).then((url) => {
            if (url) img.src = url;
          });
        }

        // Text content
        const textDiv = document.createElement('div');
        textDiv.style.cssText = 'flex:1;min-width:0';
        const genres = item.genres?.length ? item.genres.slice(0, 3).join(', ') : '';
        const runtime = item.runtime ? `${item.runtime}min` : '';
        const rating = item.rating ? `★ ${item.rating.toFixed(1)}` : '';
        const meta = [item.year, genres, runtime, rating, item.country?.toUpperCase()].filter(Boolean).join(' · ');
        const overview = item.overview ? item.overview.substring(0, 150) + (item.overview.length > 150 ? '...' : '') : '';

        textDiv.innerHTML = `<strong>${item.title}</strong>`
          + (meta ? `<br><span style="color:#999;font-size:12px">${meta}</span>` : '')
          + (overview ? `<br><span style="color:#777;font-size:11px;line-height:1.3;display:block;margin-top:4px">${overview}</span>` : '');

        btn.appendChild(img);
        btn.appendChild(textDiv);
        btn.addEventListener('click', () => { overlay.remove(); resolve(item); });
        list.appendChild(btn);
      }

      box.querySelector('#pvt-disambig-manual').addEventListener('click', () => { overlay.remove(); resolve('__manual__'); });
      box.querySelector('#pvt-disambig-skip').addEventListener('click', () => { overlay.remove(); resolve(null); });
      box.querySelector('#pvt-disambig-skip-synced').addEventListener('click', () => { overlay.remove(); resolve('__skip_synced__'); });
      overlay.appendChild(box);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
      document.body.appendChild(overlay);
    });
  }

  function showManualSearchDialog(title, type, initialResults, amazonPoster) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'pvt-disambig-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center';

      const box = document.createElement('div');
      box.style.cssText = 'background:#1a1a2e;color:#e0e0e0;border-radius:12px;width:560px;max-width:90vw;max-height:80vh;overflow-y:auto;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:system-ui,sans-serif';

      const typeLabel = type === 'movie' ? 'Movie' : 'Show';
      const posterHtml = amazonPoster
        ? `<div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;padding:10px;background:#0f0f23;border-radius:6px;border:1px solid #333">
            <img src="${amazonPoster}" style="width:60px;min-width:60px;height:90px;object-fit:cover;border-radius:4px" alt="Amazon poster">
            <div><span style="color:#999;font-size:11px">From Prime Video:</span><br><strong>${title}</strong></div>
          </div>`
        : '';

      function renderResults(results, query, year) {
        box.innerHTML = `
          <h3 style="margin:0 0 8px;color:#ed1d24;font-size:16px">No auto-match for "${title}"</h3>
          ${posterHtml}
          <p style="font-size:13px;color:#999;margin:0 0 12px">Search Trakt for the correct ${typeLabel.toLowerCase()}:</p>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input type="text" id="pvt-manual-query" value="${(query || '').replace(/"/g, '&quot;')}" placeholder="Search query..."
              style="flex:1;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#0f0f23;color:#e0e0e0;font-size:13px;font-family:inherit">
            <input type="text" id="pvt-manual-year" value="${year || ''}" placeholder="Year" maxlength="4"
              style="width:60px;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#0f0f23;color:#e0e0e0;font-size:13px;font-family:inherit;text-align:center">
            <button class="pvt-btn-primary" id="pvt-manual-search" style="margin:0;padding:8px 16px;font-size:13px">Search</button>
          </div>
          <div id="pvt-manual-list"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            <button class="pvt-btn-secondary" id="pvt-manual-skip">Skip for now</button>
            <button class="pvt-btn-secondary" id="pvt-manual-skip-synced" style="color:#f1fa8c">Skip & mark synced</button>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid #333">
            <p style="font-size:12px;color:#777;margin:0 0 6px">Or paste a Trakt URL (e.g. https://trakt.tv/movies/brothers-2024):</p>
            <div style="display:flex;gap:8px">
              <input type="text" id="pvt-manual-url" placeholder="https://trakt.tv/movies/..."
                style="flex:1;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#0f0f23;color:#e0e0e0;font-size:13px;font-family:inherit">
              <button class="pvt-btn-primary" id="pvt-manual-url-go" style="margin:0;padding:8px 16px;font-size:13px">Go</button>
            </div>
          </div>
        `;

        const input = box.querySelector('#pvt-manual-query');
        const yearInput = box.querySelector('#pvt-manual-year');
        const searchBtn = box.querySelector('#pvt-manual-search');

        const doSearch = async () => {
          const q = input.value.trim();
          if (!q) return;
          searchBtn.disabled = true;
          searchBtn.textContent = '...';
          try {
            const encodedQuery = encodeURIComponent(q);
            const res = await traktFetch('GET', `/search/${type}?query=${encodedQuery}&limit=50&extended=full`);
            let items = (res.data || []).map((e) => e[type]).filter(Boolean);
            const y = yearInput.value.trim();
            if (y && /^\d{4}$/.test(y)) {
              items = items.filter(i => i.year === parseInt(y, 10));
            }
            renderResults(items, q, y);
          } catch {
            searchBtn.disabled = false;
            searchBtn.textContent = 'Search';
          }
        };

        searchBtn.addEventListener('click', doSearch);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

        const list = box.querySelector('#pvt-manual-list');
        if (results.length === 0) {
          list.innerHTML = '<p style="color:#777;font-size:13px;text-align:center;padding:16px 0">No results found. Try a different query.</p>';
        }
        for (const item of results) {
          const btn = document.createElement('button');
          btn.style.cssText = 'display:flex;gap:12px;width:100%;text-align:left;background:#0f0f23;border:1px solid #333;border-radius:6px;padding:10px 12px;margin-bottom:8px;color:#e0e0e0;cursor:pointer;font-size:13px;font-family:inherit;align-items:flex-start';
          btn.onmouseenter = () => btn.style.borderColor = '#ed1d24';
          btn.onmouseleave = () => btn.style.borderColor = '#333';

          const img = document.createElement('img');
          img.style.cssText = 'width:60px;min-width:60px;height:90px;object-fit:cover;border-radius:4px;background:#222';
          img.alt = item.title;
          img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="90"><rect width="60" height="90" fill="%23222"/><text x="30" y="50" fill="%23555" font-size="10" text-anchor="middle">...</text></svg>');
          if (item.ids?.tmdb) {
            fetchPoster(type, item.ids).then((url) => { if (url) img.src = url; });
          }

          const textDiv = document.createElement('div');
          textDiv.style.cssText = 'flex:1;min-width:0';
          const genres = item.genres?.length ? item.genres.slice(0, 3).join(', ') : '';
          const runtime = item.runtime ? `${item.runtime}min` : '';
          const rating = item.rating ? `★ ${item.rating.toFixed(1)}` : '';
          const meta = [item.year, genres, runtime, rating, item.country?.toUpperCase()].filter(Boolean).join(' · ');
          const overview = item.overview ? item.overview.substring(0, 150) + (item.overview.length > 150 ? '...' : '') : '';
          textDiv.innerHTML = `<strong>${item.title}</strong>`
            + (meta ? `<br><span style="color:#999;font-size:12px">${meta}</span>` : '')
            + (overview ? `<br><span style="color:#777;font-size:11px;line-height:1.3;display:block;margin-top:4px">${overview}</span>` : '');

          btn.appendChild(img);
          btn.appendChild(textDiv);
          btn.addEventListener('click', () => { overlay.remove(); resolve(item); });
          list.appendChild(btn);
        }

        box.querySelector('#pvt-manual-skip').addEventListener('click', () => { overlay.remove(); resolve(null); });
        box.querySelector('#pvt-manual-skip-synced').addEventListener('click', () => { overlay.remove(); resolve('__skip_synced__'); });

        const urlInput = box.querySelector('#pvt-manual-url');
        const urlBtn = box.querySelector('#pvt-manual-url-go');
        const doUrlLookup = async () => {
          const url = urlInput.value.trim();
          // Parse trakt.tv URL: https://trakt.tv/movies/slug or https://trakt.tv/shows/slug
          const urlMatch = url.match(/trakt\.tv\/(movies|shows)\/([^\/\?#]+)/);
          if (!urlMatch) { urlInput.style.borderColor = '#ff5555'; return; }
          urlInput.style.borderColor = '#333';
          urlBtn.disabled = true;
          urlBtn.textContent = '...';
          const urlType = urlMatch[1] === 'movies' ? 'movie' : 'show';
          const slug = urlMatch[2];
          try {
            const res = await traktFetch('GET', `/${urlMatch[1]}/${slug}?extended=full`);
            if (res.data) { overlay.remove(); resolve(res.data); }
            else { urlBtn.disabled = false; urlBtn.textContent = 'Go'; }
          } catch {
            urlInput.style.borderColor = '#ff5555';
            urlBtn.disabled = false;
            urlBtn.textContent = 'Go';
          }
        };
        urlBtn.addEventListener('click', doUrlLookup);
        urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUrlLookup(); });
      }

      renderResults(initialResults, title, '');
      overlay.appendChild(box);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
      document.body.appendChild(overlay);
    });
  }

  async function searchTrakt(title, type, skipCache = false, amazonPoster = '') {
    const cacheKey = `search_v4_${type}_${title.toLowerCase()}`;
    if (!skipCache) {
      const cached = store.get(cacheKey);
      if (cached === '__skipped__') return '__skip_synced__';
      if (cached) return cached;
    }

    const encodedQuery = encodeURIComponent(title);

    // Dual search: broad search + title-field-only search, merged & deduplicated.
    // Broad search handles aliases/translations (e.g. "Inheritance").
    // Title-field search surfaces exact title matches the broad search may bury (e.g. "Locked").
    // Use high limits to catch titles the API buries; we score & filter client-side anyway.
    // extended=full is needed for disambiguation metadata (genres, runtime, overview, etc.)
    // but makes responses larger — only request it on the title-field search which is more targeted.
    const [res1, res2] = await Promise.all([
      traktFetch('GET', `/search/${type}?query=${encodedQuery}&limit=100`),
      traktFetch('GET', `/search/${type}?query=${encodedQuery}&fields=title&limit=50&extended=full`),
    ]);

    const items1 = (res1.data || []).map((e) => e[type]).filter(Boolean);
    const items2 = (res2.data || []).map((e) => e[type]).filter(Boolean);

    // Build a lookup of extended data from items2 (which has full metadata)
    const extendedById = new Map();
    for (const item of items2) {
      if (item.ids?.trakt) extendedById.set(item.ids.trakt, item);
    }

    const seen = new Set();
    const allItems = [];
    // Merge: prefer extended data when available
    for (const item of [...items1, ...items2]) {
      const id = item.ids?.trakt;
      if (id && !seen.has(id)) {
        seen.add(id);
        allItems.push(extendedById.get(id) || item);
      }
    }

    // Log all search results for debugging
    const broadUrl = `/search/${type}?query=${encodedQuery}&limit=100`;
    const titleUrl = `/search/${type}?query=${encodedQuery}&fields=title&limit=50&extended=full`;
    const logResults = (label) => {
      console.group(`[PVT] ${label} for "${title}" (${type})`);
      console.log('Broad search URL:', `${TRAKT_API}${broadUrl}`);
      console.log(`Broad results (${items1.length}):`, items1.map(i => ({ title: i.title, year: i.year, trakt: i.ids?.trakt, score: titleSimilarity(title, i.title) })));
      console.log('Title-field URL:', `${TRAKT_API}${titleUrl}`);
      console.log(`Title-field results (${items2.length}):`, items2.map(i => ({ title: i.title, year: i.year, trakt: i.ids?.trakt, score: titleSimilarity(title, i.title) })));
      console.log(`Merged unique (${allItems.length}):`, allItems.map(i => ({ title: i.title, year: i.year, trakt: i.ids?.trakt, score: titleSimilarity(title, i.title) })));
    };

    if (allItems.length > 0) {
      // Score each result by title similarity and pick the best match
      const scored = [];
      for (const item of allItems) {
        const score = titleSimilarity(title, item.title);
        if (score >= 0.5) scored.push({ item, score });
      }

      if (scored.length > 0) {
        // Sort by score descending, then by year descending (prefer recent)
        scored.sort((a, b) => b.score - a.score || (b.item.year || 0) - (a.item.year || 0));

        // Check if there are multiple results with the same top score (ambiguous)
        const topScore = scored[0].score;
        const tied = scored.filter((s) => s.score === topScore);

        let chosen;
        if (tied.length > 1) {
          // Fetch full metadata for tied items that came from the broad (non-extended) search
          const tiedWithMeta = await Promise.all(tied.map(async (t) => {
            if (t.item.overview !== undefined) return t.item; // already has extended data
            try {
              const full = await traktFetch('GET', `/${type}s/${t.item.ids.trakt}?extended=full`);
              return { ...t.item, ...full.data };
            } catch { return t.item; }
          }));
          logResults(`Disambiguation (${tied.length} tied at score ${topScore})`);
          console.log('Scored above threshold:', scored.map(s => ({ title: s.item.title, year: s.item.year, score: s.score })));
          console.groupEnd();
          chosen = await showDisambiguationDialog(title, type, tiedWithMeta, amazonPoster);
          if (chosen === '__manual__') {
            chosen = await showManualSearchDialog(title, type, allItems, amazonPoster);
          }
        } else {
          chosen = scored[0].item;
        }

        if (chosen === '__skip_synced__') {
          cacheSet(cacheKey, '__skipped__');
          return '__skip_synced__';
        }
        if (chosen) {
          cacheSet(cacheKey, chosen);
          return chosen;
        }
        return null; // User skipped disambiguation
      }
    }

    logResults('No auto-match — all scored below 0.5 threshold');
    console.groupEnd();

    // No auto-match — sort results by relevance before showing manual search
    const sortedItems = [...allItems].sort((a, b) => titleSimilarity(title, b.title) - titleSimilarity(title, a.title));

    // No auto-match — show manual search dialog with sorted results
    const chosen = await showManualSearchDialog(title, type, sortedItems, amazonPoster);
    if (chosen === '__skip_synced__') {
      cacheSet(cacheKey, '__skipped__');
      return '__skip_synced__';
    }
    if (chosen) {
      cacheSet(cacheKey, chosen);
      return chosen;
    }
    return null;
  }

  // ── Sync tracking ──

  function syncKey(item) {
    if (item.type === 'movie') {
      return `m|${item.title.toLowerCase()}|${item.watchedAt}`;
    }
    return `e|${item.showTitle.toLowerCase()}|${item.season}|${item.episodeNumber}|${item.watchedAt}`;
  }

  function getSyncedKeys() {
    return new Set(store.get('synced_keys', []));
  }

  function addSyncedKeys(keys) {
    const existing = getSyncedKeys();
    for (const k of keys) existing.add(k);
    store.set('synced_keys', [...existing]);
  }

  // ── Build sync payload ──

  function buildSyncPayload(parsedItems, matchedShows, matchedMovies) {
    const movies = [];
    const showMap = new Map(); // key: "showTitle" → { ids, seasons: Map<number, episodes[]> }

    for (const item of parsedItems) {
      if (item.type === 'movie') {
        const match = matchedMovies.get(item.title.toLowerCase());
        if (!match) continue;
        movies.push({
          ids: match.ids,
          title: match.title,
          year: match.year,
          watched_at: item.watchedAt,
        });
      } else if (item.type === 'episode') {
        const match = matchedShows.get(item.showTitle.toLowerCase());
        if (!match) continue;
        const key = item.showTitle.toLowerCase();
        if (!showMap.has(key)) {
          showMap.set(key, { ids: match.ids, title: match.title, year: match.year, seasons: new Map() });
        }
        const show = showMap.get(key);
        if (!show.seasons.has(item.season)) {
          show.seasons.set(item.season, []);
        }
        show.seasons.get(item.season).push({
          number: item.episodeNumber,
          watched_at: item.watchedAt,
        });
      }
    }

    // For episodes where number is 0 (unknown), assign sequential numbers as fallback
    for (const show of showMap.values()) {
      for (const [, episodes] of show.seasons) {
        const hasUnknown = episodes.some((e) => e.number === 0);
        if (hasUnknown) {
          episodes.sort((a, b) => new Date(a.watched_at) - new Date(b.watched_at));
          for (let i = 0; i < episodes.length; i++) {
            if (episodes[i].number === 0) episodes[i].number = i + 1;
          }
        }
      }
    }

    const shows = [];
    for (const show of showMap.values()) {
      const seasons = [];
      for (const [num, episodes] of show.seasons) {
        seasons.push({ number: num, episodes });
      }
      shows.push({
        ids: show.ids,
        title: show.title,
        year: show.year,
        seasons,
      });
    }

    return { movies, shows };
  }

  // ── Device authentication flow ──

  async function deviceAuth() {
    const clientId = store.get('client_id');
    const clientSecret = store.get('client_secret');

    const codes = await traktFetch('POST', '/oauth/device/code', { client_id: clientId });
    return { codes: codes.data, clientId, clientSecret };
  }

  async function pollForToken(deviceCode, interval, expiresIn, clientId, clientSecret) {
    const deadline = Date.now() + expiresIn * 1000;

    while (Date.now() < deadline) {
      await sleep(interval * 1000);
      try {
        const res = await traktFetch('POST', '/oauth/device/token', {
          code: deviceCode,
          client_id: clientId,
          client_secret: clientSecret,
        });
        store.set('access_token', res.data.access_token);
        store.set('refresh_token', res.data.refresh_token);
        store.set('token_created', res.data.created_at);
        store.set('token_expires_in', res.data.expires_in);
        return true;
      } catch (e) {
        if (e.status === 400) continue; // Pending
        if (e.status === 429) {
          interval += 1; // Slow down
          continue;
        }
        if (e.status === 410) throw new Error('Code expired. Please try again.');
        if (e.status === 418) throw new Error('Authorization denied by user.');
        throw new Error(`Auth failed with status ${e.status}`);
      }
    }
    throw new Error('Code expired. Please try again.');
  }

  // ── Check / refresh token ──

  async function ensureAuth() {
    const token = store.get('access_token');
    if (!token) return false;

    // Check if token needs refresh (expires after 7776000 seconds = 90 days typically)
    const created = store.get('token_created', 0);
    const expiresIn = store.get('token_expires_in', 7776000);
    const expiresAt = (created + expiresIn) * 1000;

    if (Date.now() > expiresAt - 86400000) {
      // Token expired or expiring within 1 day, try refresh
      const refreshToken = store.get('refresh_token');
      if (!refreshToken) return false;
      try {
        const res = await traktFetch('POST', '/oauth/token', {
          refresh_token: refreshToken,
          client_id: store.get('client_id'),
          client_secret: store.get('client_secret'),
          redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
          grant_type: 'refresh_token',
        });
        store.set('access_token', res.data.access_token);
        store.set('refresh_token', res.data.refresh_token);
        store.set('token_created', res.data.created_at);
        store.set('token_expires_in', res.data.expires_in);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  // ── UI ──

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #pvt-btn {
        position: fixed; bottom: 24px; right: 24px; z-index: 99999;
        background: #ed1d24; color: #fff; border: none; border-radius: 8px;
        padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: background 0.2s;
        line-height: 1.3;
      }
      #pvt-btn:hover { background: #c4151c; }
      #pvt-overlay {
        position: fixed; inset: 0; z-index: 100000;
        background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
      }
      #pvt-modal {
        background: #1a1a2e; color: #e0e0e0; border-radius: 12px;
        width: 600px; max-width: 95vw; max-height: 85vh; overflow-y: auto;
        padding: 28px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); font-family: system-ui, sans-serif;
      }
      #pvt-modal h2 { margin: 0 0 16px; color: #ed1d24; font-size: 20px; }
      #pvt-modal h3 { margin: 16px 0 8px; color: #ccc; font-size: 15px; }
      #pvt-modal label { display: block; margin: 8px 0 4px; font-size: 13px; color: #aaa; }
      #pvt-modal input[type="text"], #pvt-modal input[type="password"] {
        width: 100%; padding: 8px 10px; border: 1px solid #333; border-radius: 6px;
        background: #0f0f23; color: #e0e0e0; font-size: 14px; box-sizing: border-box;
      }
      .pvt-btn-primary {
        background: #ed1d24; color: #fff; border: none; border-radius: 6px;
        padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 12px;
      }
      .pvt-btn-primary:hover { background: #c4151c; }
      .pvt-btn-primary:disabled { background: #555; cursor: not-allowed; }
      .pvt-btn-secondary {
        background: #333; color: #ccc; border: 1px solid #555; border-radius: 6px;
        padding: 8px 16px; font-size: 13px; cursor: pointer; margin-top: 8px;
      }
      .pvt-btn-secondary:hover { background: #444; }
      #pvt-log {
        background: #0f0f23; border: 1px solid #333; border-radius: 6px;
        padding: 12px; margin-top: 12px; max-height: 300px; overflow-y: auto;
        font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; line-height: 1.6;
      }
      #pvt-log .info { color: #8be9fd; }
      #pvt-log .success { color: #50fa7b; }
      #pvt-log .warn { color: #f1fa8c; }
      #pvt-log .error { color: #ff5555; }
      .pvt-progress {
        background: #333; border-radius: 4px; height: 6px; margin: 8px 0; overflow: hidden;
      }
      .pvt-progress-bar {
        background: #ed1d24; height: 100%; transition: width 0.3s; width: 0%;
      }
      .pvt-code {
        display: inline-block; background: #0f0f23; border: 2px solid #ed1d24;
        border-radius: 8px; padding: 12px 24px; font-size: 28px; font-weight: bold;
        letter-spacing: 4px; color: #fff; margin: 12px 0; font-family: monospace;
      }
      .pvt-link {
        color: #8be9fd; text-decoration: underline; cursor: pointer;
      }
      .pvt-summary { margin-top: 12px; }
      .pvt-summary-row {
        display: flex; justify-content: space-between; padding: 4px 0;
        border-bottom: 1px solid #222; font-size: 13px;
      }
      .pvt-summary-row:last-child { border-bottom: none; }
    `;
    document.head.appendChild(style);
  }

  function createModal() {
    const overlay = document.createElement('div');
    overlay.id = 'pvt-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.id = 'pvt-modal';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    return modal;
  }

  function log(container, msg, cls = 'info') {
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = msg;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }

  // ── Settings view ──

  function showSettings(modal) {
    const clientId = store.get('client_id', '');
    const clientSecret = store.get('client_secret', '');

    modal.innerHTML = `
      <h2>Trakt API Settings</h2>
      <p style="font-size:13px;color:#999;margin:0 0 12px">
        Create an app at
        <a href="https://trakt.tv/oauth/applications/new" target="_blank" class="pvt-link">trakt.tv/oauth/applications/new</a><br>
        Set Redirect URI to: <code style="color:#f1fa8c">urn:ietf:wg:oauth:2.0:oob</code>
      </p>
      <label for="pvt-cid">Client ID</label>
      <input type="text" id="pvt-cid" value="${clientId}" placeholder="Your Trakt Client ID">
      <label for="pvt-csec">Client Secret</label>
      <input type="password" id="pvt-csec" value="${clientSecret}" placeholder="Your Trakt Client Secret">
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="pvt-btn-primary" id="pvt-save-settings">Save & Continue</button>
        <button class="pvt-btn-secondary" id="pvt-cancel">Cancel</button>
      </div>
    `;

    modal.querySelector('#pvt-save-settings').addEventListener('click', () => {
      const id = modal.querySelector('#pvt-cid').value.trim();
      const secret = modal.querySelector('#pvt-csec').value.trim();
      if (!id || !secret) return alert('Both fields are required.');
      store.set('client_id', id);
      store.set('client_secret', secret);
      showMain(modal);
    });

    modal.querySelector('#pvt-cancel').addEventListener('click', () => {
      modal.closest('#pvt-overlay')?.remove();
    });
  }

  // ── Auth view ──

  async function showAuth(modal) {
    modal.innerHTML = `
      <h2>Connect to Trakt</h2>
      <p style="font-size:14px">Generating device code...</p>
    `;

    try {
      const { codes, clientId, clientSecret } = await deviceAuth();

      modal.innerHTML = `
        <h2>Connect to Trakt</h2>
        <p style="font-size:14px">Visit the link below and enter this code:</p>
        <div class="pvt-code">${codes.user_code}</div>
        <p>
          <a href="${codes.verification_url}" target="_blank" class="pvt-link">${codes.verification_url}</a>
        </p>
        <p style="font-size:13px;color:#999">Waiting for authorization... (expires in ${Math.round(codes.expires_in / 60)} minutes)</p>
        <div class="pvt-progress"><div class="pvt-progress-bar" id="pvt-auth-progress"></div></div>
        <button class="pvt-btn-secondary" id="pvt-auth-cancel">Cancel</button>
      `;

      let cancelled = false;
      modal.querySelector('#pvt-auth-cancel').addEventListener('click', () => {
        cancelled = true;
        modal.closest('#pvt-overlay')?.remove();
      });

      // Poll in background
      const deadline = Date.now() + codes.expires_in * 1000;
      let pollInterval = codes.interval;

      while (Date.now() < deadline && !cancelled) {
        await sleep(pollInterval * 1000);
        if (cancelled) return;

        // Update progress bar
        const progressBar = document.getElementById('pvt-auth-progress');
        if (progressBar) {
          const elapsed = Date.now() - (deadline - codes.expires_in * 1000);
          progressBar.style.width = `${Math.min(100, (elapsed / (codes.expires_in * 1000)) * 100)}%`;
        }

        try {
          const res = await traktFetch('POST', '/oauth/device/token', {
            code: codes.device_code,
            client_id: clientId,
            client_secret: clientSecret,
          });
          store.set('access_token', res.data.access_token);
          store.set('refresh_token', res.data.refresh_token);
          store.set('token_created', res.data.created_at);
          store.set('token_expires_in', res.data.expires_in);
          showMain(modal);
          return;
        } catch (e) {
          if (e.status === 400) continue;
          if (e.status === 429) { pollInterval += 1; continue; }
          if (e.status === 410) {
            modal.innerHTML = `<h2>Code Expired</h2><p>Please try again.</p>
              <button class="pvt-btn-primary" id="pvt-retry-auth">Retry</button>`;
            modal.querySelector('#pvt-retry-auth').addEventListener('click', () => showAuth(modal));
            return;
          }
          if (e.status === 418) {
            modal.innerHTML = `<h2>Authorization Denied</h2><p>You denied the request. Try again when ready.</p>
              <button class="pvt-btn-secondary" id="pvt-close">Close</button>`;
            modal.querySelector('#pvt-close').addEventListener('click', () => modal.closest('#pvt-overlay')?.remove());
            return;
          }
        }
      }
    } catch (err) {
      modal.innerHTML = `<h2>Auth Error</h2><p class="error">${err.message || 'Failed to start authentication.'}</p>
        <button class="pvt-btn-primary" id="pvt-retry-auth">Retry</button>
        <button class="pvt-btn-secondary" id="pvt-settings">Settings</button>`;
      modal.querySelector('#pvt-retry-auth')?.addEventListener('click', () => showAuth(modal));
      modal.querySelector('#pvt-settings')?.addEventListener('click', () => showSettings(modal));
    }
  }

  // ── Main sync view ──

  async function showMain(modal) {
    // Check settings
    if (!store.get('client_id') || !store.get('client_secret')) {
      showSettings(modal);
      return;
    }

    // Check auth
    const authed = await ensureAuth();
    if (!authed) {
      showAuth(modal);
      return;
    }

    const lastSync = store.get('last_sync_at', null);
    const lastSyncText = lastSync
      ? new Date(lastSync).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : null;
    const cacheCount = store.get('cache_keys', []).length;
    const syncedCount = store.get('synced_keys', []).length;

    modal.innerHTML = `
      <h2>Prime Video → Trakt Sync</h2>
      <p style="font-size:13px;color:#50fa7b;margin:0 0 12px">Connected to Trakt ✓</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="pvt-btn-primary" id="pvt-sync-new" ${!lastSync ? 'disabled title="No previous sync"' : ''} style="line-height:1.2;padding:10px 20px">Sync New${lastSyncText ? `<br><span style="font-size:10px;font-weight:400;opacity:0.8">since ${lastSyncText}</span>` : ''}</button>
        <button class="pvt-btn-primary" id="pvt-sync-all" style="background:#444;border:1px solid #666">Sync All</button>
      </div>
      ${!lastSync ? '<p id="pvt-no-sync-msg" style="font-size:12px;color:#777;margin:6px 0 0">No previous sync — use "Sync All" for first run</p>' : ''}
      <div id="pvt-log" style="display:none"></div>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #333;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="pvt-btn-secondary" id="pvt-debug-sync" style="font-size:12px;padding:6px 10px">Debug (Dry Run)</button>
        <button class="pvt-btn-secondary" id="pvt-settings" style="font-size:12px;padding:6px 10px">Settings</button>
        <button class="pvt-btn-secondary" id="pvt-logout" style="font-size:12px;padding:6px 10px">Disconnect</button>
        <button class="pvt-btn-secondary" id="pvt-clear-cache" style="font-size:12px;padding:6px 10px">Clear Cache (${cacheCount})</button>
        <button class="pvt-btn-secondary" id="pvt-clear-synced" style="font-size:12px;padding:6px 10px">Clear History (${syncedCount})</button>
      </div>
    `;

    modal.querySelector('#pvt-sync-new').addEventListener('click', () => runSync(modal, false, 'new'));
    modal.querySelector('#pvt-sync-all').addEventListener('click', () => runSync(modal, false, 'all'));
    modal.querySelector('#pvt-debug-sync').addEventListener('click', () => runSync(modal, true, 'all'));
    modal.querySelector('#pvt-settings').addEventListener('click', () => showSettings(modal));
    modal.querySelector('#pvt-logout').addEventListener('click', () => {
      store.del('access_token');
      store.del('refresh_token');
      store.del('token_created');
      store.del('token_expires_in');
      showMain(modal);
    });
    modal.querySelector('#pvt-clear-cache').addEventListener('click', () => {
      const keys = store.get('cache_keys', []);
      for (const k of keys) store.del(k);
      store.del('cache_keys');
      alert(`Search cache cleared (${keys.length} entries).`);
      showMain(modal);
    });
    modal.querySelector('#pvt-clear-synced').addEventListener('click', () => {
      store.del('synced_keys');
      alert('Sync history cleared. Next sync will re-send all items.');
      showMain(modal);
    });
  }

  // ── Core sync logic ──

  async function runSync(modal, debugMode = false, syncMode = 'all') {
    const logEl = modal.querySelector('#pvt-log');
    logEl.style.display = 'block';
    logEl.innerHTML = '';

    // Disable both sync buttons
    const syncNewBtn = modal.querySelector('#pvt-sync-new');
    const syncAllBtn = modal.querySelector('#pvt-sync-all');
    if (syncNewBtn) syncNewBtn.disabled = true;
    if (syncAllBtn) syncAllBtn.disabled = true;
    const activeBtn = syncMode === 'new' ? syncNewBtn : syncAllBtn;
    if (activeBtn) activeBtn.textContent = debugMode ? 'Debug running...' : 'Syncing...';

    if (debugMode) {
      log(logEl, '🐛 DEBUG MODE — dry run, no data will be sent to Trakt', 'warn');
    }

    const lastSyncAt = store.get('last_sync_at', null);
    const stopAfterDate = (syncMode === 'new' && lastSyncAt) ? new Date(lastSyncAt) : null;
    if (stopAfterDate) {
      log(logEl, `📅 Syncing items since ${stopAfterDate.toLocaleDateString()}`, 'info');
    }

    try {
      // Step 1: Auto-scroll
      log(logEl, stopAfterDate ? '⏬ Scrolling to load recent watch history...' : '⏬ Auto-scrolling to load full watch history...');
      await autoScrollToBottom((count) => {
        const lastLine = logEl.lastElementChild;
        if (lastLine && lastLine.textContent.startsWith('⏬')) {
          lastLine.textContent = `⏬ Loading... ${count} items found so far`;
        }
      }, stopAfterDate);

      // Step 2: Parse
      log(logEl, '📋 Expanding episodes and parsing watch history...');
      const debugLogger = debugMode ? (msg) => log(logEl, msg, 'info') : null;
      let parsed = await parseWatchHistory(debugLogger);

      // Filter by date if syncing new only
      if (stopAfterDate) {
        const before = parsed.length;
        parsed = parsed.filter(item => new Date(item.watchedAt) > stopAfterDate);
        if (before !== parsed.length) {
          log(logEl, `📅 Filtered to ${parsed.length} item(s) newer than last sync (${before - parsed.length} older skipped)`, 'info');
        }
      }

      if (parsed.length === 0) {
        log(logEl, 'No items found in watch history.', 'warn');
        if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }
        if (syncAllBtn) { syncAllBtn.disabled = false; syncAllBtn.textContent = 'Sync All'; }
        return;
      }

      // In debug mode, limit to first 10 items
      if (debugMode && parsed.length > 10) {
        log(logEl, `🐛 Debug: limiting from ${parsed.length} to first 10 items`, 'warn');
        parsed = parsed.slice(0, 10);
      }

      let startBtn = activeBtn;

      // Filter out already-synced items
      const syncedKeys = getSyncedKeys();
      const beforeCount = parsed.length;
      parsed = parsed.filter((item) => !syncedKeys.has(syncKey(item)));
      const skippedCount = beforeCount - parsed.length;
      if (skippedCount > 0) {
        log(logEl, `⏭ Skipped ${skippedCount} already-synced item(s)`, 'info');
      }

      const movieItems = parsed.filter((i) => i.type === 'movie');
      const episodeItems = parsed.filter((i) => i.type === 'episode');
      const uniqueMovies = [...new Set(movieItems.map((m) => m.title.toLowerCase()))];
      const uniqueShows = [...new Set(episodeItems.map((e) => e.showTitle.toLowerCase()))];

      log(logEl, `Found ${movieItems.length} movie watches (${uniqueMovies.length} unique) and ${episodeItems.length} episode watches (${uniqueShows.length} unique shows)`, 'success');

      if (debugMode) {
        log(logEl, '\n🐛 Parsed items:', 'info');
        for (const item of parsed) {
          if (item.type === 'movie') {
            log(logEl, `  🎬 Movie: "${item.title}" (${item.watchedAt})`);
          } else {
            log(logEl, `  📺 Show: "${item.showTitle}" S${String(item.season).padStart(2,'0')}E${String(item.episodeNumber).padStart(2,'0')}${item.episodeTitle ? ': ' + item.episodeTitle : ''} (${item.watchedAt})`);
          }
        }
      }

      // Step 3: Search Trakt for each unique title
      log(logEl, '🔍 Searching Trakt for matches...');
      const matchedMovies = new Map();
      const matchedShows = new Map();
      const unmatched = [];
      const skippedSynced = [];
      let searchCount = 0;
      const totalSearches = uniqueMovies.length + uniqueShows.length;

      for (const title of uniqueMovies) {
        searchCount++;
        const firstItem = movieItems.find((m) => m.title.toLowerCase() === title);
        const origTitle = firstItem.title;
        const amazonPoster = firstItem.posterUrl || '';
        try {
          const result = await searchTrakt(origTitle, 'movie', debugMode, amazonPoster);
          if (result === '__skip_synced__') {
            skippedSynced.push(...movieItems.filter(m => m.title.toLowerCase() === title));
            log(logEl, `  [${searchCount}/${totalSearches}] ⏭ Movie: "${origTitle}" — skipped & marked synced`);
          } else if (result) {
            matchedMovies.set(title, result);
            log(logEl, `  [${searchCount}/${totalSearches}] ✓ Movie: "${origTitle}" → "${result.title}" (${result.year})`);
          } else {
            unmatched.push({ type: 'movie', title: origTitle });
            log(logEl, `  [${searchCount}/${totalSearches}] ✗ Movie: "${origTitle}" — not found`, 'warn');
          }
        } catch (e) {
          unmatched.push({ type: 'movie', title: origTitle });
          log(logEl, `  [${searchCount}/${totalSearches}] ✗ Movie: "${origTitle}" — search error`, 'error');
        }
        if (searchCount < totalSearches) await sleep(250); // Be gentle with rate limits
      }

      for (const showKey of uniqueShows) {
        searchCount++;
        const firstItem = episodeItems.find((e) => e.showTitle.toLowerCase() === showKey);
        const origTitle = firstItem.showTitle;
        const amazonPoster = firstItem.posterUrl || '';
        try {
          const result = await searchTrakt(origTitle, 'show', debugMode, amazonPoster);
          if (result === '__skip_synced__') {
            skippedSynced.push(...episodeItems.filter(e => e.showTitle.toLowerCase() === showKey));
            log(logEl, `  [${searchCount}/${totalSearches}] ⏭ Show: "${origTitle}" — skipped & marked synced`);
          } else if (result) {
            matchedShows.set(showKey, result);
            log(logEl, `  [${searchCount}/${totalSearches}] ✓ Show: "${origTitle}" → "${result.title}" (${result.year})`);
          } else {
            unmatched.push({ type: 'show', title: origTitle });
            log(logEl, `  [${searchCount}/${totalSearches}] ✗ Show: "${origTitle}" — not found`, 'warn');
          }
        } catch (e) {
          unmatched.push({ type: 'show', title: origTitle });
          log(logEl, `  [${searchCount}/${totalSearches}] ✗ Show: "${origTitle}" — search error`, 'error');
        }
        if (searchCount < totalSearches) await sleep(250);
      }

      // Record "skip & mark synced" items immediately (but not in debug/dry-run mode)
      if (skippedSynced.length > 0 && !debugMode) {
        addSyncedKeys(skippedSynced.map(syncKey));
        log(logEl, `⏭ Marked ${skippedSynced.length} skipped item(s) as synced`, 'info');
      } else if (skippedSynced.length > 0 && debugMode) {
        log(logEl, `🐛 Would mark ${skippedSynced.length} skipped item(s) as synced (dry run — not saved)`, 'warn');
      }

      // Step 4: Build payload
      const payload = buildSyncPayload(parsed, matchedShows, matchedMovies);
      const totalToSync = payload.movies.length + payload.shows.reduce((sum, s) => sum + s.seasons.reduce((ss, sn) => ss + sn.episodes.length, 0), 0);
      const totalEpisodesInPayload = payload.shows.reduce((sum, s) => sum + s.seasons.reduce((ss, sn) => ss + sn.episodes.length, 0), 0);

      log(logEl, `\n📊 Ready to sync: ${payload.movies.length} movie plays, ${totalEpisodesInPayload} episode plays across ${payload.shows.length} shows`);
      if (unmatched.length > 0) {
        log(logEl, `⚠️ ${unmatched.length} item(s) could not be matched and will be skipped`, 'warn');
      }

      if (totalToSync === 0) {
        log(logEl, 'Nothing to sync.', 'warn');
        if (!debugMode) {
          store.set('last_sync_at', new Date().toISOString());
          const noSyncMsg = modal.querySelector('#pvt-no-sync-msg');
          if (noSyncMsg) noSyncMsg.remove();
        }
        if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }
        if (syncAllBtn) { syncAllBtn.disabled = false; syncAllBtn.textContent = 'Sync All'; }
        return;
      }

      // In debug mode, show the payload and stop
      if (debugMode) {
        log(logEl, '\n🐛 Payload that would be sent to Trakt:', 'info');
        for (const m of payload.movies) {
          log(logEl, `  🎬 Movie: "${m.title}" (${m.year}) [trakt:${m.ids?.trakt}] watched_at: ${m.watched_at}`);
        }
        for (const s of payload.shows) {
          log(logEl, `  📺 Show: "${s.title}" (${s.year}) [trakt:${s.ids?.trakt}]`);
          for (const sn of s.seasons) {
            for (const ep of sn.episodes) {
              log(logEl, `      S${String(sn.number).padStart(2,'0')}E${String(ep.number).padStart(2,'0')} watched_at: ${ep.watched_at}`);
            }
          }
        }
        log(logEl, '\n🐛 Debug complete — no data was sent to Trakt', 'success');
        if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }
        if (syncAllBtn) { syncAllBtn.disabled = false; syncAllBtn.textContent = 'Sync All'; }
        return;
      }

      // Step 5: Confirm
      log(logEl, '\n▶ Click "Confirm Sync" to send to Trakt...');

      // Replace button — clone to strip all previous listeners
      const confirmBtn = startBtn.cloneNode(true);
      confirmBtn.textContent = 'Confirm Sync';
      confirmBtn.disabled = false;
      startBtn.replaceWith(confirmBtn);
      startBtn = confirmBtn;

      await new Promise((resolve) => {
        confirmBtn.addEventListener('click', resolve, { once: true });
      });

      startBtn.disabled = true;
      startBtn.textContent = 'Syncing...';

      // Step 6: Send to Trakt
      log(logEl, '📤 Sending watch history to Trakt...');
      const res = await traktFetch('POST', '/sync/history', payload);

      // Step 7: Show results
      const added = res.data?.added;
      const notFound = res.data?.not_found;

      // Record only items that were actually synced (matched and included in payload)
      const syncedItems = parsed.filter((item) => {
        if (item.type === 'movie') return matchedMovies.has(item.title.toLowerCase());
        return matchedShows.has(item.showTitle.toLowerCase());
      });
      addSyncedKeys(syncedItems.map(syncKey));
      store.set('last_sync_at', new Date().toISOString());
      const noSyncMsg = modal.querySelector('#pvt-no-sync-msg');
      if (noSyncMsg) noSyncMsg.remove();
      if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }

      log(logEl, '\n✅ Sync complete!', 'success');
      if (added) {
        log(logEl, `  Added: ${added.movies || 0} movies, ${added.episodes || 0} episodes`, 'success');
      }
      if (notFound) {
        const nfMovies = notFound.movies?.length || 0;
        const nfShows = notFound.shows?.length || 0;
        const nfEps = notFound.episodes?.length || 0;
        if (nfMovies + nfShows + nfEps > 0) {
          log(logEl, `  Not found on Trakt: ${nfMovies} movies, ${nfShows} shows, ${nfEps} episodes`, 'warn');
        }
      }

      if (startBtn) startBtn.textContent = 'Done!';
    } catch (err) {
      log(logEl, `\n❌ Error: ${err.message || err.data || 'Unknown error'}`, 'error');
      if (err.status === 401) {
        log(logEl, 'Token may have expired. Try disconnecting and reconnecting Trakt.', 'error');
      }
      if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }
      if (syncAllBtn) { syncAllBtn.disabled = false; syncAllBtn.textContent = 'Sync All'; }
    }
  }

  // ── Initialize ──

  function init() {
    injectStyles();

    const btn = document.createElement('button');
    btn.id = 'pvt-btn';
    const lastSync = store.get('last_sync_at', null);
    if (lastSync) {
      const lastSyncText = new Date(lastSync).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      btn.innerHTML = `↗ Sync to Trakt<br><span style="font-size:10px;font-weight:400;opacity:0.8">Last: ${lastSyncText}</span>`;
    } else {
      btn.textContent = '↗ Sync to Trakt';
    }
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
      // Remove any existing modal
      document.getElementById('pvt-overlay')?.remove();
      const modal = createModal();
      showMain(modal);
    });
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();