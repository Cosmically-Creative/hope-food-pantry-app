(function () {
  bindCalendar();
  var boxes = document.querySelectorAll('[data-under-18]');
  for (var i = 0; i < boxes.length; i += 1) bind(boxes[i]);

  function bindCalendar() {
    var calendar = document.querySelector('.shift-calendar');
    var weeks = document.querySelectorAll('.cal-week');
    if (!calendar || !weeks.length) return;
    calendar.classList.add('js');
    var wide = window.matchMedia('(min-width: 42.001em) and (max-width: 75em)');
    var syncAll = function () {
      for (var i = 0; i < weeks.length; i += 1) syncWeek(weeks[i], wide.matches);
    };
    for (var i = 0; i < weeks.length; i += 1) {
      var details = weeks[i].querySelectorAll('details.day-reveal');
      for (var j = 0; j < details.length; j += 1) details[j].addEventListener('toggle', syncAll);
    }
    if (wide.addEventListener) wide.addEventListener('change', syncAll);
    syncAll();
  }

  function syncWeek(week, wide) {
    var tray = week.querySelector('.week-tray');
    if (!tray) return;
    var details = week.querySelectorAll('details.day-reveal');
    for (var i = 0; i < details.length; i += 1) {
      var detail = details[i];
      var date = detail.getAttribute('data-date');
      if (!date || !detail.parentNode) continue;
      var drawer = week.querySelector('.shift-drawer[data-date="' + date + '"]');
      if (!drawer) continue;
      if (wide && detail.open) {
        if (drawer.parentNode !== tray) tray.appendChild(drawer);
      } else if (drawer.parentNode === tray) {
        detail.parentNode.appendChild(drawer);
      }
    }
  }

  function bind(box) {
    var form = box.form;
    if (!form) return;
    var guardian = form.querySelector('[data-guardian]');
    if (!guardian) return;
    var inputs = guardian.querySelectorAll('input');
    var sync = function () {
      var on = box.checked;
      for (var j = 0; j < inputs.length; j += 1) inputs[j].required = on;
    };
    box.addEventListener('change', sync);
    sync();
  }
})();
