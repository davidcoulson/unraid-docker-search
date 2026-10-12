'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/docker.search/js/filter-core.js');

let seq = 0;
function ct(over) {
  seq++;
  return Object.assign({
    key: 'k' + seq, kind: 'container', name: 'ct' + seq, id: 'id' + seq, image: '', tag: '',
    state: 'started', restarting: false, health: null, update: 0, autostart: true,
    manager: 'dockerman', compose: '', webui: '', cpuset: '', networks: ['bridge'], ips: [],
    ports: [], volumes: [], labels: {}, folder: '', folderId: '', tailscale: false
  }, over);
}

const items = [
  ct({ name: 'plex', image: 'lscr.io/linuxserver/plex:latest', tag: 'latest', networks: ['host'], health: 'healthy',
    webui: 'http://192.0.2.1:32400/web', folder: 'Media', folderId: 'f1', cpuset: '4-7', ports: ['192.0.2.1:32400'] }),
  ct({ name: 'sonarr', image: 'binhex/arch-sonarr:latest', networks: ['br0.106'], ips: ['198.51.100.7'],
    health: 'healthy', update: 1, folder: 'Media', folderId: 'f1', ports: ['8989:TCP'] }),
  ct({ name: 'radarr', image: 'binhex/arch-radarr:latest', networks: ['br0.106'], ips: ['198.51.100.8'],
    state: 'stopped', autostart: false, folder: 'Media', folderId: 'f1', ports: ['8080:TCP'] }),
  ct({ name: 'grafana', image: 'grafana/grafana:11', networks: ['bridge'], health: 'unhealthy',
    labels: { 'com.docker.compose.project': 'monitoring' }, compose: 'monitoring', manager: 'composeman', autostart: null }),
  ct({ name: 'flaky', image: 'example/flaky', state: 'started', restarting: true, health: 'starting', networks: ['br0'],
    volumes: ['/config ↔ /mnt/user/appdata/flaky'], tailscale: true }),
  { key: 'orphan1', kind: 'orphan', name: '(orphan image)', image: 'old/image:1', networks: [] }
];

const shown = view => items.filter(i => view.visible.has(i.key)).map(i => i.name);

test('parseQuery: free text, keys, aliases, quotes, negation', () => {
  assert.deepEqual(Core.parseQuery('  Plex  '), [{ key: null, value: 'plex', negate: false }]);
  assert.deepEqual(Core.parseQuery('image:LinuxServer'), [{ key: 'image', value: 'linuxserver', negate: false }]);
  assert.deepEqual(Core.parseQuery('net:br0 stack:mon'), [
    { key: 'network', value: 'br0', negate: false }, { key: 'compose', value: 'mon', negate: false }]);
  assert.deepEqual(Core.parseQuery('folder:"Media Apps"'), [{ key: 'folder', value: 'media apps', negate: false }]);
  assert.deepEqual(Core.parseQuery('-is:running !plex'), [
    { key: 'is', value: 'running', negate: true }, { key: null, value: 'plex', negate: true }]);
  // Unknown keys and quoted colons stay plain text.
  assert.deepEqual(Core.parseQuery('http://x'), [{ key: null, value: 'http://x', negate: false }]);
  assert.deepEqual(Core.parseQuery('"name:foo"'), [{ key: null, value: 'name:foo', negate: false }]);
  // Empty values are dropped.
  assert.deepEqual(Core.parseQuery('name: -'), [{ key: null, value: '-', negate: false }]);
  assert.deepEqual(Core.parseQuery('name:'), []);
});

