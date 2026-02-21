/**
 * Browser Automation Tips — Contextual tips injected into chrome-bridge
 * tool responses based on the site the agent is interacting with.
 *
 * Tips are sourced from docs/SETUP-GUIDE.md and shown at most once per
 * MCP server session (lifetime = Claude Code session).
 */

// ============================================================================
// Types
// ============================================================================

export interface BrowserTip {
  /** Unique identifier for dedup tracking */
  id: string;
  /** Hostnames that trigger this tip (empty = all sites) */
  hostnames: string[];
  /** Tools that trigger tip evaluation */
  tools: string[];
  /** Tip text shown to the agent */
  text: string;
}

// ============================================================================
// Tip Data (verbatim from docs/SETUP-GUIDE.md)
// ============================================================================

/** Interactive tools that trigger tip evaluation */
const INTERACTIVE_TOOLS = ['navigate', 'computer', 'form_input', 'find', 'read_page'] as const;
type InteractiveTool = typeof INTERACTIVE_TOOLS[number];

const ALL_INTERACTIVE = [...INTERACTIVE_TOOLS] as string[];

export const BROWSER_TIPS: BrowserTip[] = [
  // --- General tips (any site) ---
  {
    id: 'general-form-input',
    hostnames: [],
    tools: ALL_INTERACTIVE,
    text: 'Prefer `form_input` over `click` + `type` for filling form fields — it\'s more reliable and handles special characters (e.g., `/`, `@`) that `type` may misinterpret as keyboard shortcuts.',
  },
  {
    id: 'general-read-page-interactive',
    hostnames: [],
    tools: ALL_INTERACTIVE,
    text: 'Use `read_page(filter="interactive")` to discover form elements and buttons before interacting with them.',
  },
  {
    id: 'general-zoom-verify',
    hostnames: [],
    tools: ALL_INTERACTIVE,
    text: 'Use the `computer` tool\'s `zoom` action to verify small UI elements (checkboxes, toggles, dropdown states) before and after interaction.',
  },
  {
    id: 'general-get-page-text',
    hostnames: [],
    tools: ALL_INTERACTIVE,
    text: 'Use `get_page_text` to extract values from the page (API keys, tokens, IDs) rather than trying to select/copy text via UI interactions.',
  },
  {
    id: 'general-extension-recovery',
    hostnames: [],
    tools: ALL_INTERACTIVE,
    text: 'Chrome Extension interference: Browser extensions (especially 1Password) can inject errors like `Cannot access a chrome-extension:// URL` across unrelated sites. Recovery: call `navigate()` to the current URL to refresh the page, then retry.',
  },

  // --- Site-specific tips ---
  {
    id: '1password-fields',
    hostnames: ['1password.com'],
    tools: ALL_INTERACTIVE,
    text: 'When adding fields to a 1Password item, the `+ add another field` button and its dropdown chevron (`▼`) are **separate clickable controls**. Click the chevron first to select the field type (e.g., "password"), then click the `+` button to create the field. After creating the field, use `form_input` to set both the label and value. Built-in template fields may not match the required field name — always add a **new custom field** with the exact name specified.',
  },
  {
    id: 'github-form-input',
    hostnames: ['github.com'],
    tools: ALL_INTERACTIVE,
    text: 'Use `form_input` (not `type`) for the token name field, especially if the name contains `/` or other special characters that browsers interpret as shortcuts.',
  },
  {
    id: 'render-api-key-capture',
    hostnames: ['dashboard.render.com'],
    tools: ALL_INTERACTIVE,
    text: 'The Render API key is displayed once after creation. Use `get_page_text` immediately to capture it before navigating away.',
  },
  {
    id: 'vercel-token-capture',
    hostnames: ['vercel.com'],
    tools: ALL_INTERACTIVE,
    text: 'The Vercel token is displayed once after creation. Use `get_page_text` to capture it. The Team ID on the Settings page can also be extracted via `get_page_text` — look for the string labeled "Team ID".',
  },
  {
    id: 'cloudflare-zone-id',
    hostnames: ['dash.cloudflare.com'],
    tools: ALL_INTERACTIVE,
    text: 'The Cloudflare Zone ID is visible on the domain overview page without clicking into any sub-menus. Use `get_page_text` to extract it — look for a 32-character hex string near "Zone ID" in the right sidebar. The token creation flow uses a multi-step wizard with dropdowns; use `read_page(filter="interactive")` to find selectors at each step.',
  },
  {
    id: 'supabase-keys',
    hostnames: ['supabase.com'],
    tools: ALL_INTERACTIVE,
    text: 'The Supabase API page shows the `anon` key, `service_role` key, and URL all on one page. Use `get_page_text` to extract all three at once. The `service_role` key is hidden behind a "Reveal" button — click it first, then extract. For the management access token, it is displayed once after generation — capture immediately with `get_page_text`.',
  },
  {
    id: 'elastic-dev-tools',
    hostnames: ['cloud.elastic.co'],
    tools: ALL_INTERACTIVE,
    text: 'The Elastic Cloud "Create API Key" UI has unreliable toggles and role selectors with browser automation. **Strongly prefer using the Dev Tools Console** (REST API) instead: navigate to Dev Tools, run `POST /_security/api_key` with the desired role descriptors, then use `get_page_text` to extract the JSON response. Store the `encoded` value — it is the base64-encoded `id:api_key` string ready for use.',
  },
  {
    id: 'resend-api-key-capture',
    hostnames: ['resend.com'],
    tools: ALL_INTERACTIVE,
    text: 'The Resend API key is displayed once after creation. Use `get_page_text` to capture it immediately. Select the permission dropdown ("Full access" vs "Sending access") before clicking "Create".',
  },
  {
    id: 'codecov-oauth-workaround',
    hostnames: ['app.codecov.io', 'codecov.io'],
    tools: ALL_INTERACTIVE,
    text: 'Codecov uses GitHub OAuth for login, which can be disrupted by Chrome extensions. If the OAuth redirect fails or loops, ask the user to log in manually first, then navigate directly to the repository settings page. The Upload Token is visible on the settings page without any reveal/toggle — use `get_page_text` to extract it.',
  },
];

