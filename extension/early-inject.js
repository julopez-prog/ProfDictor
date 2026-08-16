/**
 * Injects the page bridge at document_start.
 *
 * The bridge records the requests the AMIS app makes to list classes, and then
 * replays them with a different term. That only works if the bridge is in place
 * before Nuxt boots, which is why this runs at document_start instead of waiting
 * for the main content script at document_idle.
 *
 * Kept deliberately tiny: at document_start `document.head` may not exist yet,
 * so the script tag goes on `documentElement`.
 */
(() => {
  if (document.getElementById("profdictor-bridge")) return;
  try {
    const s = document.createElement("script");
    s.id = "profdictor-bridge";
    s.src = chrome.runtime.getURL("page-bridge.js");
    s.async = false;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (_) {
    // The main content script injects the bridge again on first use, so a
    // failure here only costs us the recorded-traffic shortcut.
  }
})();
