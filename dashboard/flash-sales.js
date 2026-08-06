/* Flash Sales — Kat's event creator.
 *
 * Joshua's ask: "I want an event creator... in the admin dashboard for Kat to
 * use to create a flash event and then set prices."
 *
 * NOT an artist-level thing and not a category request. Artists ask for
 * categories; nobody asks for a sale. `flash_sales` is admin-only in RLS, so
 * this tab is the only way one comes into existence and an artist calling the
 * same endpoint by hand is refused by Postgres, not by this file.
 *
 * THE SALE SWITCHES ITSELF ON. There is no midnight job to schedule and
 * nothing to run overnight at the shop. The kiosk reads as `anon`, and the
 * policy for that role is `published and now() >= starts_at and now() <
 * ends_at` — so the sale becomes visible when the clock reaches the start and
 * stops being visible at the end. The kiosk re-fetches every five minutes and
 * picks it up. `published` is Kat's separate hand on the switch: build a sale
 * a week early without it leaking, pull one down early without editing times
 * under pressure on the day.
 *
 * SELF-WIRING, like tour.js and category-suggest.js. app.js is the file with
 * the most to lose from being edited, so this one adds nothing to it: the tab
 * and pane live in index.html, and this file claims the tab's click handler
 * after app.js has set its own. app.js's show() would throw on a view it has
 * no renderer for, so taking the handler over is what keeps it out of that
 * path entirely.
 */
