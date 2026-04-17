import './assets/service-worker.js';

// Forward demo interrupt signals from content script to native host.
// Uses sendNativeMessage (one-shot) rather than the persistent port managed
// by the compiled service worker — avoids coupling to its internal state.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'demo_interrupt') {
    chrome.runtime.sendNativeMessage(
      'com.gentyr.chrome_browser_extension',
      { type: 'demo_interrupt', tabId: sender.tab?.id, url: sender.tab?.url },
      () => { /* response or lastError — ignore */ },
    );
    sendResponse({ ack: true });
    return false; // synchronous response
  }
});
