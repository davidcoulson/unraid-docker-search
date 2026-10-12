/*
 * A small stand-in for the folder.view2 plugin, for the fixture only. It builds folder
 * rows the way folder.view2 does on the real page (folder row, member rows parked in
 * div.folder-storage until expanded, a preview strip) and fires the same events, so the
 * search plugin can be tried against folders without the real plugin.
 * Like folder.view2, it declares its globals with const in a classic script.
 */
const folderEvents = new EventTarget();
let globalFolders = {};
let loadedFolder = false;

const fire = (name, detail) => folderEvents.dispatchEvent(new CustomEvent(name, { detail }));

const dropDownButton = (id) => {
  fire('docker-pre-folder-expansion', { id });
  const btn = $(`.dropDown-${id}`);
  const open = btn.attr('active') === 'true';
  if (open) {
    btn.children().removeClass('fa-chevron-up').addClass('fa-chevron-down');
    $(`tr.folder-id-${id}`).addClass('sortable');
    $(`tr.folder-id-${id} .folder-storage`).append($(`.folder-${id}-element`));
    btn.attr('active', 'false');
  } else {
    btn.children().removeClass('fa-chevron-down').addClass('fa-chevron-up');
    $(`tr.folder-id-${id}`).removeClass('sortable');
    $(`tr.folder-id-${id}`).after($(`.folder-${id}-element`));
    btn.attr('active', 'true');
  }
  if (globalFolders[id]) globalFolders[id].status.expanded = !open;
  fire('docker-post-folder-expansion', { id });
};

const createFolders = async () => {
  const folders = await (await fetch('/fixture/folders.json', { cache: 'no-store' })).json();
  fire('docker-pre-folders-creation', { folders });
  const done = {};
  const advanced = $.cookie('docker_listview_mode') === 'advanced';
  for (const [id, folder] of Object.entries(folders)) {
    const rows = $('#docker_list > tr.sortable').filter(function () {
      return folder.containers.indexOf($(this).find('td.ct-name .appname').text().trim()) !== -1;
    });
    if (!rows.length) continue;
    const started = rows.find('i[id^="load-"].started').length;
    const fld = $(`<tr class="sortable folder-id-${id} folder"><td class="ct-name folder-name"><div class="folder-name-sub"><i class="fa fa-arrows-v mover orange-text"></i><span class="outer folder-outer"><span id="${id}" class="hand folder-hand"><img src="/plugins/dynamix.docker.manager/images/question.png" class="img folder-img"></span><span class="inner folder-inner"><span class="appname" style="display: none;"><a>folder-${id}</a></span><a class="exec folder-appname">${folder.name}</a><br><i id="load-folder-${id}" class="fa fa-${started ? 'play started green-text' : 'square stopped red-text'} folder-load-status"></i><span class="state folder-state"> ${started}/${rows.length} started</span></span></span><button class="dropDown-${id} folder-dropdown" onclick="dropDownButton('${id}')"><i class="fa fa-chevron-down" aria-hidden="true"></i></button></div></td><td class="updatecolumn folder-update"><span class="green-text folder-update-text"><i class="fa fa-check fa-fw"></i> up-to-date</span></td><td colspan="5"><div class="folder-storage"></div><div class="folder-preview folder-preview-1"></div></td><td class="advanced folder-advanced" ${advanced ? 'style="display: table-cell;"' : ''}><span class="folder-cpu">0%</span></td><td class="folder-autostart"></td><td></td></tr>`);
    rows.first().before(fld);
    rows.each(function () {
      const row = $(this);
      fld.find('div.folder-storage').append(row.addClass(`folder-${id}-element folder-element`).removeClass('sortable'));
      const clone = row.find('td.ct-name > span.outer').clone();
      clone.find('span.state').each(function () { this.innerHTML = this.innerHTML.split('<br>')[0]; });
      clone.find('i[id^="load-"]').each(function () { this.id = 'folder-' + this.id; });
      clone.find('span.hand').each(function () { this.id = 'folder-preview-' + this.id; this.removeAttribute('onclick'); });
      fld.find('div.folder-preview').append($('<div class="folder-preview-wrapper"></div>').append(clone));
    });
    folder.status = { expanded: false };
    done[id] = folder;
  }
  for (const [id, folder] of Object.entries(done)) {
    if ((globalFolders[id] && globalFolders[id].status.expanded) || folder.settings.expand_tab) {
      folder.status.expanded = true;
      dropDownButton(id);
    }
  }
  globalFolders = done;
  fire('docker-post-folders-creation', { folders });
};

// Patch the page's functions the way folder.view2 does.
window.listview_original = listview;
window.listview = () => {
  listview_original();
  if (!loadedFolder) {
    createFolders();
    loadedFolder = true;
  }
};
window.loadlist_original = loadlist;
window.loadlist = () => {
  loadedFolder = false;
  loadlist_original();
};
