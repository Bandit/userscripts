// ==UserScript==
// @name        Send Magnet links to qBittorrent
// @namespace   https://github.com/Bandit/userscripts
// @version     1.0.0
// @description When a magnet: link is detected on a page, it can be right-clicked to send it to a local qBittorrent WebUI instance. Doesn't do anything otherwise.
// @author      Bandit
// @homepageURL https://github.com/Bandit/userscripts/blob/main/Magnet-to-qBittorrent.user.js
// @supportURL  https://github.com/Bandit/userscripts/issues
// @updateURL   https://raw.githubusercontent.com/Bandit/userscripts/main/Magnet-to-qBittorrent.user.js
// @downloadURL https://raw.githubusercontent.com/Bandit/userscripts/main/Magnet-to-qBittorrent.user.js
// @match       http://*/*
// @match       https://*/*
// @noframes
// @grant       GM_addStyle
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_deleteValue
// @grant       GM_registerMenuCommand
// @grant       GM_xmlhttpRequest
// @grant       GM_notification
// @grant       GM_setClipboard
// @connect     localhost
// @connect     127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'qbms.config.v1';
  const CATEGORY_CACHE_KEY = 'qbms.categories.v1';
  const CATEGORY_SYNCED_AT_KEY = 'qbms.categoriesSyncedAt.v1';

  /*
    Edit these defaults before installing, or use the Violentmonkey menu command:
    "qBittorrent: Settings". Some userscript managers enforce @connect settings for
    GM_xmlhttpRequest; Violentmonkey may not require it for your qBittorrent host.

    Once installed, right click on any magnet link to open the context menu. The
    menu will show synced categories from qBittorrent and let you launch a settings
    dialog for post-install configuration.
  */
  const DEFAULT_CONFIG = Object.freeze({
    serverUrl: 'http://localhost:8282',
    username: '',
    password: '',
    defaultCategory: '',
    savePath: '',
    tags: '',
    paused: false,
    sequentialDownload: false,
    firstLastPiecePrio: false,
    autoTMM: false,
    chooseCategoryOnSend: true,
    showPageContextMenu: true,
    requestTimeoutMs: 15000,
    categorySyncIntervalMs: 6 * 60 * 60 * 1000,
  });

  let menuElement = null;
  let settingsElement = null;
  let stylesInstalled = false;

  const STYLE_CSS = `
    .qbms-menu {
      position: fixed;
      z-index: 2147483647;
      min-width: 230px;
      max-width: min(360px, calc(100vw - 24px));
      padding: 8px;
      color: #161616;
      background: #fbfbf8;
      border: 1px solid #9c988d;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
      font: 13px/1.35 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .qbms-menu-title {
      padding: 4px 6px 8px;
      color: #4f4a3f;
      font-weight: 650;
      overflow-wrap: anywhere;
    }

    .qbms-menu-section {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid #d6d1c5;
    }

    .qbms-menu button,
    .qbms-settings button {
      display: block;
      width: 100%;
      min-height: 30px;
      margin: 0;
      padding: 6px 8px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 4px;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }

    .qbms-menu button:hover,
    .qbms-menu button:focus-visible,
    .qbms-settings button:hover,
    .qbms-settings button:focus-visible {
      outline: none;
      background: #ebe4d3;
    }

    .qbms-muted {
      color: #6c665b;
    }

    .qbms-settings-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      padding: 18px;
      background: rgba(0, 0, 0, 0.42);
      font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .qbms-settings {
      width: min(620px, 100%);
      max-height: min(760px, calc(100vh - 36px));
      overflow: auto;
      padding: 18px;
      color: #171717;
      background: #fbfbf8;
      border: 1px solid #9c988d;
      border-top: 0;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
    }

    .qbms-settings h2 {
      margin: 0 0 12px;
      font-size: 18px;
      letter-spacing: 0;
    }

    .qbms-settings p {
      margin: 0 0 14px;
      color: #5f584d;
    }

    .qbms-settings label {
      display: grid;
      gap: 4px;
      margin: 10px 0;
      font-weight: 650;
    }

    .qbms-settings input[type="text"],
    .qbms-settings input[type="password"],
    .qbms-settings input[type="number"],
    .qbms-settings select {
      width: 100%;
      box-sizing: border-box;
      min-height: 34px;
      padding: 6px 8px;
      color: #171717;
      background: #fff;
      border: 1px solid #b9b2a5;
      border-radius: 4px;
      font: inherit;
    }

    .qbms-settings .qbms-check {
      display: flex;
      grid-template-columns: none;
      align-items: center;
      gap: 8px;
      font-weight: 500;
    }

    .qbms-settings-actions {
      position: sticky;
      bottom: -18px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 16px -18px -18px;
      padding: 12px 18px 18px;
      background: #fbfbf8;
    }

    .qbms-settings-actions button {
      width: auto;
      min-width: 94px;
      text-align: center;
      background: #eee7d8;
      border: 1px solid #b9b2a5;
    }

    .qbms-settings-actions button[data-primary="true"] {
      color: #fff;
      background: #215f61;
      border-color: #215f61;
    }
  `;

  registerMenuCommands();
  maybeSyncCategoriesOnStart();

  document.addEventListener('contextmenu', handleContextMenu, true);
  document.addEventListener('click', closeMenu, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      closeSettings();
    }
  }, true);

  function registerMenuCommands() {
    GM_registerMenuCommand('qBittorrent: Settings', openSettingsDialog);
    GM_registerMenuCommand('qBittorrent: Sync categories', () => syncCategories(true));
    GM_registerMenuCommand('qBittorrent: Send magnet from prompt', promptForMagnet);
    GM_registerMenuCommand('qBittorrent: Clear stored settings', clearSettings);
  }

  function loadConfig() {
    const saved = GM_getValue(STORAGE_KEY, {});
    return Object.assign({}, DEFAULT_CONFIG, isPlainObject(saved) ? saved : {});
  }

  function saveConfig(config) {
    GM_setValue(STORAGE_KEY, Object.assign({}, DEFAULT_CONFIG, config));
  }

  function getCachedCategories() {
    const categories = GM_getValue(CATEGORY_CACHE_KEY, []);
    return Array.isArray(categories) ? categories.filter(Boolean).sort(localeCompare) : [];
  }

  function setCachedCategories(categories) {
    GM_setValue(CATEGORY_CACHE_KEY, categories.filter(Boolean).sort(localeCompare));
    GM_setValue(CATEGORY_SYNCED_AT_KEY, Date.now());
  }

  function ensureStyles() {
    if (stylesInstalled) {
      return;
    }

    GM_addStyle(STYLE_CSS);
    stylesInstalled = true;
  }

  function maybeSyncCategoriesOnStart() {
    if (!pageHasMagnetLinks()) {
      return;
    }

    const config = loadConfig();
    const lastSyncedAt = Number(GM_getValue(CATEGORY_SYNCED_AT_KEY, 0));

    if (Date.now() - lastSyncedAt < config.categorySyncIntervalMs) {
      return;
    }

    syncCategories(false).catch((error) => {
      console.debug('[qBittorrent magnet sender] Category sync skipped:', error);
    });
  }

  function pageHasMagnetLinks() {
    return Array.prototype.some.call(document.links, (link) => isMagnetUri(link.getAttribute('href')));
  }

  function handleContextMenu(event) {
    const config = loadConfig();

    if (!config.showPageContextMenu || !event.isTrusted) {
      return;
    }

    const link = findMagnetLink(event.target);
    if (!link) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    showMenu(event.clientX, event.clientY, link.href);
  }

  function findMagnetLink(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    const link = target.closest('a[href]');
    if (!link) {
      return null;
    }

    return isMagnetUri(link.getAttribute('href')) ? link : null;
  }

  function showMenu(clientX, clientY, magnetUri) {
    closeMenu();
    ensureStyles();

    const config = loadConfig();
    const categories = getCachedCategories();
    const menu = document.createElement('div');
    menu.className = 'qbms-menu';
    menu.setAttribute('role', 'menu');

    const title = document.createElement('div');
    title.className = 'qbms-menu-title';
    title.textContent = getMagnetDisplayName(magnetUri);
    menu.append(title);

    menu.append(createMenuButton(categoryCaption(config.defaultCategory), (event) => {
      if (!event.isTrusted) {
        return;
      }
      sendMagnet(magnetUri, config.defaultCategory);
    }));

    if (config.defaultCategory) {
      menu.append(createMenuButton('Send without category', (event) => {
        if (!event.isTrusted) {
          return;
        }
        sendMagnet(magnetUri, '');
      }));
    }

    if (config.chooseCategoryOnSend) {
      const section = document.createElement('div');
      section.className = 'qbms-menu-section';

      if (categories.length > 0) {
        categories.forEach((category) => {
          section.append(createMenuButton(`Send to ${category}`, (event) => {
            if (!event.isTrusted) {
              return;
            }
            sendMagnet(magnetUri, category);
          }));
        });
      } else {
        const empty = document.createElement('div');
        empty.className = 'qbms-menu-title qbms-muted';
        empty.textContent = 'No synced categories yet';
        section.append(empty);
      }

      section.append(createMenuButton('Refresh categories...', (event) => {
        if (!event.isTrusted) {
          return;
        }
        syncCategories(true);
      }));
      menu.append(section);
    }

    const tools = document.createElement('div');
    tools.className = 'qbms-menu-section';
    tools.append(createMenuButton('Copy magnet URL', (event) => {
      if (!event.isTrusted) {
        return;
      }
      copyMagnetUri(magnetUri);
    }));
    tools.append(createMenuButton('Settings...', (event) => {
      if (!event.isTrusted) {
        return;
      }
      openSettingsDialog();
    }));
    menu.append(tools);

    document.body.append(menu);
    menuElement = menu;
    positionMenu(menu, clientX, clientY);
  }

  function createMenuButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      onClick(event);
    });
    return button;
  }

  function positionMenu(menu, clientX, clientY) {
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(clientX, window.innerWidth - rect.width - margin);
    const top = Math.min(clientY, window.innerHeight - rect.height - margin);
    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
  }

  function closeMenu() {
    if (menuElement) {
      menuElement.remove();
      menuElement = null;
    }
  }

  function copyMagnetUri(magnetUri) {
    GM_setClipboard(magnetUri, 'text/plain');
    notify('qBittorrent', 'Magnet URL copied.');
  }

  async function promptForMagnet() {
    const magnetUri = window.prompt('Paste a magnet link to send to qBittorrent:');
    if (!magnetUri) {
      return;
    }

    if (!isMagnetUri(magnetUri)) {
      notify('qBittorrent', 'That does not look like a magnet link.');
      return;
    }

    const config = loadConfig();
    await sendMagnet(magnetUri.trim(), config.defaultCategory);
  }

  async function sendMagnet(magnetUri, category) {
    const config = loadConfig();

    try {
      if (!isMagnetUri(magnetUri)) {
        throw new Error('That does not look like a magnet link.');
      }

      await ensureLogin(config);

      const formData = new FormData();
      formData.append('urls', magnetUri.trim());
      appendIfValue(formData, 'category', category);
      appendIfValue(formData, 'savepath', config.savePath);
      appendIfValue(formData, 'tags', config.tags);
      appendBoolean(formData, 'paused', config.paused);
      appendBoolean(formData, 'sequentialDownload', config.sequentialDownload);
      appendBoolean(formData, 'firstLastPiecePrio', config.firstLastPiecePrio);
      appendBoolean(formData, 'autoTMM', config.autoTMM);

      const response = await requestApi(config, '/api/v2/torrents/add', {
        method: 'POST',
        data: formData,
      });

      if (response.status !== 200) {
        throw new Error(`Add failed: HTTP ${response.status} ${response.statusText}`);
      }

      const target = category ? `category "${category}"` : 'no category';
      notify('qBittorrent', `Magnet sent with ${target}.`);
    } catch (error) {
      notify('qBittorrent error', error.message || String(error));
      console.error('[qBittorrent magnet sender]', error);
    }
  }

  async function syncCategories(userInitiated) {
    const config = loadConfig();

    try {
      await ensureLogin(config);
      const response = await requestApi(config, '/api/v2/torrents/categories', {
        method: 'GET',
        responseType: 'json',
      });

      if (response.status !== 200) {
        throw new Error(`Category sync failed: HTTP ${response.status} ${response.statusText}`);
      }

      const payload = response.response || JSON.parse(response.responseText || '{}');
      const categories = Object.keys(payload).sort(localeCompare);
      setCachedCategories(categories);

      if (userInitiated) {
        notify('qBittorrent', `Synced ${categories.length} categories.`);
      }

      return categories;
    } catch (error) {
      if (userInitiated) {
        notify('qBittorrent error', error.message || String(error));
      }
      throw error;
    }
  }

  async function ensureLogin(config) {
    if (!config.username && !config.password) {
      return;
    }

    const body = new URLSearchParams();
    body.set('username', config.username || '');
    body.set('password', config.password || '');

    const response = await requestApi(config, '/api/v2/auth/login', {
      method: 'POST',
      data: body.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const bodyText = (response.responseText || '').trim();
    if (response.status === 403) {
      throw new Error('qBittorrent rejected login and may have temporarily banned this IP.');
    }

    if (response.status !== 200 || bodyText !== 'Ok.') {
      throw new Error(`qBittorrent login failed${bodyText ? `: ${bodyText}` : ''}`);
    }
  }

  function requestApi(config, path, options) {
    const url = apiUrl(config.serverUrl, path);
    const headers = Object.assign({}, sameOriginHeaders(config.serverUrl), options.headers || {});

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        data: options.data,
        headers,
        responseType: options.responseType,
        timeout: Number(config.requestTimeoutMs) || DEFAULT_CONFIG.requestTimeoutMs,
        anonymous: false,
        onload: resolve,
        onerror: () => reject(new Error(`Network error while contacting ${url}`)),
        ontimeout: () => reject(new Error(`Timed out contacting ${url}`)),
        onabort: () => reject(new Error(`Request aborted for ${url}`)),
      });
    });
  }

  function apiUrl(serverUrl, path) {
    return `${String(serverUrl || DEFAULT_CONFIG.serverUrl).replace(/\/+$/, '')}${path}`;
  }

  function sameOriginHeaders(serverUrl) {
    const url = new URL(serverUrl || DEFAULT_CONFIG.serverUrl, window.location.href);
    return {
      Origin: url.origin,
      Referer: `${String(serverUrl || DEFAULT_CONFIG.serverUrl).replace(/\/+$/, '')}/`,
    };
  }

  function openSettingsDialog() {
    closeSettings();
    ensureStyles();

    const config = loadConfig();
    const backdrop = document.createElement('div');
    backdrop.className = 'qbms-settings-backdrop';

    const panel = document.createElement('form');
    panel.className = 'qbms-settings';
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      const nextConfig = readSettingsForm(panel, config);
      saveConfig(nextConfig);
      closeSettings();
      notify('qBittorrent', 'Settings saved.');
    });

    const heading = document.createElement('h2');
    heading.textContent = 'qBittorrent Magnet Sender';
    panel.append(heading);

    const note = document.createElement('p');
    note.textContent = 'Password is stored in userscript-manager storage. Leave it blank here to keep the existing stored password.';
    panel.append(note);

    panel.append(createTextField('serverUrl', 'Server URL', config.serverUrl));
    panel.append(createTextField('username', 'Username', config.username));
    panel.append(createTextField('password', 'Password', '', 'password'));
    panel.append(createCheckbox('clearPassword', 'Clear stored password', false));
    panel.append(createCategorySelect(config.defaultCategory));
    panel.append(createTextField('savePath', 'Save path override', config.savePath));
    panel.append(createTextField('tags', 'Tags, comma-separated', config.tags));
    panel.append(createCheckbox('paused', 'Add torrents paused', config.paused));
    panel.append(createCheckbox('chooseCategoryOnSend', 'Show synced category choices', config.chooseCategoryOnSend));
    panel.append(createCheckbox('showPageContextMenu', 'Show right-click page menu on magnet links', config.showPageContextMenu));
    panel.append(createCheckbox('sequentialDownload', 'Sequential download', config.sequentialDownload));
    panel.append(createCheckbox('firstLastPiecePrio', 'Prioritize first and last pieces', config.firstLastPiecePrio));
    panel.append(createCheckbox('autoTMM', 'Use automatic torrent management', config.autoTMM));

    const actions = document.createElement('div');
    actions.className = 'qbms-settings-actions';
    actions.append(createActionButton('Save', 'submit', true));
    actions.append(createActionButton('Refresh categories', 'button', false, async () => {
      const nextConfig = readSettingsForm(panel, config);
      saveConfig(nextConfig);

      try {
        const categories = await syncCategories(true);
        replaceCategoryOptions(panel.elements.defaultCategory, categories, nextConfig.defaultCategory);
      } catch (error) {
        console.error('[qBittorrent magnet sender]', error);
      }
    }));
    actions.append(createActionButton('Cancel', 'button', false, closeSettings));
    panel.append(actions);

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        closeSettings();
      }
    });

    backdrop.append(panel);
    document.body.append(backdrop);
    settingsElement = backdrop;
  }

  function createTextField(name, labelText, value, type) {
    const label = document.createElement('label');
    label.textContent = labelText;

    const input = document.createElement('input');
    input.name = name;
    input.type = type || 'text';
    input.value = value || '';

    label.append(input);
    return label;
  }

  function createCategorySelect(currentCategory) {
    const label = document.createElement('label');
    label.textContent = 'Default category';

    const select = document.createElement('select');
    select.name = 'defaultCategory';
    replaceCategoryOptions(select, getCachedCategories(), currentCategory);

    label.append(select);
    return label;
  }

  function replaceCategoryOptions(select, categories, currentCategory) {
    const selectedCategory = currentCategory || select.value || '';
    const categorySet = new Set(categories);
    select.replaceChildren();

    select.append(createOption('', 'No category'));

    if (selectedCategory && !categorySet.has(selectedCategory)) {
      select.append(createOption(selectedCategory, `${selectedCategory} (not in latest sync)`));
    }

    categories.forEach((category) => {
      select.append(createOption(category, category));
    });

    select.value = selectedCategory;
  }

  function createOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  function createCheckbox(name, labelText, checked) {
    const label = document.createElement('label');
    label.className = 'qbms-check';

    const input = document.createElement('input');
    input.name = name;
    input.type = 'checkbox';
    input.checked = Boolean(checked);

    const text = document.createElement('span');
    text.textContent = labelText;

    label.append(input, text);
    return label;
  }

  function createActionButton(label, type, primary, onClick) {
    const button = document.createElement('button');
    button.type = type;
    button.textContent = label;
    button.dataset.primary = String(Boolean(primary));

    if (onClick) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        onClick(event);
      });
    }

    return button;
  }

  function readSettingsForm(form, previousConfig) {
    const formData = new FormData(form);
    const nextConfig = Object.assign({}, previousConfig, {
      serverUrl: stringValue(formData, 'serverUrl'),
      username: stringValue(formData, 'username'),
      defaultCategory: stringValue(formData, 'defaultCategory'),
      savePath: stringValue(formData, 'savePath'),
      tags: stringValue(formData, 'tags'),
      paused: formData.has('paused'),
      chooseCategoryOnSend: formData.has('chooseCategoryOnSend'),
      showPageContextMenu: formData.has('showPageContextMenu'),
      sequentialDownload: formData.has('sequentialDownload'),
      firstLastPiecePrio: formData.has('firstLastPiecePrio'),
      autoTMM: formData.has('autoTMM'),
    });

    const password = stringValue(formData, 'password');
    if (formData.has('clearPassword')) {
      nextConfig.password = '';
    } else if (password) {
      nextConfig.password = password;
    }

    return nextConfig;
  }

  function closeSettings() {
    if (settingsElement) {
      settingsElement.remove();
      settingsElement = null;
    }
  }

  function clearSettings() {
    if (!window.confirm('Clear qBittorrent Magnet Sender settings and category cache?')) {
      return;
    }

    GM_deleteValue(STORAGE_KEY);
    GM_deleteValue(CATEGORY_CACHE_KEY);
    GM_deleteValue(CATEGORY_SYNCED_AT_KEY);
    notify('qBittorrent', 'Stored settings cleared.');
  }

  function appendIfValue(formData, name, value) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      formData.append(name, String(value).trim());
    }
  }

  function appendBoolean(formData, name, value) {
    if (value) {
      formData.append(name, 'true');
    }
  }

  function stringValue(formData, name) {
    return String(formData.get(name) || '').trim();
  }

  function categoryCaption(category) {
    return category ? `Send to default category: ${category}` : 'Send to qBittorrent';
  }

  function getMagnetDisplayName(magnetUri) {
    try {
      const url = new URL(magnetUri);
      return url.searchParams.get('dn') || 'Magnet link';
    } catch (error) {
      const match = /[?&]dn=([^&]+)/i.exec(magnetUri);
      return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : 'Magnet link';
    }
  }

  function isMagnetUri(value) {
    return String(value || '').trim().toLowerCase().startsWith('magnet:');
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function localeCompare(left, right) {
    return String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
  }

  function notify(title, text) {
    try {
      GM_notification({
        title,
        text,
        silent: true,
        timeout: 5000,
      });
    } catch (error) {
      console.log(`${title}: ${text}`);
    }
  }
}());
