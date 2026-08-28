// ==UserScript==
// @name         Shudder Watched on Floppy
// @namespace    https://github.com/Bandit/userscripts
// @version      1.0.0
// @description  Show a watched indicator on Shudder cards using your Floppy history
// @author       Bandit
// @homepageURL  https://github.com/Bandit/userscripts/blob/main/Shudder-Watched-on-Floppy.user.js
// @supportURL   https://github.com/Bandit/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/Bandit/userscripts/main/Shudder-Watched-on-Floppy.user.js
// @downloadURL  https://raw.githubusercontent.com/Bandit/userscripts/main/Shudder-Watched-on-Floppy.user.js
// @match        https://watch.shudder.com/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

// Optional: replace @connect * above with the hostname from your Floppy instance URL.

(function () {
  'use strict';

  const STORAGE_PREFIX = 'swf_';
  const HISTORY_PAGE_SIZE = 100;
  const HISTORY_CACHE_VERSION = 1;
  const HISTORY_CACHE_KEY = 'history_cache_v1';
  const INCREMENTAL_OVERLAP_MS = 24 * 60 * 60 * 1000;
  const MIN_HISTORY_PAGE_SIZE = 10;
  const HISTORY_REQUEST_ATTEMPTS = 2;
  const REQUEST_TIMEOUT_MS = 20000;
  const MAX_DEBUG_ENTRIES = 200;
  const GRID_CARD_SELECTOR = '[role="button"][aria-label] [data-testid^="card-container-"]';
  const HOME_CARD_SELECTOR = '[data-test-id="card-wrapper"] > a[aria-label] > .card-background';
  const watchedTitles = new Map();
  const watchedTimeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  let scanTimer = null;
  let loadGeneration = 0;
  let latestWatchedTimestamp = null;
  const debugEntries = [];

  const store = {
    get: (key, defaultValue = '') => GM_getValue(STORAGE_PREFIX + key, defaultValue),
    set: (key, value) => GM_setValue(STORAGE_PREFIX + key, value),
  };

  GM_addStyle(`
    .swf-watched-card { position: relative !important; }
    .swf-watched-badge {
      position: absolute;
      right: 8px;
      bottom: 8px;
      z-index: 20;
      display: flex;
      box-sizing: border-box;
      align-items: center;
      place-items: center;
      justify-content: center;
      width: 32px;
      height: 24px;
      padding: 4px 8px;
      color: oklch(0.765 0.177 163.223);
      background: rgba(17, 24, 39, .9);
      border-radius: 6px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, .35);
      cursor: help;
    }
    .swf-watched-badge svg { width: 16px; height: 16px; fill: none; stroke: currentColor; }
    .swf-watched-badge::after {
      content: attr(data-tooltip);
      position: absolute;
      right: 0;
      bottom: calc(100% + 7px);
      width: max-content;
      max-width: min(280px, calc(100vw - 32px));
      padding: 6px 8px;
      color: #f3f4f6;
      background: rgba(17, 24, 39, .96);
      border: 1px solid rgba(255, 255, 255, .16);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, .45);
      font: 12px/1.35 "Segoe UI", sans-serif;
      letter-spacing: 0;
      white-space: nowrap;
      opacity: 0;
      visibility: hidden;
      transform: translateY(3px);
      transition: opacity .12s ease, transform .12s ease, visibility .12s ease;
      pointer-events: none;
    }
    .swf-watched-badge:hover::after {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }
    .swf-toast {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483646;
      max-width: min(390px, calc(100vw - 40px));
      padding: 10px 13px;
      color: #fff;
      background: #242424;
      border-left: 4px solid #e21b23;
      box-shadow: 0 5px 18px rgba(0, 0, 0, .5);
      font: 14px/1.4 "Segoe UI", sans-serif;
    }
    .swf-settings-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      padding: 18px;
      background: rgba(0, 0, 0, .72);
      font: 14px/1.4 "Segoe UI", sans-serif;
    }
    .swf-settings {
      width: min(520px, 100%);
      padding: 20px;
      color: #eee;
      background: #171717;
      border: 1px solid #555;
      box-shadow: 0 16px 48px rgba(0, 0, 0, .65);
    }
    .swf-settings h2 { margin: 0 0 8px; font-size: 20px; letter-spacing: 0; }
    .swf-settings p { margin: 0 0 15px; color: #bbb; }
    .swf-settings .swf-error { color: #ff8585; }
    .swf-settings label { display: grid; gap: 5px; margin: 12px 0; font-weight: 650; }
    .swf-settings input {
      box-sizing: border-box;
      width: 100%;
      min-height: 38px;
      padding: 7px 9px;
      color: #171717;
      background: #fff;
      border: 1px solid #999;
      border-radius: 3px;
      font: inherit;
    }
    .swf-settings textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: min(430px, 60vh);
      padding: 9px;
      resize: vertical;
      color: #ddd;
      background: #0d0d0d;
      border: 1px solid #555;
      border-radius: 3px;
      font: 12px/1.45 Consolas, monospace;
      white-space: pre;
    }
    .swf-settings-actions { display: flex; gap: 8px; margin-top: 18px; }
    .swf-settings button {
      min-height: 38px;
      padding: 7px 14px;
      color: #eee;
      background: #333;
      border: 1px solid #666;
      border-radius: 3px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .swf-settings button[data-primary="true"] { background: #c9151c; border-color: #e21b23; }
    .swf-settings button:disabled { cursor: wait; opacity: .65; }
  `);

  GM_registerMenuCommand('Floppy: Refresh watched indicators', () => loadHistory());
  GM_registerMenuCommand('Floppy: Rebuild watched cache', () => loadHistory({ forceFull: true }));
  GM_registerMenuCommand('Floppy: Settings', () => showSettings());
  GM_registerMenuCommand('Floppy: Debug log', () => showDebugLog());

  debugLog('Script started', {
    online: navigator.onLine,
    page: location.href,
    configured: Boolean(store.get('base_url') && store.get('api_token')),
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (store.get('base_url') && store.get('api_token')) {
    restoreHistoryCache();
    loadHistory();
  } else {
    showSettings();
  }

  function first(object, paths) {
    for (const path of paths) {
      let value = object;
      for (const key of path.split('.')) {
        value = value && typeof value === 'object' ? value[key] : undefined;
      }
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function debugLog(message, details = {}) {
    const entry = {
      time: new Date().toISOString(),
      message,
      ...details,
    };
    debugEntries.push(entry);
    if (debugEntries.length > MAX_DEBUG_ENTRIES) debugEntries.shift();
    console.debug('[SWF]', message, details);
  }

  function debugReport() {
    const baseUrl = store.get('base_url').trim().replace(/\/+$/, '');
    return [
      'Shudder Watched on Floppy v1.0.0',
      `Generated: ${new Date().toISOString()}`,
      `Page: ${location.href}`,
      `Floppy URL: ${baseUrl || '(not configured)'}`,
      `Browser online: ${navigator.onLine}`,
      `Request timeout: ${REQUEST_TIMEOUT_MS} ms`,
      '',
      ...debugEntries.map(entry => JSON.stringify(entry)),
    ].join('\n');
  }

  function normalizeTitle(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*\(\s*\d{4}\s*\)\s*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function connectionFingerprint() {
    const value = `${store.get('base_url').trim().replace(/\/+$/, '')}\0${store.get('api_token').trim()}`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function restoreHistoryCache() {
    const cache = store.get(HISTORY_CACHE_KEY, null);
    if (!cache || cache.version !== HISTORY_CACHE_VERSION || cache.connection !== connectionFingerprint() || !Array.isArray(cache.titles)) {
      debugLog('No compatible history cache found');
      return false;
    }

    watchedTitles.clear();
    for (const entry of cache.titles) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const timestamp = Number.isFinite(entry[1]) ? entry[1] : null;
      watchedTitles.set(entry[0], timestamp);
    }
    latestWatchedTimestamp = Number.isFinite(cache.latestWatchedTimestamp) ? cache.latestWatchedTimestamp : null;
    debugLog('History cache restored', {
      titles: watchedTitles.size,
      latestWatchedTimestamp,
      savedAt: cache.savedAt || null,
    });
    scanCards();
    return true;
  }

  function saveHistoryCache() {
    store.set(HISTORY_CACHE_KEY, {
      version: HISTORY_CACHE_VERSION,
      connection: connectionFingerprint(),
      savedAt: new Date().toISOString(),
      latestWatchedTimestamp,
      titles: [...watchedTitles.entries()],
    });
    debugLog('History cache saved', { titles: watchedTitles.size, latestWatchedTimestamp });
  }

  function incrementalStartDate() {
    if (!Number.isFinite(latestWatchedTimestamp)) return null;
    return new Date(latestWatchedTimestamp - INCREMENTAL_OVERLAP_MS).toISOString().slice(0, 10);
  }

  function isHistoryEntry(object) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
    const hasId = first(object, ['history_id', 'consumption_id', 'play_id', 'instance_id', 'entry_key', 'id']) !== null;
    const hasMedia = first(object, ['media_type', 'type', 'item.media_type', 'media.media_type', 'title', 'item.title', 'media.title']) !== null;
    const hasEvent = first(object, ['played_at', 'played_at_local', 'watched_at', 'end_date', 'completed_at', 'progressed_at', 'created', 'date']) !== null;
    return hasId && hasMedia && hasEvent;
  }

  function collectWatchedTitles(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach(item => collectWatchedTitles(item, seen));
      return;
    }

    if (isHistoryEntry(value)) {
      const mediaType = String(first(value, ['media_type', 'type', 'item.media_type', 'media.media_type']) || '').toLowerCase();
      const title = mediaType === 'episode'
        ? first(value, ['series_title', 'show_title', 'item.series_title', 'media.series_title', 'item.show_title', 'media.show_title'])
        : first(value, ['item.title', 'media.title', 'title', 'series_title', 'show_title']);
      const normalized = normalizeTitle(title);
      const watchedAtValue = first(value, ['played_at', 'played_at_local', 'watched_at', 'end_date', 'completed_at', 'progressed_at', 'created', 'date']);
      const watchedAt = watchedAtValue ? new Date(watchedAtValue).getTime() : null;
      const timestamp = Number.isFinite(watchedAt) ? watchedAt : null;
      const existingTimestamp = watchedTitles.get(normalized);
      if (normalized && (!watchedTitles.has(normalized) || (timestamp !== null && (existingTimestamp === null || timestamp > existingTimestamp)))) {
        watchedTitles.set(normalized, timestamp);
      }
      if (timestamp !== null && (latestWatchedTimestamp === null || timestamp > latestWatchedTimestamp)) {
        latestWatchedTimestamp = timestamp;
      }
      return;
    }

    Object.values(value).forEach(child => collectWatchedTitles(child, seen));
  }

  function floppyGet(path) {
    return new Promise((resolve, reject) => {
      const baseUrl = store.get('base_url').trim().replace(/\/+$/, '');
      const startedAt = performance.now();
      const requestUrl = `${baseUrl}${path}`;
      debugLog('Request started', { method: 'GET', path, url: requestUrl, timeoutMs: REQUEST_TIMEOUT_MS });

      function elapsedMs() {
        return Math.round(performance.now() - startedAt);
      }

      GM_xmlhttpRequest({
        method: 'GET',
        url: requestUrl,
        headers: {
          Accept: 'application/json',
          'X-API-Key': store.get('api_token').trim(),
        },
        timeout: REQUEST_TIMEOUT_MS,
        onload(response) {
          debugLog('Request completed', {
            method: 'GET',
            path,
            status: response.status,
            statusText: response.statusText || '',
            elapsedMs: elapsedMs(),
            responseBytes: response.responseText?.length || 0,
            finalUrl: response.finalUrl || requestUrl,
          });
          let data;
          try { data = response.responseText ? JSON.parse(response.responseText) : null; }
          catch {
            debugLog('Response JSON parsing failed', { path, status: response.status, elapsedMs: elapsedMs() });
            reject(new Error(`Floppy returned invalid JSON for ${path} (HTTP ${response.status}).`));
            return;
          }
          if (response.status >= 200 && response.status < 300) resolve(data);
          else reject(new Error(data?.detail || `Floppy request failed for ${path} (HTTP ${response.status}).`));
        },
        onerror(response) {
          debugLog('Request network error', {
            method: 'GET', path, status: response?.status || 0, elapsedMs: elapsedMs(), online: navigator.onLine,
          });
          reject(new Error(`Could not connect to Floppy while requesting ${path}.`));
        },
        ontimeout(response) {
          debugLog('Request timed out', {
            method: 'GET', path, status: response?.status || 0, elapsedMs: elapsedMs(), timeoutMs: REQUEST_TIMEOUT_MS, online: navigator.onLine,
          });
          const error = new Error(`Floppy request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${path}. Open “Floppy: Debug log” in the userscript menu for details.`);
          error.code = 'SWF_TIMEOUT';
          reject(error);
        },
      });
    });
  }

  const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

  function historyPath(offset, limit, startDate = null) {
    const params = new URLSearchParams({
      types: 'episodes,movies',
      limit: String(limit),
      offset: String(offset),
    });
    if (startDate) {
      params.set('flat', '1');
      params.set('start_date', startDate);
    }
    return `/api/v1/history/?${params}`;
  }

  async function fetchHistoryPage(offset, limit, startDate, attempt = 1) {
    const path = historyPath(offset, limit, startDate);
    try {
      const page = await floppyGet(path);
      if (!Array.isArray(page?.results)) throw new Error('Floppy returned an unexpected history page.');
      return page.results;
    } catch (error) {
      if (error.code !== 'SWF_TIMEOUT') throw error;

      if (limit <= MIN_HISTORY_PAGE_SIZE && attempt < HISTORY_REQUEST_ATTEMPTS) {
        debugLog('Retrying timed-out history page', { offset, limit, nextAttempt: attempt + 1 });
        await wait(500);
        return fetchHistoryPage(offset, limit, startDate, attempt + 1);
      }

      if (limit <= MIN_HISTORY_PAGE_SIZE) throw error;
      const firstLimit = Math.floor(limit / 2);
      const secondLimit = limit - firstLimit;
      debugLog('Splitting timed-out history page', {
        offset, limit, firstOffset: offset, firstLimit, secondOffset: offset + firstLimit, secondLimit,
      });
      const firstResults = await fetchHistoryPage(offset, firstLimit, startDate);
      const secondResults = await fetchHistoryPage(offset + firstLimit, secondLimit, startDate);
      return [...firstResults, ...secondResults];
    }
  }

  async function fetchHistory(startDate = null) {
    debugLog('History load started', { pageSize: HISTORY_PAGE_SIZE, mode: startDate ? 'incremental' : 'full', startDate });
    const firstPage = await floppyGet(historyPath(0, HISTORY_PAGE_SIZE, startDate));
    if (!Array.isArray(firstPage?.results) || !firstPage.pagination) {
      throw new Error('Floppy returned an unexpected history response.');
    }

    const total = Number(firstPage.pagination.total);
    if (!Number.isFinite(total) || total < 0) throw new Error('Floppy returned an invalid history total.');
    debugLog('History first page received', { total, results: firstPage.results.length });
    const pages = [firstPage.results];
    for (let offset = HISTORY_PAGE_SIZE; offset < total; offset += HISTORY_PAGE_SIZE) {
      const limit = Math.min(HISTORY_PAGE_SIZE, total - offset);
      const results = await fetchHistoryPage(offset, limit, startDate);
      pages.push(results);
      debugLog('History page received', { offset, requested: limit, results: results.length, loaded: pages.flat().length, total });
    }
    const history = pages.flat();
    debugLog('History load completed', { results: history.length, pages: pages.length });
    return history;
  }

  async function loadHistory({ quiet = false, forceFull = false } = {}) {
    if (!store.get('base_url') || !store.get('api_token')) {
      showSettings();
      return;
    }

    const generation = ++loadGeneration;
    const startDate = forceFull ? null : incrementalStartDate();
    const mode = startDate ? 'incremental' : 'full';
    debugLog('Indicator refresh started', { generation, mode, startDate });
    const toast = quiet ? null : showToast(startDate ? 'Checking Floppy for new watches...' : 'Loading watched titles from Floppy...', 0);
    try {
      const history = await fetchHistory(startDate);
      if (generation !== loadGeneration) return;
      if (!startDate) {
        watchedTitles.clear();
        latestWatchedTimestamp = null;
      }
      collectWatchedTitles(history);
      saveHistoryCache();
      scanCards();
      debugLog('Indicator refresh completed', { generation, mode, historyEntries: history.length, watchedTitles: watchedTitles.size });
      showToast(`${startDate ? 'Updated' : 'Loaded'} ${watchedTitles.size} watched titles from Floppy.`, 3500, toast);
    } catch (error) {
      if (generation !== loadGeneration) return;
      debugLog('Indicator refresh failed', { generation, error: error?.message || String(error) });
      showToast(error.message || 'Could not load Floppy history.', 7000, toast);
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanCards, 120);
  }

  function watchedTooltip(timestamp) {
    return timestamp === null
      ? 'Watched on Floppy'
      : `Watched ${watchedTimeFormatter.format(new Date(timestamp))}`;
  }

  function scanCards() {
    const cards = [
      ...[...document.querySelectorAll(GRID_CARD_SELECTOR)]
        .map(container => container.closest('[role="button"][aria-label]')),
      ...[...document.querySelectorAll(HOME_CARD_SELECTOR)]
        .map(background => background.closest('a[aria-label]')),
    ].filter(Boolean);

    for (const card of new Set(cards)) {
      const homeTitle = card.querySelector(':scope > .card-background img[alt]')?.alt;
      const title = homeTitle || card.getAttribute('aria-label');
      const normalizedTitle = normalizeTitle(title);
      const isWatched = watchedTitles.has(normalizedTitle);
      card.classList.toggle('swf-watched-card', isWatched);
      let badge = card.querySelector(':scope > .swf-watched-badge');
      if (isWatched && !badge) {
        badge = document.createElement('span');
        badge.className = 'swf-watched-badge';
        badge.innerHTML = `
          <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21.801 10A10 10 0 1 1 17 3.335"></path>
            <path d="m9 11 3 3L22 4"></path>
          </svg>`;
        card.appendChild(badge);
      }
      if (isWatched) {
        const tooltip = watchedTooltip(watchedTitles.get(normalizedTitle));
        badge.dataset.tooltip = tooltip;
        badge.setAttribute('aria-label', tooltip);
      } else if (!isWatched) {
        badge?.remove();
      }
    }
  }

  function showToast(message, duration = 3500, existing = null) {
    const toast = existing?.isConnected ? existing : document.createElement('div');
    toast.className = 'swf-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    if (!toast.isConnected) document.body.appendChild(toast);
    clearTimeout(toast.hideTimer);
    if (duration) toast.hideTimer = setTimeout(() => toast.remove(), duration);
    return toast;
  }

  function showDebugLog() {
    document.querySelector('.swf-settings-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'swf-settings-backdrop';
    backdrop.innerHTML = `
      <div class="swf-settings" role="dialog" aria-modal="true" aria-labelledby="swf-debug-title">
        <h2 id="swf-debug-title">Floppy Debug Log</h2>
        <p>Request metadata only. API keys and response bodies are not included.</p>
        <textarea readonly aria-label="Debug log"></textarea>
        <div class="swf-settings-actions">
          <button type="button" data-primary="true" data-copy>Copy log</button>
          <button type="button" data-clear>Clear</button>
          <button type="button" data-close>Close</button>
        </div>
      </div>`;

    const textarea = backdrop.querySelector('textarea');
    textarea.value = debugReport();
    backdrop.querySelector('[data-copy]').addEventListener('click', event => {
      GM_setClipboard(textarea.value, 'text');
      event.currentTarget.textContent = 'Copied';
    });
    backdrop.querySelector('[data-clear]').addEventListener('click', () => {
      debugEntries.length = 0;
      debugLog('Debug log cleared');
      textarea.value = debugReport();
    });
    backdrop.querySelector('[data-close]').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
  }

  function showSettings(errorMessage = '') {
    document.querySelector('.swf-settings-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'swf-settings-backdrop';
    backdrop.innerHTML = `
      <form class="swf-settings">
        <h2>Floppy Settings</h2>
        <p>Copy your API token from Floppy Settings &gt; Integrations.</p>
        <p class="swf-error" hidden></p>
        <label>Floppy URL<input name="baseUrl" type="url" placeholder="https://floppy.example.com" required></label>
        <label>API token<input name="apiToken" type="password" placeholder="Your Floppy API token" required></label>
        <div class="swf-settings-actions">
          <button type="submit" data-primary="true">Test &amp; Save</button>
          <button type="button" data-cancel>Cancel</button>
        </div>
      </form>`;

    const form = backdrop.querySelector('form');
    const error = backdrop.querySelector('.swf-error');
    form.elements.baseUrl.value = store.get('base_url');
    form.elements.apiToken.value = store.get('api_token');
    if (errorMessage) {
      error.textContent = errorMessage;
      error.hidden = false;
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const baseUrl = form.elements.baseUrl.value.trim().replace(/\/+$/, '');
      const apiToken = form.elements.apiToken.value.trim();
      if (!/^https?:\/\//i.test(baseUrl) || !apiToken) {
        error.textContent = 'Enter an HTTP(S) Floppy URL and API token.';
        error.hidden = false;
        return;
      }

      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Testing...';
      store.set('base_url', baseUrl);
      store.set('api_token', apiToken);
      try {
        await floppyGet('/api/v1/user/preferences/');
        backdrop.remove();
        loadHistory({ forceFull: true });
      } catch (requestError) {
        error.textContent = requestError.message || 'Could not connect to Floppy.';
        error.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Test & Save';
      }
    });

    backdrop.querySelector('[data-cancel]').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
  }
})();