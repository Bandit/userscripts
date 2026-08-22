// ==UserScript==
// @name         Prime Video to Floppy
// @namespace    https://github.com/Bandit/userscripts
// @version      1.0.0
// @description  Sync your Amazon Prime Video watch history to Floppy
// @author       Bandit
// @homepageURL  https://github.com/Bandit/userscripts/blob/main/Prime-Video-to-Floppy.user.js
// @supportURL   https://github.com/Bandit/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/Bandit/userscripts/main/Prime-Video-to-Floppy.user.js
// @downloadURL  https://raw.githubusercontent.com/Bandit/userscripts/main/Prime-Video-to-Floppy.user.js
// @match        *://*.primevideo.com/*/settings/watch-history*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      *
// @connect      www.themoviedb.org
// ==/UserScript==

// Optional: replace @connect * above with the hostname from your Floppy instance URL.

/*
  SETUP INSTRUCTIONS:
  1. Open Floppy Settings -> Integrations
  2. Copy your API Token
  3. Click the "Sync to Floppy" button on your Prime watch history page
  4. Enter your Floppy URL and API token
*/

(function () {
  'use strict';

  // ── Constants ──
  const DEFAULT_FLOPPY_URL = '';
  const SCRIPT_PREFIX = 'pvf_';

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

  // ── Floppy API wrapper (uses GM_xmlhttpRequest to bypass CORS) ──
  function floppyFetch(method, path, body) {
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': store.get('api_token', ''),
      };
      const baseUrl = store.get('base_url', DEFAULT_FLOPPY_URL).replace(/\/+$/, '');

      GM_xmlhttpRequest({
        method,
        url: `${baseUrl}${path}`,
        headers,
        data: body ? JSON.stringify(body) : undefined,
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            resolve({ status: res.status, data: res.responseText ? JSON.parse(res.responseText) : null });
          } else {
            let data = res.responseText;
            try { data = JSON.parse(res.responseText); } catch { /* Keep the raw response. */ }
            reject({ status: res.status, data });
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

  // ── Floppy search (with caching and title scoring) ──

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
      overlay.id = 'pvf-disambig-overlay';
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
        <div id="pvf-disambig-list"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button class="pvf-btn-secondary" id="pvf-disambig-manual">None of these — search manually</button>
          <button class="pvf-btn-secondary" id="pvf-disambig-skip">Skip for now</button>
          <button class="pvf-btn-secondary" id="pvf-disambig-skip-synced" style="color:#f1fa8c">Skip & mark synced</button>
        </div>
      `;

      const list = box.querySelector('#pvf-disambig-list');
      for (const item of candidates) {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:flex;gap:12px;width:100%;text-align:left;background:#0f0f23;border:1px solid #333;border-radius:6px;padding:10px 12px;margin-bottom:8px;color:#e0e0e0;cursor:pointer;font-size:13px;font-family:inherit;align-items:flex-start';
        btn.onmouseenter = () => btn.style.borderColor = '#ed1d24';
        btn.onmouseleave = () => btn.style.borderColor = '#333';

        // Poster placeholder
        const img = document.createElement('img');
        img.style.cssText = 'width:60px;min-width:60px;height:90px;object-fit:cover;border-radius:4px;background:#222';
        img.alt = item.title;
        img.src = item.image || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="90"><rect width="60" height="90" fill="%23222"/><text x="30" y="50" fill="%23555" font-size="10" text-anchor="middle">...</text></svg>');

        // Fetch poster async
        if (!item.image && item.ids?.tmdb) {
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

      box.querySelector('#pvf-disambig-manual').addEventListener('click', () => { overlay.remove(); resolve('__manual__'); });
      box.querySelector('#pvf-disambig-skip').addEventListener('click', () => { overlay.remove(); resolve(null); });
      box.querySelector('#pvf-disambig-skip-synced').addEventListener('click', () => { overlay.remove(); resolve('__skip_synced__'); });
      overlay.appendChild(box);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
      document.body.appendChild(overlay);
    });
  }

  function showManualSearchDialog(title, type, initialResults, amazonPoster) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'pvf-disambig-overlay';
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
          <p style="font-size:13px;color:#999;margin:0 0 12px">Search Floppy for the correct ${typeLabel.toLowerCase()}:</p>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input type="text" id="pvf-manual-query" value="${(query || '').replace(/"/g, '&quot;')}" placeholder="Search query..."
              style="flex:1;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#0f0f23;color:#e0e0e0;font-size:13px;font-family:inherit">
            <input type="text" id="pvf-manual-year" value="${year || ''}" placeholder="Year" maxlength="4"
              style="width:60px;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#0f0f23;color:#e0e0e0;font-size:13px;font-family:inherit;text-align:center">
            <button class="pvf-btn-primary" id="pvf-manual-search" style="margin:0;padding:8px 16px;font-size:13px">Search</button>
          </div>
          <div id="pvf-manual-list"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            <button class="pvf-btn-secondary" id="pvf-manual-skip">Skip for now</button>
            <button class="pvf-btn-secondary" id="pvf-manual-skip-synced" style="color:#f1fa8c">Skip & mark synced</button>
          </div>
        `;

        const input = box.querySelector('#pvf-manual-query');
        const yearInput = box.querySelector('#pvf-manual-year');
        const searchBtn = box.querySelector('#pvf-manual-search');

        const doSearch = async () => {
          const q = input.value.trim();
          if (!q) return;
          searchBtn.disabled = true;
          searchBtn.textContent = '...';
          try {
            const items = await searchFloppyCatalog(q, type, 50);
            const y = yearInput.value.trim();
            if (y && /^\d{4}$/.test(y)) {
              renderResults(items.filter(i => i.year === parseInt(y, 10)), q, y);
            } else {
              renderResults(items, q, y);
            }
          } catch {
            searchBtn.disabled = false;
            searchBtn.textContent = 'Search';
          }
        };

        searchBtn.addEventListener('click', doSearch);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

        const list = box.querySelector('#pvf-manual-list');
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
          img.src = item.image || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="90"><rect width="60" height="90" fill="%23222"/><text x="30" y="50" fill="%23555" font-size="10" text-anchor="middle">...</text></svg>');
          if (!item.image && item.ids?.tmdb) {
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

        box.querySelector('#pvf-manual-skip').addEventListener('click', () => { overlay.remove(); resolve(null); });
        box.querySelector('#pvf-manual-skip-synced').addEventListener('click', () => { overlay.remove(); resolve('__skip_synced__'); });

      }

      renderResults(initialResults, title, '');
      overlay.appendChild(box);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
      document.body.appendChild(overlay);
    });
  }

  function normalizeFloppyResult(item) {
    const source = item.source || 'tmdb';
    return {
      ...item,
      ids: { [source]: String(item.media_id) },
    };
  }

  async function searchFloppyCatalog(title, type, limit = 100) {
    const mediaType = type === 'show' ? 'tv' : type;
    const query = encodeURIComponent(title);
    const res = await floppyFetch('GET', `/api/v1/search/${mediaType}/?search=${query}&source=tmdb&limit=${limit}`);
    return (res.data?.results || []).map(normalizeFloppyResult);
  }

  async function searchFloppy(title, type, skipCache = false, amazonPoster = '') {
    const cacheKey = `search_v1_${type}_${title.toLowerCase()}`;
    if (!skipCache) {
      const cached = store.get(cacheKey);
      if (cached === '__skipped__') return '__skip_synced__';
      if (cached) return cached;
    }

    const allItems = await searchFloppyCatalog(title, type);

    // Log all search results for debugging
    const logResults = (label) => {
      console.group(`[PVF] ${label} for "${title}" (${type})`);
      console.log(`Floppy results (${allItems.length}):`, allItems.map(i => ({ title: i.title, year: i.year, source: i.source, mediaId: i.media_id, score: titleSimilarity(title, i.title) })));
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
          logResults(`Disambiguation (${tied.length} tied at score ${topScore})`);
          console.log('Scored above threshold:', scored.map(s => ({ title: s.item.title, year: s.item.year, score: s.score })));
          console.groupEnd();
          chosen = await showDisambiguationDialog(title, type, tied.map(t => t.item), amazonPoster);
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

  // ── Build Floppy scrobbles ──

  function floppyIds(ids = {}) {
    return Object.fromEntries(['tmdb', 'imdb', 'tvdb']
      .filter(key => ids[key] != null)
      .map(key => [key, String(ids[key])]));
  }

  function buildScrobbleRequests(parsedItems, matchedShows, matchedMovies) {
    const items = parsedItems.map(item => ({ ...item }));
    const episodeGroups = new Map();

    for (const item of items.filter(item => item.type === 'episode')) {
      const key = `${item.showTitle.toLowerCase()}|${item.season}`;
      if (!episodeGroups.has(key)) episodeGroups.set(key, []);
      episodeGroups.get(key).push(item);
    }

    for (const episodes of episodeGroups.values()) {
      episodes.sort((a, b) => new Date(a.watchedAt) - new Date(b.watchedAt));
      const used = new Set(episodes.map(item => item.episodeNumber).filter(Boolean));
      let fallback = 1;
      for (const item of episodes) {
        if (item.episodeNumber) continue;
        while (used.has(fallback)) fallback++;
        item.episodeNumber = fallback;
        used.add(fallback);
      }
    }

    const requests = [];
    for (const item of items) {
      if (item.type === 'movie') {
        const match = matchedMovies.get(item.title.toLowerCase());
        if (!match) continue;
        requests.push({
          item,
          body: {
            action: 'stop',
            media_type: 'movie',
            ids: floppyIds(match.ids),
            title: match.title,
            completed: true,
            played_at: item.watchedAt,
          },
        });
      } else {
        const match = matchedShows.get(item.showTitle.toLowerCase());
        if (!match) continue;
        requests.push({
          item,
          body: {
            action: 'stop',
            media_type: 'episode',
            ids: floppyIds(match.ids),
            title: item.episodeTitle || null,
            series_title: match.title,
            season_number: item.season,
            episode_number: item.episodeNumber,
            completed: true,
            played_at: item.watchedAt,
          },
        });
      }
    }
    return requests;
  }

  async function ensureAuth() {
    if (!store.get('api_token')) return false;
    try {
      await floppyFetch('GET', '/api/v1/user/preferences/');
      return true;
    } catch (error) {
      if (error.status === 401 || error.status === 403) return false;
      throw error;
    }
  }

  // ── UI ──

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #pvf-btn {
        position: fixed; bottom: 24px; right: 24px; z-index: 99999;
        background: #ed1d24; color: #fff; border: none; border-radius: 8px;
        padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: background 0.2s;
        line-height: 1.3;
      }
      #pvf-btn:hover { background: #c4151c; }
      #pvf-overlay {
        position: fixed; inset: 0; z-index: 100000;
        background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
      }
      #pvf-modal {
        background: #1a1a2e; color: #e0e0e0; border-radius: 12px;
        width: 600px; max-width: 95vw; max-height: 85vh; overflow-y: auto;
        padding: 28px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); font-family: system-ui, sans-serif;
      }
      #pvf-modal h2 { margin: 0 0 16px; color: #ed1d24; font-size: 20px; }
      #pvf-modal h3 { margin: 16px 0 8px; color: #ccc; font-size: 15px; }
      #pvf-modal label { display: block; margin: 8px 0 4px; font-size: 13px; color: #aaa; }
      #pvf-modal input[type="text"], #pvf-modal input[type="password"] {
        width: 100%; padding: 8px 10px; border: 1px solid #333; border-radius: 6px;
        background: #0f0f23; color: #e0e0e0; font-size: 14px; box-sizing: border-box;
      }
      .pvf-btn-primary {
        background: #ed1d24; color: #fff; border: none; border-radius: 6px;
        padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 12px;
      }
      .pvf-btn-primary:hover { background: #c4151c; }
      .pvf-btn-primary:disabled { background: #555; cursor: not-allowed; }
      .pvf-btn-secondary {
        background: #333; color: #ccc; border: 1px solid #555; border-radius: 6px;
        padding: 8px 16px; font-size: 13px; cursor: pointer; margin-top: 8px;
      }
      .pvf-btn-secondary:hover { background: #444; }
      #pvf-log {
        background: #0f0f23; border: 1px solid #333; border-radius: 6px;
        padding: 12px; margin-top: 12px; max-height: 300px; overflow-y: auto;
        font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; line-height: 1.6;
      }
      #pvf-log .info { color: #8be9fd; }
      #pvf-log .success { color: #50fa7b; }
      #pvf-log .warn { color: #f1fa8c; }
      #pvf-log .error { color: #ff5555; }
      .pvf-progress {
        background: #333; border-radius: 4px; height: 6px; margin: 8px 0; overflow: hidden;
      }
      .pvf-progress-bar {
        background: #ed1d24; height: 100%; transition: width 0.3s; width: 0%;
      }
      .pvf-code {
        display: inline-block; background: #0f0f23; border: 2px solid #ed1d24;
        border-radius: 8px; padding: 12px 24px; font-size: 28px; font-weight: bold;
        letter-spacing: 4px; color: #fff; margin: 12px 0; font-family: monospace;
      }
      .pvf-link {
        color: #8be9fd; text-decoration: underline; cursor: pointer;
      }
      .pvf-summary { margin-top: 12px; }
      .pvf-summary-row {
        display: flex; justify-content: space-between; padding: 4px 0;
        border-bottom: 1px solid #222; font-size: 13px;
      }
      .pvf-summary-row:last-child { border-bottom: none; }
    `;
    document.head.appendChild(style);
  }

  function createModal() {
    const overlay = document.createElement('div');
    overlay.id = 'pvf-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.id = 'pvf-modal';
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

  function showSettings(modal, errorMessage = '') {
    const baseUrl = store.get('base_url', DEFAULT_FLOPPY_URL);
    const apiToken = store.get('api_token', '');

    modal.innerHTML = `
      <h2>Floppy API Settings</h2>
      <p style="font-size:13px;color:#999;margin:0 0 12px">
        Copy your API token from Floppy Settings -> Integrations.
      </p>
      ${errorMessage ? `<p style="font-size:13px;color:#ff5555">${errorMessage}</p>` : ''}
      <label for="pvf-base-url">Floppy URL</label>
      <input type="text" id="pvf-base-url" value="${baseUrl}" placeholder="https://floppy.example.com">
      <label for="pvf-api-token">API Token</label>
      <input type="password" id="pvf-api-token" value="${apiToken}" placeholder="Your Floppy API token">
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="pvf-btn-primary" id="pvf-save-settings">Test & Save</button>
        <button class="pvf-btn-secondary" id="pvf-cancel">Cancel</button>
      </div>
    `;

    modal.querySelector('#pvf-save-settings').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const url = modal.querySelector('#pvf-base-url').value.trim().replace(/\/+$/, '');
      const token = modal.querySelector('#pvf-api-token').value.trim();
      if (!url || !token) return alert('Both fields are required.');
      if (!/^https?:\/\//i.test(url)) return alert('Floppy URL must start with http:// or https://.');
      store.set('base_url', url);
      store.set('api_token', token);
      button.disabled = true;
      button.textContent = 'Testing...';
      try {
        if (!await ensureAuth()) throw new Error('Floppy rejected the API token.');
        showMain(modal);
      } catch (error) {
        showSettings(modal, error.message || error.data?.detail || 'Could not connect to Floppy.');
      }
    });

    modal.querySelector('#pvf-cancel').addEventListener('click', () => {
      modal.closest('#pvf-overlay')?.remove();
    });
  }

  // ── Main sync view ──

  async function showMain(modal) {
    // Check settings
    if (!store.get('api_token')) {
      showSettings(modal);
      return;
    }

    // Check auth
    let authed;
    try {
      authed = await ensureAuth();
    } catch (error) {
      showSettings(modal, error.message || error.data?.detail || 'Could not connect to Floppy.');
      return;
    }
    if (!authed) {
      showSettings(modal, 'Floppy rejected the saved API token.');
      return;
    }

    const lastSync = store.get('last_sync_at', null);
    const lastSyncText = lastSync
      ? new Date(lastSync).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : null;
    const cacheCount = store.get('cache_keys', []).length;
    const syncedCount = store.get('synced_keys', []).length;

    modal.innerHTML = `
      <h2>Prime Video → Floppy Sync</h2>
      <p style="font-size:13px;color:#50fa7b;margin:0 0 12px">Connected to Floppy</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="pvf-btn-primary" id="pvf-sync-new" ${!lastSync ? 'disabled title="No previous sync"' : ''} style="line-height:1.2;padding:10px 20px">Sync New${lastSyncText ? `<br><span style="font-size:10px;font-weight:400;opacity:0.8">since ${lastSyncText}</span>` : ''}</button>
        <button class="pvf-btn-primary" id="pvf-sync-all" style="background:#444;border:1px solid #666">Sync All</button>
      </div>
      ${!lastSync ? '<p id="pvf-no-sync-msg" style="font-size:12px;color:#777;margin:6px 0 0">No previous sync — use "Sync All" for first run</p>' : ''}
      <div id="pvf-log" style="display:none"></div>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #333;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="pvf-btn-secondary" id="pvf-debug-sync" style="font-size:12px;padding:6px 10px">Debug (Dry Run)</button>
        <button class="pvf-btn-secondary" id="pvf-settings" style="font-size:12px;padding:6px 10px">Settings</button>
        <button class="pvf-btn-secondary" id="pvf-logout" style="font-size:12px;padding:6px 10px">Disconnect</button>
        <button class="pvf-btn-secondary" id="pvf-clear-cache" style="font-size:12px;padding:6px 10px">Clear Cache (${cacheCount})</button>
        <button class="pvf-btn-secondary" id="pvf-clear-synced" style="font-size:12px;padding:6px 10px">Clear History (${syncedCount})</button>
      </div>
    `;

    modal.querySelector('#pvf-sync-new').addEventListener('click', () => runSync(modal, false, 'new'));
    modal.querySelector('#pvf-sync-all').addEventListener('click', () => runSync(modal, false, 'all'));
    modal.querySelector('#pvf-debug-sync').addEventListener('click', () => runSync(modal, true, 'all'));
    modal.querySelector('#pvf-settings').addEventListener('click', () => showSettings(modal));
    modal.querySelector('#pvf-logout').addEventListener('click', () => {
      store.del('api_token');
      showMain(modal);
    });
    modal.querySelector('#pvf-clear-cache').addEventListener('click', () => {
      const keys = store.get('cache_keys', []);
      for (const k of keys) store.del(k);
      store.del('cache_keys');
      alert(`Search cache cleared (${keys.length} entries).`);
      showMain(modal);
    });
    modal.querySelector('#pvf-clear-synced').addEventListener('click', () => {
      store.del('synced_keys');
      alert('Sync history cleared. Next sync will re-send all items.');
      showMain(modal);
    });
  }

  // ── Core sync logic ──

  async function runSync(modal, debugMode = false, syncMode = 'all') {
    const logEl = modal.querySelector('#pvf-log');
    logEl.style.display = 'block';
    logEl.innerHTML = '';

    // Disable both sync buttons
    const syncNewBtn = modal.querySelector('#pvf-sync-new');
    const syncAllBtn = modal.querySelector('#pvf-sync-all');
    if (syncNewBtn) syncNewBtn.disabled = true;
    if (syncAllBtn) syncAllBtn.disabled = true;
    const activeBtn = syncMode === 'new' ? syncNewBtn : syncAllBtn;
    if (activeBtn) activeBtn.textContent = debugMode ? 'Debug running...' : 'Syncing...';

    if (debugMode) {
      log(logEl, '🐛 DEBUG MODE — dry run, no data will be sent to Floppy', 'warn');
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

      // Step 3: Search Floppy for each unique title
      log(logEl, '🔍 Searching Floppy for matches...');
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
          const result = await searchFloppy(origTitle, 'movie', debugMode, amazonPoster);
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
          const result = await searchFloppy(origTitle, 'show', debugMode, amazonPoster);
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

      // Step 4: Build scrobble requests
      const requests = buildScrobbleRequests(parsed, matchedShows, matchedMovies);
      const movieCount = requests.filter(request => request.body.media_type === 'movie').length;
      const episodeCount = requests.length - movieCount;

      log(logEl, `\n📊 Ready to sync: ${movieCount} movie plays and ${episodeCount} episode plays`);
      if (unmatched.length > 0) {
        log(logEl, `⚠️ ${unmatched.length} item(s) could not be matched and will be skipped`, 'warn');
      }

      if (requests.length === 0) {
        log(logEl, 'Nothing to sync.', 'warn');
        if (!debugMode && unmatched.length === 0) {
          store.set('last_sync_at', new Date().toISOString());
          const noSyncMsg = modal.querySelector('#pvf-no-sync-msg');
          if (noSyncMsg) noSyncMsg.remove();
        }
        if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }
        if (syncAllBtn) { syncAllBtn.disabled = false; syncAllBtn.textContent = 'Sync All'; }
        return;
      }

      // In debug mode, show the payload and stop
      if (debugMode) {
        log(logEl, '\n🐛 Scrobbles that would be sent to Floppy:', 'info');
        for (const request of requests) {
          const body = request.body;
          const label = body.media_type === 'movie'
            ? `Movie: "${body.title}"`
            : `Episode: "${body.series_title}" S${String(body.season_number).padStart(2,'0')}E${String(body.episode_number).padStart(2,'0')}`;
          log(logEl, `  ${label} ids=${JSON.stringify(body.ids)} played_at=${body.played_at}`);
        }
        log(logEl, '\n🐛 Debug complete — no data was sent to Floppy', 'success');
        if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }
        if (syncAllBtn) { syncAllBtn.disabled = false; syncAllBtn.textContent = 'Sync All'; }
        return;
      }

      // Step 5: Confirm
      log(logEl, '\n▶ Click "Confirm Sync" to send to Floppy...');

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

      // Step 6: Send each scrobble so partial failures remain retryable
      log(logEl, '📤 Sending watch history to Floppy...');
      const syncedItems = [];
      let failedCount = 0;
      for (let index = 0; index < requests.length; index++) {
        const request = requests[index];
        try {
          await floppyFetch('POST', '/api/v1/scrobble/', request.body);
          syncedItems.push(request.item);
          log(logEl, `  [${index + 1}/${requests.length}] Synced ${request.body.media_type}`, 'success');
        } catch (error) {
          failedCount++;
          const detail = error.data?.detail || error.data?.errors || error.data || `HTTP ${error.status}`;
          log(logEl, `  [${index + 1}/${requests.length}] Failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, 'error');
        }
      }

      addSyncedKeys(syncedItems.map(syncKey));
      if (failedCount === 0) {
        store.set('last_sync_at', new Date().toISOString());
        const noSyncMsg = modal.querySelector('#pvf-no-sync-msg');
        if (noSyncMsg) noSyncMsg.remove();
      }
      if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }

      log(logEl, `\n✅ Sync complete: ${syncedItems.length} succeeded, ${failedCount} failed.`, failedCount ? 'warn' : 'success');

      if (startBtn) startBtn.textContent = 'Done!';
    } catch (err) {
      log(logEl, `\n❌ Error: ${err.message || err.data || 'Unknown error'}`, 'error');
      if (err.status === 401 || err.status === 403) {
        log(logEl, 'Floppy rejected the API token. Open Settings and enter the current token.', 'error');
      }
      if (syncNewBtn) { syncNewBtn.disabled = false; syncNewBtn.textContent = 'Sync New'; }
      if (syncAllBtn) { syncAllBtn.disabled = false; syncAllBtn.textContent = 'Sync All'; }
    }
  }

  // ── Initialize ──

  function init() {
    injectStyles();

    const btn = document.createElement('button');
    btn.id = 'pvf-btn';
    const lastSync = store.get('last_sync_at', null);
    if (lastSync) {
      const lastSyncText = new Date(lastSync).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      btn.innerHTML = `↗ Sync to Floppy<br><span style="font-size:10px;font-weight:400;opacity:0.8">Last: ${lastSyncText}</span>`;
    } else {
      btn.textContent = '↗ Sync to Floppy';
    }
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
      // Remove any existing modal
      document.getElementById('pvf-overlay')?.remove();
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