test('free text matches name, image, folder, network, ip and port, case-insensitively', () => {
  const v = q => shown(Core.computeView(items, { q }));
  assert.deepEqual(v('PLEX'), ['plex']);
  assert.deepEqual(v('binhex'), ['sonarr', 'radarr']);
  assert.deepEqual(v('media'), ['plex', 'sonarr', 'radarr']);
  assert.deepEqual(v('198.51.100.8'), ['radarr']);
  assert.deepEqual(v('32400'), ['plex']);
  assert.deepEqual(v('br0.106'), ['sonarr', 'radarr']);
  // Paths are only searched with path:, so "appdata" alone does not match.
  assert.deepEqual(v('appdata'), []);
  assert.deepEqual(v('path:appdata/flaky'), ['flaky']);
});

test('terms are ANDed and negation excludes', () => {
  const v = q => shown(Core.computeView(items, { q }));
  assert.deepEqual(v('binhex is:running'), ['sonarr']);
  assert.deepEqual(v('binhex -sonarr'), ['radarr']);
  assert.deepEqual(v('folder:media -is:stopped'), ['plex', 'sonarr']);
});

test('key:value searches', () => {
  const v = q => shown(Core.computeView(items, { q }));
  assert.deepEqual(v('image:linuxserver'), ['plex']);
  assert.deepEqual(v('tag:latest'), ['plex']);
  assert.deepEqual(v('net:host'), ['plex']);
  assert.deepEqual(v('ip:198.51.100.'), ['sonarr', 'radarr']);
  assert.deepEqual(v('label:compose.project=monitoring'), ['grafana']);
  assert.deepEqual(v('stack:monitoring'), ['grafana']);
  assert.deepEqual(v('name:arr'), ['sonarr', 'radarr']);
});

test('port: compares whole numbers', () => {
  const v = q => shown(Core.computeView(items, { q }));
  assert.deepEqual(v('port:80'), []);
  assert.deepEqual(v('port:8080'), ['radarr']);
  assert.deepEqual(v('port:tcp'), ['sonarr', 'radarr']);
});

test('cpu: matches pinned cores and any/none', () => {
  const v = q => shown(Core.computeView(items, { q }));
  assert.deepEqual(v('cpu:5'), ['plex']);
  assert.deepEqual(v('cpu:3'), []);
  assert.deepEqual(v('cpu:any'), ['plex']);
  assert.equal(v('cpu:none').length, 4);
});

test('is: values', () => {
  const v = q => shown(Core.computeView(items, { q }));
  assert.deepEqual(v('is:healthy'), ['plex', 'sonarr']);
  assert.deepEqual(v('is:unhealthy'), ['grafana']);
  assert.deepEqual(v('health:starting'), ['flaky']);
  assert.deepEqual(v('is:restarting'), ['flaky']);
  assert.deepEqual(v('is:update'), ['sonarr']);
  assert.deepEqual(v('is:manual'), ['radarr']);
  assert.deepEqual(v('has:webui'), ['plex']);
  assert.deepEqual(v('is:compose'), ['grafana']);
  assert.deepEqual(v('is:tailscale'), ['flaky']);
  assert.deepEqual(v('is:no-folder'), ['grafana', 'flaky', '(orphan image)']);
  assert.deepEqual(v('is:bogus'), []);
});

test('chips: OR inside an any-group, AND across groups', () => {
  const v = chips => shown(Core.computeView(items, { chips }));
  assert.deepEqual(v(['running']), ['plex', 'sonarr', 'grafana', 'flaky']);
  assert.deepEqual(v(['running', 'stopped']), ['plex', 'sonarr', 'radarr', 'grafana', 'flaky']);
  assert.deepEqual(v(['running', 'healthy']), ['plex', 'sonarr']);
  assert.deepEqual(v(['healthy', 'unhealthy']), ['plex', 'sonarr', 'grafana']);
  assert.deepEqual(v(['autostart-off']), ['radarr']);
  // autostart null (compose / 3rd party) matches neither autostart chip
  assert.deepEqual(v(['autostart-on', 'autostart-off']), ['plex', 'sonarr', 'radarr', 'flaky']);
  // features narrow each other
  assert.deepEqual(v(['webui', 'pinned']), ['plex']);
  assert.deepEqual(v(['webui', 'compose']), []);
  // unknown chip ids are ignored
  assert.deepEqual(v(['nope']).length, items.length);
});

