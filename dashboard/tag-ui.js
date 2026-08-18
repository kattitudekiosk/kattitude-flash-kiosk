/* Category tagging — a collapsed chip row and one icon that opens the picker.
 *
 * Joshua, verbatim: "I don't like the way the UI for the tags is. You don't
 * need to see all the tags. If we need to add more tags, it should just be an
 * icon that you can open up and then open up an expandable card to a more tag
 * style like the expandable cards we use for The Lost And Unfounds."
 *
 * WHAT THE PROBLEM ACTUALLY WAS. app.js's chipGroups() renders EVERY category
 * on EVERY card, grouped by kind. At eleven categories that is already taller
 * than the artwork it is attached to, and it grows every time an artist asks
 * for a theme. The list was doing two jobs at once — telling you what a design
 * IS, and offering everything it COULD be — and the second job was crowding
 * out the first.
 *
 * So they are separated. The bar says what the design is. The icon opens what
 * it could be.
 *
 * THE PATTERN IS BORROWED, NOT INVENTED. This is the Platform Console Tray
 * from canyouseeus/thelostandunfounds — .claude/skills/bento-design/SKILL.md:
 *
 *     "a console tray is icon-only, never a row of always-visible controls.
 *      Each icon expands its own focused card on tap"
 *
 * and, for the card it opens:
 *
 *     "initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
 *      transition={{ duration: 0.15 }}"
 *
 * Those numbers are reused verbatim in tag-ui.css. What is deliberately NOT
 * borrowed is the palette: Joshua was explicit that "it's not noir style. I'm
 * just talking about the components, the way the components are built." So the
 * construction comes across — icon-only trigger, one card open at a time,
 * separation by surface tone rather than an outline, 10px/0.2em micro-labels,
 * inverted active state instead of a ring — and the colours stay Kattitude's.
 *
 * WHY THIS IS A BOLT-ON AND NOT AN EDIT TO app.js. index.html already
 * describes the arrangement: "These bind to the document, or take over a tab
 * app.js has already bound, so they load AFTER it and it does not know they
 * exist." tour.js says the same thing about itself and gives the reason —
 * app.js is "the file with the most to lose and the least to gain from being
 * edited". This file takes the .kindgroups element app.js builds, MOVES it
 * into an expandable card, and leaves every button inside it wired to the
 * handlers app.js already attached. Toggling a category, bulk-tagging a whole
 * staging queue and the "Request a new category…" button all keep working
 * because none of them were touched.
 *
 * NOTHING FLASHES. The rule that hides a loose .kindgroups is injected from
 * JavaScript, not shipped in a stylesheet, and the wrapping happens in a
 * MutationObserver callback — a microtask, which runs before the browser
 * paints. So the long list is never on screen for a frame. And if this file
 * ever fails to load, the rule does not exist either: the dashboard falls back
 * to exactly today's behaviour, long but working. A stylesheet rule would have
 * hidden tagging outright the moment the script 404'd, which is a worse
 * failure than the one being fixed.
 */
