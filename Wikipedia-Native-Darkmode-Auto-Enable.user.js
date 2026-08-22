// ==UserScript==
// @name         Wikipedia Native Dark Mode Auto-Enable
// @namespace    https://github.com/Bandit/userscripts
// @version      1.0.4
// @description  Automatically enables Wikipedia's built-in dark mode preference on supported skins.
// @author       Bandit
// @homepageURL  https://github.com/Bandit/userscripts/blob/main/Wikipedia-Native-Darkmode-Auto-Enable.user.js
// @supportURL   https://github.com/Bandit/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/Bandit/userscripts/main/Wikipedia-Native-Darkmode-Auto-Enable.user.js
// @downloadURL  https://raw.githubusercontent.com/Bandit/userscripts/main/Wikipedia-Native-Darkmode-Auto-Enable.user.js
// @match        *://*.wikipedia.org/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_MODE = 'night'; // change to 'os' for Automatic
  const COOKIE_NAME = 'mwclientpreferences';
  const FEATURE_NAME = 'skin-theme';
  const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
  const ANTI_FLASH_STYLE_ID = 'wiki-native-dark-antiflash';
  const ANTI_FLASH_TIMEOUT = 4000;

  function shouldUseDarkMode() {
    return TARGET_MODE === 'night' ||
      (TARGET_MODE === 'os' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  }

  function hasNativeNightModeSupport() {
    return /\bskin-theme-clientpref-(?:day|night|os|--excluded)\b/.test(
      document.documentElement.className
    ) || document.documentElement.classList.contains('skin-night-mode-page-disabled');
  }

  function isNightModeExcludedOnThisPage() {
    const classes = document.documentElement.classList;
    return classes.contains('skin-theme-clientpref--excluded') ||
      classes.contains('skin-night-mode-page-disabled');
  }

  function detectLoggedInPrefKey() {
    const className = document.documentElement.className;
    if (/\bskin-minerva\b/.test(className) || location.hostname.startsWith('m.')) {
      return 'minerva-theme';
    }
    if (/\bskin-vector\b/.test(className)) {
      return 'vector-theme';
    }
    return null;
  }

  function applyThemeClassImmediately() {
    if (!shouldUseDarkMode() || !hasNativeNightModeSupport() || isNightModeExcludedOnThisPage()) {
      return;
    }

    const classes = document.documentElement.classList;
    classes.remove('skin-theme-clientpref-day', 'skin-theme-clientpref-os');
    classes.add(`skin-theme-clientpref-${TARGET_MODE}`);
  }

  function installAntiFlashGuard() {
    if (!shouldUseDarkMode() || isNightModeExcludedOnThisPage()) {
      return;
    }

    if (document.getElementById(ANTI_FLASH_STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = ANTI_FLASH_STYLE_ID;
    style.textContent = `
      :root {
        color-scheme: dark !important;
      }

      html, body {
        background: #111 !important;
        color: #ddd !important;
      }

      a {
        color: #9dc3ff !important;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function clearAntiFlashGuard() {
    document.getElementById(ANTI_FLASH_STYLE_ID)?.remove();
  }

  function scheduleAntiFlashGuardClear() {
    window.addEventListener('load', clearAntiFlashGuard, { once: true });
    setTimeout(clearAntiFlashGuard, ANTI_FLASH_TIMEOUT);
  }

  function isNativeDarkThemeActive() {
    const classes = document.documentElement.classList;
    if (TARGET_MODE === 'night') {
      return classes.contains('skin-theme-clientpref-night');
    }

    return classes.contains('skin-theme-clientpref-os');
  }

  function waitForNativeDarkTheme() {
    if (!shouldUseDarkMode()) {
      clearAntiFlashGuard();
      return;
    }

    if (isNativeDarkThemeActive()) {
      requestAnimationFrame(() => {
        requestAnimationFrame(clearAntiFlashGuard);
      });
      return;
    }

    const observer = new MutationObserver(() => {
      if (!isNativeDarkThemeActive()) {
        return;
      }

      observer.disconnect();
      requestAnimationFrame(() => {
        requestAnimationFrame(clearAntiFlashGuard);
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });

    setTimeout(() => {
      observer.disconnect();
      clearAntiFlashGuard();
    }, ANTI_FLASH_TIMEOUT);
  }

  function writeAnonymousPreferenceCookie() {
    const prefs = Object.create(null);

    const cookieEntry = document.cookie
      .split(/;\s*/)
      .find((entry) => entry.startsWith(`${COOKIE_NAME}=`));

    if (cookieEntry) {
      const rawValue = cookieEntry.slice(COOKIE_NAME.length + 1);
      const decoded = decodeURIComponent(rawValue);

      decoded.split(',').forEach((entry) => {
        const match = entry.match(/^([\w-]+)-clientpref-(\w+)$/);
        if (match) {
          prefs[match[1]] = match[2];
        }
      });
    }

    prefs[FEATURE_NAME] = TARGET_MODE;

    const value = Object.keys(prefs)
      .map((key) => `${key}-clientpref-${prefs[key]}`)
      .join(',');

    document.cookie =
      `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax` +
      (location.protocol === 'https:' ? '; Secure' : '');
  }

  function persistAnonymousPreference() {
    try {
      if (window.mw?.user?.clientPrefs?.set) {
        window.mw.user.clientPrefs.set(FEATURE_NAME, TARGET_MODE);
        return;
      }
    } catch (_) {
      // Fall back to writing the same cookie directly.
    }

    writeAnonymousPreferenceCookie();
  }

  function primeNativePreferenceEarly() {
    if (!shouldUseDarkMode()) {
      return;
    }

    try {
      writeAnonymousPreferenceCookie();
    } catch (_) {
      // Ignore early cookie write failures and continue with the normal path.
    }
  }

  function persistLoggedInPreference() {
    const prefKey = detectLoggedInPrefKey();
    const mw = window.mw;

    if (!prefKey || !mw?.Api || !mw?.user?.options) {
      return;
    }

    if (String(mw.user.options.get(prefKey)) === TARGET_MODE) {
      return;
    }

    mw.user.options.set(prefKey, TARGET_MODE);
    new mw.Api().saveOption(prefKey, TARGET_MODE).catch(() => {});
  }

  function whenMediaWikiReady(callback, attemptsLeft = 400) {
    const mw = window.mw;

    if (typeof mw?.loader?.using === 'function') {
      mw.loader
        .using(['mediawiki.api', 'mediawiki.user', 'user.options'])
        .then(() => callback(), () => callback());
      return;
    }

    if (attemptsLeft <= 0) {
      callback();
      return;
    }

    setTimeout(() => whenMediaWikiReady(callback, attemptsLeft - 1), 25);
  }

  primeNativePreferenceEarly();
  installAntiFlashGuard();
  scheduleAntiFlashGuardClear();

  if (!hasNativeNightModeSupport()) {
    return;
  }

  applyThemeClassImmediately();

  whenMediaWikiReady(() => {
    const mw = window.mw;

    if (mw?.user?.isNamed?.()) {
      persistLoggedInPreference();
    } else {
      persistAnonymousPreference();
    }

    applyThemeClassImmediately();
    waitForNativeDarkTheme();
  });
})();