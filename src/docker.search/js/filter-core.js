/*
 * docker.search: pure filter logic for the Unraid Docker page search.
 * No DOM access here, so it runs the same in the browser and under node --test.
 *
 * An item is one container (or orphan image) row:
 *   { key, kind: 'container'|'orphan', name, id, image, tag, state: 'started'|'paused'|'stopped',
 *     restarting, health: 'healthy'|'unhealthy'|'starting'|null, update: 0|1|2|3|null,
 *     autostart: true|false|null, manager: 'dockerman'|'composeman'|'' , compose, webui,
 *     cpuset, networks: [], ips: [], ports: [], volumes: [], labels: {}, folder, folderId, tailscale }
 *
 * MIT License. Copyright (c) 2026 David Coulson.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DockerSearchCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Search keys and their aliases. Anything else before a colon is plain text.
  const KEYS = {
    name: 'name', n: 'name',
    image: 'image', img: 'image', repo: 'image',
    tag: 'tag', version: 'tag',
    net: 'network', network: 'network',
    ip: 'ip',
    port: 'port',
    folder: 'folder', dir: 'folder',
    compose: 'compose', stack: 'compose',
    label: 'label',
    cpu: 'cpu', cpuset: 'cpu',
    path: 'path', vol: 'path', volume: 'path',
    id: 'id',
    is: 'is', has: 'is', state: 'is', health: 'is', status: 'is'
  };

  // Values accepted by is:/has:. Each is a predicate on a container item.
  const IS = {
    running: i => i.state === 'started',
    started: i => i.state === 'started',
    up: i => i.state === 'started',
    stopped: i => i.state === 'stopped',
    exited: i => i.state === 'stopped',
    paused: i => i.state === 'paused',
    restarting: i => !!i.restarting,
    healthy: i => i.health === 'healthy',
    unhealthy: i => i.health === 'unhealthy',
    starting: i => i.health === 'starting',
    nohealth: i => !i.health,
    healthcheck: i => !!i.health,
    update: i => i.update === 1 || i.update === 2,
    updates: i => i.update === 1 || i.update === 2,
    outdated: i => i.update === 1 || i.update === 2,
    uptodate: i => i.update === 0,
    autostart: i => i.autostart === true,
    manual: i => i.autostart === false,
    noautostart: i => i.autostart === false,
    webui: i => !!i.webui,
    pinned: i => !!i.cpuset,
    cpu: i => !!i.cpuset,
    compose: i => i.manager === 'composeman' || !!i.compose,
    dockerman: i => i.manager === 'dockerman',
    template: i => i.manager === 'dockerman',
    thirdparty: i => i.manager !== 'dockerman' && i.manager !== 'composeman' && !i.compose,
    '3rdparty': i => i.manager !== 'dockerman' && i.manager !== 'composeman' && !i.compose,
    folder: i => !!i.folder,
    nofolder: i => !i.folder,
    tailscale: i => !!i.tailscale,
    orphan: i => i.kind === 'orphan'
  };

  // Quick filter chips. Chips in an 'any' group are ORed (they exclude each other anyway);
  // chips in an 'all' group narrow each other. Groups are always ANDed together.
  // 'rare' chips are only shown when something matches them or they are switched on.
  // 'needs' names an item field that must exist on at least one item for the chip to show.
  const GROUPS = [
    { id: 'state', mode: 'any' },
    { id: 'health', mode: 'any' },
    { id: 'update', mode: 'any' },
    { id: 'autostart', mode: 'any' },
    { id: 'features', mode: 'all' }
  ];
  const CHIPS = [
    { id: 'running', group: 'state', label: 'Running', test: IS.running },
    { id: 'stopped', group: 'state', label: 'Stopped', test: IS.stopped },
    { id: 'paused', group: 'state', label: 'Paused', test: IS.paused, rare: true },
    { id: 'restarting', group: 'state', label: 'Restarting', test: IS.restarting, rare: true },
    { id: 'healthy', group: 'health', label: 'Healthy', test: IS.healthy },
    { id: 'unhealthy', group: 'health', label: 'Unhealthy', test: IS.unhealthy },
    { id: 'starting', group: 'health', label: 'Starting', test: IS.starting, rare: true },
    { id: 'update', group: 'update', label: 'Update available', test: IS.update },
    { id: 'autostart-on', group: 'autostart', label: 'Autostart on', test: IS.autostart },
    { id: 'autostart-off', group: 'autostart', label: 'Autostart off', test: IS.manual },
    { id: 'webui', group: 'features', label: 'WebUI', test: IS.webui },
    { id: 'pinned', group: 'features', label: 'CPU pinned', test: IS.pinned, needs: 'cpuset' },
    { id: 'compose', group: 'features', label: 'Compose', test: IS.compose, rare: true },
    { id: 'tailscale', group: 'features', label: 'Tailscale', test: IS.tailscale, rare: true }
  ];
  const CHIP_BY_ID = Object.fromEntries(CHIPS.map(c => [c.id, c]));
  const GROUP_BY_ID = Object.fromEntries(GROUPS.map(g => [g.id, g]));

  const lc = s => String(s == null ? '' : s).toLowerCase();
  // Lookups keyed by user input (query keys, is: values, chip ids from the URL) must not
  // reach Object.prototype: "constructor" or "__proto__" are not chips.
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const get = (obj, k) => (own(obj, k) ? obj[k] : undefined);

  /** Split a query into tokens, honouring "double quotes" and a leading - or ! for negation. */
  function tokenize(query) {
    const s = String(query || '');
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      let negate = false;
      if ((s[i] === '-' || s[i] === '!') && i + 1 < s.length && !/\s/.test(s[i + 1])) {
        negate = true;
        i++;
      }
      let text = '';
      let quoteAt = -1; // position in text where the first quoted part starts
      while (i < s.length && !/\s/.test(s[i])) {
        if (s[i] === '"') {
          if (quoteAt < 0) quoteAt = text.length;
          i++;
          while (i < s.length && s[i] !== '"') text += s[i++];
          i++; // closing quote (or end of input)
        } else {
          text += s[i++];
        }
      }
      out.push({ text, negate, quoteAt });
    }
    return out;
  }

  /** Parse a query string into terms: { key: string|null, value: string (lower case), negate }. */
  function parseQuery(query) {
    const terms = [];
    for (const tok of tokenize(query)) {
      let key = null;
      let value = tok.text;
      const colon = tok.text.indexOf(':');
      if (colon > 0 && (tok.quoteAt < 0 || colon < tok.quoteAt)) {
        const k = get(KEYS, lc(tok.text.slice(0, colon)));
        if (k) {
          key = k;
          value = tok.text.slice(colon + 1);
        }
      }
      value = lc(value).trim();
      if (!value) continue;
      terms.push({ key, value, negate: tok.negate });
    }
    return terms;
  }

  /** "0-3,8" -> [0,1,2,3,8] */
  function parseCpuset(str) {
    const out = [];
    for (const part of String(str || '').split(',')) {
      const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = +m[1];
      const b = m[2] === undefined ? a : +m[2];
      for (let n = Math.min(a, b); n <= Math.max(a, b) && out.length < 4096; n++) out.push(n);
    }
    return out;
  }

  /** Health and restart state from a docker status line such as "Up 3 days (healthy)". */
  function parseStatus(text) {
    const s = String(text || '');
    let health = null;
    if (/\(unhealthy\)/i.test(s)) health = 'unhealthy';
    else if (/health:\s*starting/i.test(s)) health = 'starting';
    else if (/\(healthy\)/i.test(s)) health = 'healthy';
    return { health, restarting: /^\s*restarting\b/i.test(s) };
  }

  /**
   * Arguments of an inline handler such as
   *   addDockerContainerContext('plex','abc','/path',1,0,0,true,'http://x','',...)
   * Single-quoted strings use PHP addslashes() escaping.
   */
  function parseCallArgs(src) {
    const s = String(src || '');
    const open = s.indexOf('(');
    if (open < 0) return [];
    const args = [];
    let i = open + 1;
    let cur = '';
    let inArg = false;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "'") {
        i++;
        while (i < s.length && s[i] !== "'") {
          if (s[i] === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
          cur += s[i++];
        }
        i++;
        inArg = true;
        continue;
      }
      if (ch === ',' || ch === ')') {
        args.push(cur.trim());
        cur = '';
        inArg = false;
        if (ch === ')') break;
        i++;
        continue;
      }
      cur += ch;
      inArg = true;
      i++;
    }
    if (inArg && cur) args.push(cur.trim());
    return args;
  }

  /** "registry:5000/owner/app:1.2-alpine@sha256:..." -> "1.2-alpine" ('' when there is no tag). */
  function imageTag(image) {
    const ref = String(image || '').split('@')[0];
    const last = ref.slice(ref.lastIndexOf('/') + 1);
    const colon = last.indexOf(':');
    return colon === -1 ? '' : last.slice(colon + 1);
  }

  /** Lower-cased search fields, cached on the item. */
  function fields(item) {
    if (item._f) return item._f;
    const labels = item.labels || {};
    const f = {
      name: [lc(item.name)],
      image: [lc(item.image)],
      tag: [lc(item.tag)],
      network: (item.networks || []).map(lc),
      ip: (item.ips || []).map(lc),
      port: (item.ports || []).map(lc),
      folder: [lc(item.folder)],
      compose: [lc(item.compose)],
      path: (item.volumes || []).map(lc),
      id: [lc(item.id)],
      label: Object.keys(labels).map(k => lc(k) + '=' + lc(labels[k])),
      cpu: [lc(item.cpuset)]
    };
    f.text = [].concat(f.name, f.image, f.tag, f.folder, f.network, f.ip, f.compose, f.port, f.id).filter(Boolean);
    Object.defineProperty(item, '_f', { value: f, enumerable: false, configurable: true });
    return f;
  }

  const has = (list, v) => list.some(s => s && s.indexOf(v) !== -1);

  function matchTerm(item, term) {
    const v = term.value;
    const f = fields(item);
    switch (term.key) {
      case null: return has(f.text, v);
      case 'is': {
        const pred = get(IS, v.replace(/[\s_-]/g, ''));
        return pred ? !!pred(item) : false;
      }
      case 'port': {
        // port:80 should not match 8080, so compare whole numbers when the value is numeric.
        if (/^\d+$/.test(v)) return f.port.some(p => p.split(/[^0-9]+/).indexOf(v) !== -1);
        return has(f.port, v);
      }
      case 'cpu': {
        if (item.kind !== 'container') return false;
        if (/^\d+$/.test(v)) return parseCpuset(item.cpuset).indexOf(+v) !== -1;
        if (v === 'any' || v === 'yes' || v === 'true') return !!item.cpuset;
        if (v === 'none' || v === 'no' || v === 'false') return !item.cpuset;
        return has(f.cpu, v);
      }
      case 'network':
      case 'ip':
      case 'name':
      case 'image':
      case 'tag':
      case 'folder':
      case 'compose':
      case 'path':
      case 'id':
      case 'label':
        return has(f[term.key], v);
      default:
        return false;
    }
  }

  function matchesQuery(item, terms) {
    for (const t of terms) {
      if (matchTerm(item, t) === t.negate) return false;
    }
    return true;
  }

  /** Does the item pass the active chips, optionally ignoring one group (for faceted counts)? */
  function matchesChips(item, chips, skipGroup) {
    if (!chips.length) return true;
    if (item.kind !== 'container') return false;
    const byGroup = {};
    for (const id of chips) {
      const c = get(CHIP_BY_ID, id);
      if (!c || c.group === skipGroup) continue;
      (byGroup[c.group] = byGroup[c.group] || []).push(c);
    }
    for (const g of Object.keys(byGroup)) {
      const list = byGroup[g];
      const mode = (get(GROUP_BY_ID, g) || {}).mode || 'any';
      const ok = mode === 'all' ? list.every(c => c.test(item)) : list.some(c => c.test(item));
      if (!ok) return false;
    }
    return true;
  }

  function matchesNetwork(item, net) {
    if (!net) return true;
    return item.kind === 'container' && (item.networks || []).indexOf(net) !== -1;
  }

  function normalizeState(state) {
    const s = state || {};
    const chips = Array.from(Array.isArray(s.chips) ? s.chips : []).filter(id => typeof id === 'string' && own(CHIP_BY_ID, id));
    return { q: typeof s.q === 'string' ? s.q : '', chips, net: typeof s.net === 'string' ? s.net : '' };
  }

  function isActive(state) {
    const s = normalizeState(state);
    return !!(s.q.trim() || s.chips.length || s.net);
  }

  /**
   * Work out which items to show and the count for every chip and network.
   * Counts are faceted: each chip's count is what you would see if you also switched it on.
   */
  function computeView(items, state) {
    const s = normalizeState(state);
    const terms = parseQuery(s.q);
    const active = !!(terms.length || s.chips.length || s.net);
    const containers = items.filter(i => i.kind === 'container');
    const qOk = new Map(items.map(i => [i, matchesQuery(i, terms)]));

    const visible = new Set();
    for (const i of items) {
      if (!active || (qOk.get(i) && matchesChips(i, s.chips) && matchesNetwork(i, s.net))) visible.add(i.key);
    }

    const counts = {};
    for (const c of CHIPS) {
      const g = get(GROUP_BY_ID, c.group);
      const skip = g && g.mode === 'any' ? c.group : null;
      let n = 0;
      for (const i of containers) {
        if (qOk.get(i) && matchesNetwork(i, s.net) && matchesChips(i, s.chips, skip) && c.test(i)) n++;
      }
      counts[c.id] = n;
    }

    const totals = {};
    for (const c of CHIPS) totals[c.id] = containers.filter(c.test).length;

    const netCounts = {};
    for (const i of containers) {
      const hit = qOk.get(i) && matchesChips(i, s.chips);
      for (const n of i.networks || []) {
        const prev = own(netCounts, n) ? netCounts[n] : 0;
        netCounts[n] = prev + (hit ? 1 : 0);
      }
    }

    const available = {};
    for (const c of CHIPS) {
      const needed = !c.needs || containers.some(i => i[c.needs] !== undefined && i[c.needs] !== null);
      available[c.id] = needed && (!c.rare || totals[c.id] > 0 || s.chips.indexOf(c.id) !== -1);
    }

    return {
      active,
      visible,
      counts,
      totals,
      available,
      netCounts,
      shown: containers.filter(i => visible.has(i.key)).length,
      total: containers.length
    };
  }

  /** Per-folder totals: { folderId: { total, shown } }. */
  function summarizeFolders(items, visible) {
    const out = {};
    for (const i of items) {
      if (!i.folderId) continue;
      const f = out[i.folderId] || (out[i.folderId] = { total: 0, shown: 0 });
      f.total++;
      if (visible.has(i.key)) f.shown++;
    }
    return out;
  }

  /** State <-> URL hash ("#q=plex&f=running,healthy&net=br0"). */
  function encodeHash(state) {
    const s = normalizeState(state);
    const parts = [];
    if (s.q) parts.push('q=' + encodeURIComponent(s.q));
    if (s.chips.length) parts.push('f=' + s.chips.map(encodeURIComponent).join(','));
    if (s.net) parts.push('net=' + encodeURIComponent(s.net));
    return parts.join('&');
  }

  function decodeHash(hash) {
    const h = String(hash || '').replace(/^#/, '');
    if (!h) return null;
    const out = { q: '', chips: [], net: '' };
    let seen = false;
    for (const part of h.split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq);
      let v;
      try { v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch (e) { continue; }
      if (k === 'q') { out.q = v; seen = true; }
      else if (k === 'f') { out.chips = v.split(',').filter(Boolean); seen = true; }
      else if (k === 'net') { out.net = v; seen = true; }
    }
    return seen ? normalizeState(out) : null;
  }

  return {
    KEYS, IS, CHIPS, GROUPS,
    tokenize, parseQuery, parseCpuset, parseStatus, parseCallArgs, imageTag,
    matchesQuery, matchesChips, matchesNetwork, computeView, summarizeFolders,
    normalizeState, isActive, encodeHash, decodeHash
  };
});
