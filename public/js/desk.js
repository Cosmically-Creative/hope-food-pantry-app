(function () {
  var key = 'hope-place';
  var place = null;
  try {
    var raw = sessionStorage.getItem(key);
    if (raw) {
      sessionStorage.removeItem(key);
      place = JSON.parse(raw);
    }
  } catch (err) {
    place = null;
  }
  var restore = place && place.path === location.pathname && typeof place.y === 'number' && place.y > 0;
  if (restore && 'scrollRestoration' in history) history.scrollRestoration = 'manual';

  var scrollToY = function (y) {
    var root = document.documentElement;
    var previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, y);
    root.scrollTop = y;
    if (document.body) document.body.scrollTop = y;
    root.style.scrollBehavior = previous;
  };

  if (restore) scrollToY(place.y);

  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (!form || !form.hasAttribute || !form.hasAttribute('data-keep-place')) return;
      var y = window.scrollY || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0) || 0;
      try {
        sessionStorage.setItem(key, JSON.stringify({ path: location.pathname, y: y }));
      } catch (err) {}
    },
    true,
  );

  var bind = function () {
    if (restore) scrollToY(place.y);
    if (location.search.indexOf('notice=') !== -1) {
      try {
        var url = new URL(location.href);
        if (url.searchParams.has('notice')) {
          url.searchParams.delete('notice');
          history.replaceState(null, '', url.pathname + url.search + url.hash);
        }
      } catch (err) {}
    }
    document.querySelectorAll('[data-dismiss-notice]').forEach(function (button) {
      button.addEventListener('click', function () {
        var notice = button.closest('[data-notice]');
        if (notice) notice.remove();
      });
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  window.addEventListener('load', function () {
    if (restore) scrollToY(place.y);
  });
})();
