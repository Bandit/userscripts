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

### `Shudder-Watched-on-Floppy.user.js`

Adds a watched checkmark to Shudder movie and series cards by comparing their titles with a user-configured Floppy instance's watch history. The Floppy-style indicator shows the latest watch time on hover and follows Shudder's in-page navigation and newly loaded grids automatically.

A Floppy instance URL and API token are required and are stored by the userscript manager. After the initial history load, the script caches watched titles and requests only recent movie and episode history. The userscript menu provides connection settings, an explicit connection-copy command, refresh and cache-rebuild commands, and a sanitized debug log. Full history loading uses adaptive pagination to recover from slow pages.

### `Shudder-Watchlist-to-Floppy.user.js`

Syncs the movie and series cards on Shudder My List to a custom Floppy list. Use the button beside the My List heading or the userscript menu to sync. Setup can create a new "Shudder Watchlist" list or use an existing editable list. The default additive mode never removes list entries; optional mirror mode removes only entries previously added by this script to the same list and Floppy connection.

Titles are matched conservatively against Floppy's TMDB movie or TV search using Shudder's content type. A unique exact normalized title is tracked in Floppy with Planning status if needed, then added to the selected list. Ambiguous matches open a visual review dialog with Shudder artwork beside the candidate posters; confirmed choices are remembered for later syncs and can be cleared from the userscript menu. Missing matches remain in the last-sync report.

Userscript-manager storage is isolated between separate scripts, so credentials are not shared silently. Both Shudder scripts provide copy and import menu commands for an explicit clipboard handoff in either direction. The API token is never placed in Shudder's page storage; treat the temporary clipboard contents like a password.

### `Wikipedia-Native-Darkmode-Auto-Enable.user.js`

Automatically enables Wikipedia's native dark-mode preference on supported desktop and mobile skins. It runs at document start to reduce light-theme flashing and supports both anonymous and signed-in preference mechanisms. I hate that this script is even needed.

### `Floppy-History-Analyzer.html`

A standalone browser tool for finding duplicate entries in a Floppy watch history. It loads paginated history data, groups likely duplicates, retrieves exact consumption details, and recommends which entries to retain.

Deletion is guarded by per-entry checkboxes, group validation, a review dialog, and explicit confirmation. The Floppy URL and API token are kept in the current tab's `sessionStorage`; exported analysis files do not include the token.

Download and open the HTML file directly in a browser to use it.

