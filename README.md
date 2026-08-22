# Userscripts

A miscellaneous collection of scripts I wrote to solve my own frustrations with various websites. They are shared in case somebody else finds them useful, but there is no warranty and no support desk. Use them freely, but expect the occasional rough edge.

I recommend [Violentmonkey](https://violentmonkey.github.io/) for running the userscripts. Install one by opening its raw GitHub URL in a browser with Violentmonkey or another userscript manager installed. Configuration and credentials are entered locally after installation; this repository does not include personal API tokens or passwords.

## Files

### `Configurable-Auto-Refresh.user.js`

Adds a configurable automatic page refreshing toolbar to the bottom right corner of any website. It includes pause and countdown controls and can optionally send a notification when the rendered page content changes. Good for queue pages and waiting for things to unlock.

### `Magnet-to-qBittorrent.user.js`

"Takes over" the context menu when right-clicking any `magnet:` link on any webpage and lets you send it to a qBittorrent WebUI. It supports saved connection settings, category selection, tags, save-path overrides, paused downloads, sequential downloading, and related torrent options.

### `Prime-Video-to-Floppy.user.js`

Reads the signed-in user's Amazon Prime Video watch-history page, matches titles against Floppy's media catalog, and records completed watches in a user-configured Floppy instance. It supports review, manual matching, caching, incremental synchronization, and retry-safe per-item scrobbling.

A [Floppy](https://github.com/dannyvfilms/Floppy) instance URL and API token are required and are stored by the userscript manager.

### `Prime-Video-to-Trakt.user.js`

Reads Amazon Prime Video watch history, matches movies and episodes against Trakt, and synchronizes completed watches. It provides review and manual matching for ambiguous titles and uses Trakt's device authorization flow.

A Trakt application client ID and client secret are required and are stored by the userscript manager. Sadly this requires VIP now, which is why I moved to [Floppy](https://github.com/dannyvfilms/Floppy).

### `Wikipedia-Native-Darkmode-Auto-Enable.user.js`

Automatically enables Wikipedia's native dark-mode preference on supported desktop and mobile skins. It runs at document start to reduce light-theme flashing and supports both anonymous and signed-in preference mechanisms. I hate that this script is even needed.

### `Floppy-History-Analyzer.html`

A standalone browser tool for finding duplicate entries in a Floppy watch history. It loads paginated history data, groups likely duplicates, retrieves exact consumption details, and recommends which entries to retain.

Deletion is guarded by per-entry checkboxes, group validation, a review dialog, and explicit confirmation. The Floppy URL and API token are kept in the current tab's `sessionStorage`; exported analysis files do not include the token.

Download and open the HTML file directly in a browser to use it.

