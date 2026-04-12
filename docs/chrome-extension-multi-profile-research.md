# Chrome Extension Management: Multi-Profile Research

Research into how Chrome profiles interact with the AppleScript-based extension management tools (`list_chrome_extensions`, `reload_chrome_extension`) on the chrome-bridge MCP server, and what options exist for profile-aware targeting.

---

## Current Behavior

`tell application "Google Chrome"` sees **all windows from all running profiles as a single flat list**. The `executeOnExtensionsPage()` function iterates them sequentially and grabs the **first** `chrome://extensions` tab it finds (or creates one in `window 1`). Which profile gets targeted is effectively arbitrary -- it depends on window ordering, which is influenced by focus recency.

Chrome's AppleScript dictionary exposes **no profile metadata** on window objects. There is no `profile of window`, `person of window`, or similar property.

---

## Chrome APIs and What They Can Do

### `chrome.developerPrivate` (chrome://extensions page context only)

Available only in the main world of `chrome://extensions` pages. Not an extension API -- cannot be called from a regular extension's service worker or content script.

| Method | Capability |
|--------|-----------|
| `chrome.developerPrivate.reload(extensionId, {failQuietly: true})` | Reload **any** extension in the profile by ID |
| `chrome.developerPrivate.getExtensionsInfo()` | List all extensions with full metadata (id, name, version, state, type, description) |
| `chrome.developerPrivate.updateExtensionConfiguration({extensionId, enable})` | Enable/disable extensions |

This is what our current AppleScript tools use. It's the **only API that can reload arbitrary extensions**.

### `chrome.management` (extension API, requires `management` permission)

Available to extensions that declare `"management"` in `manifest.json` permissions.

| Method | Capability |
|--------|-----------|
| `chrome.management.getAll()` | List extensions in the current profile |
| `chrome.management.get(extensionId)` | Get info for a specific extension |
| `chrome.management.setEnabled(extensionId, enabled)` | Enable/disable an extension |
| `chrome.management.uninstall(extensionId)` | Uninstall an extension |

**Cannot reload extensions.** There is no `chrome.management.reload()`. This API can list, enable/disable, and uninstall -- but not trigger a reload.

### `chrome.runtime.reload()` (extension self-reload only)

Reloads **the calling extension itself**. Cannot target other extensions.

---

## Approaches for Profile-Aware Targeting

### Approach 1: Window Title Matching (AppleScript)

Chrome window titles include the profile name as a suffix:
- Default profile: `"GitHub - Google Chrome"` (no profile suffix)
- Named profile: `"GitHub - Google Chrome - Work"`
- Named profile: `"GitHub - Google Chrome - Personal"`

`name of window w` in AppleScript returns the full title string. We could:

1. Enumerate all windows and extract profile names by parsing the title suffix after the last ` - Google Chrome` occurrence
2. Add an optional `profile` parameter to both tools
3. Filter windows to only those matching the requested profile before searching for `chrome://extensions`

**Pros:**
- Works with the existing `chrome.developerPrivate` approach (can reload any extension)
- No changes to the Chrome extension needed
- Quick to implement

**Cons:**
- String matching against window titles is fragile
- Localized Chrome builds may have different title formats
- Profile names with hyphens could cause ambiguous parsing
- Default/unnamed profiles have no suffix -- need fallback logic
- macOS only

### Approach 2: Socket-Based via Chrome Extension

The native host already creates per-profile sockets at `/tmp/claude-mcp-browser-bridge-{user}/{pid}.sock`. Each Chrome profile runs its own native host process. The `ChromeBridgeClient` discovers and connects to all sockets. Profile isolation comes for free through socket routing.

To add extension management via sockets:
1. Add `"management"` permission to `tools/chrome-extension/extension/manifest.json`
2. Add tool handlers in the service worker for `list_extensions` and `manage_extension`
3. Route through the existing native messaging bridge