(function () {
  'use strict';

  /* Which cards are open, keyed by something stable. This CANNOT live on the
   * DOM node: app.js rebuilds a whole pane on every category toggle
   * (renderQueue / renderDesigns both start with innerHTML = ''), so the node
   * that was open is thrown away microseconds later. Without this the picker
   * would slam shut every time you tapped a chip inside it. */
  var OPEN = Object.create(null);

  /* Past six, the bar is doing the thing it was built to stop. The rest
   * collapse into a "+N" that opens the card. */
  var MAX_CHIPS = 6;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* A luggage tag, stroked in currentColor so it inverts with the button
   * instead of needing a second asset for the active state. */
  function tagIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    ['M2.5 2.5h9l10 10-9 9-10-10v-9z', 'M7 7h.01'].forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  /* ── Identity ──────────────────────────────────────────────────────────
   * The open/closed state has to survive app.js rebuilding the pane, so the
   * key has to mean the same thing before and after that rebuild. It is
   * derived from the DOM rather than from app.js's state because this file
   * has no access to app.js's state — everything in there is private to its
   * IIFE.
   *
   * The thumbnail's src is the honest answer: a design's is its storage URL,
   * a staged file's is its blob URL, and both survive a re-render unchanged.
   * Position is the fallback and is only ever wrong if the list reorders
   * between a tap and its re-render, which it does not. */
  function cardOf(node) {
    var n = node.parentNode;
    while (n && n.nodeType === 1) {
      if (n.classList && n.classList.contains('card')) return n;
      n = n.parentNode;
    }
    return node.parentNode;
  }

  function keyFor(card) {
    if (card.classList && card.classList.contains('bulk')) return 'bulk';
    var img = card.querySelector ? card.querySelector('img.design-thumb, img.item-thumb') : null;
    if (img && img.getAttribute('src')) return 'img:' + img.getAttribute('src');
    var i = card.parentNode
      ? Array.prototype.indexOf.call(card.parentNode.children, card)
      : -1;
    return 'pos:' + i;
  }

  /* ── Open and close ────────────────────────────────────────────────────
   * One card at a time, which is the tray pattern's own rule. On a Designs
   * tab with twenty cards it is also the only version that keeps the page
   * short, which was the complaint. */
  function closeField(field) {
    if (!field) return;
    if (field.dataset.tagkey) delete OPEN[field.dataset.tagkey];
    field.dataset.tagopen = '0';
    var p = field.querySelector('.tagpanel');
    var t = field.querySelector('.tagtoggle');
    if (p) { p.hidden = true; p.classList.remove('tagpanel-in'); }
    if (t) { t.classList.remove('is-on'); t.setAttribute('aria-expanded', 'false'); }
  }

  function closeAll(except) {
    var open = document.querySelectorAll('.tagfield[data-tagopen="1"]');
    var any = false;
    Array.prototype.forEach.call(open, function (f) {
      if (f === except) return;
      closeField(f);
      any = true;
    });
    return any;
  }

  function openField(field) {
    closeAll(field);
    if (field.dataset.tagkey) OPEN[field.dataset.tagkey] = true;
    field.dataset.tagopen = '1';
    var p = field.querySelector('.tagpanel');
    var t = field.querySelector('.tagtoggle');
    if (t) { t.classList.add('is-on'); t.setAttribute('aria-expanded', 'true'); }
    if (p) {
      p.hidden = false;
      /* Restart the enter animation rather than letting a re-used node keep
       * its finished one. Reading offsetHeight between the remove and the add
       * forces the style flush that makes the restart actually happen. */
      p.classList.remove('tagpanel-in');
      void p.offsetHeight;
      p.classList.add('tagpanel-in');
    }
  }

  /* app.js writes "Tap a category to apply it to every staged file:"
   * immediately above the chip list on the bulk card. With the list behind a
   * button that sentence points at nothing, so it is rewritten here rather
   * than in app.js — same arrangement as every other bolt-on in this app.
   * Guarded on the exact opening words, so if that copy ever changes in
   * app.js this quietly does nothing instead of overwriting something new. */
  function relabelBulkHint(field) {
    var prev = field.previousElementSibling;
    if (!prev || !prev.classList || !prev.classList.contains('muted')) return;
    if (prev.textContent.indexOf('Tap a category') !== 0) return;
    prev.textContent = 'Tag the whole batch in one go:';
  }

  /* ── The wrap ──────────────────────────────────────────────────────────*/
  function wrapGroups(groups) {
    if (!groups || groups.dataset.taguiDone === '1') return;
    var parent = groups.parentNode;
    if (!parent) return;

    groups.dataset.taguiDone = '1';
    groups.classList.add('tagui-in-panel');

    var card = cardOf(groups);
    var cl = card.classList || { contains: function () { return false; } };
    var bulk = cl.contains('bulk');
    var isDesign = cl.contains('design');
    var key = keyFor(card);

    var field = el('div', 'tagfield');
    field.dataset.tagkey = key;
    field.dataset.tagopen = '0';
    parent.insertBefore(field, groups);

    var bar = el('div', 'tagbar');
    var applied = Array.prototype.slice.call(groups.querySelectorAll('.chip.is-on'));

    var panel = el('div', 'tagpanel');
    panel.hidden = true;
    panel.id = 'tagpanel-' + (++uid);

    var toggle = el('button', 'tagtoggle');
    toggle.type = 'button';
    toggle.appendChild(tagIcon());
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', panel.id);

    if (bulk) {
      /* Nothing is "applied" to a batch — the bulk control only ever adds —
       * so there are no chips to show and no empty state to warn about. The
       * rewritten hint above the bar carries the meaning; the icon is the
       * control. This is the affordance that makes a twenty-file upload
       * bearable, so it stays one tap from the top of the screen. */
      toggle.setAttribute('aria-label', 'Tag every staged file');
      relabelBulkHint(field);
    } else if (applied.length) {
      applied.slice(0, MAX_CHIPS).forEach(function (chip) {
        bar.appendChild(el('span', 'chip-applied', chip.textContent));
      });
      if (applied.length > MAX_CHIPS) {
        var more = el('button', 'chip-more', '+' + (applied.length - MAX_CHIPS));
        more.type = 'button';
        more.setAttribute('aria-label',
          'Show the other ' + (applied.length - MAX_CHIPS) + ' categories');
        more.onclick = function () { toggle.click(); };
        bar.appendChild(more);
      }
      toggle.setAttribute('aria-label', 'Change categories');
    } else {
      /* NOT AN ERROR. A design with no categories is the ordinary state of
       * something uploaded thirty seconds ago. An empty row would read as
       * broken, so it says what is missing and what to do — and stops, which
       * is tour.js's rule 7: "Name the thing, say what to do, stop." The
       * reason a published design cannot lose its last category is left to
       * the refusal that fires at the moment somebody hits it, in app.js's
       * own toast, where it is an answer rather than an unprompted argument.
       * That refusal is real and it is not this client's: CLAUDE.md, DATABASE
       * RULE — "the 'cannot publish without a category' gate is a Postgres
       * trigger, not a UI check." */
      var prompt = el('button', 'tagbar-empty');
      prompt.type = 'button';
      prompt.appendChild(el('span', 'tagbar-empty-lead', 'Not tagged yet'));
      prompt.appendChild(el('span', 'tagbar-empty-note', isDesign
        ? 'Add one before it can go on the kiosk.'
        : 'Tag it, or save it as a draft.'));
      prompt.onclick = function () { toggle.click(); };
      bar.appendChild(prompt);
      toggle.setAttribute('aria-label', 'Add a category');
    }

    toggle.title = toggle.getAttribute('aria-label');
    bar.appendChild(toggle);

    var head = el('div', 'tagpanel-head');
    head.appendChild(el('div', 'tagpanel-title', 'Categories'));
    panel.appendChild(head);

    /* MOVED, not cloned. Every chip in here is still the button app.js made,
     * with app.js's own onclick on it — which is why toggling, bulk tagging
     * and "Request a new category…" all keep working untouched. */
    panel.appendChild(groups);

    if (isDesign && applied.length === 1 && card.querySelector('.pill.ok')) {
      panel.appendChild(el('div', 'tagpanel-note',
        'This one is published, so it has to keep at least one category. ' +
        'Add another before you take this one off.'));
    }

    var foot = el('div', 'tagpanel-foot');
    var done = el('button', 'btn btn-quiet', 'Done');
    done.type = 'button';
    done.onclick = function () { closeField(field); toggle.focus(); };
    foot.appendChild(done);
    panel.appendChild(foot);

    field.appendChild(bar);
    field.appendChild(panel);

    toggle.onclick = function () {
      if (field.dataset.tagopen === '1') closeField(field);
      else openField(field);
    };

    if (OPEN[key]) openField(field);
  }

  /* ── Finding them ──────────────────────────────────────────────────────*/
  function sweep(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.classList && root.classList.contains('kindgroups')) wrapGroups(root);
    if (!root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('.kindgroups'), wrapGroups);
  }

  var obs = new MutationObserver(function (records) {
    records.forEach(function (r) {
      Array.prototype.forEach.call(r.addedNodes, sweep);
    });
  });

  function injectRule() {
    if (document.getElementById('tagui-rule')) return;
    var s = document.createElement('style');
    s.id = 'tagui-rule';
    s.textContent = '.kindgroups:not(.tagui-in-panel){display:none!important}';
    (document.head || document.documentElement).appendChild(s);
  }

  /* Escape closes the card, the same way it closes everything else on this
   * page — except while the tour is running, because Escape is how the tour
   * is dismissed and stealing it would leave the reader unable to get out. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.tour-bubble')) return;
    closeAll(null);
  });

  /* One tutorial step describes the control this file just replaced:
   * upload-tagging said "Tap the chips on a file to tag it". The id is
   * deliberately left alone — tour.js: "IDS ARE PERMANENT. Renaming one makes
   * the step unseen for the entire shop and everybody gets taught it again.
   * Change the copy freely; leave the id." Only the copy moves.
   *
   * It is patched through Tour._steps from here rather than edited in
   * tour.js, for the same reason everything else in this file is a bolt-on.
   * If you are already in tour.js for another reason, move it inline and
   * delete this. */
  function fixTourCopy() {
    var steps = window.Tour && window.Tour._steps && window.Tour._steps.artist;
    if (!steps) return false;
    var hit = false;
    steps.forEach(function (s) {
      if (s.id !== 'upload-tagging') return;
      s.body = 'Categories are how a customer finds you. Tap the tag button ' +
        'on a file to open the list and pick what fits — or tag the whole ' +
        'batch at once from the top.';
      hit = true;
    });
    return hit;
  }

  function boot() {
    injectRule();
    var app = document.getElementById('app');
    if (!app) { setTimeout(boot, 100); return; }
    sweep(app);
    obs.observe(app, { childList: true, subtree: true });
  }

  boot();

  (function tryTour(n) {
    if (fixTourCopy() || n > 20) return;
    setTimeout(function () { tryTour(n + 1); }, 200);
  })(0);

  window.TagUI = { closeAll: closeAll, _open: OPEN };
})();
