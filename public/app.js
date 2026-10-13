/* Club Votes — the whole client.
 *
 * One screen, three views, no framework: the hash picks the view
 *   #/           open decisions, newest first
 *   #/decided    closed decisions, with the result
 *   #/d/<id>     one decision: vote, comments, close (its author)
 * and every view re-renders <main id="app"> from server data. User text is
 * only ever set with textContent, and votes are optimistic with a rollback.
 */
(function () {
  'use strict';

  // ── Session bits the bridge gives us ────────────────────────────────────
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || null;
  var DEMO = params.has('demo'); // staging demo flag, echoed on every call
  if (TOKEN || DEMO) {
    // Keep the token out of the visible URL (it stays in memory only);
    // the hash routing needs a clean search string.
    params.delete('token');
    var rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }

  function platformNow() {
    try {
      if (window.usernode && typeof window.usernode.now === 'function') return window.usernode.now();
    } catch (e) { /* outside the frame */ }
    return new Date();
  }

  // ── API helper ───────────────────────────────────────────────────────────
  // The bridge turns a 401 account_required into its own "Make an account"
  // sheet, so this code never toasts for that status — it just stops.
  function api(path, options) {
    options = options || {};
    var headers = { Accept: 'application/json' };
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    if (window.usernode && window.usernode.previewNow) {
      try { headers['x-usernode-now'] = platformNow().toISOString(); } catch (e) { /* ignore */ }
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    var qs = DEMO ? (path.indexOf('?') === -1 ? '?demo=1' : '&demo=1') : '';
    return fetch('/api' + path + qs, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'include',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || 'request_failed');
          err.status = res.status;
          err.code = data && data.error;
          throw err;
        }
        return data;
      });
    });
  }

  function isAccountRequired(err) {
    return err && (err.status === 401 || err.code === 'account_required');
  }

  // ── Small DOM + text helpers ─────────────────────────────────────────────
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function relTime(iso) {
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '';
    var diff = platformNow().getTime() - t;
    if (diff < 60e3) return 'just now';
    var mins = Math.floor(diff / 60e3);
    if (mins < 60) return mins === 1 ? '1 minute ago' : mins + ' minutes ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
    var days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function outcomeText(d) {
    var total = d.agree + d.disagree;
    if (d.agree > d.disagree) return 'Agreed ' + d.agree + ' to ' + d.disagree;
    if (d.disagree > d.agree) return 'Not agreed ' + d.disagree + ' to ' + d.agree;
    return 'Tied ' + total / 2 + ' to ' + total / 2;
  }

  // The ballot bar: green grows from the left, red from the right, a short
  // line marks the half-way point. Widths come from the counts themselves.
  function ballotBar(d, large) {
    var bar = el('div', 'ballot' + (large ? ' ballot-lg' : ''));
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', d.agree + ' agree, ' + d.disagree + ' disagree');
    var total = d.agree + d.disagree;
    if (total === 0) {
      bar.classList.add('idle');
      bar.appendChild(el('span', 'ballot-empty'));
      return bar;
    }
    var agree = el('span', 'ballot-agree' + (d.disagree === 0 ? ' ballot-solo' : ''));
    agree.style.flexGrow = String(d.agree);
    var disagree = el('span', 'ballot-disagree' + (d.agree === 0 ? ' ballot-solo' : ''));
    disagree.style.flexGrow = String(d.disagree);
    bar.appendChild(agree);
    bar.appendChild(disagree);
    return bar;
  }

  function myVoteLabel(d) {
    if (d.my_vote === 'agree') return 'You agreed';
    if (d.my_vote === 'disagree') return 'You disagreed';
    return null;
  }

  // The right end of a list row's meta line: how you voted, or the counted
  // result once the decision is closed. Green when you agreed, red when you
  // disagreed, plain grey when you have not voted.
  function rowMarker(d) {
    if (d.closed_at) {
      var cls = d.agree > d.disagree ? 'text-agree' : d.disagree > d.agree ? 'text-disagree' : 'text-muted';
      return { text: outcomeText(d), cls: 'shrink-0 font-semibold ' + cls };
    }
    if (d.my_vote === 'agree') return { text: 'You agreed', cls: 'shrink-0 font-medium text-agree' };
    if (d.my_vote === 'disagree') return { text: 'You disagreed', cls: 'shrink-0 font-medium text-disagree' };
    return { text: 'Not voted', cls: 'shrink-0 text-muted' };
  }

  // A small speech bubble with the comment count, on the counts line.
  function commentChip(count) {
    var span = el('span', 'inline-flex items-center gap-1');
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z');
    svg.appendChild(path);
    span.appendChild(svg);
    span.appendChild(el('span', 'tabular-nums', String(count)));
    return span;
  }

  // "⋯" opens the More menu (Report). Hidden on your own posts.
  function moreButton(type, id, label) {
    var btn = el('button', 'un-touch-target shrink-0 rounded-full text-muted hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus px-1.5 text-body leading-none');
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    btn.dataset.moreType = type;
    btn.dataset.moreId = String(id);
    btn.textContent = '⋯';
    return btn;
  }

  // ── Native kit wrappers (with plain fallbacks outside the platform) ──────
  function native(name) {
    return window.unNative && typeof window.unNative[name] === 'function' ? window.unNative[name] : null;
  }

  function toast(message) {
    var fn = native('toast');
    if (fn) { try { fn(message); } catch (e) { /* ignore */ } }
  }

  function confirmAlert(title, message, confirmLabel, onConfirm) {
    var fn = native('alert');
    if (fn) {
      try {
        fn({
          title: title,
          message: message,
          buttons: [
            { label: 'Cancel', style: 'cancel' },
            { label: confirmLabel, style: 'destructive', handler: onConfirm },
          ],
        });
        return;
      } catch (e) { /* fall through */ }
    }
    if (window.confirm(title + (message ? '\n\n' + message : ''))) onConfirm();
  }

  function openMenu(anchorEl, items) {
    var fn = native('menu');
    if (fn) {
      try { fn({ anchorEl: anchorEl, items: items }); return; } catch (e) { /* fall through */ }
    }
    var choice = window.prompt('Type "report" to report this.');
    if (choice && choice.toLowerCase() === 'report' && items[0]) items[0].handler();
  }

  function presentSheet(content, onDone) {
    var fn = native('presentSheet');
    if (fn) {
      try {
        // The kit's `content` option is an HTML STRING; `contentEl` takes the
        // Element. Passing the element as `content` stringifies it, and the
        // sheet shows "[object HTMLFormElement]".
        var handle = fn({ contentEl: content, onDismiss: onDone });
        return {
          close: function () {
            if (handle && typeof handle.dismiss === 'function') handle.dismiss();
            else if (content.parentNode) content.parentNode.removeChild(content);
          },
        };
      } catch (e) { /* fall through */ }
    }
    // Crude fallback: swap the page for the form until it is done.
    var app = document.getElementById('app');
    var prev = app.removeChild(app.firstChild);
    app.appendChild(content);
    return {
      close: function () {
        app.removeChild(content);
        app.appendChild(prev);
        onDone();
      },
    };
  }

  // ── Drafts kept across re-renders ────────────────────────────────────────
  var commentDrafts = {}; // decision id -> textarea value

  // ── Actions ──────────────────────────────────────────────────────────────
  function vote(d, choice) {
    var before = d.my_vote;
    if (before === choice) choice = null; // re-tap takes the vote back
    d.my_vote = choice;
    // d is the decision object the open detail view renders from, so the
    // optimistic counts land where render() reads them.
    if (choice === 'agree' && before !== 'agree') d.agree += 1;
    if (before === 'agree' && choice !== 'agree') d.agree -= 1;
    if (choice === 'disagree' && before !== 'disagree') d.disagree += 1;
    if (before === 'disagree' && choice !== 'disagree') d.disagree -= 1;
    render();
    var voteBtns = app.querySelectorAll('[data-vote]');
    voteBtns.forEach(function (b) { b.disabled = true; });
    api('/decisions/' + d.id + '/vote', { method: 'PUT', body: { choice: choice } })
      .then(function (tallies) {
        applyTallies(d.id, tallies);
        render();
      })
      .catch(function (err) {
        if (err.code === 'closed') { toast('This decision is already closed.'); loadDetail(d.id, true); return; }
        if (isAccountRequired(err)) { d.my_vote = before; render(); return; }
        d.my_vote = before;
        render();
        toast("Couldn't save your vote. Try again.");
      });
  }

  function applyTallies(id, tallies) {
    if (state.detail && state.detail.decision && state.detail.id === id) {
      state.detail.decision.agree = tallies.agree;
      state.detail.decision.disagree = tallies.disagree;
      state.detail.decision.my_vote = tallies.my_vote;
    }
    [state.open, state.decided].forEach(function (list) {
      if (!list || !list.decisions) return;
      var row = list.decisions.find(function (x) { return x.id === id; });
      if (row) {
        row.agree = tallies.agree;
        row.disagree = tallies.disagree;
        row.my_vote = tallies.my_vote;
      }
    });
  }

  function postComment(d, textarea, button) {
    var body = textarea.value.trim();
    if (!body) return;
    button.disabled = true;
    textarea.disabled = true;
    api('/decisions/' + d.id + '/comments', { method: 'POST', body: { body: body } })
      .then(function (comment) {
        delete commentDrafts[d.id];
        if (state.detail && state.detail.decision && state.detail.id === d.id) {
          state.detail.comments.push(comment);
          state.detail.decision.comment_count += 1;
        }
        bumpCommentCount(d.id, 1);
        render();
        toast('Comment posted.');
      })
      .catch(function (err) {
        render();
        if (!isAccountRequired(err)) toast("Couldn't post your comment. Try again.");
      });
  }

  function bumpCommentCount(id, delta) {
    [state.open, state.decided].forEach(function (list) {
      if (!list || !list.decisions) return;
      var row = list.decisions.find(function (x) { return x.id === id; });
      if (row) row.comment_count += delta;
    });
  }

  function closeDecision(d) {
    confirmAlert(
      'Close this decision?',
      'Voting stops and the result is shown to everyone. This cannot be undone.',
      'Close',
      function () {
        api('/decisions/' + d.id + '/close', { method: 'POST' })
          .then(function (res) {
            toast('Closed. ' + outcomeText(Object.assign({}, d, { agree: res.agree, disagree: res.disagree })));
            state.open = null; // refetch both tabs: one row moved lists
            state.decided = null;
            route();
          })
          .catch(function (err) {
            if (err.code === 'already_closed') { loadDetail(d.id, true); return; }
            if (!isAccountRequired(err)) toast("Couldn't close the decision. Try again.");
          });
      }
    );
  }

  function report(type, id) {
    confirmAlert(
      'Report this?',
      'It is hidden for you right away. If 3 people report it, it is hidden for everyone.',
      'Report',
      function () {
        api('/reports', { method: 'POST', body: { type: type, id: id } })
          .then(function () {
            toast('Reported. It is now hidden for you.');
            route(); // refetch: the hidden item may change the lists
          })
          .catch(function (err) {
            if (isAccountRequired(err)) return;
            toast("Couldn't send the report. Try again.");
          });
      }
    );
  }

  function postDecision() {
    var form = el('form', 'flex flex-col gap-4 pb-2');
    form.appendChild(el('h2', 'text-heading font-serif text-fg', 'Post a decision'));
    var qLabel = el('label', 'block text-small font-medium text-fg', 'Question');
    qLabel.htmlFor = 'new-question';
    var q = el('input', 'field');
    q.id = 'new-question';
    q.type = 'text';
    q.maxLength = 140;
    q.placeholder = 'e.g. Should we move our meetup to Thursday?';
    q.required = true;
    var counter = el('p', 'text-small text-muted tabular-nums', '0 of 140');
    var send = el('button', 'btn-primary flex-1', 'Post decision');
    send.type = 'submit';
    send.disabled = true; // until the question has 3+ characters
    var cancel = el('button', 'btn-secondary flex-1', 'Cancel');
    cancel.type = 'button';
    var buttons = el('div', 'flex gap-2');
    buttons.appendChild(cancel);
    buttons.appendChild(send);
    var errNote = el('p', 'text-small text-danger', '');
    errNote.hidden = true;
    q.addEventListener('input', function () {
      counter.textContent = q.value.length + ' of 140';
      counter.classList.toggle('text-danger', q.value.length > 120);
      send.disabled = q.value.trim().length < 3;
    });
    var dLabel = el('label', 'block text-small font-medium text-fg', 'Details (optional)');
    dLabel.htmlFor = 'new-details';
    var details = el('textarea', 'field');
    details.id = 'new-details';
    details.maxLength = 1000;
    details.rows = 3;
    details.placeholder = 'e.g. the date, the cost, anything people will ask about';
    form.appendChild(qLabel);
    form.appendChild(q);
    form.appendChild(counter);
    form.appendChild(dLabel);
    form.appendChild(details);
    form.appendChild(errNote);
    form.appendChild(buttons);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var question = q.value.trim();
      if (question.length < 3) {
        errNote.textContent = 'A decision needs at least 3 characters.';
        errNote.hidden = false;
        return;
      }
      send.disabled = true;
      api('/decisions', { method: 'POST', body: { question: question, details: details.value.trim() || null } })
        .then(function () {
          sheet.close();
          state.open = null;
          state.decided = null;
          toast('Decision posted. The club can vote on it now.');
          location.hash = '#/';
          route();
        })
        .catch(function (err) {
          send.disabled = false;
          if (isAccountRequired(err)) return;
          errNote.textContent = "Couldn't post that. Check it and try again.";
          errNote.hidden = false;
        });
    });
    cancel.addEventListener('click', function () { sheet.close(); });
    var sheet = presentSheet(form, function () { /* dismissed; nothing to undo */ });
    try { q.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  // ── Views ────────────────────────────────────────────────────────────────
  var app = document.getElementById('app');
  var state = {
    me: null,
    open: null, // {state:'loading'|'ready'|'error', decisions, counts}
    decided: null,
    detail: null, // {state, decision?, comments?, removed?}
  };

  function header(activeTab, counts, empty) {
    var wrap = el('div', 'flex flex-col gap-3');
    var top = el('div', 'flex items-center justify-between gap-2');
    var h1 = el('h1', 'text-title font-bold', 'Club Votes');
    h1.classList.add('font-serif');
    // When the club has nothing open, the empty state carries the one
    // filled button, so this one goes quiet.
    var post = el('button', (empty ? 'btn-secondary' : 'btn-primary') + ' shrink-0', 'Post a decision');
    post.type = 'button';
    post.addEventListener('click', postDecision);
    top.appendChild(h1);
    top.appendChild(post);
    var tabs = el('div', 'segmented');
    tabs.setAttribute('role', 'tablist');
    [
      ['Open', '#/', activeTab === 'open', counts ? counts.open : null],
      ['Decided', '#/decided', activeTab === 'decided', counts ? counts.decided : null],
    ].forEach(function (t) {
      var tab = el('button', 'segmented-tab' + (t[2] ? ' font-semibold' : ''), t[3] === null || t[3] === undefined ? t[0] : t[0] + ' (' + t[3] + ')');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', t[2] ? 'true' : 'false');
      if (t[2]) tab.setAttribute('aria-current', 'page');
      tab.addEventListener('click', function () { location.hash = t[1]; });
      tabs.appendChild(tab);
    });
    wrap.appendChild(top);
    wrap.appendChild(tabs);
    return wrap;
  }

  function errorState(title, message, onRetry) {
    var box = el('div', 'state-error');
    box.appendChild(el('p', 'text-body font-semibold', title));
    box.appendChild(el('p', 'text-small text-muted', message));
    var retry = el('button', 'btn-secondary', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    box.appendChild(retry);
    return box;
  }

  function skeletonList() {
    // Three rows inside one grouped container, hairline dividers between
    // them: the shape the real list will take.
    var ul = el('ul', 'list');
    for (var i = 0; i < 3; i++) {
      var row = el('li', 'list-row flex-col !items-stretch gap-2');
      row.appendChild(el('div', 'skeleton h-5 w-4/5'));
      row.appendChild(el('div', 'skeleton h-2 w-full'));
      row.appendChild(el('div', 'skeleton h-3 w-2/5'));
      ul.appendChild(row);
    }
    return ul;
  }

  function decisionRow(d) {
    var li = el('li', 'list-row flex-col !items-stretch gap-2');
    var link = el('a', 'block min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus');
    link.href = '#/d/' + d.id;
    // Top to bottom: the question, the ballot bar, the counts, then one
    // meta line: who and when on the left, your vote (or the result) on
    // the right.
    link.appendChild(el('p', 'font-serif text-fg leading-snug', d.question));
    link.appendChild(ballotBar(d, false));
    var counts = el('div', 'flex flex-wrap items-center gap-x-3 gap-y-0.5 text-small text-muted tabular-nums');
    counts.appendChild(el('span', 'text-agree', d.agree + ' agree'));
    counts.appendChild(el('span', 'text-disagree', d.disagree + ' disagree'));
    if (d.comment_count > 0) counts.appendChild(commentChip(d.comment_count));
    link.appendChild(counts);
    var marker = rowMarker(d);
    var meta = el('div', 'flex items-center justify-between gap-2 text-small');
    meta.appendChild(el('span', 'min-w-0 truncate text-muted', (d.mine ? 'You' : d.author_username) + ' · ' + relTime(d.created_at)));
    meta.appendChild(el('span', marker.cls, marker.text));
    link.appendChild(meta);
    li.appendChild(link);
    return li;
  }

  function listView() {
    var tab = location.hash === '#/decided' ? 'decided' : 'open';
    var list = state[tab];
    app.textContent = '';
    var isEmpty = !!(list && list.state === 'ready' && tab === 'open' && list.decisions.length === 0);
    app.appendChild(header(tab, list && list.counts, isEmpty));

    if (!list || list.state === 'loading') {
      app.appendChild(skeletonList());
      loadList(tab);
      return;
    }
    if (list.state === 'error') {
      app.appendChild(errorState(
        "Couldn't load the decisions",
        'Check your connection and try again. Nothing you voted on is lost.',
        function () { state[tab] = { state: 'loading' }; render(); }
      ));
      return;
    }
    var decisions = list.decisions;
    if (!decisions.length) {
      var box = el('div', 'state-empty');
      if (tab === 'open') {
        box.appendChild(el('p', 'text-heading', 'No open decisions'));
        box.appendChild(el('p', 'text-body text-muted', 'Post the first thing your club needs to decide.'));
        var start = el('button', 'btn-primary', 'Post a decision');
        start.type = 'button';
        start.addEventListener('click', postDecision);
        box.appendChild(start);
      } else {
        box.appendChild(el('p', 'text-heading', 'Nothing decided yet'));
        box.appendChild(el('p', 'text-body text-muted', 'When a decision is closed, the result moves here for everyone to see.'));
      }
      app.appendChild(box);
      return;
    }
    var ul = el('ul', 'list');
    decisions.forEach(function (d) { ul.appendChild(decisionRow(d)); });
    app.appendChild(ul);
  }

  function detailView() {
    var det = state.detail;
    app.textContent = '';
    var back = el('a', 'inline-flex min-h-11 items-center gap-1 text-small font-medium text-muted rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus', '← All decisions');
    back.href = '#/';
    app.appendChild(back);

    if (!det || det.state === 'loading') {
      var skel = el('div', 'card mt-3 flex flex-col gap-3');
      skel.appendChild(el('div', 'skeleton h-6 w-4/5'));
      skel.appendChild(el('div', 'skeleton h-3 w-1/3'));
      skel.appendChild(el('div', 'skeleton h-3 w-full'));
      skel.appendChild(el('div', 'skeleton h-3 w-2/3'));
      app.appendChild(skel);
      return;
    }
    if (det.state === 'removed') {
      var gone = el('div', 'state-empty mt-6');
      gone.appendChild(el('p', 'text-heading', 'This decision was removed'));
      gone.appendChild(el('p', 'text-body text-muted', 'It was taken down after reports from the club.'));
      app.appendChild(gone);
      return;
    }
    if (det.state === 'error') {
      app.appendChild(errorState("Couldn't load this decision", 'It may have been removed, or the connection dropped.', function () { loadDetail(det.id, true); }));
      return;
    }
    if (det.state === 'missing') {
      var miss = el('div', 'state-empty mt-6');
      miss.appendChild(el('p', 'text-heading', 'Decision not found'));
      miss.appendChild(el('p', 'text-body text-muted', 'It may have been removed, or the link is old.'));
      app.appendChild(miss);
      return;
    }

    var d = det.decision;
    var article = el('article', 'card mt-3 flex flex-col gap-3');
    var q = el('h2', 'font-serif text-heading text-fg', d.question);
    if (d.details) {
      var det2 = el('p', 'whitespace-pre-wrap text-body text-fg/90', d.details);
      article.appendChild(q);
      article.appendChild(det2);
    } else {
      article.appendChild(q);
    }
    article.appendChild(el('p', 'text-small text-muted', (d.mine ? 'You' : d.author_username) + ' · ' + relTime(d.created_at)));

    var result = el('div', 'flex flex-col gap-1.5');
    result.appendChild(ballotBar(d, true));
    var counts = el('div', 'flex flex-wrap items-center gap-x-3 gap-y-0.5 text-small text-muted tabular-nums');
    counts.appendChild(el('span', 'text-agree font-medium', d.agree + ' agree'));
    counts.appendChild(el('span', 'text-disagree font-medium', d.disagree + ' disagree'));
    var marker = myVoteLabel(d);
    if (marker) counts.appendChild(el('span', 'font-medium text-fg', marker));
    result.appendChild(counts);
    article.appendChild(result);

    if (d.closed_at) {
      var resLine = el('p', 'text-body font-semibold ' + (
        d.agree > d.disagree ? 'text-agree' : d.disagree > d.agree ? 'text-disagree' : 'text-muted'
      ), outcomeText(d));
      var closedBy = el('p', 'text-small text-muted', 'Closed ' + relTime(d.closed_at) + (d.closed_by ? ' by ' + d.closed_by : ''));
      article.appendChild(resLine);
      article.appendChild(closedBy);
    } else {
      var buttons = el('div', 'flex flex-wrap gap-2');
      ['agree', 'disagree'].forEach(function (choice) {
        var b = el('button', 'vote-' + choice);
        b.type = 'button';
        b.dataset.vote = choice;
        b.setAttribute('aria-pressed', d.my_vote === choice ? 'true' : 'false');
        b.appendChild(el('span', '', choice === 'agree' ? '✓' : '✕'));
        b.appendChild(el('span', '', choice === 'agree' ? 'Agree' : 'Disagree'));
        b.addEventListener('click', function () { vote(d, choice); });
        buttons.appendChild(b);
      });
      article.appendChild(buttons);
      if (!d.mine) {
        var row = el('div', 'flex items-center justify-between gap-2');
        row.appendChild(el('p', 'text-small text-muted', 'One vote each. Tap again to take it back.'));
        var more = moreButton('decision', d.id, 'More options for this decision');
        row.appendChild(more);
        article.appendChild(row);
      } else {
        var close = el('button', 'btn-secondary self-start', 'Close decision');
        close.type = 'button';
        close.addEventListener('click', function () { closeDecision(d); });
        article.appendChild(close);
      }
    }
    if (d.mine) {
      var ownRow = el('div', 'flex items-center justify-between gap-2');
      ownRow.appendChild(el('p', 'text-small text-muted', 'Your decision. Only you can close it.'));
      article.appendChild(ownRow);
    }
    app.appendChild(article);

    // Comments, oldest first, on open and closed decisions alike.
    var section = el('section', 'mt-5 flex flex-col gap-2');
    section.appendChild(el('h3', 'section-label', 'Comments (' + det.comments.length + ')'));
    if (det.comments.length) {
      var ul = el('ul', 'list');
      det.comments.forEach(function (c) {
        var li = el('li', 'list-row flex-col !items-stretch gap-1');
        var head = el('div', 'flex items-start gap-1');
        var who = el('p', 'min-w-0 flex-1 text-small font-medium ' + (c.mine ? 'text-accent' : 'text-fg'), c.mine ? 'You' : c.author_username);
        head.appendChild(who);
        if (!c.mine) head.appendChild(moreButton('comment', c.id, 'More options for this comment'));
        li.appendChild(head);
        li.appendChild(el('p', 'whitespace-pre-wrap text-body text-fg', c.body));
        li.appendChild(el('p', 'text-small text-muted', relTime(c.created_at)));
        ul.appendChild(li);
      });
      section.appendChild(ul);
    }
    var form = el('form', 'flex flex-col gap-2');
    var ta = el('textarea', 'field');
    ta.rows = 2;
    ta.maxLength = 1000;
    ta.placeholder = 'Add a comment…';
    ta.setAttribute('aria-label', 'Add a comment');
    ta.value = commentDrafts[d.id] || '';
    ta.addEventListener('input', function () { commentDrafts[d.id] = ta.value; });
    var send = el('button', 'btn-primary self-start', 'Comment');
    send.type = 'submit';
    form.appendChild(ta);
    form.appendChild(send);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      postComment(d, ta, send);
    });
    section.appendChild(form);
    app.appendChild(section);
    wireMore();
  }

  // ── Data loading ─────────────────────────────────────────────────────────
  function loadList(tab) {
    var status = tab === 'decided' ? 'decided' : 'open';
    api('/decisions?status=' + status)
      .then(function (data) {
        state[tab] = { state: 'ready', decisions: data.decisions, counts: data.counts };
        if (data.demo) showDemoBanner();
        var other = tab === 'open' ? 'decided' : 'open';
        if (state[other] && state[other].counts) state[other].counts = data.counts;
        if (isListViewActive(tab)) render();
      })
      .catch(function () {
        state[tab] = { state: 'error' };
        if (isListViewActive(tab)) render();
      });
  }

  function isListViewActive(tab) {
    return tab === 'decided' ? location.hash === '#/decided' : (location.hash === '#/' || location.hash === '' || location.hash === '#');
  }

  function loadDetail(id, force) {
    if (state.detail && state.detail.id === id && state.detail.state !== 'error' && !force) return;
    state.detail = { id: id, state: 'loading' };
    render();
    api('/decisions/' + id)
      .then(function (data) {
        if (state.detail && state.detail.id === id) {
          // The detail route answers flat: the decision's own fields plus a
          // comments array on the same object.
          state.detail = {
            id: id,
            state: 'ready',
            decision: data,
            comments: Array.isArray(data.comments) ? data.comments : [],
          };
          if (isDetailActive(id)) render();
        }
      })
      .catch(function (err) {
        if (state.detail && state.detail.id !== id) return;
        state.detail = { id: id, state: err.code === 'removed' ? 'removed' : err.status === 404 ? 'missing' : 'error' };
        if (isDetailActive(id)) render();
      });
  }

  function isDetailActive(id) {
    var m = location.hash.match(/^#\/d\/(\d+)/);
    return m && Number(m[1]) === Number(id);
  }

  // ── Router ───────────────────────────────────────────────────────────────
  function route() {
    var m = location.hash.match(/^#\/d\/(\d+)/);
    if (m) {
      loadDetail(Number(m[1]));
      return;
    }
    state.detail = null;
    render();
  }

  function render() {
    var m = location.hash.match(/^#\/d\/(\d+)/);
    if (m) detailView();
    else listView();
    wireMore();
    if (TOKEN === null && state.me === null) {
      // One quiet check so the UI knows who is signed in (also confirms the
      // demo flag from the server side).
      state.me = { checked: true };
      api('/me')
        .then(function (data) {
          state.me = data;
          if (data.demo) showDemoBanner();
          else hideDemoBanner();
        })
        .catch(function () { /* anonymous is fine */ });
    }
  }

  function wireMore() {
    app.querySelectorAll('[data-more-type]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var type = btn.dataset.moreType;
        var id = Number(btn.dataset.moreId);
        openMenu(btn, [
          { label: 'Report', handler: function () { report(type, id); } },
        ]);
      });
    });
  }

  // ── Demo banner (staging only, confirmed by the server) ──────────────────
  var demoBanner = document.getElementById('demo-banner');
  function showDemoBanner() { if (demoBanner) demoBanner.hidden = false; }
  function hideDemoBanner() { if (demoBanner) demoBanner.hidden = true; }

  // ── Keep it fresh when the viewer comes back ─────────────────────────────
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (state.open) state.open = null;
    if (state.decided) state.decided = null;
    if (location.hash.startsWith('#/d/')) {
      var m = location.hash.match(/^#\/d\/(\d+)/);
      if (m) loadDetail(Number(m[1]), true);
      else route();
    } else {
      route();
    }
  });

  window.addEventListener('hashchange', route);
  route();
})();
