# Development

## How it works

`DockerSearch.page` is a `Menu="Buttons"` page, which the webGUI evaluates in the `<head>` of
every page; it only emits the CSS and JS when the current page is Docker. Hooking in there
rather than with `Menu="Docker"` keeps the Docker tab's own page list (and so its tabbed or
untabbed layout) unchanged.

`js/docker-search.js` reads the rows that `DockerContainers.php` renders: name, state icon,
status line (health), autostart switch, networks, IPs, ports, volumes, the WebUI argument of the
context menu, and the `docker[]` array the page fills in (update status). Non-matching rows get a
class that hides them; the rows themselves are never changed, so sorting, drag-to-reorder,
context menus, the autostart switches and the Basic/Advanced toggle keep working. A
`MutationObserver` on `#docker_list` re-applies the filter whenever the list is redrawn or
folder.view2 rebuilds its folders.

Some things are not on the page: the full image name (the page shortens it to 24 characters and
only shows it in Advanced view), CPU pinning and labels. `include/data.php` returns those as JSON
(read-only, behind the webGUI login) and the search uses them once they arrive; without it the
search still works on what the page shows.

`js/filter-core.js` holds all of the matching logic as a plain module with no DOM access, so it
can be tested under Node.

### Search syntax

- Plain words match name, image, tag, folder, network, IP, port, compose stack and ID
  (case-insensitive substring; every word must match).
- Keys: `name:` `image:` `tag:` `net:` `ip:` `port:` `folder:` `stack:` `label:` `cpu:`
  `path:` `id:`. `port:80` matches the whole number, not 8080; `cpu:4` means pinned to core 4,
  `cpu:any` / `cpu:none` too.
- `is:`/`has:` values: `running` `stopped` `paused` `restarting` `healthy` `unhealthy`
  `starting` `update` `autostart` `manual` `webui` `pinned` `compose` `folder` `tailscale`.
- A leading `-` (or `!`) excludes; quote values with spaces: `folder:"Media Apps"`.

Chips in the same group (Running / Stopped) widen the match; chips in different groups narrow
it. Each chip's count is what you would see if you also switched it on. Paused, Restarting,
Starting, Compose and Tailscale chips only appear when something matches them.

### folder.view2

folder.view2 parks a folder's rows inside the folder row until it is expanded and exposes
`dropDownButton(id)` and a `folderEvents` EventTarget (both declared with `const`, so they live
in the global lexical scope, not on `window`). While a filter is active, a folder with matches
is opened via `dropDownButton` and closed again when the filter is cleared; folders the user
closes by hand stay closed, even across a list redraw. Non-matching icons in a collapsed folder's
preview are dimmed. Keystrokes in the search box don't propagate, because folder.view2 starts a
debug download when it sees "debug" typed anywhere on the page.

### Limits

- Health comes from Docker's status text (`(healthy)`, `(unhealthy)`, `(health: starting)`).
  On a translated webGUI the page's wording differs, so the plugin falls back to the status from
  `data.php`.
- Dragging rows while filtered moves them relative to the visible rows only.
- folder.view2 support depends on its markup and globals staying as they are.

## Commands

```
npm test                             # filter logic tests (node --test, no dependencies)
scripts/fetch-vendor.sh root@tower   # optional: webGUI CSS/fonts/icons into fixture/vendor (gitignored)
npm run serve                        # fixture page on http://localhost:8817/
scripts/build.sh 2026.10.12b         # archive/docker.search-<version>-noarch-1.txz + version/MD5 in the .plg
```

Bump the version and add a `<CHANGES>` entry in `docker.search.plg` for every release; the
package is named `name-version-noarch-1` so `upgradepkg` replaces the previous one.

## Fixture

`fixture/` is a capture of a real Docker page (83 containers, 8 folders) for trying changes in a
browser. `fixture/fv2-stub.js` stands in for folder.view2 (same DOM shape and events), and the
toolbar switches theme, Basic/Advanced view, folders and sorting, and can redraw the list.

To refresh it from your own server:

```
scripts/capture.sh root@tower /tmp/capture
python3 -I scripts/make-fixture.py /tmp/capture --renames ~/renames.json --drop-folder Private
```

`make-fixture.py` rewrites host paths under `/mnt` (pools, shares and folders that aren't
generic become `poolN`/`shareN`/`dirN`, including where container paths mirror them), maps
addresses to private test ranges, replaces MACs and e-mail addresses, cuts labels to an
allowlist, applies a renames file you keep outside the repo, and leaves out whole folders or
containers with `--drop-folder` / `--drop`. **Read the output before committing it**: it is a
picture of your server.

The optional vendor files (webGUI CSS, fonts, icons) are fetched from your own server, are
Lime Technology's and plugin authors', and stay out of the repository.

## Community Apps

`ca_profile.xml` (repository profile) and `plugins/docker.search.xml` (the plugin wrapper) are
what Community Apps reads. The wrapper's `<PluginURL>` must match the `.plg`'s `pluginURL`
exactly. After changing either, run Validate and Scan at <https://ca.unraid.net/submit>.
