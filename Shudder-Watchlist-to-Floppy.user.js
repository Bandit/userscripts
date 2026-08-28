// ==UserScript==
// @name         Shudder Watchlist to Floppy
// @namespace    https://github.com/Bandit/userscripts
// @version      1.0.0
// @description  Sync titles from Shudder My List to a custom Floppy list
// @author       Bandit
// @homepageURL  https://github.com/Bandit/userscripts/blob/main/Shudder-Watchlist-to-Floppy.user.js
// @supportURL   https://github.com/Bandit/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/Bandit/userscripts/main/Shudder-Watchlist-to-Floppy.user.js
// @downloadURL  https://raw.githubusercontent.com/Bandit/userscripts/main/Shudder-Watchlist-to-Floppy.user.js
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

  const STORAGE_PREFIX = 'swlf_';
  const REQUEST_TIMEOUT_MS = 20000;
  const CARD_SELECTOR = '[data-test-id="card-wrapper"][data-card-id]';
  const DEFAULT_LIST_NAME = 'Shudder Watchlist';
  let lastReport = null;
  let syncInProgress = false;
  let autoSyncTimer = null;
  let lastAutoSignature = '';
  let lastAutoAttemptAt = 0;

  const store = {
    get: (key, defaultValue = '') => GM_getValue(STORAGE_PREFIX + key, defaultValue),
    set: (key, value) => GM_setValue(STORAGE_PREFIX + key, value),
  };

  GM_addStyle(`
    .swlf-toast {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      max-width: min(430px, calc(100vw - 40px)); padding: 10px 13px;
      color: #fff; background: #242424; border-left: 4px solid #e21b23;
      box-shadow: 0 5px 18px rgba(0, 0, 0, .5); font: 14px/1.4 "Segoe UI", sans-serif;
    }
    .swlf-sync-button {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 32px; margin: 0 0 22px 16px; padding: 6px 12px;
      color: #fff; background: #c9151c; border: 1px solid #e21b23; border-radius: 3px;
      font: 700 14px/1.2 "Segoe UI", sans-serif; letter-spacing: 0; vertical-align: top; cursor: pointer;
    }
    .swlf-sync-button:hover { background: #e21b23; }
    .swlf-sync-button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .swlf-sync-button:disabled { cursor: wait; opacity: .65; }
    .swlf-backdrop {
      position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
      overflow: auto; padding: 18px; background: rgba(0, 0, 0, .72);
      font: 14px/1.4 "Segoe UI", sans-serif;
    }
    .swlf-dialog {
      box-sizing: border-box; width: min(590px, 100%); padding: 20px;
      color: #eee; background: #171717; border: 1px solid #555;
      box-shadow: 0 16px 48px rgba(0, 0, 0, .65);
    }
    .swlf-dialog h2 { margin: 0 0 8px; font-size: 20px; letter-spacing: 0; }
    .swlf-dialog p { margin: 0 0 14px; color: #bbb; }
    .swlf-dialog .swlf-error { color: #ff8585; }
    .swlf-dialog label { display: grid; gap: 5px; margin: 12px 0; font-weight: 650; }
    .swlf-dialog input, .swlf-dialog select, .swlf-dialog textarea {
      box-sizing: border-box; width: 100%; min-height: 38px; padding: 7px 9px;
      color: #171717; background: #fff; border: 1px solid #999; border-radius: 3px; font: inherit;
    }
    .swlf-dialog textarea {
      min-height: min(430px, 60vh); resize: vertical; color: #ddd; background: #0d0d0d;
      border-color: #555; font: 12px/1.45 Consolas, monospace; white-space: pre;
    }
    .swlf-choice { display: flex !important; grid-template-columns: none !important; align-items: center; gap: 8px !important; }
    .swlf-choice input { width: 18px; min-height: 18px; margin: 0; }
    .swlf-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    .swlf-dialog button {
      min-height: 38px; padding: 7px 14px; color: #eee; background: #333;
      border: 1px solid #666; border-radius: 3px; font: inherit; font-weight: 700; cursor: pointer;
    }
    .swlf-dialog button[data-primary="true"] { background: #c9151c; border-color: #e21b23; }
    .swlf-dialog button:disabled { cursor: wait; opacity: .65; }
    .swlf-review-dialog { width: min(960px, 100%); max-height: calc(100vh - 36px); overflow: auto; }
    .swlf-review-list { display: grid; gap: 20px; }
    .swlf-review-item { padding-top: 18px; border-top: 1px solid #444; }
    .swlf-review-item:first-child { padding-top: 0; border-top: 0; }
    .swlf-review-item h3 { margin: 0 0 10px; font-size: 17px; letter-spacing: 0; }
    .swlf-review-comparison { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 16px; }
    .swlf-review-source { color: #aaa; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .swlf-review-shudder img { display: block; width: 100%; aspect-ratio: 16 / 9; margin-top: 6px; object-fit: cover; background: #090909; }
    .swlf-candidates { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
    .swlf-candidate {
      display: grid !important; grid-template-rows: auto 1fr; gap: 7px !important; margin: 0 !important;
      padding: 8px; background: #242424; border: 2px solid transparent; cursor: pointer;
    }
    .swlf-candidate:has(input:checked) { border-color: #e21b23; background: #301719; }
    .swlf-candidate input { position: absolute; width: 1px; min-height: 1px; opacity: 0; }
    .swlf-candidate img { display: block; width: 100%; aspect-ratio: 2 / 3; object-fit: cover; background: #090909; }
    .swlf-candidate strong { display: block; color: #fff; font-size: 13px; line-height: 1.25; }
    .swlf-candidate small { display: block; margin-top: 3px; color: #aaa; font-weight: 400; }
    .swlf-no-candidates { margin: 6px 0 0; color: #ffb4b4; }
    @media (max-width: 620px) {
      .swlf-review-comparison { grid-template-columns: 1fr; }
      .swlf-review-shudder { max-width: 240px; }
    }
  `);

  GM_registerMenuCommand('Floppy Watchlist: Sync now', () => syncWatchlist());
  GM_registerMenuCommand('Floppy Watchlist: Settings', () => showSettings());
  GM_registerMenuCommand('Floppy Watchlist: Copy connection', () => copyConnection());
  GM_registerMenuCommand('Floppy Watchlist: Import connection', () => importConnection());
  GM_registerMenuCommand('Floppy Watchlist: Clear saved matches', () => clearMatchOverrides());
  GM_registerMenuCommand('Floppy Watchlist: Last report', () => showReport());

  const observer = new MutationObserver(schedulePageUpdate);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  ensureSyncButton();
  if (!isConfigured()) showSettings();
  else scheduleAutoSync();

  function normalizeTitle(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*\(\s*\d{4}\s*\)\s*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function isConfigured() {
    return Boolean(store.get('base_url') && store.get('api_token') && store.get('list_id'));
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

  function managedItemsKey(listId) {
    return `managed_items_${connectionFingerprint()}_${listId}`;
  }

  function matchOverridesKey() {
    return `match_overrides_${connectionFingerprint()}`;
  }

  function matchOverrideKey(card) {
    return `${card.typeHint || 'unknown'}|${card.normalizedTitle}`;
  }

  function getMatchOverrides() {
    const overrides = store.get(matchOverridesKey(), {});
    return overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  }

  function saveMatchOverride(card, match) {
    const overrides = getMatchOverrides();
    overrides[matchOverrideKey(card)] = match;
    store.set(matchOverridesKey(), overrides);
  }

  function clearMatchOverrides() {
    if (!confirm('Clear all saved Shudder-to-Floppy match choices for this connection?')) return;
    store.set(matchOverridesKey(), {});
    showToast('Saved match choices cleared. The next sync will ask again for ambiguous titles.');
  }

  function showToast(message, duration = 4500, existing = null) {
    const toast = existing?.isConnected
      ? existing
      : document.querySelector('.swlf-toast') || document.createElement('div');
    toast.className = 'swlf-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    if (!toast.isConnected) document.body.appendChild(toast);
    clearTimeout(toast.hideTimer);
    if (duration) toast.hideTimer = setTimeout(() => toast.remove(), duration);
    return toast;
  }

  function ensureSyncButton() {
    const existing = document.querySelector('.swlf-sync-button');
    if (!location.pathname.replace(/\/+$/, '').endsWith('/mylist')) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const title = [...document.querySelectorAll('.card-list > .card-list-title[role="heading"]')]
      .find(element => element.textContent.trim() === 'My List');
    if (!title) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swlf-sync-button';
    button.textContent = syncInProgress ? 'Syncing...' : 'Sync to Floppy';
    button.disabled = syncInProgress;
    button.addEventListener('click', () => syncWatchlist());
    title.insertAdjacentElement('afterend', button);
  }

  function updateSyncButton() {
    const button = document.querySelector('.swlf-sync-button');
    if (!button) return;
    button.disabled = syncInProgress;
    button.textContent = syncInProgress ? 'Syncing...' : 'Sync to Floppy';
  }

  function schedulePageUpdate() {
    ensureSyncButton();
    scheduleAutoSync();
  }

  function floppyRequest(method, path, body, acceptedStatuses = []) {
    return new Promise((resolve, reject) => {
      const baseUrl = store.get('base_url').trim().replace(/\/+$/, '');
      GM_xmlhttpRequest({
        method,
        url: `${baseUrl}${path}`,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-API-Key': store.get('api_token').trim(),
        },
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: REQUEST_TIMEOUT_MS,
        onload(response) {
          let data = null;
          try { data = response.responseText ? JSON.parse(response.responseText) : null; }
          catch {
            reject(new Error(`Floppy returned invalid JSON for ${path} (HTTP ${response.status}).`));
            return;
          }
          if ((response.status >= 200 && response.status < 300) || acceptedStatuses.includes(response.status)) {
            resolve({ data, status: response.status });
            return;
          }
          const error = new Error(data?.detail || `Floppy request failed for ${path} (HTTP ${response.status}).`);
          error.status = response.status;
          reject(error);
        },
        onerror: () => reject(new Error(`Could not connect to Floppy while requesting ${path}.`)),
        ontimeout: () => reject(new Error(`Floppy request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${path}.`)),
      });
    });
  }

  async function fetchAll(path, limit = 100) {
    const results = [];
    for (let offset = 0; ; offset += limit) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await floppyRequest('GET', `${path}${separator}limit=${limit}&offset=${offset}`);
      const page = response.data;
      if (!Array.isArray(page?.results)) throw new Error(`Floppy returned an unexpected response for ${path}.`);
      results.push(...page.results);
      const total = Number(page.pagination?.total);
      if (!Number.isFinite(total) || results.length >= total || page.results.length === 0) return results;
    }
  }

  function collectCards() {
    const byTitle = new Map();
    for (const wrapper of document.querySelectorAll(CARD_SELECTOR)) {
      const link = wrapper.querySelector(':scope > a[aria-label]');
      const title = link?.querySelector('.card-background img[alt]')?.alt || link?.getAttribute('aria-label');
      const normalizedTitle = normalizeTitle(title);
      if (!normalizedTitle || byTitle.has(normalizedTitle)) continue;
      const contentType = String(link?.dataset.contentType || '').toLowerCase();
      const typeHint = contentType === 'vod_series'
        ? 'tv'
        : contentType === 'vod' ? 'movie' : null;
      byTitle.set(normalizedTitle, {
        title: String(title).trim(),
        normalizedTitle,
        shudderId: wrapper.dataset.cardId,
        poster: link?.querySelector('.card-background img')?.src || '',
        typeHint,
      });
    }
    return [...byTitle.values()];
  }

  async function searchCatalog(title, mediaType) {
    const params = new URLSearchParams({ search: title, source: 'tmdb', limit: '20' });
    const response = await floppyRequest('GET', `/api/v1/search/${mediaType}/?${params}`);
    return Array.isArray(response.data?.results) ? response.data.results : [];
  }

  async function resolveCard(card) {
    const savedMatch = getMatchOverrides()[matchOverrideKey(card)];
    if (savedMatch?.media_type && savedMatch?.source && savedMatch?.media_id != null) {
      return { match: savedMatch };
    }
    const mediaTypes = card.typeHint ? [card.typeHint] : ['movie', 'tv'];
    const pages = await Promise.all(mediaTypes.map(mediaType => searchCatalog(card.title, mediaType)));
    const exactMatches = pages.flat().filter(result => normalizeTitle(result.title) === card.normalizedTitle);
    const uniqueMatches = new Map();
    for (const match of exactMatches) {
      const key = `${match.media_type}|${match.source}|${match.media_id}`;
      uniqueMatches.set(key, match);
    }
    if (uniqueMatches.size === 1) return { match: [...uniqueMatches.values()][0] };
    if (uniqueMatches.size === 0) return { reason: `No exact ${mediaTypes.join(' or ')} match in Floppy search.` };
    return {
      reason: `Ambiguous exact match (${uniqueMatches.size} results).`,
      candidates: [...uniqueMatches.values()],
    };
  }

  function mediaIdentity(media) {
    return `${media.media_type}|${media.source}|${media.media_id}`;
  }

  function mediaPath(media, listId) {
    const parts = [media.media_type, media.source, media.media_id, 'lists', listId]
      .map(value => encodeURIComponent(String(value)));
    return `/api/v1/media/${parts.join('/')}/`;
  }

  async function addToList(media, listId) {
    await floppyRequest('POST', `/api/v1/media/${encodeURIComponent(media.media_type)}/`, {
      source: media.source,
      media_id: media.media_id,
    }, [409]);
    const response = await floppyRequest('PUT', mediaPath(media, listId), {}, [409]);
    return response.status === 409 ? 'already-present' : 'added';
  }

  async function syncWatchlist({ automatic = false } = {}) {
    if (syncInProgress) return false;
    if (!isConfigured()) {
      showSettings('Complete the connection and list settings before syncing.');
      return false;
    }
    if (!location.pathname.replace(/\/+$/, '').endsWith('/mylist')) {
      showToast('Open Shudder My List before syncing.', 6000);
      return false;
    }

    const cards = collectCards();
    if (!cards.length) {
      if (!automatic) showToast('No My List cards are currently loaded.', 6000);
      return false;
    }

    const mode = store.get('sync_mode', 'additive');
    if (automatic && mode === 'mirror') return false;
    syncInProgress = true;
    updateSyncButton();
    const toast = showToast(`Syncing ${cards.length} Shudder title${cards.length === 1 ? '' : 's'}...`, 0);
    const report = {
      startedAt: new Date().toISOString(),
      mode,
      listId: String(store.get('list_id')),
      found: cards.length,
      added: [],
      alreadyPresent: [],
      removed: [],
      unresolved: [],
      failed: [],
    };
    const managedKey = managedItemsKey(report.listId);
    const storedManaged = store.get(managedKey, []);
    const priorManaged = Array.isArray(storedManaged) ? storedManaged : [];
    const managedByIdentity = new Map(priorManaged.map(item => [item.identity, item]));
    const currentTitles = new Set(cards.map(card => card.normalizedTitle));

    try {
      for (const card of cards) {
        try {
          const resolution = await resolveCard(card);
          if (!resolution.match) {
            report.unresolved.push({ ...card, reason: resolution.reason, candidates: resolution.candidates || [] });
            continue;
          }
          const identity = mediaIdentity(resolution.match);
          const result = await addToList(resolution.match, report.listId);
          const managed = {
            identity,
            normalizedTitle: card.normalizedTitle,
            title: card.title,
            media_type: resolution.match.media_type,
            source: resolution.match.source,
            media_id: resolution.match.media_id,
          };
          if (result === 'added' || managedByIdentity.has(identity)) {
            managedByIdentity.set(identity, managed);
          }
          report[result === 'added' ? 'added' : 'alreadyPresent'].push(card.title);
        } catch (error) {
          report.failed.push({ title: card.title, error: error.message || String(error) });
        }
      }

      if (mode === 'mirror') {
        for (const managed of priorManaged) {
          if (currentTitles.has(managed.normalizedTitle)) continue;
          try {
            const response = await floppyRequest('DELETE', mediaPath(managed, report.listId), undefined, [404]);
            if (response.status !== 404) report.removed.push(managed.title);
            managedByIdentity.delete(managed.identity);
          } catch (error) {
            report.failed.push({ title: managed.title, error: `Removal failed: ${error.message || String(error)}` });
          }
        }
      }

      store.set(managedKey, [...managedByIdentity.values()]);
      report.finishedAt = new Date().toISOString();
      lastReport = report;
      store.set('last_report', report);
      const problemCount = report.unresolved.length + report.failed.length;
      showToast(
        `Shudder sync complete: ${report.added.length} added, ${report.alreadyPresent.length} already present, ${report.removed.length} removed${problemCount ? `, ${problemCount} need review` : ''}.`,
        8000,
        toast,
      );
      if (report.unresolved.some(item => item.candidates.length)) showMatchReview(report);
      return true;
    } finally {
      syncInProgress = false;
      updateSyncButton();
    }
  }

  function scheduleAutoSync() {
    clearTimeout(autoSyncTimer);
    if (!store.get('auto_sync', false) || !isConfigured()) return;
    autoSyncTimer = setTimeout(async () => {
      const cards = collectCards();
      const signature = cards.map(card => card.normalizedTitle).sort().join('|');
      if (!signature || signature === lastAutoSignature) return;
      if (Date.now() - lastAutoAttemptAt < 60000) return;
      lastAutoAttemptAt = Date.now();
      if (await syncWatchlist({ automatic: true })) lastAutoSignature = signature;
    }, 1500);
  }

  function importConnection() {
    const value = prompt('Paste the connection copied from “Floppy: Copy connection settings”.');
    if (!value) return;
    try {
      const connection = JSON.parse(value);
      if (connection?.type !== 'floppy-connection' || connection?.version !== 1 || !/^https?:\/\//i.test(connection.baseUrl) || !connection.apiToken) {
        throw new Error('Unrecognized connection data.');
      }
      store.set('base_url', connection.baseUrl.trim().replace(/\/+$/, ''));
      store.set('api_token', connection.apiToken.trim());
      showSettings('', true);
    } catch (error) {
      showToast(error.message || 'Could not import the connection.', 6000);
    }
  }

  function copyConnection() {
    const baseUrl = store.get('base_url').trim().replace(/\/+$/, '');
    const apiToken = store.get('api_token').trim();
    if (!baseUrl || !apiToken) {
      showToast('Configure your Floppy connection before copying it.', 5000);
      return;
    }
    GM_setClipboard(JSON.stringify({ type: 'floppy-connection', version: 1, baseUrl, apiToken }), 'text');
    showToast('Floppy connection copied. Treat the clipboard contents like a password.', 5000);
  }

  function showReport() {
    const report = lastReport || store.get('last_report', null);
    if (report?.unresolved?.some(item => item.candidates?.some(candidate => candidate && typeof candidate === 'object'))) {
      showMatchReview(report);
      return;
    }
    showJsonReport(report);
  }

  function createReviewImage(url, alt) {
    const image = document.createElement('img');
    image.alt = alt;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    if (url) image.src = url;
    else image.hidden = true;
    image.addEventListener('error', () => { image.hidden = true; });
    return image;
  }

  function showMatchReview(report) {
    document.querySelector('.swlf-backdrop')?.remove();
    const reviewable = report.unresolved.filter(item => item.candidates?.some(candidate => candidate && typeof candidate === 'object'));
    if (!reviewable.length) {
      showJsonReport(report);
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'swlf-backdrop';
    backdrop.innerHTML = `
      <div class="swlf-dialog swlf-review-dialog" role="dialog" aria-modal="true" aria-labelledby="swlf-review-title">
        <h2 id="swlf-review-title">Review ambiguous matches</h2>
        <p>Compare Shudder's artwork with the Floppy candidates, then select the correct title in each row.</p>
        <p class="swlf-error" hidden></p>
        <div class="swlf-review-list"></div>
        <div class="swlf-actions">
          <button type="button" data-primary="true" data-apply>Apply selected</button>
          <button type="button" data-json>View JSON report</button>
          <button type="button" data-close>Close</button>
        </div>
      </div>`;

    const list = backdrop.querySelector('.swlf-review-list');
    reviewable.forEach((item, itemIndex) => {
      const section = document.createElement('section');
      section.className = 'swlf-review-item';
      const heading = document.createElement('h3');
      heading.textContent = item.title;
      section.appendChild(heading);

      const comparison = document.createElement('div');
      comparison.className = 'swlf-review-comparison';
      const shudder = document.createElement('div');
      shudder.className = 'swlf-review-shudder';
      const shudderLabel = document.createElement('div');
      shudderLabel.className = 'swlf-review-source';
      shudderLabel.textContent = 'Shudder';
      shudder.append(shudderLabel, createReviewImage(item.poster, `${item.title} on Shudder`));

      const candidates = document.createElement('div');
      candidates.className = 'swlf-candidates';
      item.candidates.forEach((candidate, candidateIndex) => {
        const label = document.createElement('label');
        label.className = 'swlf-candidate';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `swlf-match-${itemIndex}`;
        input.value = String(candidateIndex);
        input.matchItem = item;
        input.matchCandidate = candidate;
        const details = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = candidate.title || 'Untitled';
        const metadata = document.createElement('small');
        metadata.textContent = [candidate.year, candidate.media_type, candidate.source]
          .filter(value => value !== undefined && value !== null && value !== '')
          .join(' · ');
        details.append(title, metadata);
        label.append(input, createReviewImage(candidate.image, `${candidate.title || 'Candidate'} poster`), details);
        candidates.appendChild(label);
      });
      comparison.append(shudder, candidates);
      section.appendChild(comparison);
      list.appendChild(section);
    });

    const error = backdrop.querySelector('.swlf-error');
    backdrop.querySelector('[data-apply]').addEventListener('click', async event => {
      const selected = [...backdrop.querySelectorAll('.swlf-candidate input:checked')];
      if (!selected.length) {
        error.textContent = 'Select at least one match to apply.';
        error.hidden = false;
        return;
      }
      const applyButton = event.currentTarget;
      applyButton.disabled = true;
      applyButton.textContent = 'Applying...';
      error.hidden = true;
      const managedKey = managedItemsKey(report.listId);
      const storedManaged = store.get(managedKey, []);
      const managedByIdentity = new Map(
        (Array.isArray(storedManaged) ? storedManaged : []).map(item => [item.identity, item]),
      );
      const appliedTitles = new Set();

      for (const input of selected) {
        const item = input.matchItem;
        const candidate = input.matchCandidate;
        try {
          const result = await addToList(candidate, report.listId);
          saveMatchOverride(item, candidate);
          const identity = mediaIdentity(candidate);
          if (result === 'added' || managedByIdentity.has(identity)) {
            managedByIdentity.set(identity, {
              identity,
              normalizedTitle: item.normalizedTitle,
              title: item.title,
              media_type: candidate.media_type,
              source: candidate.source,
              media_id: candidate.media_id,
            });
          }
          report[result === 'added' ? 'added' : 'alreadyPresent'].push(item.title);
          appliedTitles.add(item.normalizedTitle);
        } catch (applyError) {
          report.failed.push({ title: item.title, error: applyError.message || String(applyError) });
        }
      }

      store.set(managedKey, [...managedByIdentity.values()]);
      report.unresolved = report.unresolved.filter(item => !appliedTitles.has(item.normalizedTitle));
      report.finishedAt = new Date().toISOString();
      lastReport = report;
      store.set('last_report', report);
      backdrop.remove();
      showToast(`Applied ${appliedTitles.size} reviewed match${appliedTitles.size === 1 ? '' : 'es'} to Floppy.`, 6000);
    });
    backdrop.querySelector('[data-json]').addEventListener('click', () => {
      backdrop.remove();
      showJsonReport(report);
    });
    backdrop.querySelector('[data-close]').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', event => { if (event.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
  }

  function showJsonReport(report) {
    document.querySelector('.swlf-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'swlf-backdrop';
    backdrop.innerHTML = `
      <div class="swlf-dialog" role="dialog" aria-modal="true" aria-labelledby="swlf-report-title">
        <h2 id="swlf-report-title">Shudder Watchlist Sync</h2>
        <p>Ambiguous and missing matches are skipped. The report contains no API token.</p>
        <textarea readonly aria-label="Sync report"></textarea>
        <div class="swlf-actions"><button type="button" data-primary="true" data-close>Close</button></div>
      </div>`;
    backdrop.querySelector('textarea').value = report ? JSON.stringify(report, null, 2) : 'No sync has run yet.';
    backdrop.querySelector('[data-close]').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', event => { if (event.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
  }

  async function loadListOptions(select, preferredId = '') {
    const lists = await fetchAll('/api/v1/lists/');
    select.replaceChildren();
    for (const list of lists.filter(item => item.can_edit !== false)) {
      const id = list.list_id ?? list.id;
      if (id === undefined || id === null) continue;
      const option = document.createElement('option');
      option.value = String(id);
      option.textContent = list.name || `List ${id}`;
      option.selected = String(id) === String(preferredId);
      select.appendChild(option);
    }
    return lists;
  }

  function showSettings(errorMessage = '', loadImmediately = false) {
    document.querySelector('.swlf-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'swlf-backdrop';
    backdrop.innerHTML = `
      <form class="swlf-dialog">
        <h2>Floppy Watchlist Settings</h2>
        <p>Adding a catalog result tracks it in Floppy with Planning status before placing it in the list.</p>
        <p class="swlf-error" hidden></p>
        <label>Floppy URL<input name="baseUrl" type="url" placeholder="https://floppy.example.com" required></label>
        <label>API token<input name="apiToken" type="password" placeholder="Your Floppy API token" required></label>
        <div class="swlf-actions">
          <button type="button" data-load data-primary="true">Test &amp; Load Lists</button>
          <button type="button" data-import>Import Connection</button>
        </div>
        <label>List setup
          <select name="listSetup">
            <option value="existing">Use an existing list</option>
            <option value="create">Create a new list</option>
          </select>
        </label>
        <label data-existing>Floppy list<select name="listId" disabled><option>Load lists first</option></select></label>
        <label data-create hidden>New list name<input name="listName" value="${DEFAULT_LIST_NAME}"></label>
        <label>Sync behavior
          <select name="syncMode">
            <option value="additive">Additive (never remove)</option>
            <option value="mirror">Mirror script-managed items</option>
          </select>
        </label>
        <label class="swlf-choice"><input name="autoSync" type="checkbox">Sync automatically on My List (additive mode only)</label>
        <div class="swlf-actions">
          <button type="submit" data-primary="true">Save</button>
          <button type="button" data-cancel>Cancel</button>
        </div>
      </form>`;

    const form = backdrop.querySelector('form');
    const error = backdrop.querySelector('.swlf-error');
    const loadButton = backdrop.querySelector('[data-load]');
    let loadedConnection = '';
    const setError = message => {
      error.textContent = message;
      error.hidden = !message;
    };
    form.elements.baseUrl.value = store.get('base_url');
    form.elements.apiToken.value = store.get('api_token');
    form.elements.syncMode.value = store.get('sync_mode', 'additive');
    form.elements.autoSync.checked = store.get('auto_sync', false);
    if (errorMessage) setError(errorMessage);

    const connectionValue = () => `${form.elements.baseUrl.value.trim().replace(/\/+$/, '')}\0${form.elements.apiToken.value.trim()}`;
    for (const input of [form.elements.baseUrl, form.elements.apiToken]) {
      input.addEventListener('input', () => {
        if (loadedConnection && loadedConnection !== connectionValue()) {
          loadedConnection = '';
          form.elements.listId.disabled = true;
          form.elements.listId.replaceChildren(new Option('Reload lists for this connection'));
          loadButton.textContent = 'Test & Load Lists';
        }
      });
    }

    form.elements.listSetup.addEventListener('change', () => {
      const creating = form.elements.listSetup.value === 'create';
      backdrop.querySelector('[data-existing]').hidden = creating;
      backdrop.querySelector('[data-create]').hidden = !creating;
    });

    const testAndLoad = async () => {
      const baseUrl = form.elements.baseUrl.value.trim().replace(/\/+$/, '');
      const apiToken = form.elements.apiToken.value.trim();
      if (!/^https?:\/\//i.test(baseUrl) || !apiToken) {
        setError('Enter an HTTP(S) Floppy URL and API token.');
        return;
      }
      store.set('base_url', baseUrl);
      store.set('api_token', apiToken);
      loadButton.disabled = true;
      loadButton.textContent = 'Loading...';
      setError('');
      try {
        await floppyRequest('GET', '/api/v1/user/preferences/');
        const lists = await loadListOptions(form.elements.listId, store.get('list_id'));
        loadedConnection = connectionValue();
        form.elements.listId.disabled = false;
        loadButton.textContent = 'Lists Loaded';
        if (!lists.length) form.elements.listSetup.value = 'create';
        form.elements.listSetup.dispatchEvent(new Event('change'));
      } catch (requestError) {
        setError(requestError.message || 'Could not connect to Floppy.');
        loadButton.textContent = 'Test & Load Lists';
      } finally {
        loadButton.disabled = false;
      }
    };

    loadButton.addEventListener('click', testAndLoad);
    backdrop.querySelector('[data-import]').addEventListener('click', () => {
      backdrop.remove();
      importConnection();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      setError('');
      try {
        const baseUrl = form.elements.baseUrl.value.trim().replace(/\/+$/, '');
        const apiToken = form.elements.apiToken.value.trim();
        if (!/^https?:\/\//i.test(baseUrl) || !apiToken) {
          throw new Error('Enter an HTTP(S) Floppy URL and API token.');
        }
        store.set('base_url', baseUrl);
        store.set('api_token', apiToken);
        let listId = form.elements.listId.value;
        if (form.elements.listSetup.value === 'create') {
          const name = form.elements.listName.value.trim();
          if (!name) throw new Error('Enter a name for the new Floppy list.');
          const response = await floppyRequest('POST', '/api/v1/lists/', {
            name,
            description: 'Synced from Shudder My List.',
          });
          listId = response.data?.list_id ?? response.data?.id;
        }
        if (form.elements.listSetup.value === 'existing' && (loadedConnection !== connectionValue() || form.elements.listId.disabled)) {
          throw new Error('Test this connection and load its lists before saving.');
        }
        if (!listId) {
          throw new Error('Load and select an existing list, or create a new one.');
        }
        store.set('list_id', String(listId));
        store.set('sync_mode', form.elements.syncMode.value);
        store.set('auto_sync', form.elements.autoSync.checked);
        backdrop.remove();
        showToast('Floppy watchlist settings saved.');
        scheduleAutoSync();
      } catch (saveError) {
        setError(saveError.message || 'Could not save the settings.');
        submit.disabled = false;
      }
    });
    backdrop.querySelector('[data-cancel]').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', event => { if (event.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
    if (loadImmediately) testAndLoad();
  }
})();