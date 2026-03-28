// ==UserScript==
// @name         Better IMDb Trivia (Hide Shitty Movie Details)
// @namespace    https://github.com/Felegz/awesome-userscripts
// @version      1.6
// @author       Felegz
// @description  Silently hides poor IMDb trivia (Wilson score). Collects worst facts globally — open list via Tampermonkey menu.
// @license      MIT
// @homepageURL  https://github.com/Felegz/awesome-userscripts
// @match        https://www.imdb.com/title/*/trivia*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  const STORAGE_KEY         = 'imdb_worst_facts_v1';
  const PROCESSED_FLAG      = 'data-trivia-processed';
  const HIDDEN_ATTR         = 'data-trivia-hidden';
  const WILSON_HIDE_THRESHOLD = 0.55; // hide from page: statistically very bad
  const SAVE_MIN_DOWN       = 3;      // save to hall of shame: down > up AND down >= this
  const MAX_STORED          = 400;

  // In-memory mirror of GM storage — loaded once at init
  let storedFacts = [];
  const processedHashes = new Set(); // fact text hashes already in storage

  /*** GM helpers ***/
  function gmGet(key, def) {
    try {
      const r = typeof GM_getValue === 'function' ? GM_getValue(key) : undefined;
      if (r && typeof r.then === 'function') return r.then(v => (v === undefined ? def : v));
      return Promise.resolve(r === undefined ? def : r);
    } catch { return Promise.resolve(def); }
  }
  function gmSet(key, value) {
    try {
      const r = typeof GM_setValue === 'function' ? GM_setValue(key, value) : undefined;
      if (r && typeof r.then === 'function') return r;
      return Promise.resolve();
    } catch { return Promise.resolve(); }
  }

  /*** CSS: silent hide + modal ***/
  if (typeof GM_addStyle === 'function') {
    GM_addStyle(`
      [data-trivia-hidden="1"]{display:none !important;}
      .tw-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;}
      .tw-modal{background:#1a1a1a;color:#e8e8e8;border-radius:10px;width:720px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.85);font-family:Arial,Helvetica,sans-serif;}
      .tw-header{padding:14px 18px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;font-size:15px;gap:8px;}
      .tw-header-title{flex:1;}
      .tw-header-actions{display:flex;align-items:center;gap:8px;}
      .tw-btn-clear{background:#5a1111;border:none;color:#fff;font-size:12px;border-radius:4px;padding:4px 10px;cursor:pointer;white-space:nowrap;}
      .tw-btn-clear:hover{background:#7a1515;}
      .tw-btn-close{background:none;border:none;color:#999;font-size:22px;cursor:pointer;line-height:1;padding:0 2px;}
      .tw-btn-close:hover{color:#fff;}
      .tw-list{overflow-y:auto;padding:0 18px;flex:1;}
      .tw-item{padding:22px 0;border-bottom:1px solid #242424;}
      .tw-rank{font-size:11px;color:#555;margin-bottom:3px;}
      .tw-movie{font-size:12px;margin-bottom:6px;}
      .tw-movie a{color:#f5a623;text-decoration:none;}
      .tw-movie a:hover{text-decoration:underline;}
      .tw-spoiler{color:#e03030;font-weight:bold;margin-left:8px;font-size:11px;letter-spacing:0.04em;}
      .tw-text{font-size:13px;line-height:1.6;color:#ddd;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;}
      .tw-votes{font-size:12px;color:#777;margin-top:6px;}
      .tw-empty{padding:40px;text-align:center;color:#555;font-size:14px;}
    `);
  }

  /*** Utilities ***/
  function parseCount(node) {
    if (!node) return null;
    const d = (node.textContent || '').replace(/[^\d]/g, '');
    return d.length ? parseInt(d, 10) : 0;
  }

  function wilsonDislike(up, down) {
    const n = up + down;
    if (n === 0) return 0;
    const z = 1.96, p = down / n;
    return (p + z*z/(2*n) - z*Math.sqrt((p*(1-p) + z*z/(4*n))/n)) / (1 + z*z/n);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // djb2 hash — dedup key for stored facts
  function hashText(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
  }

  function getMovieInfo() {
    const m = location.pathname.match(/\/title\/(tt\d+)\//);
    const movieId = m ? m[1] : 'unknown';

    // 1. og:title — most reliable, present on all IMDb pages including /trivia/
    //    Format: "Movie Name (Year) - IMDb" or just "Movie Name"
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
    if (ogTitle) {
      return { movieId, movieTitle: ogTitle.replace(/\s*-\s*IMDb\s*$/i, '').trim() };
    }

    // 2. Sub-page header link (IMDb trivia/subpages often have a link back to the movie)
    const subLink = document.querySelector('[data-testid="sub-page-title-link"]');
    if (subLink?.textContent) {
      return { movieId, movieTitle: subLink.textContent.trim() };
    }

    // 3. Breadcrumb / hero title selectors used on the main movie page
    const heroEl =
      document.querySelector('[data-testid="hero-title-block__title"]') ||
      document.querySelector('h1[data-testid="hero__pageTitle"] span');
    if (heroEl?.textContent) {
      return { movieId, movieTitle: heroEl.textContent.trim() };
    }

    // 4. document.title — format: "Movie Name (Year) - Trivia - IMDb"
    //    Strip everything from the first " - " that is followed by Trivia/IMDb/etc.
    const fromTitle = document.title.replace(/\s*-\s*(Trivia|IMDb).*$/i, '').trim();
    return { movieId, movieTitle: fromTitle || movieId };
  }

  /*** Persistent storage ***/
  async function initStorage() {
    const raw = await gmGet(STORAGE_KEY, '[]');
    try { storedFacts = JSON.parse(raw) || []; } catch { storedFacts = []; }
    // Populate in-memory hash set to detect duplicates without re-reading storage
    storedFacts.forEach(f => processedHashes.add(f.hash));
  }

  async function saveFactIfNew(fact) {
    if (processedHashes.has(fact.hash)) return; // already stored — skip
    processedHashes.add(fact.hash);
    storedFacts.push(fact);
    // If over limit, keep the worst MAX_STORED by Wilson score
    if (storedFacts.length > MAX_STORED) {
      storedFacts.sort((a, b) => b.wilson - a.wilson);
      storedFacts.splice(MAX_STORED);
      // Rebuild hash set after eviction (some facts may have been dropped)
      processedHashes.clear();
      storedFacts.forEach(f => processedHashes.add(f.hash));
    }
    await gmSet(STORAGE_KEY, JSON.stringify(storedFacts));
  }

  // Detect if a trivia item belongs to a spoiler section
  function isSpoilerSection(item) {
    // Check ancestor data-testid / id for "spoiler"
    let el = item.parentElement;
    while (el && el !== document.body) {
      if (/spoiler/i.test(el.getAttribute('data-testid') || '') ||
          /spoiler/i.test(el.getAttribute('id') || '')) return true;
      el = el.parentElement;
    }
    // Walk up looking for a preceding sibling heading containing "spoiler"
    el = item;
    while (el && el !== document.body) {
      let prev = el.previousElementSibling;
      while (prev) {
        if (/spoiler/i.test(prev.textContent || '') &&
            /^H[2-4]$/.test(prev.tagName || '')) return true;
        prev = prev.previousElementSibling;
      }
      el = el.parentElement;
    }
    return false;
  }

  /*** Filtering (background, no UI) ***/
  function processItem(item, movieInfo) {
    if (!item || item.hasAttribute(PROCESSED_FLAG)) return;
    try {
      const upNode   = item.querySelector('.ipc-voting__label__count--up');
      const downNode = item.querySelector('.ipc-voting__label__count--down');

      // No vote UI at all — mark done and skip
      if (!upNode && !downNode) {
        item.setAttribute(PROCESSED_FLAG, '1');
        return;
      }

      const up = parseCount(upNode), down = parseCount(downNode);

      // Parsing error — mark done and skip
      if (up === null || down === null) {
        item.setAttribute(PROCESSED_FLAG, '1');
        return;
      }

      // Votes not loaded yet (IMDb renders them async) — leave unprocessed for next scan
      if (up === 0 && down === 0) return;

      // Votes are present — mark as processed so we don't re-process
      item.setAttribute(PROCESSED_FLAG, '1');

      const wilson = wilsonDislike(up, down);

      // --- Hide from page ---
      if (wilson > WILSON_HIDE_THRESHOLD) {
        item.setAttribute(HIDDEN_ATTR, '1');
      } else {
        item.removeAttribute(HIDDEN_ATTR);
      }

      // --- Save to hall of shame ---
      // Criterion: more dislikes than likes AND at least SAVE_MIN_DOWN dislikes.
      // Deliberately separate from the hide threshold so we collect more data.
      // Note: a fact like 175 up / 110 down will NOT be saved (down < up).
      if (down > up && down >= SAVE_MIN_DOWN) {
        const textNode = item.querySelector('.ipc-html-content-inner-div') || item.querySelector('p');
        const text = (textNode?.textContent || '').trim().slice(0, 500);
        if (text) {
          saveFactIfNew({
            hash: hashText(text), text, up, down, wilson,
            movieId: movieInfo.movieId,
            movieTitle: movieInfo.movieTitle,
            isSpoiler: isSpoilerSection(item),
            savedAt: Date.now()
          });
        }
      }
    } catch (e) { console.error('trivia-hider:', e); }
  }

  function scanAll() {
    const movieInfo = getMovieInfo();
    document.querySelectorAll('[data-testid="item-id"]').forEach(item => processItem(item, movieInfo));
  }

  /*** Modal (opened via Tampermonkey menu) ***/
  function showWorstFactsModal() {
    // Sort in-memory facts by Wilson score descending, show top 50
    const top = [...storedFacts].sort((a, b) => b.wilson - a.wilson).slice(0, 50);

    const overlay = document.createElement('div');
    overlay.className = 'tw-overlay';
    overlay.innerHTML = `
      <div class="tw-modal">
        <div class="tw-header">
          <span class="tw-header-title">Top ${top.length} worst trivia facts (all time, ${storedFacts.length} stored)</span>
          <span class="tw-header-actions">
            <button class="tw-btn-clear">Clear all</button>
            <button class="tw-btn-close">&#x2715;</button>
          </span>
        </div>
        <div class="tw-list">
          ${top.length === 0
            ? '<div class="tw-empty">No facts collected yet — browse some IMDb trivia pages!</div>'
            : top.map((d, i) => `
                <div class="tw-item">
                  <div class="tw-rank">#${i + 1}</div>
                  <div class="tw-movie">
                    <a href="https://www.imdb.com/title/${escapeHtml(d.movieId)}/trivia/" target="_blank" rel="noopener">&#x1F3AC; ${escapeHtml(d.movieTitle || d.movieId)}</a>${d.isSpoiler ? ' <span class="tw-spoiler">⚠ SPOILER</span>' : ''}
                  </div>
                  <div class="tw-text">${escapeHtml(d.text)}</div>
                  <div class="tw-votes">&#x1F44D; ${d.up} &nbsp; &#x1F44E; ${d.down} &nbsp; net: &#x2212;${d.down - d.up} &nbsp; wilson: ${(d.wilson * 100).toFixed(1)}%</div>
                </div>`
            ).join('')}
        </div>
      </div>
    `;

    overlay.querySelector('.tw-btn-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.tw-btn-clear').addEventListener('click', async () => {
      if (!confirm('Clear all stored worst-trivia facts? This cannot be undone.')) return;
      storedFacts = [];
      processedHashes.clear();
      await gmSet(STORAGE_KEY, '[]');
      overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  /*** Observer (debounced) ***/
  function startObserver() {
    let timer = null;
    new MutationObserver(mutations => {
      let hit = false;
      outer: for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches?.('[data-testid="item-id"]') || n.querySelector?.('[data-testid="item-id"]')) {
            hit = true; break outer;
          }
        }
      }
      if (hit) { clearTimeout(timer); timer = setTimeout(scanAll, 300); }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /*** Init ***/
  (async function init() {
    // Load stored facts into memory before any scanning begins
    await initStorage();

    // Register Tampermonkey menu item — user opens modal by clicking the TM icon
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Show worst trivia facts (Top 50)', showWorstFactsModal);
    }

    // Scan with delays to account for IMDb’s async vote counter rendering
    scanAll();
    setTimeout(scanAll, 900);
    setTimeout(scanAll, 2500);

    startObserver();

    // Re-scan after PJAX navigation (new movie page)
    window.addEventListener('popstate', () => {
      document.querySelectorAll('[data-testid="item-id"]')
        .forEach(it => it.removeAttribute(PROCESSED_FLAG));
      setTimeout(scanAll, 400);
    });
  })();

})();
