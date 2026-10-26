(function () {
  var form = document.querySelector('[data-export-range]');
  if (!form) return;
  var from = form.querySelector('input[name="from"]');
  var to = form.querySelector('input[name="to"]');
  var buttons = form.querySelectorAll('[data-range]');
  if (!from || !to) return;

  var select = function (name) {
    buttons.forEach(function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-range') === name ? 'true' : 'false');
    });
  };

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      var name = button.getAttribute('data-range');
      if (name === 'this' || name === 'last') {
        from.value = button.getAttribute('data-from') || '';
        to.value = button.getAttribute('data-to') || '';
      }
      select(name || 'custom');
    });
  });

  var markCustom = function () {
    select('custom');
  };
  from.addEventListener('input', markCustom);
  to.addEventListener('input', markCustom);
})();
