(function () {
  var dialog = document.getElementById('new-event');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  var show = function () {
    if (dialog.open) dialog.close();
    dialog.showModal();
    dialog.classList.add('is-modal');
    var field = dialog.querySelector('input[name="title"]');
    if (field) field.focus();
  };

  document.querySelectorAll('[data-open-event]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      if (dialog.open && dialog.classList.contains('is-modal')) {
        var field = dialog.querySelector('input[name="title"]');
        if (field) field.focus();
        return;
      }
      show();
    });
  });

  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('close', function () {
    if (!dialog.open) dialog.classList.remove('is-modal');
  });

  if (dialog.open) show();
})();
