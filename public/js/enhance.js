(function () {
  bindNav();
  bindCalendar();
  bindViewMenu();
  document.querySelectorAll('[data-contact]').forEach(bindContact);
  document.querySelectorAll('[data-see-more]').forEach(bindSeeMore);

  function bindNav() {
    var header = document.querySelector('.header');
    var button = document.querySelector('.btn-mobile-nav');
    if (!header || !button) return;
    button.addEventListener('click', function () {
      var open = header.classList.toggle('nav-open');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    var close = function () {
      header.classList.remove('nav-open');
      button.setAttribute('aria-expanded', 'false');
    };
    var links = document.querySelectorAll('.main-nav-link, .session-bar a');
    for (var i = 0; i < links.length; i += 1) links[i].addEventListener('click', close);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') close();
    });
  }

  function bindViewMenu() {
    var menus = document.querySelectorAll('details.view-menu');
    if (!menus.length) return;
    document.addEventListener('click', function (event) {
      for (var i = 0; i < menus.length; i += 1) {
        if (!menus[i].open || menus[i].contains(event.target)) continue;
        menus[i].open = false;
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      for (var i = 0; i < menus.length; i += 1) menus[i].open = false;
    });
  }

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

  function bindSeeMore(link) {
    var list = document.getElementById('contacts-list');
    if (!list) return;
    var size = Number(link.getAttribute('data-see-more'));
    if (!size || size < 1) size = 20;
    link.addEventListener('click', function (event) {
      var hidden = list.querySelectorAll('[data-contact-row][hidden]');
      if (!hidden.length) return;
      event.preventDefault();
      var count = Math.min(size, hidden.length);
      for (var i = 0; i < count; i += 1) hidden[i].hidden = false;
      if (hidden.length <= count) {
        var more = link.parentNode;
        if (more && more.classList && more.classList.contains('contact-more')) more.hidden = true;
        else link.hidden = true;
      }
    });
  }

  function bindContact(picker) {
    picker.addEventListener('change', function () {
      var form = picker.form;
      var option = picker.options[picker.selectedIndex];
      if (!form || !option || !option.value) return;
      setField(form, 'name', option.getAttribute('data-name') || '');
      setField(form, 'email', option.getAttribute('data-email') || '');
      setField(form, 'phone', option.getAttribute('data-phone') || '');
    });
  }

  function setField(form, name, value) {
    var input = form.elements[name];
    if (input && 'value' in input) input.value = value;
  }
})();