window.FlashSales = (function () {
  'use strict';

  var sb = null;
  var sales = [];        // [{...sale, tiers:[], design_count}]
  var painted = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function toast(msg, kind) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' toast-' + kind : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, kind === 'error' ? 9000 : 4000);
  }

  /* Money is stored in cents as an integer. Kat types dollars. Parsing here
   * rather than trusting a float keeps "50" and "50.00" the same row. */
  function toCents(str) {
    var raw = String(str || '');
    // A minus has to be rejected, not stripped. Stripping turned "-5" into
    // $5, which is a wrong number entered silently rather than an error.
    if (raw.indexOf('-') !== -1) return null;
    var s = raw.replace(/[^0-9.]/g, '');
    if (!s) return null;
    var n = Math.round(parseFloat(s) * 100);
    return (isFinite(n) && n > 0) ? n : null;
  }
  function money(cents) {
    return '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
  }

  /* <input type="datetime-local"> speaks local time with no zone. The column
   * is timestamptz. Converting through a Date means what Kat types as 9am is
   * 9am in the shop, not 9am UTC — four hours of a sale silently missing. */
  function toISO(localValue) {
    if (!localValue) return null;
    var d = new Date(localValue);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  /* The same question the kiosk's RLS policy asks, asked here so the label
   * matches what the wall is actually doing. */
  function status(s) {
    var now = Date.now();
    var a = new Date(s.starts_at).getTime();
    var b = new Date(s.ends_at).getTime();
    if (!s.published) return { text: 'Draft — not on the kiosk', cls: 'pill' };
    if (now < a) return { text: 'Scheduled', cls: 'pill warn' };
    if (now >= b) return { text: 'Finished', cls: 'pill' };
    return { text: 'LIVE ON THE KIOSK NOW', cls: 'pill ok' };
  }

  async function load() {
    if (!sb) sb = await window.DashClient.client();
    if (!sb) return;
    var r = await sb.from('flash_sales')
      .select('*, flash_sale_tiers(*), flash_sale_designs(design_id), flash_sale_media(*)')
      .order('starts_at', { ascending: false });
    if (r.error) { toast('Loading flash sales: ' + r.error.message, 'error'); return; }
    sales = (r.data || []).map(function (s) {
      s.tiers = (s.flash_sale_tiers || []).sort(function (a, b) {
        return a.display_order - b.display_order || a.price_cents - b.price_cents;
      });
      s.design_count = (s.flash_sale_designs || []).length;
      return s;
    });
  }

  /* == Create ============================================================ */
  function createCard() {
    var card = el('div', 'card');
    card.appendChild(el('h2', null, 'Flash sales'));
    card.appendChild(el('p', 'muted',
      'Make the event, set when it runs, then add the price levels. It ' +
      'appears on the kiosk on its own when the start time arrives, and ' +
      'comes down at the end.'));

    var name = el('input', 'input'); name.placeholder = 'Name — e.g. Friday the 13th';
    var sub = el('input', 'input'); sub.placeholder = 'Subtitle (optional) — e.g. Walk-ins only';

    var startWrap = el('label', 'field');
    startWrap.appendChild(el('span', 'muted small', 'Starts'));
    var start = el('input', 'input'); start.type = 'datetime-local';
    startWrap.appendChild(start);

    var endWrap = el('label', 'field');
    endWrap.appendChild(el('span', 'muted small', 'Ends'));
    var end = el('input', 'input'); end.type = 'datetime-local';
    endWrap.appendChild(end);

    var btn = el('button', 'btn btn-primary', 'Create flash sale');
    btn.onclick = async function () {
      if (!name.value.trim()) return toast('Give it a name first.', 'error');
      var a = toISO(start.value), b = toISO(end.value);
      if (!a || !b) return toast('Set both a start and an end.', 'error');
      if (new Date(b) <= new Date(a)) return toast('The end has to be after the start.', 'error');

      btn.disabled = true;
      var r = await sb.from('flash_sales').insert({
        name: name.value.trim(),
        subtitle: sub.value.trim() || null,
        starts_at: a, ends_at: b,
        published: false,   // never live the instant it is made
      });
      btn.disabled = false;
      if (r.error) return toast('Could not create it: ' + r.error.message, 'error');

      name.value = sub.value = start.value = end.value = '';
      toast('Created. Add the price levels, then publish it.');
      await refresh();
    };

    card.append(name, sub, startWrap, endWrap, btn);
    return card;
  }

  /* == One sale ========================================================== */
  function saleCard(s) {
    var card = el('div', 'card');

    var head = el('div', 'row');
    head.appendChild(el('h3', null, s.name));
    var st = status(s);
    head.appendChild(el('span', st.cls, st.text));
    card.appendChild(head);

    if (s.subtitle) card.appendChild(el('div', 'muted small', s.subtitle));
    card.appendChild(el('div', 'muted small',
      when(s.starts_at) + '  →  ' + when(s.ends_at)));
    card.appendChild(el('div', 'muted small',
      s.design_count === 1 ? '1 design in this sale'
                           : s.design_count + ' designs in this sale'));

    /* Price levels. Kat's example was $50 / $100 / $200 as collections, so
     * this is a list she adds to rather than three fixed boxes. */
    card.appendChild(el('div', 'muted small tierlabel', 'Price levels'));
    var tiers = el('div', 'chips');
    if (!s.tiers.length) {
      tiers.appendChild(el('span', 'muted small',
        'None yet — a sale with no prices shows nothing to price.'));
    }
    s.tiers.forEach(function (t) {
      var chip = el('span', 'chip is-on');
      chip.appendChild(document.createTextNode(
        money(t.price_cents) + (t.label ? ' · ' + t.label : '')));
      var x = el('button', 'btn btn-quiet tier-x', '×');
      x.title = 'Remove this price level';
      x.onclick = async function () {
        if (!confirm('Remove the ' + money(t.price_cents) + ' level? Designs at ' +
                     'that price stay in the sale with no price until you set one.')) return;
        var r = await sb.from('flash_sale_tiers').delete().eq('id', t.id);
        if (r.error) return toast('Could not remove it: ' + r.error.message, 'error');
        await refresh();
      };
      chip.appendChild(x);
      tiers.appendChild(chip);
    });
    card.appendChild(tiers);

    var addRow = el('div', 'row');
    var price = el('input', 'input ord');
    price.placeholder = '50'; price.inputMode = 'decimal';
    var plabel = el('input', 'input');
    plabel.placeholder = 'Label (optional) — e.g. Small';
    var addTier = el('button', 'btn btn-quiet', 'Add price level');
    addTier.onclick = async function () {
      var cents = toCents(price.value);
      if (!cents) return toast('Enter a price, like 50.', 'error');
      addTier.disabled = true;
      var r = await sb.from('flash_sale_tiers').insert({
        sale_id: s.id, price_cents: cents,
        label: plabel.value.trim() || null,
        display_order: s.tiers.length,
      });
      addTier.disabled = false;
      if (r.error) {
        return toast(/duplicate|unique/i.test(r.error.message)
          ? 'That price is already a level in this sale.'
          : 'Could not add it: ' + r.error.message, 'error');
      }
      price.value = plabel.value = '';
      await refresh();
    };
    addRow.append(price, plabel, addTier);
    card.appendChild(addRow);

    card.appendChild(mediaSection(s));

    /* Publish. Separate from the dates on purpose: the dates say when it
     * would run, this says whether it is allowed to. */
    var row = el('div', 'row');
    var pub = el('button', 'btn ' + (s.published ? 'btn-quiet' : 'btn-primary'),
      s.published ? 'Unpublish' : 'Publish to the kiosk');
    pub.onclick = async function () {
      if (!s.published && !s.tiers.length &&
          !confirm('This sale has no price levels yet. Publish anyway?')) return;
      var r = await sb.from('flash_sales')
        .update({ published: !s.published }).eq('id', s.id);
      if (r.error) return toast('Could not change it: ' + r.error.message, 'error');
      toast(s.published ? 'Taken off the kiosk.'
                        : 'Published. It appears on the kiosk when it starts.');
      await refresh();
    };
    row.appendChild(pub);

    var edit = el('button', 'btn btn-quiet', 'Change times');
    edit.onclick = function () { timesEditor(card, s); edit.disabled = true; };
    row.appendChild(edit);

    var del = el('button', 'btn btn-danger', 'Delete');
    del.onclick = async function () {
      if (!confirm('Delete "' + s.name + '"? Its price levels go with it. The ' +
                   'designs themselves are not touched.')) return;
      var r = await sb.from('flash_sales').delete().eq('id', s.id);
      if (r.error) return toast('Could not delete it: ' + r.error.message, 'error');
      toast('Deleted.');
      await refresh();
    };
    row.appendChild(del);

    card.appendChild(row);
    return card;
  }

  /* == Event branding for the attract reel ================================
   *
   * Kat's own photos or clips for the event — a poster, shop photography,
   * whatever she has. They join the attract loop while the sale is running
   * and stop appearing the moment it ends, because the RLS policy on this
   * table asks the sale's window, not a flag somebody has to remember to
   * turn off.
   *
   * NOT held to invariant 3's sizes. That rule protects an artist's drawing
   * from being cropped; this is the shop's own promo material and refusing a
   * 1600x900 poster because it is not 2048x2048 would be the rule doing the
   * opposite of its job. The kiosk letterboxes rather than crops, so nothing
   * of hers is cut off either.
   */
  function mediaSection(s) {
    var wrap = el('div', 'sale-media');
    wrap.appendChild(el('div', 'muted small tierlabel', 'Event photos'));
    wrap.appendChild(el('div', 'muted small',
      'Plays in the slideshow on the kiosk while nobody is touching it, for ' +
      'as long as this sale is running.'));

    var strip = el('div', 'row media-strip');
    var media = (s.flash_sale_media || []).slice().sort(function (a, b) {
      return a.display_order - b.display_order;
    });
    if (!media.length) strip.appendChild(el('span', 'muted small', 'Nothing yet.'));

    media.forEach(function (m) {
      var item = el('div', 'media-item');
      if (m.media_type === 'video') {
        var v = el('video', 'media-thumb');
        v.src = m.url; v.muted = true; v.playsInline = true;
        item.appendChild(v);
      } else {
        var i = el('img', 'media-thumb');
        i.src = m.url; i.loading = 'lazy'; i.alt = '';
        item.appendChild(i);
      }
      var x = el('button', 'btn btn-quiet tier-x', '×');
      x.title = 'Remove this photo';
      x.onclick = async function () {
        if (!confirm('Remove this from the event slideshow?')) return;
        var r = await sb.from('flash_sale_media').delete().eq('id', m.id);
        if (r.error) return toast('Could not remove it: ' + r.error.message, 'error');
        await refresh();
      };
      item.appendChild(x);
      strip.appendChild(item);
    });
    wrap.appendChild(strip);

    var pick = el('label', 'btn btn-quiet');
    pick.appendChild(document.createTextNode('Add event photos'));
    var input = el('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,video/mp4';
    input.multiple = true;
    input.hidden = true;
    input.onchange = function () { upload(s, [].slice.call(input.files)); };
    pick.appendChild(input);
    wrap.appendChild(pick);

    return wrap;
  }

  async function upload(s, files) {
    if (!files.length) return;
    var ok = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var isVideo = /^video\//.test(f.type);
      var ext = (f.name.match(/\.([a-z0-9]+)$/i) || [null, 'bin'])[1].toLowerCase();
      // Timestamped rather than overwritten: the bucket is public and sits
      // behind a CDN, so a replaced file can serve the old bytes for a while.
      var path = s.id + '/' + Date.now().toString(36) + '-' + i + '.' + ext;

      var up = await sb.storage.from('sale-media')
        .upload(path, f, { contentType: f.type || undefined, upsert: false });
      if (up.error) { toast(f.name + ': ' + up.error.message, 'error'); continue; }

      var url = sb.storage.from('sale-media').getPublicUrl(path).data.publicUrl;
      var ins = await sb.from('flash_sale_media').insert({
        sale_id: s.id, url: url,
        media_type: isVideo ? 'video' : 'image',
        display_order: (s.flash_sale_media || []).length + i,
      });
      if (ins.error) { toast(f.name + ': ' + ins.error.message, 'error'); continue; }
      ok++;
    }
    if (ok) toast(ok === 1 ? 'Added 1 photo to the event slideshow.'
                           : 'Added ' + ok + ' to the event slideshow.');
    await refresh();
  }

  function timesEditor(card, s) {
    var wrap = el('div', 'row');
    var a = el('input', 'input'); a.type = 'datetime-local'; a.value = toLocalInput(s.starts_at);
    var b = el('input', 'input'); b.type = 'datetime-local'; b.value = toLocalInput(s.ends_at);
    var save = el('button', 'btn btn-primary', 'Save times');
    save.onclick = async function () {
      var x = toISO(a.value), y = toISO(b.value);
      if (!x || !y) return toast('Both times are needed.', 'error');
      if (new Date(y) <= new Date(x)) return toast('The end has to be after the start.', 'error');
      var r = await sb.from('flash_sales')
        .update({ starts_at: x, ends_at: y }).eq('id', s.id);
      if (r.error) return toast('Could not save: ' + r.error.message, 'error');
      toast('Times updated.');
      await refresh();
    };
    wrap.append(a, b, save);
    card.appendChild(wrap);
  }

  /* == Render ============================================================ */
  function paint() {
    var pane = document.getElementById('view-flashsales');
    if (!pane) return;
    pane.innerHTML = '';
    pane.appendChild(createCard());
    if (!sales.length) {
      pane.appendChild(el('div', 'card muted', 'No flash sales yet.'));
    }
    sales.forEach(function (s) { pane.appendChild(saleCard(s)); });
  }

  async function refresh() { await load(); paint(); }

  async function show() {
    // Do app.js's job for this one view: hide every pane, mark the tab.
    Array.prototype.forEach.call(document.querySelectorAll('.pane'),
      function (p) { p.hidden = true; });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'),
      function (t) { t.classList.toggle('is-active', t.dataset.view === 'flashsales'); });
    var pane = document.getElementById('view-flashsales');
    if (pane) pane.hidden = false;
    if (!painted) { painted = true; paint(); }   // something on screen immediately
    await refresh();
  }

  /* app.js binds .tab click handlers during its own boot. This file loads
   * after it, so assigning onclick here replaces that binding for this tab
   * only — which matters, because app.js's show() has no renderer registered
   * for 'flashsales' and would throw on the lookup. */
  function attach() {
    var tab = document.querySelector('.tab[data-view="flashsales"]');
    if (!tab) return;
    tab.onclick = function () { show(); };
  }

  return { attach, show, refresh, _toCents: toCents, _money: money };
})();

/* Self-wiring: wait for the dashboard to sign somebody in, same trick tour.js
 * uses. The tab itself is marked admin-only in the markup, so app.js unhides
 * it for admins and leaves it hidden for artists without knowing why. */
(function () {
  'use strict';
  var bar = document.getElementById('topbar');
  if (!bar) return;
  var done = false;
  function ready() {
    if (done || bar.hidden) return;
    done = true;
    obs.disconnect();
    window.FlashSales.attach();
  }
  var obs = new MutationObserver(ready);
  obs.observe(bar, { attributes: true, attributeFilter: ['hidden'] });
  ready();
})();
