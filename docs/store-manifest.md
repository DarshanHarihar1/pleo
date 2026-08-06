# Dual-manifest strategy (HLD §11.1)

Pleo ships two distribution shapes. **Personal / unpacked is the default** for ship-to-self.

| Build | Host access | When |
|---|---|---|
| **Unpacked (this repo)** | `host_permissions: ["<all_urls>", …provider APIs…]` + content_scripts `matches: ["<all_urls>"]` | Daily self-use; no per-site grant prompt |
| **Chrome Web Store (later)** | Move page hosts to `optional_host_permissions: ["<all_urls>"]`; inject via `chrome.scripting` after user grant | Quieter install; Chrome asks on first Fill |

## Personal / unpacked (current `extension/manifest.json`)

- Content scripts declare `all_frames: true` on `<all_urls>`.
- Provider API origins stay in `host_permissions` (Anthropic / OpenAI / Groq).
- Do **not** submit this file unchanged to the Web Store.

## Store path (not implemented in Phase 6)

When preparing a Store build:

1. Remove `<all_urls>` from `host_permissions` / `content_scripts.matches`.
2. Add `"optional_host_permissions": ["<all_urls>"]`.
3. On Scan/Fill, call `chrome.permissions.request({ origins: [origin + '/*'] })` (or all-urls) before injecting.
4. Keep the same trust boundary: API key + full profile stay in the service worker / side panel only.

See `Pleo-HLD.md` §11 and Appendix A.
