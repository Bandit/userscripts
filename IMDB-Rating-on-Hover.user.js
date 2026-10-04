// ==UserScript==
// @name         IMDb Rating on Hover
// @namespace    https://github.com/Bandit/userscripts
// @version      1.0.0
// @description  Show IMDb ratings and vote counts when hovering title links.
// @author       Bandit
// @homepageURL  https://github.com/Bandit/userscripts/blob/main/IMDB-Rating-on-Hover.user.js
// @supportURL   https://github.com/Bandit/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/Bandit/userscripts/main/IMDB-Rating-on-Hover.user.js
// @downloadURL  https://raw.githubusercontent.com/Bandit/userscripts/main/IMDB-Rating-on-Hover.user.js
// @match        *://*/*
// @exclude      *://imdb.com/*
// @exclude      *://*.imdb.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'irho_api_url';
  const LOGO_URL = 'https://projectile.nz/imdb-logo-2016.svg';
  const REQUEST_TIMEOUT_MS = 10000;
  const ratingRequests = new Map();

  function isIMDbHost(hostname) {
    const host = hostname.toLowerCase();
    return host === 'imdb.com' || host.endsWith('.imdb.com');
  }

  if (isIMDbHost(location.hostname)) return;

  GM_addStyle(`
    .irho-popup {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      box-sizing: border-box;
      align-items: center;
      gap: 10px;
      min-width: 150px;
      max-width: calc(100vw - 24px);
      padding: 8px 10px;
      color: #f4f4f4;
      background: rgba(28, 28, 28, .97);
      border: 1px solid rgba(255, 255, 255, .16);
      border-radius: 6px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .4);
      font: 13px/1.25 "Segoe UI", sans-serif;
      letter-spacing: 0;
      pointer-events: none;
    }
    .irho-popup[hidden] { display: none !important; }
    .irho-logo {
      display: block;
      flex: 0 0 46px;
      width: 46px;
      height: 25px;
      object-fit: contain;
    }
    .irho-logo-fallback {
      display: grid;
      flex: 0 0 46px;
      width: 46px;
      height: 25px;
      place-items: center;
      color: #111;
      background: #f5c518;
      border-radius: 3px;
      font: 700 12px/1 "Segoe UI", sans-serif;
    }
    .irho-divider {
      width: 1px;
      height: 26px;
      background: rgba(255, 255, 255, .16);
    }
    .irho-details { display: grid; gap: 3px; min-width: 0; }
    .irho-rating {
      color: #f5c518;
      font-size: 17px;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .irho-votes { color: #c7c7c7; font-size: 11px; white-space: nowrap; }
    .irho-popup[data-state="error"] .irho-rating {
      color: #ffb4ab;
      font-size: 12px;
      line-height: 1.2;
    }
    .irho-settings-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      padding: 18px;
      background: rgba(0, 0, 0, .72);
      font: 14px/1.45 "Segoe UI", sans-serif;
    }
    .irho-settings {
      box-sizing: border-box;
      width: min(500px, 100%);
      padding: 20px;
      color: #f1f1f1;
      background: #202020;
      border: 1px solid #555;
      border-radius: 6px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, .65);
    }
    .irho-settings h2 { margin: 0 0 8px; color: #fff !important; font-size: 20px; letter-spacing: 0; }
    .irho-settings p { margin: 0 0 14px; color: #c5c5c5; }
    .irho-settings label { display: grid; gap: 6px; margin: 12px 0; color: #fff !important; font-weight: 650; }
    .irho-settings .irho-api-note { margin: -4px 0 0; color: #c5c5c5 !important; font-size: 12px; }
    .irho-settings .irho-api-note a { color: #f5c518 !important; text-decoration: underline; text-underline-offset: 2px; }
    .irho-settings input {
      box-sizing: border-box;
      width: 100%;
      min-height: 39px;
      padding: 8px 9px;
      color: #171717;
      background: #fff;
      border: 1px solid #999;
      border-radius: 3px;
      font: inherit;
    }
    .irho-settings .irho-error { color: #ff9b8c; }
    .irho-settings-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .irho-settings button {
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
    .irho-settings button[data-primary="true"] {
      color: #171717;
      background: #f5c518;
      border-color: #f5c518;
    }
  `);

  const popup = document.createElement('div');
  popup.className = 'irho-popup';
  popup.setAttribute('role', 'status');
  popup.setAttribute('aria-live', 'polite');
  popup.hidden = true;

  const logo = document.createElement('img');
  logo.className = 'irho-logo';
  logo.alt = 'IMDb';
  logo.width = 46;
  logo.height = 25;
  logo.referrerPolicy = 'no-referrer';
  logo.addEventListener('error', () => {
    const fallback = document.createElement('span');
    fallback.className = 'irho-logo-fallback';
    fallback.textContent = 'IMDb';
    logo.replaceWith(fallback);
  }, { once: true });

  const divider = document.createElement('span');
  divider.className = 'irho-divider';
  divider.setAttribute('aria-hidden', 'true');

  const details = document.createElement('span');
  details.className = 'irho-details';

  const ratingText = document.createElement('span');
  ratingText.className = 'irho-rating';
  ratingText.textContent = '...';

  const votesText = document.createElement('span');
  votesText.className = 'irho-votes';
  votesText.textContent = 'Loading rating';

  details.append(ratingText, votesText);
  popup.append(logo, divider, details);
  document.body.appendChild(popup);

  let activeLink = null;
  let logoRequested = false;

  GM_registerMenuCommand('IMDb Rating: Settings', showSettings);

  document.addEventListener('pointerover', event => {
    const link = closestLink(event.target);
    if (!link || link.contains(event.relatedTarget)) return;

    const titleId = getIMDbTitleId(link.href);
    if (!titleId) {
      if (activeLink) hidePopup();
      return;
    }

    activeLink = link;
    popup.dataset.state = 'loading';
    ratingText.textContent = '...';
    votesText.textContent = 'Loading rating';
    popup.hidden = false;
    if (!logoRequested) {
      logoRequested = true;
      logo.src = LOGO_URL;
    }
    positionPopup(link);

    getRating(titleId).then(result => {
      if (activeLink !== link) return;
      popup.dataset.state = 'ready';
      ratingText.textContent = result.rating;
      votesText.textContent = result.votes;
      positionPopup(link);
    }).catch(error => {
      if (activeLink !== link) return;
      popup.dataset.state = 'error';
      ratingText.textContent = 'Unavailable';
      votesText.textContent = error.message;
      positionPopup(link);
    });
  });

  document.addEventListener('pointerout', event => {
    const link = closestLink(event.target);
    if (link && activeLink === link && !link.contains(event.relatedTarget)) hidePopup();
  });

  window.addEventListener('scroll', () => {
    if (activeLink) positionPopup(activeLink);
  }, true);
  window.addEventListener('resize', () => {
    if (activeLink) positionPopup(activeLink);
  });

  function closestLink(target) {
    return target instanceof Element ? target.closest('a[href]') : null;
  }

  function getIMDbTitleId(href) {
    try {
      const url = new URL(href, location.href);
      if (url.hostname !== 'imdb.com' && !url.hostname.endsWith('.imdb.com')) return null;
      return url.pathname.match(/^\/title\/(tt\d+)(?:\/|$)/i)?.[1]?.toLowerCase() || null;
    } catch {
      return null;
    }
  }

  function buildApiUrl(template, titleId) {
    if (!template.includes('{id}')) throw new Error('API URL must include {id}.');

    let url;
    try {
      url = new URL(template.replaceAll('{id}', encodeURIComponent(titleId)));
    } catch {
      throw new Error('Enter a valid HTTP(S) API URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('API URL must use HTTP or HTTPS.');
    }
    return url.href;
  }

  function getRating(titleId) {
    if (ratingRequests.has(titleId)) return ratingRequests.get(titleId);

    const request = new Promise((resolve, reject) => {
      const template = GM_getValue(STORAGE_KEY, '').trim();
      if (!template) throw new Error('Set your API URL in IMDb Rating settings.');
      const url = buildApiUrl(template, titleId);

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        timeout: REQUEST_TIMEOUT_MS,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`IMDb API returned HTTP ${response.status}.`));
            return;
          }

          let data;
          try {
            data = JSON.parse(response.responseText);
          } catch {
            reject(new Error('IMDb API returned invalid JSON.'));
            return;
          }
          if (!data || typeof data !== 'object') {
            reject(new Error('IMDb API returned an unexpected response.'));
            return;
          }

          const rating = data.rating === null || data.rating === undefined || data.rating === ''
            ? NaN
            : Number(data.rating);
          const votes = data.votes === null || data.votes === undefined || data.votes === ''
            ? NaN
            : Number(data.votes);
          resolve({
            rating: Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating.toFixed(1) : 'N/A',
            votes: Number.isFinite(votes) && votes >= 0
              ? `${new Intl.NumberFormat().format(votes)} votes`
              : 'Votes unavailable',
          });
        },
        onerror() {
          reject(new Error('Could not connect to the IMDb API.'));
        },
        ontimeout() {
          reject(new Error('IMDb API request timed out.'));
        },
      });
    }).catch(error => {
      ratingRequests.delete(titleId);
      throw error;
    });

    ratingRequests.set(titleId, request);
    return request;
  }

  function positionPopup(link) {
    if (!link.isConnected || popup.hidden) return;

    const rect = link.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    let left = Math.min(rect.left, window.innerWidth - popupRect.width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + gap;
    if (top + popupRect.height > window.innerHeight - margin) top = rect.top - popupRect.height - gap;
    top = Math.max(margin, Math.min(top, window.innerHeight - popupRect.height - margin));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  function hidePopup() {
    activeLink = null;
    popup.hidden = true;
  }

  function showSettings() {
    document.querySelector('.irho-settings-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'irho-settings-backdrop';
    backdrop.innerHTML = `
      <form class="irho-settings" role="dialog" aria-modal="true" aria-labelledby="irho-settings-title">
        <h2 id="irho-settings-title">IMDb Rating Settings</h2>
        <p>Use <code>{id}</code> where the IMDb title ID belongs. The endpoint should return JSON with <code>rating</code> and <code>votes</code>.</p>
        <p class="irho-error" role="alert" hidden></p>
        <label>API URL template
          <input name="apiUrl" type="text" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://your-api.example/title/{id}" required>
        </label>
        <p class="irho-api-note"><a href="https://github.com/Bandit/imdbflare" target="_blank" rel="noopener noreferrer">imdbflare</a>-style APIs accepted.</p>
        <div class="irho-settings-actions">
          <button type="submit" data-primary="true">Save</button>
          <button type="button" data-cancel>Cancel</button>
        </div>
      </form>`;

    const form = backdrop.querySelector('form');
    const error = backdrop.querySelector('.irho-error');
    form.elements.apiUrl.value = GM_getValue(STORAGE_KEY, '');

    form.addEventListener('submit', event => {
      event.preventDefault();
      const template = form.elements.apiUrl.value.trim();
      try {
        buildApiUrl(template, 'tt6212478');
      } catch (validationError) {
        error.textContent = validationError.message;
        error.hidden = false;
        return;
      }

      GM_setValue(STORAGE_KEY, template);
      ratingRequests.clear();
      backdrop.remove();
    });

    backdrop.querySelector('[data-cancel]').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) backdrop.remove();
    });
    backdrop.addEventListener('keydown', event => {
      if (event.key === 'Escape') backdrop.remove();
    });
    document.body.appendChild(backdrop);
    form.elements.apiUrl.focus();
  }
})();