/**
 * Unit tests for BrowserTipTracker
 *
 * Tests contextual browser automation tip injection:
 * - Tool filtering (only interactive tools trigger tips)
 * - General tips shown on first interactive call
 * - Site-specific hostname matching
 * - Per-session deduplication
 * - URL edge cases
 * - Output format
 * - Data integrity of BROWSER_TIPS array
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserTipTracker, BROWSER_TIPS } from '../browser-tips.js';

describe('BrowserTipTracker', () => {
  let tracker: BrowserTipTracker;

  beforeEach(() => {
    tracker = new BrowserTipTracker();
  });

  // ========================================================================
  // Tool Filtering
  // ========================================================================

  describe('Tool filtering', () => {
    it('should return tips for interactive tools', () => {
      const interactiveTools = ['navigate', 'computer', 'form_input', 'find', 'read_page'];
      for (const tool of interactiveTools) {
        const freshTracker = new BrowserTipTracker();
        const result = freshTracker.getRelevantTips(tool, undefined);
        expect(result).not.toBeNull();
      }
    });

    it('should return null for non-interactive tools', () => {
      const nonInteractive = [
        'tabs_context_mcp', 'tabs_create_mcp', 'get_page_text',
        'javascript_tool', 'read_console_messages', 'read_network_requests',
        'resize_window', 'gif_creator', 'upload_image',
        'shortcuts_list', 'shortcuts_execute', 'update_plan', 'switch_browser',
      ];
      for (const tool of nonInteractive) {
        const result = tracker.getRelevantTips(tool, undefined);
        expect(result).toBeNull();
      }
    });
  });

  // ========================================================================
  // General Tips
  // ========================================================================

  describe('General tips', () => {
    it('should show general tips on first interactive call regardless of site', () => {
      const result = tracker.getRelevantTips('navigate', undefined);
      expect(result).not.toBeNull();
      expect(result).toContain('Browser Automation Tips (General):');
      expect(result).toContain('form_input');
    });

    it('should include all 5 general tips on first call', () => {
      const result = tracker.getRelevantTips('navigate', undefined)!;
      const bulletCount = (result.match(/^- /gm) || []).length;
      expect(bulletCount).toBe(5);
    });

    it('should show general tips even when a site-specific URL is provided', () => {
      const result = tracker.getRelevantTips('navigate', 'https://github.com/settings/tokens');
      expect(result).toContain('Browser Automation Tips (General):');
      expect(result).toContain('Browser Automation Tips (github.com):');
    });
  });

  // ========================================================================
  // Site-Specific Tips
  // ========================================================================

  describe('Site-specific tips', () => {
    it('should match 1password.com', () => {
      // Exhaust general tips first
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://my.1password.com/vaults');
      expect(result).toContain('1password.com');
      expect(result).toContain('add another field');
    });

    it('should match github.com', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://github.com/settings/tokens');
      expect(result).toContain('github.com');
      expect(result).toContain('form_input');
    });

    it('should match dashboard.render.com', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://dashboard.render.com/account/api-keys');
      expect(result).toContain('dashboard.render.com');
      expect(result).toContain('displayed once');
    });

    it('should match vercel.com', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://vercel.com/account/tokens');
      expect(result).toContain('vercel.com');
      expect(result).toContain('Team ID');
    });

    it('should match dash.cloudflare.com', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://dash.cloudflare.com/profile/api-tokens');
      expect(result).toContain('dash.cloudflare.com');
      expect(result).toContain('Zone ID');
    });

    it('should match supabase.com', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://supabase.com/dashboard/account/tokens');
      expect(result).toContain('supabase.com');
      expect(result).toContain('service_role');
    });

    it('should match cloud.elastic.co', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://cloud.elastic.co/deployments');
      expect(result).toContain('cloud.elastic.co');
      expect(result).toContain('Dev Tools Console');
    });

    it('should match resend.com', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://resend.com/api-keys');
      expect(result).toContain('resend.com');
      expect(result).toContain('displayed once');
    });

    it('should match app.codecov.io', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://app.codecov.io/gh/org/repo/settings');
      expect(result).toContain('app.codecov.io');
      expect(result).toContain('OAuth');
    });

    it('should match codecov.io (secondary hostname)', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://codecov.io/settings');
      expect(result).toContain('codecov.io');
      expect(result).toContain('OAuth');
    });
  });

  // ========================================================================
  // Subdomain Matching
  // ========================================================================

  describe('Subdomain matching', () => {
    it('should match subdomains via endsWith (my.1password.com matches 1password.com)', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://my.1password.com/vaults');
      expect(result).toContain('1password.com');
    });

    it('should not match partial domain names (not1password.com should not match 1password.com)', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://not1password.com');
      // Domain boundary matching: 'not1password.com' does NOT end with '.1password.com'
      // and is not equal to '1password.com', so no site-specific tips
      expect(result).toBeNull();
    });
  });

  // ========================================================================
  // Deduplication
  // ========================================================================

  describe('Deduplication', () => {
    it('should not show the same tip twice', () => {
      const first = tracker.getRelevantTips('navigate', undefined);
      expect(first).not.toBeNull();

      const second = tracker.getRelevantTips('navigate', undefined);
      expect(second).toBeNull();
    });

    it('should not re-show general tips when visiting a site', () => {
      // First call shows general tips
      tracker.getRelevantTips('navigate', undefined);

      // Second call with a site should only show site-specific
      const result = tracker.getRelevantTips('navigate', 'https://github.com');
      expect(result).toContain('github.com');
      expect(result).not.toContain('Browser Automation Tips (General):');
    });

    it('should not re-show site-specific tips for the same site', () => {
      // Show general + github tips
      tracker.getRelevantTips('navigate', 'https://github.com');

      // Second visit to github — all tips already shown
      const result = tracker.getRelevantTips('navigate', 'https://github.com');
      expect(result).toBeNull();
    });

    it('should show new site tips after previous site tips are exhausted', () => {
      // First call: general + github
      tracker.getRelevantTips('navigate', 'https://github.com');

      // Second call: vercel (new site, general already shown)
      const result = tracker.getRelevantTips('navigate', 'https://vercel.com');
      expect(result).not.toBeNull();
      expect(result).toContain('vercel.com');
    });
  });

  // ========================================================================
  // URL Edge Cases
  // ========================================================================

  describe('URL edge cases', () => {
    it('should handle undefined URL (general tips only)', () => {
      const result = tracker.getRelevantTips('navigate', undefined);
      expect(result).not.toBeNull();
      expect(result).toContain('General');
    });

    it('should handle malformed URL gracefully', () => {
      const result = tracker.getRelevantTips('navigate', 'not-a-url');
      // Should still return general tips, just skip site-specific
      expect(result).not.toBeNull();
      expect(result).toContain('General');
    });

    it('should handle URL with port', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://github.com:443/settings');
      expect(result).toContain('github.com');
    });

    it('should handle URL with path and query params', () => {
      tracker.getRelevantTips('navigate', undefined);
      const result = tracker.getRelevantTips('navigate', 'https://github.com/org/repo?tab=settings');
      expect(result).toContain('github.com');
    });

    it('should handle empty string URL (general tips only)', () => {
      const result = tracker.getRelevantTips('navigate', '');
      expect(result).not.toBeNull();
      expect(result).toContain('General');
    });
  });

  // ========================================================================
  // Output Format
  // ========================================================================

  describe('Output format', () => {
    it('should use --- delimiters', () => {
      const result = tracker.getRelevantTips('navigate', undefined)!;
      expect(result.startsWith('---')).toBe(true);
      expect(result.endsWith('---')).toBe(true);
    });

    it('should use bullet points for tips', () => {
      const result = tracker.getRelevantTips('navigate', undefined)!;
      expect(result).toContain('- ');
    });

    it('should include section header', () => {
      const result = tracker.getRelevantTips('navigate', undefined)!;
      expect(result).toContain('Browser Automation Tips (');
    });

    it('should include both general and site sections when applicable', () => {
      const result = tracker.getRelevantTips('navigate', 'https://github.com')!;
      expect(result).toContain('Browser Automation Tips (General):');
      expect(result).toContain('Browser Automation Tips (github.com):');
    });
  });

  // ========================================================================
  // Data Integrity
  // ========================================================================

  describe('BROWSER_TIPS data integrity', () => {
    it('should have unique IDs', () => {
      const ids = BROWSER_TIPS.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have non-empty IDs', () => {
      for (const tip of BROWSER_TIPS) {
        expect(tip.id.length).toBeGreaterThan(0);
      }
    });

    it('should have non-empty text', () => {
      for (const tip of BROWSER_TIPS) {
        expect(tip.text.length).toBeGreaterThan(0);
      }
    });

    it('should have non-empty tools array', () => {
      for (const tip of BROWSER_TIPS) {
        expect(tip.tools.length).toBeGreaterThan(0);
      }
    });

    it('should only reference valid interactive tools', () => {
      const validTools = ['navigate', 'computer', 'form_input', 'find', 'read_page'];
      for (const tip of BROWSER_TIPS) {
        for (const tool of tip.tools) {
          expect(validTools).toContain(tool);
        }
      }
    });

    it('should have valid hostnames array (can be empty for general tips)', () => {
      for (const tip of BROWSER_TIPS) {
        expect(Array.isArray(tip.hostnames)).toBe(true);
      }
    });

    it('should have 5 general tips and 9 site-specific tips', () => {
      const general = BROWSER_TIPS.filter((t) => t.hostnames.length === 0);
      const siteSpecific = BROWSER_TIPS.filter((t) => t.hostnames.length > 0);
      expect(general.length).toBe(5);
      expect(siteSpecific.length).toBe(9);
    });

    it('should have 14 total tips', () => {
      expect(BROWSER_TIPS.length).toBe(14);
    });
  });
});
