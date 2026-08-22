// ==UserScript==
// @name         Configurable Auto Refresh
// @namespace    https://github.com/Bandit/userscripts
// @version      1.0.0
// @description  Adds a menu option to auto-refresh the current site and optionally notify when its rendered content changes.
// @author       Bandit
// @homepageURL  https://github.com/Bandit/userscripts/blob/main/Configurable-Auto-Refresh.user.js
// @supportURL   https://github.com/Bandit/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/Bandit/userscripts/main/Configurable-Auto-Refresh.user.js
// @downloadURL  https://raw.githubusercontent.com/Bandit/userscripts/main/Configurable-Auto-Refresh.user.js
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_REFRESH_SECONDS = 60;
  const SESSION_KEY = 'configurableAutoRefresh.intervalSeconds';
  const NOTIFICATION_KEY = 'configurableAutoRefresh.notifyOnVisualChange';
  const SNAPSHOT_KEY = 'configurableAutoRefresh.visualSnapshot';
  let intervalSeconds = readInterval();
  let notificationEnabled = sessionStorage.getItem(NOTIFICATION_KEY) === 'true';
  let refreshTimerId = null;
  let countdownTimerId = null;
  let deadline = 0;
  let remainingMs = 0;
  let paused = false;
  let widget = null;
  let menuCommandIds = [];

  GM_addStyle(`
    #car-widget {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 6px;
      box-sizing: border-box;
      min-height: 34px;
      padding: 5px 6px 5px 9px;
      color: #f5f5f2;
      background: rgba(22, 26, 23, 0.5);
      backdrop-filter: blur(10px) saturate(120%);
      -webkit-backdrop-filter: blur(10px) saturate(120%);
      border: 1px solid #59615b;
      border-radius: 6px;
      box-shadow: 0 5px 18px rgba(0, 0, 0, 0.28);
      font: 12px/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace;
    }
    #car-widget label {
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      cursor: pointer;
    }
    #car-widget input[type="number"] {
      width: 54px;
      height: 24px;
      box-sizing: border-box;
      padding: 2px 4px;
      color: #f5f5f2;
      background: #303631;
      border: 1px solid #737d76;
      border-radius: 4px;
      font: inherit;
    }
    #car-widget input[type="checkbox"] {
      margin: 0;
    }
    #car-widget button {
      min-width: 30px;
      height: 24px;
      padding: 0 6px;
      color: inherit;
      background: transparent;
      border: 1px solid #737d76;
      border-radius: 4px;
      font: 11px/1 sans-serif;
      cursor: pointer;
    }
    #car-widget button:hover { background: #3a423d; }
    #car-widget button:focus-visible { outline: 2px solid #9cc7a5; outline-offset: 1px; }
    #car-widget .car-refresh { min-width: 68px; }
    #car-widget .car-cancel:hover { background: #703a36; border-color: #b97770; }
  `);

  registerMenuCommands();

  if (intervalSeconds !== null) {
    createWidget();
    scheduleRefresh();
    window.setTimeout(checkForVisualChange, 750);
  }

  function registerMenuCommands() {
    menuCommandIds.forEach((commandId) => GM_unregisterMenuCommand(commandId));
    menuCommandIds = [];

    if (intervalSeconds === null) {
      menuCommandIds.push(GM_registerMenuCommand('Enable auto refresh', () => startRefreshing(DEFAULT_REFRESH_SECONDS)));
    } else {
      menuCommandIds.push(GM_registerMenuCommand('Disable auto refresh', stopRefreshing));
    }
  }

  function readInterval() {
    const value = Number(sessionStorage.getItem(SESSION_KEY));
    return Number.isFinite(value) && value >= 1 ? value : null;
  }

  function startRefreshing(seconds) {
    intervalSeconds = seconds;
    sessionStorage.setItem(SESSION_KEY, String(seconds));
    registerMenuCommands();
    createWidget();
    scheduleRefresh();
  }

  function stopRefreshing() {
    intervalSeconds = null;
    notificationEnabled = false;
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(NOTIFICATION_KEY);
    sessionStorage.removeItem(SNAPSHOT_KEY);
    clearTimers();
    widget?.remove();
    widget = null;
    paused = false;
    remainingMs = 0;
    registerMenuCommands();
  }

  function scheduleRefresh(delayMs = intervalSeconds * 1000) {
    clearTimers();
    paused = false;
    remainingMs = delayMs;
    deadline = Date.now() + delayMs;
    refreshTimerId = window.setTimeout(reloadWithSnapshot, delayMs);
    countdownTimerId = window.setInterval(updateWidget, 250);
    updateWidget();
  }

  function clearTimers() {
    window.clearTimeout(refreshTimerId);
    window.clearInterval(countdownTimerId);
    refreshTimerId = null;
    countdownTimerId = null;
  }

  function setNotifications(enabled) {
    notificationEnabled = enabled;
    sessionStorage.setItem(NOTIFICATION_KEY, String(notificationEnabled));
    sessionStorage.removeItem(SNAPSHOT_KEY);
  }

  function reloadWithSnapshot() {
    if (notificationEnabled) {
      sessionStorage.setItem(SNAPSHOT_KEY, createVisualFingerprint());
    }
    location.reload();
  }

  function checkForVisualChange() {
    if (!notificationEnabled || intervalSeconds === null) return;

    const previousFingerprint = sessionStorage.getItem(SNAPSHOT_KEY);
    sessionStorage.removeItem(SNAPSHOT_KEY);
    if (previousFingerprint === null) return;

    const currentFingerprint = createVisualFingerprint();
    if (currentFingerprint !== previousFingerprint) {
      GM_notification({
        title: 'Page changed',
        text: `${document.title || location.hostname} looks different after refreshing.`,
        timeout: 10000,
        onclick: () => window.focus(),
      });
    }
  }

  function createVisualFingerprint() {
    let hash = 2166136261;
    const elements = [document.body, ...document.body.querySelectorAll('*')];

    for (const element of elements) {
      if (!element || element.closest('#car-widget') || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName)) continue;

      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width === 0 || rect.height === 0) continue;

      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join(' ');
      const mediaSource = element.currentSrc || element.src || element.getAttribute?.('href') || '';
      const formState = 'value' in element ? `${element.value}|${element.checked ?? ''}` : '';
      const visualState = [
        element.tagName,
        directText,
        mediaSource,
        formState,
        Math.round(rect.left),
        Math.round(rect.top),
        Math.round(rect.width),
        Math.round(rect.height),
        style.color,
        style.backgroundColor,
        style.backgroundImage,
        style.borderColor,
        style.font,
        style.textDecoration,
      ].join('|');

      for (let index = 0; index < visualState.length; index += 1) {
        hash ^= visualState.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }

    return (hash >>> 0).toString(16);
  }

  function togglePause() {
    if (paused) {
      scheduleRefresh(remainingMs);
      return;
    }

    remainingMs = Math.max(0, deadline - Date.now());
    paused = true;
    clearTimers();
    updateWidget();
  }

  function createWidget() {
    if (widget) return;

    widget = document.createElement('div');
    widget.id = 'car-widget';
    widget.innerHTML = '<label><input type="number" class="car-interval" min="1" step="1" aria-label="Refresh interval in seconds">s</label><label><input type="checkbox" class="car-notify">Notify on change</label><button type="button" class="car-refresh" title="Refresh now" aria-label="Refresh now">&#x21BB; <span class="car-countdown"></span></button><button type="button" class="car-pause" title="Pause auto refresh" aria-label="Pause auto refresh">&#x23F8;</button><button type="button" class="car-cancel" title="Cancel auto refresh" aria-label="Cancel auto refresh">&#x2715;</button>';
    widget.querySelector('.car-interval').value = String(intervalSeconds);
    widget.querySelector('.car-notify').checked = notificationEnabled;
    widget.querySelector('.car-interval').addEventListener('change', updateRefreshInterval);
    widget.querySelector('.car-notify').addEventListener('change', (event) => setNotifications(event.currentTarget.checked));
    widget.querySelector('.car-pause').addEventListener('click', togglePause);
    widget.querySelector('.car-refresh').addEventListener('click', reloadWithSnapshot);
    widget.querySelector('.car-cancel').addEventListener('click', stopRefreshing);
    document.documentElement.append(widget);
  }

  function updateWidget() {
    if (!widget) return;

    if (!paused) {
      remainingMs = Math.max(0, deadline - Date.now());
    }

    widget.querySelector('.car-countdown').textContent = formatDuration(remainingMs);
    const pauseButton = widget.querySelector('.car-pause');
    pauseButton.innerHTML = paused ? '&#x25B6;' : '&#x23F8;';
    pauseButton.title = paused ? 'Resume auto refresh' : 'Pause auto refresh';
    pauseButton.setAttribute('aria-label', pauseButton.title);
  }

  function updateRefreshInterval(event) {
    const seconds = Number(event.currentTarget.value);
    if (!Number.isFinite(seconds) || seconds < 1) {
      event.currentTarget.value = String(intervalSeconds);
      return;
    }

    intervalSeconds = seconds;
    sessionStorage.setItem(SESSION_KEY, String(seconds));
    scheduleRefresh();
  }

  function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
})();