/**
 * Demo Interrupt Content Script
 *
 * Detects Escape keypress during headed demos and signals the extension.
 * Runs on all URLs in the ISOLATED world. Updates the persona overlay DOM
 * directly for instant visual feedback, then forwards the interrupt signal
 * through the native messaging pipeline to the MCP server.
 *
 * Chain: keydown → overlay update → chrome.runtime.sendMessage →
 *        service worker → native host → signal file → MCP server
 */
(() => {
  // Deduplicate across navigations and multiple script injections
  if (window.__gentyrInterruptListenerInstalled) return;
  window.__gentyrInterruptListenerInstalled = true;

  let interrupted = false;

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || interrupted) return;
    interrupted = true;

    // ── Instant visual feedback: update persona overlay DOM ──────────────
    // DOM is shared between ISOLATED and MAIN worlds, so we can modify it directly.
    const overlay = document.getElementById('demo-persona-overlay');
    if (overlay) {
      // Remove step progress bar
      const stepProgress = document.getElementById('demo-step-progress');
      if (stepProgress) stepProgress.remove();

      // Remove thinking bubble
      const bubble = document.getElementById('demo-thinking-bubble');
      if (bubble) bubble.remove();

      // Update status icon to amber pause
      const iconEl = document.getElementById('demo-overlay-status-icon');
      if (iconEl) {
        iconEl.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;vertical-align:middle">' +
          '<rect x="1" y="1" width="14" height="14" rx="3" fill="#f59e0b"/>' +
          '<rect x="5" y="4.5" width="2.5" height="7" rx="0.5" fill="white"/>' +
          '<rect x="8.5" y="4.5" width="2.5" height="7" rx="0.5" fill="white"/>' +
          '</svg>';
      }

      // Update border color to amber
      overlay.style.borderLeftColor = '#f59e0b';

      // Replace overlay content after icon row with interrupted message
      const children = Array.from(overlay.children);
      for (let i = 1; i < children.length; i++) children[i].remove();

      const msg = document.createElement('div');
      msg.style.cssText =
        'font-size:12px;color:rgba(255,255,255,0.7);margin-top:4px;line-height:1.4;';
      msg.textContent = 'Demo Interrupted \u2014 interact freely';
      overlay.appendChild(msg);
    }

    // ── Also try the exposeFunction bridge (instant in-process interrupt) ─
    // If setupDemoInterrupt(context) was called in fixtures, this triggers the
    // full interrupt flow (progress file write, context.close patch, keepalive).
    // Injected into MAIN world via inline script. CSP may block this — non-fatal.
    try {
      const script = document.createElement('script');
      script.textContent =
        'if(typeof window.__gentyrDemoInterrupt==="function"&&!window.__gentyrDemoInterrupted){' +
        'window.__gentyrDemoInterrupted=true;window.__gentyrDemoInterrupt();}';
      document.documentElement.appendChild(script);
      script.remove();
    } catch {
      // CSP blocked inline script — fall through to extension signal path
    }

    // ── Signal via extension native messaging (framework-level path) ─────
    // This reaches the MCP server within ~5 seconds via:
    // service worker → native host → signal file → MCP server background monitor
    try {
      chrome.runtime.sendMessage({ type: 'demo_interrupt' });
    } catch {
      // Extension context may be invalidated — ignore
    }
  });
})();
