/* Type-ahead for the category request box.
 *
 * Joshua's ask: "if I type FL, then floral is gonna pop up, or food is gonna
 * pop up if it's just F. Food, flowers, fruit."
 *
 * The point is not convenience, it is the review queue. Every artist who
 * finds the tag that already exists is a request Kat never has to read. The
 * panel already tells you AFTER you have typed the whole word that it exists;
 * this says it at the second keystroke, while you can still change your mind.
 *
 * SELF-WIRING, like tour.js. app.js builds the request panel and this file
 * does not touch app.js — one delegated listener on the document catches the
 * input wherever and whenever it is rendered. The panel appears on two
 * surfaces and is rebuilt on every render, so binding to the element itself
 * would go stale; delegation cannot.
 *
 * Matching runs locally against a list this file loads once. No round trip
 * per keystroke: the roster of categories is tens of rows, not thousands, and
 * a suggestion that arrives after you have typed the next letter is worse
 * than none.
 */
(function () {
  'use strict';

  var LIMIT = 6;
  var cats = null;        // [{id,name,kind}] once loaded
  var loading = null;

  /* Same shape the database's unique index uses: lowercased, every space,
   * hyphen and underscore stripped. Matching on this means "fine line",
   * "Fine-Line" and "fineline" are one thing here too, rather than the
   * suggestions disagreeing with the refusal that follows. */
  function canon(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  async function load() {
    if (cats) return cats;
    if (loading) return loading;
    loading = (async function () {
      try {
        var sb = await window.DashClient.client();
        if (!sb) return [];
        var res = await sb.from('categories').select('id,name,kind').order('name');
        cats = (res && res.data) || [];
      } catch (e) {
        console.warn('category suggestions unavailable', e);
        cats = [];
      }
      return cats;
    })();
    return loading;
  }

  /* Rank: what starts with what you typed, then what has a WORD starting with
   * it, then anything containing it. "F" should reach Floral before it
   * reaches Micro Realism, even though both contain an f. */
  function rank(list, typed) {
    var q = canon(typed);
    if (!q) return [];
    var out = [];
    list.forEach(function (c) {
      var name = String(c.name || '');
      var whole = canon(name);
      var score = -1;
      if (whole.indexOf(q) === 0) score = 0;
      else if (name.toLowerCase().split(/[^a-z0-9]+/).some(function (w) {
        return w && w.indexOf(q) === 0;
      })) score = 1;
      else if (whole.indexOf(q) !== -1) score = 2;
      if (score >= 0) out.push({ c: c, score: score });
    });
    out.sort(function (a, b) {
      return a.score - b.score || a.c.name.localeCompare(b.c.name);
    });
    return out.slice(0, LIMIT).map(function (x) { return x.c; });
  }

  function boxFor(input) {
    var box = input.parentNode.querySelector('.cat-suggest');
    if (!box) {
      box = document.createElement('div');
      box.className = 'cat-suggest';
      box.setAttribute('role', 'listbox');
      // Directly after the field, before the panel's own feedback line, so
      // the two never fight for the same space.
      input.parentNode.insertBefore(box, input.nextSibling);
    }
    return box;
  }

  function paint(input, matches) {
    var box = boxFor(input);
    box.innerHTML = '';
    if (!matches.length) { box.hidden = true; return; }
    box.hidden = false;

    var lead = document.createElement('div');
    lead.className = 'muted small';
    lead.textContent = 'Already here — tap one to use it instead:';
    box.appendChild(lead);

    matches.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip cat-suggest-item';
      b.setAttribute('role', 'option');
      b.appendChild(document.createTextNode(c.name));
      var k = document.createElement('span');
      k.className = 'muted small';
      k.textContent = ' · ' + (c.kind || 'style');
      b.appendChild(k);

      // Fill the field rather than doing anything clever. The panel's own
      // exact-name check then fires and says "That already exists as Floral
      // (style). Tag your work with it instead." — one voice, not two.
      b.onclick = function () {
        input.value = c.name;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        box.hidden = true;
      };
      box.appendChild(b);
    });
  }

  function isRequestInput(el) {
    return el && el.classList && el.classList.contains('input') &&
           el.closest && el.closest('.req-panel');
  }

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!isRequestInput(el)) return;
    var typed = el.value;
    if (canon(typed).length < 1) { paint(el, []); return; }
    load().then(function (list) {
      // The field may have moved on while we were loading the first time.
      if (document.contains(el)) paint(el, rank(list, el.value));
    });
  });

  // A submitted or abandoned request should not leave a stale list behind.
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.cat-suggest')) return;
    Array.prototype.forEach.call(
      document.querySelectorAll('.cat-suggest'),
      function (b) { if (!b.contains(e.target)) b.hidden = true; });
  });

  // Exposed so a future test can rank without a DOM.
  window.CategorySuggest = { _rank: rank, _canon: canon };
})();
