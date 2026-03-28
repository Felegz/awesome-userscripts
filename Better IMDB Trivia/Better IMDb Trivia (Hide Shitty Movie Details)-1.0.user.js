// ==UserScript==
// @name         Better IMDb Trivia (Hide Shitty Movie Details)
// @namespace    https://github.com/Felegz/awesome-userscripts
// @version      1.2
// @author       Felegz
// @description  Hide IMDb trivia items with poor Wilson score (statistically disliked). Works on /title/*/trivia pages and handles lazy loading.
// @license      MIT
// @homepageURL  https://github.com/Felegz/awesome-userscripts
// @match        https://www.imdb.com/title/*/trivia*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  const ENABLE_KEY = 'imdb_trivia_hider_enabled_v1';
  const HIDDEN_FLAG = 'data-trivia-hidden-by-script';
  const PROCESSED_FLAG = 'data-trivia-processed-by-script';
  const itemData = new Map(); // element -> { up, down, text, wilson }

  /****************** utilities for GM_getValue compatibility ******************/
  function gmGet(key, defaultValue) {
    try {
      const r = (typeof GM_getValue === 'function') ? GM_getValue(key) : undefined;
      // GM_getValue may return a Promise in some environments; handle both
      if (r && typeof r.then === 'function') return r.then(v => (v === undefined ? defaultValue : v));
      return Promise.resolve((r === undefined) ? defaultValue : r);
    } catch (e) {
      return Promise.resolve(defaultValue);
    }
  }
  function gmSet(key, value) {
    try {
      const r = (typeof GM_setValue === 'function') ? GM_setValue(key, value) : undefined;
      if (r && typeof r.then === 'function') return r;
      return Promise.resolve();
    } catch (e) {
      return Promise.resolve();
    }
  }
  /***************************************************************************/

  // CSS to hide items and style panel
  if (typeof GM_addStyle === 'function') {
    GM_addStyle(`
      .trivia-hidden-by-script{display:none !important;opacity:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;}
      .trivia-hider-panel{
        position:fixed; right:12px; bottom:12px; z-index:2147483647;
        background:rgba(20,20,20,0.94); color:#fff; padding:8px 10px; border-radius:8px;
        font-family:Arial,Helvetica,sans-serif; font-size:13px; box-shadow:0 6px 18px rgba(0,0,0,0.4);
      }
      .trivia-hider-panel button, .trivia-hider-panel input[type="checkbox"]{cursor:pointer; margin-left:6px;}
      .trivia-hider-panel .label {margin-right:6px;}
      .trivia-top50-overlay{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;}
      .trivia-top50-modal{background:#1a1a1a;color:#e8e8e8;border-radius:10px;width:700px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.8);}
      .trivia-top50-header{padding:14px 18px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;font-size:15px;}
      .trivia-top50-close{background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:0 4px;line-height:1;}
      .trivia-top50-close:hover{color:#fff;}
      .trivia-top50-list{overflow-y:auto;padding:0 18px;flex:1;}
      .trivia-top50-item{padding:12px 0;border-bottom:1px solid #242424;}
      .trivia-top50-rank{font-size:11px;color:#666;margin-bottom:4px;}
      .trivia-top50-text{font-size:13px;line-height:1.5;color:#ddd;}
      .trivia-top50-votes{font-size:12px;color:#888;margin-top:6px;}
    `);
  }

  // parse integer from a node (strip non-digits)
  function parseCount(node) {
    if (!node) return null;
    const t = node.textContent || '';
    const digits = t.replace(/[^\d]/g, '');
    return digits.length ? parseInt(digits, 10) : 0;
  }

  // Wilson score lower bound on dislike ratio (95% CI) — naturally handles small sample sizes
  function wilsonDislike(up, down) {
    const n = up + down;
    if (n === 0) return 0;
    const z = 1.96;
    const p = down / n;
    return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // process single trivia item element
  function processItem(item, enabled) {
    if (!item || item.hasAttribute(PROCESSED_FLAG)) return;
    item.setAttribute(PROCESSED_FLAG, '1');
    try {
      const upNode = item.querySelector('.ipc-voting__label__count--up');
      const downNode = item.querySelector('.ipc-voting__label__count--down');

      // if neither exists, nothing to do
      if (!upNode && !downNode) return;

      const up = parseCount(upNode);
      const down = parseCount(downNode);

      // if parsing failed (null) — don't hide
      if (up === null || down === null) return;

      const textNode = item.querySelector('.ipc-html-content-inner-div') || item.querySelector('p');
      const text = (textNode?.textContent || '').trim().slice(0, 400);
      const wilson = wilsonDislike(up, down);
      itemData.set(item, { up, down, text, wilson });

      // Wilson lower bound > 0.55: statistically confident that 55%+ of votes are dislikes.
      // Requires enough votes to be meaningful — avoids hiding facts with just 1 downvote.
      if (enabled && wilson > 0.55) {
        item.classList.add('trivia-hidden-by-script');
        item.setAttribute(HIDDEN_FLAG, '1');
      } else {
        item.classList.remove('trivia-hidden-by-script');
        item.removeAttribute(HIDDEN_FLAG);
      }
    } catch (err) {
      console.error('trivia-hider: processItem error', err);
    }
  }

  // scan all trivia items on page
  function scanAll(enabled) {
    try {
      const items = document.querySelectorAll('[data-testid="item-id"]');
      if (!items || items.length === 0) return;
      items.forEach(item => processItem(item, enabled));
    } catch (e) {
      console.error('trivia-hider: scanAll error', e);
    }
  }

  // show modal with top 50 most disliked trivia facts (sorted by net dislike score)
  function showTop50Modal() {
    const entries = Array.from(itemData.entries())
      .filter(([el]) => document.body.contains(el))
      .map(([, d]) => d)
      .filter(d => d.down > 0)
      .sort((a, b) => (b.down - b.up) - (a.down - a.up))
      .slice(0, 50);

    if (entries.length === 0) {
      alert('No disliked facts found yet. Try clicking Scan first.');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'trivia-top50-overlay';
    overlay.innerHTML = `
      <div class="trivia-top50-modal">
        <div class="trivia-top50-header">
          <strong>Top ${entries.length} most disliked facts</strong>
          <button class="trivia-top50-close">&#x2715;</button>
        </div>
        <div class="trivia-top50-list">
          ${entries.map((d, i) => `
            <div class="trivia-top50-item">
              <div class="trivia-top50-rank">#${i + 1}</div>
              <div class="trivia-top50-text">${escapeHtml(d.text || '(no text extracted)')}</div>
              <div class="trivia-top50-votes">&#x1F44D; ${d.up} &nbsp;&nbsp; &#x1F44E; ${d.down} &nbsp;&nbsp; net: &#x2212;${d.down - d.up} &nbsp;&nbsp; wilson: ${(d.wilson * 100).toFixed(1)}%</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    overlay.querySelector('.trivia-top50-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // create floating control panel
  function createPanel(initialEnabled) {
    const panel = document.createElement('div');
    panel.className = 'trivia-hider-panel';
    panel.innerHTML = `
      <span class="label">Trivia Hider</span>
      <label title="Hide items where dislikes &gt; likes">
        <input type="checkbox" id="trivia-hider-toggle"> Вкл
      </label>
      <button id="trivia-hider-reveal" title="Toggle visibility of currently hidden items">Показать/скрыть скрытые</button>
      <button id="trivia-hider-scan" title="Re-scan page">Scan</button>
      <button id="trivia-hider-top50" title="Show top 50 most disliked facts">Top 50</button>
    `;
    // add to DOM after body exists
    const appendPanel = () => { document.body.appendChild(panel); attachPanelHandlers(panel); };
    if (document.body) appendPanel(); else window.addEventListener('DOMContentLoaded', appendPanel);

    // set initial checkbox state
    // attachPanelHandlers will set the actual checked state
    return panel;
  }

  function attachPanelHandlers(panel) {
    const cb = panel.querySelector('#trivia-hider-toggle');
    const btnReveal = panel.querySelector('#trivia-hider-reveal');
    const btnScan = panel.querySelector('#trivia-hider-scan');

    // restore state and set checkbox
    gmGet(ENABLE_KEY, true).then(enabled => {
      cb.checked = Boolean(enabled);
      // initial scan once checkbox set
      scanAll(Boolean(enabled));
    });

    cb.addEventListener('change', async () => {
      const enabled = Boolean(cb.checked);
      await gmSet(ENABLE_KEY, enabled);
      // re-scan and apply/hide accordingly
      // remove processed flags so items will be re-checked (in case conditions changed)
      document.querySelectorAll('[data-testid="item-id"]').forEach(it => it.removeAttribute(PROCESSED_FLAG));
      scanAll(enabled);
    });

    btnReveal.addEventListener('click', () => {
      // toggle visibility of hidden items
      const hidden = document.querySelectorAll(`[${HIDDEN_FLAG}="1"]`);
      if (!hidden || hidden.length === 0) {
        // brief feedback by toggling scan to make hidden visible then mark them as visible
        alert('Скрытых фактов пока нет.');
        return;
      }
      // if currently hidden (have class), remove class to show; if shown, add class to hide
      const anyHiddenShown = Array.from(hidden).some(el => el.classList.contains('trivia-hidden-by-script'));
      hidden.forEach(el => {
        if (anyHiddenShown) el.classList.remove('trivia-hidden-by-script');
        else el.classList.add('trivia-hidden-by-script');
      });
    });

    btnScan.addEventListener('click', async () => {
      const enabled = await gmGet(ENABLE_KEY, true);
      // clear processed flags to force re-evaluation
      document.querySelectorAll('[data-testid="item-id"]').forEach(it => it.removeAttribute(PROCESSED_FLAG));
      scanAll(Boolean(enabled));
    });

    const btnTop50 = panel.querySelector('#trivia-hider-top50');
    btnTop50.addEventListener('click', () => showTop50Modal());
  }

  // observe DOM for new trivia items (handles lazy loading / "show more")
  function startObserver(enabledRef) {
    let scanTimer = null;
    const observer = new MutationObserver((mutations) => {
      let needScan = false;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          // quick check: if any added node contains a trivia item
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches('[data-testid="item-id"]')) { needScan = true; break; }
            if (n.querySelector && n.querySelector('[data-testid="item-id"]')) { needScan = true; break; }
          }
        }
      }
      if (needScan) {
        // debounced timeout — one timer for any burst of DOM mutations
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
          gmGet(ENABLE_KEY, true).then(enabled => scanAll(Boolean(enabled)));
        }, 300);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  // init
  (async function init() {
    const enabled = await gmGet(ENABLE_KEY, true);

    // create panel and attach
    createPanel(enabled);

    // initial scans with small delays (IMDB might fill numbers after render)
    scanAll(enabled);
    setTimeout(() => scanAll(enabled), 900);
    setTimeout(() => scanAll(enabled), 2500);

    // start observer
    startObserver();

    // also re-scan on navigation events (IMDB uses PJAX-ish navigation)
    window.addEventListener('popstate', () => {
      gmGet(ENABLE_KEY, true).then(e => {
        // clear processed flags and re-scan
        document.querySelectorAll('[data-testid="item-id"]').forEach(it => it.removeAttribute(PROCESSED_FLAG));
        scanAll(Boolean(e));
      });
    });
  })();

})();
