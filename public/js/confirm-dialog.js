(function () {
  var dialog = document.getElementById('confirm');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  var form = document.getElementById('confirm-form');
  var title = document.getElementById('confirm-title');
  var detail = document.getElementById('confirm-detail');
  var body = document.getElementById('confirm-body');
  var note = document.getElementById('confirm-note');
  var submit = document.getElementById('confirm-submit');
  var cancel = document.getElementById('confirm-cancel');
  var error = document.getElementById('confirm-error');
  if (!form || !title || !detail || !body || !note || !submit || !cancel) return;

  var text = function (link, name) {
    return link.getAttribute(name) || '';
  };

  var chosenFor = function (name) {
    return document.querySelectorAll('input[data-pick="' + name + '"]:checked');
  };

  var fill = function (link) {
    form.querySelectorAll('[data-picked]').forEach(function (input) {
      input.remove();
    });
    form.action = text(link, 'data-confirm-action') || link.getAttribute('href') || '';
    title.textContent = text(link, 'data-confirm-title') || 'Remove';
    body.textContent = text(link, 'data-confirm-body');
    var when = text(link, 'data-confirm-detail');
    detail.textContent = when;
    detail.hidden = when === '';
    var extra = text(link, 'data-confirm-note');
    note.textContent = extra;
    note.hidden = extra === '';
    var label = text(link, 'data-confirm-submit');
    submit.textContent = label || 'Remove';
    submit.hidden = label === '';
    submit.disabled = label === '';
    cancel.textContent = label === '' ? 'Close' : 'Cancel';
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
    var pick = link.getAttribute('data-confirm-pick');
    if (!pick) return;
    var chosen = chosenFor(pick);
    var weekly = false;
    chosen.forEach(function (box) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = pick + '[]';
      input.value = box.value;
      input.setAttribute('data-picked', '');
      form.appendChild(input);
      if (box.getAttribute('data-weekly') === 'true') weekly = true;
    });
    detail.textContent = chosen.length === 1 ? '1 selected' : chosen.length + ' selected';
    detail.hidden = false;
    var weeklyNote = text(link, 'data-confirm-note-weekly');
    if (weekly && weeklyNote) {
      note.textContent = weeklyNote;
      note.hidden = false;
    }
  };

  var show = function () {
    if (dialog.open) dialog.close();
    dialog.showModal();
    dialog.classList.add('is-modal');
    var focus = submit.hidden ? cancel : submit;
    if (focus) focus.focus();
  };

  var syncPicks = function () {
    document.querySelectorAll('[data-confirm-pick]').forEach(function (control) {
      var name = control.getAttribute('data-confirm-pick');
      control.hidden = !name || chosenFor(name).length === 0;
    });
    document.querySelectorAll('[data-pick-all]').forEach(function (all) {
      var name = all.getAttribute('data-pick-all');
      if (!name) return;
      var boxes = document.querySelectorAll('input[data-pick="' + name + '"]');
      var checked = chosenFor(name);
      all.checked = boxes.length > 0 && checked.length === boxes.length;
      all.indeterminate = checked.length > 0 && checked.length < boxes.length;
    });
  };

  document.querySelectorAll('[data-confirm]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var pick = link.getAttribute('data-confirm-pick');
      if (pick && chosenFor(pick).length === 0) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      fill(link);
      show();
    });
  });

  document.querySelectorAll('[data-pick-all]').forEach(function (all) {
    all.addEventListener('change', function () {
      var name = all.getAttribute('data-pick-all');
      if (!name) return;
      var checked = all.checked;
      document.querySelectorAll('input[data-pick="' + name + '"]').forEach(function (box) {
        box.checked = checked;
      });
      syncPicks();
    });
  });

  document.querySelectorAll('input[data-pick]').forEach(function (box) {
    box.addEventListener('change', syncPicks);
  });

  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('close', function () {
    if (!dialog.open) dialog.classList.remove('is-modal');
  });

  syncPicks();
  if (dialog.open) show();
})();