**Pros:**
- Profile isolation is automatic (each socket = one profile)
- Cross-platform (works on macOS, Linux, Windows)
- Leverages existing architecture
- The `switch_browser` tool already provides a profile selection UX

**Cons:**
- `chrome.management` **cannot reload** extensions -- only list/enable/disable/uninstall
- Requires extension manifest change and rebuild
- Requires the Gentyr extension to be installed in the target profile

### Approach 3: Hybrid (Recommended)

Combine approaches for the best of both:

| Operation | Method | Profile-Aware? | Cross-Platform? |
|-----------|--------|---------------|-----------------|
| **List extensions** | Socket (`chrome.management.getAll()`) | Yes (automatic) | Yes |
| **Enable/disable** | Socket (`chrome.management.setEnabled()`) | Yes (automatic) | Yes |
| **Reload extension** | AppleScript (`chrome.developerPrivate.reload()`) | Via window title matching | macOS only |
| **Self-reload** | Socket (`chrome.runtime.reload()`) | Yes (automatic) | Yes |

For listing: use the socket approach (profile-aware, cross-platform).
For reloading: keep AppleScript + `chrome.developerPrivate` with window title filtering added for profile targeting.

---

## Socket Architecture Details

### How sockets map to profiles

```
Chrome Profile "Default"
  -> Extension instance
    -> Native host process (PID 12345)
      -> /tmp/claude-mcp-browser-bridge-user/12345.sock

Chrome Profile "Work"
  -> Extension instance
    -> Native host process (PID 12346)
      -> /tmp/claude-mcp-browser-bridge-user/12346.sock
```

`ChromeBridgeClient.discoverSockets()` (server.ts) scans the socket directory and connects to all `.sock` files. Tab routing maps `tabId -> socketPath` so tools execute on the correct profile's browser.

### switch_browser tool

Broadcasts a connection request to all sockets. The user clicks "Connect" in the desired browser/profile. This is the existing multi-profile selection mechanism for socket-based tools.

### Permission grant script profile awareness

`scripts/grant-chrome-ext-permissions.sh` already iterates all profiles:
```bash
# Default profile
process_profile "$CHROME_DIR/Default" "$EXTENSION_ID"
# Numbered profiles (Profile 1, Profile 2, etc.)
for profile_dir in "$CHROME_DIR"/Profile\ *; do
    process_profile "$profile_dir" "$EXTENSION_ID"
done
```

---

## Implementation Notes (for future reference)

### Adding `profile` param to AppleScript tools

```applescript
-- Extract profile name from window title
-- Format: "Page Title - Google Chrome" (default) or "Page Title - Google Chrome - ProfileName"
set windowTitle to name of window w
set profileSuffix to ""
if windowTitle contains " - Google Chrome - " then
  -- Extract everything after the last " - Google Chrome - "
  set AppleScript's text item delimiters to " - Google Chrome - "
  set profileSuffix to last text item of windowTitle
  set AppleScript's text item delimiters to ""
end if
```

### Adding `management` permission to extension

In `tools/chrome-extension/extension/manifest.json`, add `"management"` to the permissions array. Then in the service worker, register handlers for `chrome.management.getAll()` etc. The native host routing (`host.cjs`) requires no changes -- new tools flow through the existing `tool_request` envelope.

### Extension ID format

Chrome extension IDs are 32 lowercase a-p characters (base-16 encoding of the extension's public key hash using a-p instead of 0-9a-f). Validated in the current implementation with `/^[a-p]{32}$/`.

---

## Summary

The fundamental constraint is that **reloading arbitrary extensions requires `chrome.developerPrivate.reload()`**, which is only available on `chrome://extensions` pages (not to extensions via any API). This means AppleScript remains the only mechanism for triggering reloads on macOS. Profile targeting for reloads requires window title matching as a workaround.

For listing and enable/disable operations, the socket-based approach via `chrome.management` is cleaner and automatically profile-aware.