// ============================================================================
// Tracker
// ============================================================================

export class BrowserTipTracker {
  private shownTips = new Set<string>();

  /**
   * Returns formatted tip text for the given tool call and tab URL,
   * or null if no tips are relevant or all relevant tips have been shown.
   */
  getRelevantTips(toolName: string, tabUrl: string | undefined): string | null {
    // Only interactive tools trigger tip evaluation
    if (!INTERACTIVE_TOOLS.includes(toolName as InteractiveTool)) {
      return null;
    }

    // Parse hostname from URL
    let hostname: string | undefined;
    if (tabUrl) {
      try {
        hostname = new URL(tabUrl).hostname;
      } catch {
        // Malformed URL — skip site-specific tips
      }
    }

    // Collect unseen tips that match this context
    const matchingTips: BrowserTip[] = [];

    for (const tip of BROWSER_TIPS) {
      // Skip already-shown tips
      if (this.shownTips.has(tip.id)) continue;

      // Check tool match
      if (!tip.tools.includes(toolName)) continue;

      // Check hostname match
      if (tip.hostnames.length > 0) {
        // Site-specific: hostname must match
        if (!hostname) continue;
        const matches = tip.hostnames.some((h) => hostname === h || hostname!.endsWith('.' + h));
        if (!matches) continue;
      }

      matchingTips.push(tip);
    }

    if (matchingTips.length === 0) return null;

    // Mark all as shown
    for (const tip of matchingTips) {
      this.shownTips.add(tip.id);
    }

    // Determine site label
    const siteSpecific = matchingTips.filter((t) => t.hostnames.length > 0);
    const general = matchingTips.filter((t) => t.hostnames.length === 0);

    const sections: string[] = [];

    if (general.length > 0) {
      sections.push(
        '---',
        'Browser Automation Tips (General):',
        ...general.map((t) => `- ${t.text}`),
      );
    }

    if (siteSpecific.length > 0) {
      const siteLabel = hostname ?? 'Site';
      sections.push(
        general.length > 0 ? '' : '---',
        `Browser Automation Tips (${siteLabel}):`,
        ...siteSpecific.map((t) => `- ${t.text}`),
      );
    }

    sections.push('---');

    return sections.join('\n');
  }
}