test('chips combine with the search box', () => {
  const view = Core.computeView(items, { q: 'binhex', chips: ['running'] });
  assert.deepEqual(shown(view), ['sonarr']);
});

test('orphan images hide whenever a chip or network filter is on', () => {
  assert.ok(shown(Core.computeView(items, { q: 'orphan' })).includes('(orphan image)'));
  assert.ok(!shown(Core.computeView(items, { chips: ['stopped'] })).includes('(orphan image)'));
  assert.ok(!shown(Core.computeView(items, { net: 'bridge' })).includes('(orphan image)'));
});

test('network filter is exact', () => {
  assert.deepEqual(shown(Core.computeView(items, { net: 'br0' })), ['flaky']);
  assert.deepEqual(shown(Core.computeView(items, { net: 'br0.106', chips: ['running'] })), ['sonarr']);
});

test('counts are faceted', () => {
  const view = Core.computeView(items, { chips: ['running'] });
  // Same any-group: count ignores the group's own selection.
  assert.equal(view.counts.running, 4);
  assert.equal(view.counts.stopped, 1);
  // Other groups: count is within the running set.
  assert.equal(view.counts.healthy, 2);
  assert.equal(view.counts.update, 1);
  assert.equal(view.counts['autostart-off'], 0);
  assert.equal(view.shown, 4);
  assert.equal(view.total, 5);
  // Network counts respect query and chips.
  assert.deepEqual(view.netCounts, { host: 1, 'br0.106': 1, bridge: 1, br0: 1 });

  const q = Core.computeView(items, { q: 'binhex' });
  assert.equal(q.counts.running, 1);
  assert.equal(q.counts.stopped, 1);
  assert.equal(q.counts.webui, 0);
});

test('rare chips are hidden until something needs them; needs-chips hide without data', () => {
  const view = Core.computeView(items, {});
  assert.equal(view.available.paused, false);
  assert.equal(view.available.restarting, true);
  assert.equal(view.available.running, true);
  assert.equal(view.available.pinned, true);
  const bare = items.filter(i => i.kind === 'container').map(i => {
    const c = Object.assign({}, i);
    delete c.cpuset;
    return c;
  });
  assert.equal(Core.computeView(bare, {}).available.pinned, false);
  // An active rare chip stays visible even at zero.
  assert.equal(Core.computeView(items, { chips: ['paused'] }).available.paused, true);
});

test('inactive state shows everything', () => {
  const view = Core.computeView(items, { q: '   ', chips: [], net: '' });
  assert.equal(view.active, false);
  assert.equal(view.visible.size, items.length);
  assert.equal(Core.isActive({ q: ' ' }), false);
  assert.equal(Core.isActive({ chips: ['running'] }), true);
});

test('summarizeFolders', () => {
  const view = Core.computeView(items, { q: 'sonarr' });
  assert.deepEqual(Core.summarizeFolders(items, view.visible), { f1: { total: 3, shown: 1 } });
});

test('parseStatus', () => {
  assert.deepEqual(Core.parseStatus('Uptime: 3 days (healthy)'), { health: 'healthy', restarting: false });
  assert.deepEqual(Core.parseStatus('Up 2 minutes (unhealthy)'), { health: 'unhealthy', restarting: false });
  assert.deepEqual(Core.parseStatus('Up 5 seconds (health: starting)'), { health: 'starting', restarting: false });
  assert.deepEqual(Core.parseStatus('Restarting (1): 3 seconds ago'), { health: null, restarting: true });
  assert.deepEqual(Core.parseStatus('Exited (0) 2 hours ago'), { health: null, restarting: false });
  assert.deepEqual(Core.parseStatus(undefined), { health: null, restarting: false });
});

