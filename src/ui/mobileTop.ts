// Shared mobile top-offset logic for ChatView and ContextView.
//
// Obsidian mobile offsets .view-content with margin-top so content clears the
// safe area + top chrome (tab bar / view-header). We hide the view-header
// (redundant with our own toolbar), so we must re-apply the offset ourselves
// as padding-top on our root — but only what is actually IN FLOW above the
// content. Floating/fixed bars overlay the content and must NOT be cleared
// (they are drawn on top by the OS/browser).

const TOP_CHROME_SELECTORS = [
  ".mobile-navbar",
  ".workspace-tab-header-container",
  ".workspace-ribbon",
];

/** Compute how far down our toolbar must sit on mobile (px from top). */
export function computeMobileTopOffset(): number {
  if (!document.body.classList.contains("is-mobile")) return 0;
  const body = getComputedStyle(document.body);
  const safe = parseFloat(body.getPropertyValue("--safe-area-inset-top")) || 0;

  // Any in-flow top chrome that content must clear.
  for (const sel of TOP_CHROME_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "absolute") continue; // overlays content
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 0) return Math.max(safe, rect.bottom);
  }

  // Nothing in flow — content starts right below the safe area.
  return safe;
}

/**
 * Keep the root's top padding in sync with the layout while the view is open.
 * Re-checks every 2s (cheap: a computed style + one rect query, mobile only):
 * zeroes Obsidian's margin if it (re)appears and re-applies the correct
 * padding when the top chrome changes (e.g. a tab bar appears on some
 * devices). Returns a cleanup function.
 */
export function startTopSync(rootEl: HTMLElement, contentEl: HTMLElement): () => void {
  if (!document.body.classList.contains("is-mobile")) return () => {};
  const sync = (): void => {
    if (!document.body.classList.contains("is-mobile")) return;
    const marginTop = parseFloat(getComputedStyle(contentEl).marginTop) || 0;
    if (marginTop > 0) {
      contentEl.style.setProperty("margin-top", "0px", "important");
    }
    const target = computeMobileTopOffset();
    const pad = parseFloat(rootEl.style.paddingTop) || 0;
    if (Math.abs(pad - target) > 1) {
      rootEl.style.paddingTop = target + "px";
      rootEl.style.boxSizing = "border-box";
    }
  };
  const timer = window.setInterval(sync, 2000);
  return () => window.clearInterval(timer);
}
