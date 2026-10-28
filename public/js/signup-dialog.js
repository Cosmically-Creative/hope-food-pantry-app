(function () {
  var dialog = document.getElementById('signup-dialog');
  var body = document.getElementById('signup-dialog-body');
  if (!dialog || !body || typeof dialog.showModal !== 'function') return;

  var requestId = 0;
  var widgetId = null;
  var turnstileLoading = null;
  var lastTrigger = null;

  document.querySelectorAll('a[data-signup]').forEach(function (link) {
    link.setAttribute('aria-haspopup', 'dialog');
    link.setAttribute('aria-controls', 'signup-dialog');
  });

  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[data-signup]') : null;
    if (!link) return;
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var href = link.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    openSignup(link, href);
  });

  var closeButton = dialog.querySelector('[data-signup-close]');
  if (closeButton) closeButton.addEventListener('click', function () { dialog.close(); });

  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('close', function () {
    requestId += 1;
    clearWidget();
    dialog.classList.remove('is-modal');
    dialog.removeAttribute('aria-busy');
    if (lastTrigger && typeof lastTrigger.focus === 'function') lastTrigger.focus();
  });

  function openSignup(link, href) {
    lastTrigger = link;
    var id = ++requestId;
    showLoading();
    if (!dialog.open) {
      dialog.showModal();
      dialog.classList.add('is-modal');
    }
    fetch(href, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } })
      .then(function (response) {
        return response.text();
      })
      .then(function (html) {
        if (id !== requestId) return;
        fill(html, href);
      })
      .catch(function () {
        if (id !== requestId) return;
        showFailure(href);
      });
  }

  function showLoading() {
    clearWidget();
    dialog.setAttribute('aria-busy', 'true');
    var panel = panelWithTitle('Sign up');
    var note = document.createElement('p');
    note.className = 'signup-dialog-note';
    note.setAttribute('role', 'status');
    note.textContent = 'Loading the signup form.';
    panelScroll(panel).appendChild(note);
    body.replaceChildren(panel);
  }

  function showFailure(href) {
    clearWidget();
    dialog.removeAttribute('aria-busy');
    var panel = panelWithTitle('Sign up');
    var note = document.createElement('p');
    note.className = 'signup-dialog-note';
    note.textContent = 'The signup form could not be loaded. ';
    var link = document.createElement('a');
    link.href = href;
    link.textContent = 'Open the shift page';
    note.appendChild(link);
    panelScroll(panel).appendChild(note);
    body.replaceChildren(panel);
    if (closeButton) closeButton.focus();
  }

  function fill(html, href) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var main = doc.querySelector('main');
    if (!main) {
      showFailure(href);
      return;
    }
    var form = main.querySelector('form.signup-form');
    var heading = main.querySelector('h1');
    clearWidget();
    dialog.removeAttribute('aria-busy');
    var panel = document.createElement('div');
    panel.className = 'signup-dialog-panel';
    var summary = document.createElement('div');
    summary.className = 'signup-dialog-summary';
    var title = document.createElement('h2');
    title.id = 'signup-dialog-label';
    title.className = 'signup-dialog-title';
    title.textContent = heading && heading.textContent ? heading.textContent.trim() : 'Sign up';
    summary.appendChild(title);
    appendFrom(summary, main, 'p.location');
    appendFrom(summary, main, 'p.when');
    appendFrom(summary, main, 'p.status');
    appendFrom(summary, main, 'p.spots');
    var notice = main.querySelector('p.error');
    if (notice && (!form || !form.contains(notice))) summary.appendChild(document.importNode(notice, true));
    panel.appendChild(summary);
    var scroll = attachScroll(panel);
    if (!form) {
      var closed = document.createElement('p');
      closed.className = 'signup-dialog-note';
      var paragraph = main.querySelector('p');
      if (!main.querySelector('p.when') && paragraph) {
        closed.textContent = paragraph.textContent.trim();
      } else {
        closed.textContent = 'This shift is not open for signup.';
      }
      scroll.appendChild(closed);
      body.replaceChildren(panel);
      if (closeButton) closeButton.focus();
      return;
    }
    var liveForm = document.importNode(form, true);
    liveForm.querySelectorAll('noscript').forEach(function (node) { node.remove(); });
    scroll.appendChild(liveForm);
    body.replaceChildren(panel);
    bindForm(liveForm);
    mountTurnstile(liveForm);
    var field = firstField(liveForm);
    if (field) field.focus();
  }

  function bindForm(form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (form.getAttribute('data-sending') === 'true') return;
      var action = form.getAttribute('action');
      if (!action) return;
      form.setAttribute('data-sending', 'true');
      var submit = form.querySelector('button[type="submit"]');
      if (submit) {
        submit.disabled = true;
        submit.textContent = 'Signing up…';
      }
      var id = requestId;
      fetch(action, {
        method: 'POST',
        body: new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/html' },
      })
        .then(function (response) {
          if (isConfirmed(response)) {
            window.location.assign(response.url);
            return null;
          }
          return response.text();
        })
        .then(function (html) {
          if (html === null || id !== requestId) return;
          fill(html, action);
        })
        .catch(function () {
          if (id !== requestId || !form.isConnected) return;
          form.removeAttribute('data-sending');
          if (submit) {
            submit.disabled = false;
            submit.textContent = 'Sign up';
          }
          var alert = form.querySelector('[data-signup-send-error]');
          if (!alert) {
            alert = document.createElement('p');
            alert.className = 'error';
            alert.setAttribute('role', 'alert');
            alert.setAttribute('data-signup-send-error', '');
            form.insertBefore(alert, form.firstChild);
          }
          alert.textContent = 'The signup could not be sent. Please try again.';
        });
    });
  }

  function mountTurnstile(scope) {
    var widget = scope.querySelector('.cf-turnstile');
    var sitekey = widget && widget.getAttribute('data-sitekey');
    if (!widget || !sitekey) return;
    loadTurnstile()
      .then(function () {
        if (!widget.isConnected || !window.turnstile) return;
        // turnstile.ready() throws when this script is inserted dynamically.
        widgetId = window.turnstile.render(widget, {
          sitekey: sitekey,
          action: widget.getAttribute('data-action') || 'signup',
        });
      })
      .catch(function () {});
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.onload = function () { resolve(); };
      script.onerror = function () {
        turnstileLoading = null;
        reject(new Error('Turnstile did not load.'));
      };
      document.head.appendChild(script);
    });
    return turnstileLoading;
  }

  function clearWidget() {
    if (widgetId !== null && window.turnstile && window.turnstile.remove) {
      try {
        window.turnstile.remove(widgetId);
      } catch (err) {
        // The widget node is already gone.
      }
    }
    widgetId = null;
  }

  function panelWithTitle(text) {
    var panel = document.createElement('div');
    panel.className = 'signup-dialog-panel';
    var summary = document.createElement('div');
    summary.className = 'signup-dialog-summary';
    var title = document.createElement('h2');
    title.id = 'signup-dialog-label';
    title.className = 'signup-dialog-title';
    title.textContent = text;
    summary.appendChild(title);
    panel.appendChild(summary);
    attachScroll(panel);
    return panel;
  }

  function attachScroll(panel) {
    var scroll = document.createElement('div');
    scroll.className = 'signup-dialog-scroll';
    panel.appendChild(scroll);
    return scroll;
  }

  function panelScroll(panel) {
    return panel.querySelector('.signup-dialog-scroll') || panel;
  }

  function appendFrom(parent, root, selector) {
    var node = root.querySelector(selector);
    if (node) parent.appendChild(document.importNode(node, true));
  }

  function firstField(form) {
    var invalid = form.querySelector('[aria-invalid="true"]');
    if (invalid && typeof invalid.focus === 'function') return invalid;
    var inputs = form.querySelectorAll('input, textarea, select');
    for (var i = 0; i < inputs.length; i += 1) {
      var input = inputs[i];
      if (input.type === 'hidden' || input.tabIndex < 0) continue;
      return input;
    }
    return null;
  }

  function isConfirmed(response) {
    try {
      return /\/confirmed\/?$/.test(new URL(response.url, window.location.href).pathname);
    } catch (err) {
      return false;
    }
  }
})();