test('parseCallArgs handles addslashes escaping and bare values', () => {
  const src = "addDockerContainerContext('it\\'s','sha','/boot/t.xml',1,0,0,true,'http://[IP]:8080/','','sh','abc123','','','','','')";
  const a = Core.parseCallArgs(src);
  assert.equal(a.length, 16);
  assert.equal(a[0], "it's");
  assert.equal(a[3], '1');
  assert.equal(a[6], 'true');
  assert.equal(a[7], 'http://[IP]:8080/');
  assert.equal(a[8], '');
  assert.equal(a[10], 'abc123');
  assert.deepEqual(Core.parseCallArgs('nothing'), []);
  assert.deepEqual(Core.parseCallArgs("f('a, b', 'c')"), ['a, b', 'c']);
});

test('parseCpuset', () => {
  assert.deepEqual(Core.parseCpuset('0-3,8,10-11'), [0, 1, 2, 3, 8, 10, 11]);
  assert.deepEqual(Core.parseCpuset(''), []);
  assert.deepEqual(Core.parseCpuset('junk,2'), [2]);
});

test('hash round trip', () => {
  const s = { q: 'image:linuxserver "a b"', chips: ['running', 'healthy'], net: 'br0.106' };
  const h = Core.encodeHash(s);
  assert.equal(h, 'q=image%3Alinuxserver%20%22a%20b%22&f=running,healthy&net=br0.106');
  assert.deepEqual(Core.decodeHash('#' + h), s);
  assert.equal(Core.decodeHash(''), null);
  assert.equal(Core.decodeHash('#tab1'), null);
  assert.equal(Core.encodeHash({}), '');
  assert.deepEqual(Core.decodeHash('#f=running,bogus'), { q: '', chips: ['running'], net: '' });
  assert.deepEqual(Core.decodeHash('#q=%E0%A4%A'), null);
});

test('lookups ignore Object.prototype names', () => {
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.deepEqual(Core.normalizeState({ chips: [id] }).chips, []);
    assert.doesNotThrow(() => Core.computeView(items, { chips: [id] }));
  }
  assert.deepEqual(Core.decodeHash('#f=constructor,running'), { q: '', chips: ['running'], net: '' });
  // "constructor:abc" is plain text, not a key, and is:constructor matches nothing.
  assert.deepEqual(Core.parseQuery('constructor:abc'), [{ key: null, value: 'constructor:abc', negate: false }]);
  assert.equal(shown(Core.computeView(items, { q: 'is:constructor' })).length, 0);
  assert.equal(shown(Core.computeView(items, { q: 'is:__proto__' })).length, 0);
  // A network called "constructor" counts like any other.
  const odd = [ct({ name: 'odd', networks: ['constructor'] }), ct({ name: 'odd2', networks: ['toString'] })];
  const v = Core.computeView(odd, {});
  assert.equal(v.netCounts.constructor, 1);
  assert.equal(v.netCounts.toString, 1);
  // Non-string state from storage is ignored.
  assert.deepEqual(Core.normalizeState({ q: { x: 1 }, chips: 'running', net: 5 }), { q: '', chips: [], net: '' });
});

test('networks outside the current match still list with zero', () => {
  const v = Core.computeView(items, { q: 'plex' });
  assert.equal(v.netCounts.host, 1);
  assert.equal(v.netCounts['br0.106'], 0);
});

test('imageTag', () => {
  assert.equal(Core.imageTag('lscr.io/linuxserver/plex:latest'), 'latest');
  assert.equal(Core.imageTag('registry.local:5000/owner/app:1.2-alpine'), '1.2-alpine');
  assert.equal(Core.imageTag('registry.local:5000/owner/app'), '');
  assert.equal(Core.imageTag('app:5.0-alpine-long-tag@sha256:abc'), '5.0-alpine-long-tag');
  assert.equal(Core.imageTag(''), '');
});
