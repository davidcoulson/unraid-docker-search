/*
 * docker.search: search box and quick filters for the Unraid Docker page.
 *
 * Reads the rows that DockerContainers.php renders (and that folder.view2 may have
 * regrouped), hides the ones that do not match by adding a class, and never changes
 * the rows' own markup, so sorting, context menus, autostart switches and the
 * Basic/Advanced toggle keep working.
 *
 * MIT License. Copyright (c) 2026 David Coulson.
 */
(function () {
  'use strict';

  const Core = window.DockerSearchCore;
  const STORE_KEY = 'docker.search.v1';
  const DATA_URL = '/plugins/docker.search/include/data.php';
  const HIDE = 'uds-hide';
  const DIM = 'uds-dim';

  const state = { q: '', chips: [], net: '' };
  let list = null;
  let ui = {};
  let items = [];
  let dirty = true;
  let enrich = null; // id -> container details from data.php
  let enrichAt = 0;
  let enrichBusy = false;
  let enrichTimer = 0;
  let redrawn = false; // the list was redrawn since the last fetch
  let applying = false;
  let observer = null;
  let lastView = null;

  // Folders this script opened, folders the user closed while filtering, and whether
  // folder.view2 is rebuilding (its own re-expansion should not count as the user's).
  const autoExpanded = new Set();
  const userCollapsed = new Set();
  let selfToggle = false;
  let folderBuild = false;

  const $$ = (root, sel) => Array.prototype.slice.call(root.querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- reading the rows ---------- */

  // Text of an element's direct text nodes, one entry per <br>-separated line.
  function lines(el) {
    if (!el) return [];
    const out = [];
    let cur = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) cur += n.nodeValue;
      else if (n.nodeName === 'BR') { out.push(cur); cur = ''; }
    }
    out.push(cur);
    return out.map(s => s.trim()).filter(Boolean);
  }

  // Lines of an element including nested markup (for volume mappings).
  function deepLines(el) {
    if (!el) return [];
    const out = [];
    let cur = '';
    for (const n of el.childNodes) {
      if (n.nodeName === 'BR') { out.push(cur); cur = ''; continue; }
      if (n.nodeType === 1 && n.classList.contains('fa')) { cur += ' ↔ '; continue; }
      cur += n.textContent;
    }
    out.push(cur);
    return out.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  function folderOf(row) {
    const m = (row.className || '').match(/(?:^|\s)folder-(\S+)-element(?:\s|$)/);
    if (!m) return { folderId: '', folder: '' };
    const fr = list.querySelector('tr.folder-id-' + cssEscape(m[1]));
    const name = fr && fr.querySelector('.folder-appname');
    return { folderId: m[1], folder: name ? name.textContent.trim() : '' };
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function readContainer(row, nameCell) {
    const cells = Array.prototype.filter.call(row.children, c => c.nodeName === 'TD');
    const hand = nameCell.querySelector('span.outer > span.hand[id]');
    const id = hand ? hand.id : '';
    const appname = nameCell.querySelector('.appname');
    const name = appname ? appname.textContent.trim() : '';
    const icon = nameCell.querySelector('i[id^="load-"]');
    const cls = icon ? icon.classList : { contains: () => false };
    const st = cls.contains('paused') ? 'paused' : cls.contains('started') ? 'started' : 'stopped';
    const args = Core.parseCallArgs(hand ? hand.getAttribute('onclick') : '');
    const statusText = cells.length ? cells[cells.length - 1].textContent : '';
    const status = Core.parseStatus(statusText);
    const auto = row.querySelector('input.autostart');
    const autoCell = cells[8] ? cells[8].textContent : '';
    const stateText = (nameCell.querySelector('.state') || {}).textContent || '';
    const composeMatch = stateText.match(/Compose Stack:\s*(.+)$/);
    const advanced = nameCell.querySelector('div.advanced');
    const byText = advanced ? (advanced.textContent.match(/:\s*([^\s:]+)\s*$/) || [])[1] || '' : '';
    const tagEl = cells[1] && cells[1].querySelector('i.fa-info-circle');
    const ct = (window.docker || []).find(d => d && d.id === id);
    let update = ct ? +ct.update : null;
    if (update === null && cells[1]) update = cells[1].querySelector('.fa-flash') ? 1 : 0;

    const item = {
      key: 'ct:' + (id || name),
      kind: 'container',
      row,
      name,
      id,
      image: byText,
      tag: tagEl && tagEl.parentNode ? tagEl.parentNode.textContent.trim() : '',
      state: st,
      restarting: status.restarting,
      health: status.health,
      update,
      autostart: auto ? !!auto.checked : null,
      manager: auto ? 'dockerman' : /compose/i.test(autoCell) || composeMatch ? 'composeman' : '',
      compose: composeMatch ? composeMatch[1].trim() : '',
      webui: args[7] || '',
      networks: lines(cells[2] && cells[2].querySelector('.docker_readmore')),
      ips: lines(cells[3] && cells[3].querySelector('.docker_readmore')),
      ports: [].concat(lines(cells[4] && cells[4].querySelector('.docker_readmore')),
        lines(cells[5] && cells[5].querySelector('.docker_readmore'))),
      volumes: deepLines(cells[6] && cells[6].querySelector('.docker_readmore')),
      labels: {},
      tailscale: !!(cells[2] && cells[2].querySelector('.TS_tooltip'))
    };
    Object.assign(item, folderOf(row));

    const e = enrich && id ? enrich[id] : null;
    if (e) {
      item.image = e.image || item.image;
      // The page shortens long tags ("latest-gpu-n..."); the image reference has the full one.
      item.tag = Core.imageTag(e.image) || item.tag;
      item.cpuset = e.cpuset || '';
      item.labels = e.labels || {};
      item.compose = item.compose || e.compose || '';
      if (e.manager) item.manager = e.manager;
      if (!item.webui && e.webui) item.webui = e.webui;
      const nets = Object.keys(e.networks || {});
      for (const n of nets) if (item.networks.indexOf(n) === -1) item.networks.push(n);
      for (const n of nets) {
        const ip = e.networks[n];
        if (ip && item.ips.indexOf(ip) === -1) item.ips.push(ip);
      }
      // A translated page says "(gesund)" rather than "(healthy)"; only then fall back to
      // docker's own status line, which may be older than the row.
      if (!item.health && /\((?!\d+\))[^)]+\)/.test(statusText)) item.health = Core.parseStatus(e.status).health;
    }
    return item;
  }

  function readOrphan(row) {
    const td = row.querySelector('td:nth-child(2)');
    const tags = td ? td.textContent.replace(/^[^:]*:\s*\S+/, '').trim() : '';
    return {
      key: 'img:' + ((row.querySelector('span.hand[id]') || {}).id || tags),
      kind: 'orphan', row, name: '(orphan image)', id: '', image: tags, networks: [], labels: {}
    };
  }

  function collect() {
    const out = [];
    for (const row of $$(list, 'tr')) {
      if (row.classList.contains('folder')) continue;
      const nameCell = row.querySelector(':scope > td.ct-name');
      if (nameCell && !row.classList.contains('folder')) out.push(readContainer(row, nameCell));
      else if (row.querySelector(':scope > td > span.outer.apps')) out.push(readOrphan(row));
    }
    return out;
  }

  /* ---------- the bar ---------- */

  const HELP = [
    ['plex', 'name, image, folder, network, IP, port or stack contains "plex"'],
    ['image:linuxserver', 'also name: tag: net: ip: port: folder: stack: label: cpu: path: id:'],
    ['is:running', 'stopped paused restarting healthy unhealthy starting update autostart manual webui pinned compose folder tailscale'],
    ['-is:running', 'a leading - excludes; quote values with spaces: folder:"Media Apps"'],
    ['cpu:4', 'pinned to core 4 (cpu:any / cpu:none)'],
    ['/  Esc', 'focus the search box; clear it']
  ];

  function buildBar() {
    const table = document.getElementById('docker_containers');
    const anchor = (table && table.closest('.TableContainer')) || table;
    if (!anchor) return false;

    const bar = document.createElement('div');
    bar.id = 'uds-bar';
    bar.setAttribute('role', 'search');
    bar.innerHTML =
      '<div class="uds-search">' +
        '<i class="fa fa-search uds-icon" aria-hidden="true"></i>' +
        '<input type="text" class="uds-input" placeholder="Search containers" aria-label="Search containers" autocomplete="off" spellcheck="false">' +
        '<kbd class="uds-kbd" title="Press / to search">/</kbd>' +
        '<button type="button" class="uds-clear" title="Clear (Esc)" aria-label="Clear search"><i class="fa fa-times" aria-hidden="true"></i></button>' +
      '</div>' +
      '<div class="uds-chips" role="group" aria-label="Quick filters"></div>' +
      '<select class="uds-net" aria-label="Network"></select>' +
      '<span class="uds-summary" aria-live="polite"></span>' +
      '<button type="button" class="uds-reset" title="Clear search and filters">Clear</button>' +
      '<button type="button" class="uds-help-btn" title="Search syntax" aria-expanded="false"><i class="fa fa-question-circle" aria-hidden="true"></i></button>' +
      '<div class="uds-help" hidden>' +
        HELP.map(h => '<div><code>' + esc(h[0]) + '</code><span>' + esc(h[1]) + '</span></div>').join('') +
      '</div>';
    anchor.parentNode.insertBefore(bar, anchor);

    ui = {
      bar,
      input: bar.querySelector('.uds-input'),
      clear: bar.querySelector('.uds-clear'),
      chips: bar.querySelector('.uds-chips'),
      net: bar.querySelector('.uds-net'),
      summary: bar.querySelector('.uds-summary'),
      reset: bar.querySelector('.uds-reset'),
      helpBtn: bar.querySelector('.uds-help-btn'),
      help: bar.querySelector('.uds-help')
    };

    let lastGroup = null;
    for (const c of Core.CHIPS) {
      if (lastGroup && lastGroup !== c.group) {
        const sep = document.createElement('span');
        sep.className = 'uds-sep';
        sep.setAttribute('aria-hidden', 'true');
        ui.chips.appendChild(sep);
      }
      lastGroup = c.group;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'uds-chip uds-chip-' + c.id;
      b.dataset.chip = c.id;
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<span class="uds-chip-label">' + esc(c.label) + '</span><span class="uds-count">0</span>';
      ui.chips.appendChild(b);
    }

    let timer = 0;
    ui.input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => setState({ q: ui.input.value }), 60);
    });
    // Keep typing away from page-wide key handlers (folder.view2 starts a debug
    // download when it sees the word "debug" typed anywhere).
    for (const t of ['keydown', 'keypress', 'keyup']) {
      ui.input.addEventListener(t, ev => {
        if (t === 'keydown' && ev.key === 'Escape') {
          ev.preventDefault();
          if (ui.input.value) { ui.input.value = ''; setState({ q: '' }); } else ui.input.blur();
        }
        ev.stopPropagation();
      });
    }
    ui.clear.addEventListener('click', () => { ui.input.value = ''; setState({ q: '' }); ui.input.focus(); });
    ui.reset.addEventListener('click', () => { ui.input.value = ''; ui.net.value = ''; setState({ q: '', chips: [], net: '' }); });
    ui.chips.addEventListener('click', ev => {
      const b = ev.target.closest('.uds-chip');
      if (!b) return;
      const id = b.dataset.chip;
      const chips = state.chips.slice();
      const at = chips.indexOf(id);
      if (at === -1) chips.push(id); else chips.splice(at, 1);
      setState({ chips });
    });
    ui.net.addEventListener('change', () => setState({ net: ui.net.value }));
    ui.helpBtn.addEventListener('click', () => {
      ui.help.hidden = !ui.help.hidden;
      ui.helpBtn.setAttribute('aria-expanded', String(!ui.help.hidden));
    });
    return true;
  }

  function renderBar(view) {
    const active = view.active;
    ui.bar.classList.toggle('uds-active', active);
    ui.clear.hidden = !state.q;
    ui.reset.hidden = !active;
    for (const b of $$(ui.chips, '.uds-chip')) {
      const id = b.dataset.chip;
      const on = state.chips.indexOf(id) !== -1;
      b.hidden = !view.available[id];
      b.classList.toggle('uds-on', on);
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('uds-zero', !on && view.counts[id] === 0);
      b.querySelector('.uds-count').textContent = view.counts[id];
    }
    // Hide separators that end up between nothing.
    const kids = Array.prototype.slice.call(ui.chips.children);
    kids.forEach((el, i) => {
      if (!el.classList.contains('uds-sep')) return;
      const before = kids.slice(0, i).some(k => k.classList.contains('uds-chip') && !k.hidden);
      const after = kids.slice(i + 1).find(k => k.classList.contains('uds-sep') || (k.classList.contains('uds-chip') && !k.hidden));
      el.hidden = !before || !after || after.classList.contains('uds-sep');
    });

    const nets = Object.keys(view.netCounts).sort((a, b) => (view.netCounts[b] - view.netCounts[a]) || a.localeCompare(b));
    if (state.net && nets.indexOf(state.net) === -1) nets.push(state.net);
    const opts = '<option value="">All networks</option>' +
      nets.map(n => '<option value="' + esc(n) + '">' + esc(n) + ' (' + (view.netCounts[n] || 0) + ')</option>').join('');
    if (ui.net.dataset.opts !== opts) {
      ui.net.innerHTML = opts;
      ui.net.dataset.opts = opts;
    }
    ui.net.value = state.net;
    ui.net.hidden = nets.length < 2 && !state.net;
    ui.net.classList.toggle('uds-on', !!state.net);

    ui.summary.textContent = active
      ? view.shown + ' of ' + view.total + ' containers'
      : view.total + ' containers';
  }

  /* ---------- applying the filter ---------- */

  function isExpanded(id) {
    const btn = list.querySelector('.dropDown-' + cssEscape(id));
    return !!btn && btn.getAttribute('active') === 'true';
  }

  // folder.view2 declares these with const in classic scripts, so they live in the
  // global lexical scope rather than on window.
  function fv2(name) {
    try {
      if (name === 'dropDownButton') return typeof dropDownButton === 'function' ? dropDownButton : null; // eslint-disable-line no-undef
      if (name === 'folderEvents') return typeof folderEvents !== 'undefined' ? folderEvents : null; // eslint-disable-line no-undef
    } catch (e) { /* not loaded */ }
    return null;
  }

  function toggleFolder(id) {
    const fn = fv2('dropDownButton');
    if (!fn) return;
    selfToggle = true;
    try { fn(id); } finally { selfToggle = false; }
  }

  function applyFolders(view) {
    const sums = Core.summarizeFolders(items, view.visible);
    const names = new Map(items.map(i => [i.name, i]));
    const ids = new Map(items.map(i => [i.id, i]));
    for (const fr of $$(list, ':scope > tr.folder')) {
      const m = fr.className.match(/(?:^|\s)folder-id-(\S+)/);
      if (!m) continue;
      const id = m[1];
      const sum = sums[id] || { total: 0, shown: 0 };
      let badge = fr.querySelector('.uds-folder-badge');

      if (!view.active) {
        fr.classList.remove(HIDE);
        if (badge) badge.remove();
        for (const el of $$(fr, '.' + DIM)) el.classList.remove(DIM);
        if (autoExpanded.has(id) && isExpanded(id)) toggleFolder(id);
        autoExpanded.delete(id);
        continue;
      }

      fr.classList.toggle(HIDE, sum.shown === 0);
      if (!badge) {
        const title = fr.querySelector('.folder-appname');
        if (title) {
          badge = document.createElement('span');
          badge.className = 'uds-folder-badge';
          title.after(badge);
        }
      }
      if (badge) {
        badge.textContent = sum.shown + '/' + sum.total;
        badge.title = sum.shown + ' of ' + sum.total + ' containers in this folder match';
      }

      if (userCollapsed.has(id) && isExpanded(id) && !autoExpanded.has(id)) {
        // folder.view2 reopened it while rebuilding (expand_tab); the user had closed it.
        toggleFolder(id);
      } else if (sum.shown > 0 && !isExpanded(id) && !userCollapsed.has(id)) {
        toggleFolder(id);
        if (isExpanded(id)) autoExpanded.add(id);
      } else if (sum.shown === 0 && autoExpanded.has(id) && isExpanded(id)) {
        toggleFolder(id);
        autoExpanded.delete(id);
      }

      // Dim non-matching containers in a collapsed folder's preview.
      const preview = fr.querySelector('.folder-preview');
      if (preview) {
        for (const el of $$(preview, '.folder-preview-wrapper')) {
          const nameEls = $$(el, '.appname');
          if (nameEls.length > 1) {
            el.classList.remove(DIM);
            for (const n of nameEls) {
              const it = names.get(n.textContent.trim());
              const box = n.closest('span.inner') || n;
              box.classList.toggle(DIM, !!it && !view.visible.has(it.key));
            }
            continue;
          }
          let it = nameEls[0] && names.get(nameEls[0].textContent.trim());
          if (!it) {
            const idEl = el.querySelector('[id]');
            if (idEl) it = ids.get(idEl.id.replace(/^folder-preview-/, ''));
          }
          el.classList.toggle(DIM, !!it && !view.visible.has(it.key));
        }
      }
    }
  }

  function apply() {
    if (!list || applying) return;
    applying = true;
    try {
      if (dirty) {
        items = collect();
        dirty = false;
        maybeRefreshEnrichment();
      }
      const view = Core.computeView(items, state);
      lastView = view;
      for (const i of items) i.row.classList.toggle(HIDE, view.active && !view.visible.has(i.key));
      applyFolders(view);
      if (!view.active) userCollapsed.clear();
      renderBar(view);
      list.classList.toggle('uds-filtering', view.active);
      // Rows moved by our own folder toggles are not news (the row elements are the same).
      if (observer) observer.takeRecords();
    } finally {
      applying = false;
    }
  }

  function setState(patch) {
    Object.assign(state, patch);
    const s = Core.normalizeState(state);
    state.q = s.q;
    state.chips = s.chips;
    state.net = s.net;
    if (ui.input && ui.input.value !== state.q) ui.input.value = state.q;
    save();
    apply();
  }

  /* ---------- persistence ---------- */

  function save() {
    const s = Core.normalizeState(state);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
    const hash = Core.encodeHash(s);
    const ours = Core.decodeHash(location.hash) !== null;
    if (hash) history.replaceState(null, '', '#' + hash);
    else if (ours) history.replaceState(null, '', location.pathname + location.search);
  }

  function restore() {
    let s = Core.decodeHash(location.hash);
    if (!s) {
      try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { s = null; }
    }
    s = Core.normalizeState(s);
    state.q = s.q;
    state.chips = s.chips;
    state.net = s.net;
    ui.input.value = s.q;
  }

  /* ---------- extra data ---------- */

  // Fetch when a container is missing (at most every 10 s) or, after the list was redrawn
  // (start/stop/update/edit), at most every 30 s, so pinning and network changes catch up.
  function maybeRefreshEnrichment() {
    if (enrichBusy || !window.fetch) return;
    const ids = items.filter(i => i.kind === 'container').map(i => i.id);
    const missing = !enrich || ids.some(id => id && !Object.prototype.hasOwnProperty.call(enrich, id));
    if (!missing && !redrawn) return;
    const wait = (missing ? 10000 : 30000) - (Date.now() - enrichAt);
    if (wait > 0) {
      if (!enrichTimer) enrichTimer = setTimeout(() => { enrichTimer = 0; maybeRefreshEnrichment(); }, wait);
      return;
    }
    enrichBusy = true;
    redrawn = false;
    enrichAt = Date.now();
    fetch(DATA_URL, { credentials: 'same-origin', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || !Array.isArray(d.containers)) return;
        enrich = Object.create(null);
        for (const c of d.containers) if (c && typeof c.id === 'string') enrich[c.id] = c;
        dirty = true;
        apply();
      })
      .catch(() => {})
      .finally(() => { enrichBusy = false; });
  }

  /* ---------- wiring ---------- */

  function onKey(ev) {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.nodeName))) return;
    if (!ui.input || ui.input.offsetParent === null) return; // Docker tab not showing
    ev.preventDefault();
    ui.input.focus();
    ui.input.select();
  }

  // jQuery's .toggle() on the Basic/Advanced switch can re-show an orphan-image row
  // that is hidden by the filter; put those rows back to what the view mode says.
  function resyncViewMode() {
    if (!window.jQuery) return;
    const adv = window.jQuery.cookie && window.jQuery.cookie('docker_listview_mode') === 'advanced';
    const fix = () => window.jQuery(list).children('tr.advanced').toggle(!!adv);
    fix();
    setTimeout(fix, 700);
  }

  function init() {
    list = document.getElementById('docker_list');
    if (!list || !Core || document.getElementById('uds-bar')) return;
    if (!buildBar()) return;
    restore();

    observer = new MutationObserver(() => {
      if (applying) return;
      dirty = true;
      redrawn = true;
      apply();
    });
    observer.observe(list, { childList: true });

    // The autostart switches are jQuery switchButtons, which fire jQuery-only change events.
    const onAutostart = () => { dirty = true; setTimeout(apply, 0); };
    if (window.jQuery) window.jQuery(list).on('change', 'input.autostart', onAutostart);
    else list.addEventListener('change', ev => { if (ev.target.matches && ev.target.matches('input.autostart')) onAutostart(); });

    const events = fv2('folderEvents');
    if (events && events.addEventListener) {
      events.addEventListener('docker-pre-folders-creation', () => { folderBuild = true; });
      events.addEventListener('docker-post-folders-creation', () => {
        folderBuild = false;
        dirty = true;
        setTimeout(apply, 0);
      });
      events.addEventListener('docker-post-folder-expansion', ev => {
        if (selfToggle || folderBuild) return;
        const id = ev.detail && ev.detail.id;
        if (!id) return;
        autoExpanded.delete(id);
        if (isExpanded(id)) userCollapsed.delete(id); else userCollapsed.add(id);
        dirty = true;
        setTimeout(apply, 0);
      });
    }

    if (window.jQuery) window.jQuery(document).on('change', '.advancedview', resyncViewMode);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', () => {
      const s = Core.decodeHash(location.hash);
      if (!s) return;
      ui.input.value = s.q;
      setState(s);
    });

    apply();
  }

  // Exposed for debugging from the console.
  window.DockerSearch = {
    state: () => Core.normalizeState(state),
    set: setState,
    items: () => items,
    view: () => lastView,
    refresh: () => { dirty = true; apply(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
