/* Kattitude Flash Dashboard
 *
 * A static single-page app talking directly to Supabase. No build step and no
 * server of its own — the same zero-dependency shape as the kiosk, for the
 * same reason: fewer moving parts to rot between visits from whoever
 * maintains this next.
 *
 * SECURITY POSTURE
 * Every write goes out with the signed-in user's JWT and is evaluated by
 * row-level security in Postgres. The client never decides what someone may
 * do — it only decides what to SHOW. An artist who forged a request would
 * still be refused by the database. There is no service-role key here.
 *
 * That posture is why the category-request feature is shaped the way it is.
 * The "artists cannot create categories" rule is an RLS policy on
 * `categories`; the "no two spellings of the same category" rule is a UNIQUE
 * index on a generated canonical key; the "only an admin approves" rule is an
 * is_admin() guard inside a SECURITY DEFINER function. Everything below is
 * the friendly face of those three, and none of it is load-bearing.
 *
 * WHAT IS NO LONGER HERE: a category is NOT required to publish. There used
 * to be a `designs_publish_gate` trigger refusing to publish an untagged
 * design, and this file wore its shape in three places — a refusal in
 * uploadAll(), a three-write dance in uploadOne(), and a guard against
 * removing a published design's last category. The trigger was dropped on
 * 17 Aug 2026 because it was stopping artists uploading at all. Joshua:
 * "they shouldn't be forced to do that. They should be able to just upload
 * the designs, and they can add categories or remove the categories later."
 * An untagged design is a perfectly ordinary design. It appears under See All
 * on the kiosk; it simply matches no category filter until somebody tags it.
 *
 * The Artists tab lives in artists-tab.js — it is the largest surface here
 * and the one Kat uses most, so it earns its own file.
 */
(function () {
  'use strict';

  const cfg = window.DASH_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  /* Categories are two different kinds of thing wearing one label. `style` is
   * how a piece is drawn (Fine Line, Blackwork). `theme` is what it evokes
   * (summertime, Texas, love). `subject` is what it literally depicts (snakes,
   * roses). They are orthogonal — a piece can be all three — so they are shown
   * as separate shelves rather than one flat run of chips. An admin picks the
   * kind at approval time; artists never set it. */
  const KINDS = [
    ['style',   'Style'],
    ['theme',   'Theme'],
    ['subject', 'Subject'],
  ];

  const KIND_LABEL = { style: 'Styles', theme: 'Themes', subject: 'Subjects' };

  /* == State == */
  const state = {
    user: null,
    me: null,          // the artists row for this user
    isAdmin: false,
    artists: [],
    categories: [],
    designs: [],
    requests: [],      // rows from category_request_queue (RLS decides which)
    queue: [],         // files staged for upload
    view: 'upload',
  };

  /* == Tiny DOM helpers == */
  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' toast-' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    // An error people have to act on needs longer than a success they can
    // ignore, and the invite-failed message is long.
    setTimeout(() => {}, 0);
    toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 12000 : 4000);
  }

  function fail(where, error) {
    console.error(where, error);
    toast((error && error.message) ? `${where}: ${error.message}` : where, 'error');
  }

  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    return d.toLocaleDateString();
  }

  /* == Auth == */
  async function sendMagicLink() {
    const email = $('#email').value.trim();
    if (!email) { $('#signinMsg').textContent = 'Enter your email first.'; return; }

    $('#sendLink').disabled = true;
    $('#signinMsg').textContent = 'Sending…';

    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });

    $('#sendLink').disabled = false;
    if (error) { $('#signinMsg').textContent = error.message; return; }
    $('#signinMsg').textContent =
      'Sent. Open the link on this device — it signs you in here.';
  }

  async function loadMe() {
    // The artists row IS the identity. A signed-in user with no row can see
    // nothing, which is the correct default for a stranger who guessed the URL.
    const { data, error } = await sb
      .from('artists').select('*').eq('auth_user_id', state.user.id).maybeSingle();
    if (error) { fail('Loading your profile', error); return; }
    state.me = data;
    state.isAdmin = !!(data && data.role === 'admin');
  }

  async function onSignedIn() {
    await loadMe();

    if (!state.me) {
      $('#signin').hidden = false;
      $('#signin').innerHTML = '';
      const c = el('div', 'card signin-card');
      c.appendChild(el('h1', null, 'No artist profile yet'));
      const p = el('p', 'muted');
      p.textContent = 'You are signed in as ' + state.user.email +
        ', but that address is not attached to an artist yet. Ask Kat to add ' +
        'you in the Artists tab — she just needs to set your email on your card.';
      c.appendChild(p);
      const b = el('button', 'btn btn-quiet', 'Sign out');
      b.onclick = signOut;
      c.appendChild(b);
      $('#signin').appendChild(c);
      return;
    }

    $('#signin').hidden = true;
    $('#topbar').hidden = false;
    $('#tabs').hidden = false;
    $('#whoName').textContent = state.me.name;
    $('#whoRole').textContent = state.isAdmin ? 'Admin' : 'Artist';
    $$('.admin-only').forEach(t => { t.hidden = !state.isAdmin; });

    window.ArtistsTab.init({
      sb, state, el, toast, fail,
      reload: async () => { await loadArtists(); renderArtists(); },
    });

    await Promise.all([loadArtists(), loadCategories(), loadRequests()]);
    await loadDesigns();
    show('upload');
  }

  async function signOut() {
    await sb.auth.signOut();
    location.reload();
  }

  /* == Data == */
  async function loadArtists() {
    const { data, error } = await sb.from('artists')
      .select('*').order('display_order');
    if (error) return fail('Loading artists', error);
    state.artists = data || [];
  }

  async function loadCategories() {
    const { data, error } = await sb.from('categories')
      .select('*').order('display_order');
    if (error) return fail('Loading categories', error);
    state.categories = data || [];
  }

  async function loadDesigns() {
    // RLS already limits an artist to their own rows, so no client-side
    // filter is needed — and none should be relied on.
    const { data, error } = await sb.from('designs')
      .select('*, design_categories(category_id)')
      .order('display_order').order('created_at', { ascending: false });
    if (error) return fail('Loading designs', error);
    state.designs = data || [];
  }

  async function loadRequests() {
    // Same query for everyone. The view is security_invoker, so an artist
    // gets their own rows and an admin gets all of them — the client is not
    // filtering, and could not be trusted to.
    const { data, error } = await sb.from('category_request_queue')
      .select('*').order('created_at', { ascending: false });
    if (error) return fail('Loading category requests', error);
    state.requests = data || [];
    paintRequestBadge();
  }

  function pendingForMe() {
    return state.requests.filter(r => r.status === 'pending' &&
      (state.isAdmin || r.requested_by === state.me.id));
  }

  function paintRequestBadge() {
    const tab = $('.tab[data-view="requests"]');
    if (!tab) return;
    const n = pendingForMe().length;
    tab.innerHTML = '';
    tab.appendChild(document.createTextNode('Requests'));
    if (n) tab.appendChild(el('span', 'count', String(n)));
  }

  /* == Image handling == */
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not a readable image')); };
      img.src = url;
    });
  }

  /**
   * Which spec does this file match? Returns 'design', 'sheet', or null.
   * Dimensions decide the type, so an artist cannot mislabel a file into the
   * wrong shape and break the kiosk grid.
   */
  /* [CHANGED 2 Oct 2026 — Joshua: flash sheets must be "resized to the
   * appropriate size"] Exact sizes still classify as before. Beyond that:
   *   - a square at least 2048 wide is a single, scaled down to 2048×2048;
   *   - any other shape at least 1080 wide (the wall's width) is a sheet,
   *     fitted inside 2160×3840 on upload (fitInside below).
   * NOTHING IS EVER CROPPED and nothing is upscaled — the original upload is
   * kept untouched next to the resized copy. Smaller files are still refused:
   * stretched, they would look soft on the wall. */
  /* [CHANGED 2 Oct 2026 — Joshua: "designs are sheets".] Every upload is a
   * flash sheet, exactly as a file dropped into KIOSK MEDIA is — so the
   * phone page and the wall always agree on what something is. Too small to
   * read on the 1080-wide wall (long side under 1080) is still refused. */
  function classify(w, h) {
    return Math.max(w, h) >= 1080 ? 'sheet' : null;
  }

  function specError(w, h) {
    const d = cfg.spec.design;
    return `${w}×${h} is too small for the wall. A flash sheet needs at ` +
           `least 1080 pixels on its long side. Bigger files are resized for ` +
           `you — never cropped.`;
  }

  /** The copy the kiosk shows: the whole image scaled to fit inside maxW×maxH,
   *  aspect kept, no padding, never larger than the original. */
  function fitInside(img, maxW, maxH) {
    const s = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return new Promise(res => c.toBlob(b => res({ blob: b, w: c.width, h: c.height }), 'image/webp', 0.92));
  }

  /** Render a derivative with canvas. `cover` centre-crops, `contain` fits. */
  function derive(img, spec) {
    const c = document.createElement('canvas');
    c.width = spec.w; c.height = spec.h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';

    const sr = img.naturalWidth / img.naturalHeight;
    const dr = spec.w / spec.h;
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;

    if (spec.fit === 'cover') {
      if (sr > dr) { sw = sh * dr; sx = (img.naturalWidth - sw) / 2; }
      else { sh = sw / dr; sy = (img.naturalHeight - sh) / 2; }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, spec.w, spec.h);
    } else {
      const scale = Math.min(spec.w / sw, spec.h / sh);
      const dw = sw * scale, dh = sh * scale;
      ctx.drawImage(img, 0, 0, sw, sh, (spec.w - dw) / 2, (spec.h - dh) / 2, dw, dh);
    }

    return new Promise(res => c.toBlob(res, 'image/webp', 0.86));
  }

  /* == Category chips, grouped by kind ====================================
   *
   * Used by the staged-file cards, the bulk tagger and the designs list, so
   * the grouping cannot drift between them. `selected` is an array of
   * category ids; `onToggle(category, isOn)` does whatever that surface does.
   */
  function chipGroups(selected, onToggle) {
    const wrap = el('div', 'kindgroups');
    let any = false;

    KINDS.forEach(([kind]) => {
      // A category written before `kind` existed defaults to style, matching
      // the column default. Nothing should vanish because a field is null.
      const cats = state.categories.filter(c => (c.kind || 'style') === kind);
      if (!cats.length) return;
      any = true;

      const g = el('div', 'kindgroup');
      g.appendChild(el('div', 'muted small kindlabel', KIND_LABEL[kind]));

      const chips = el('div', 'chips');
      cats.forEach(c => {
        const on = selected.indexOf(c.id) !== -1;
        const b = el('button', 'chip' + (on ? ' is-on' : ''), c.name);
        b.onclick = () => onToggle(c, on);
        chips.appendChild(b);
      });
      g.appendChild(chips);
      wrap.appendChild(g);
    });

    if (!any) wrap.appendChild(el('div', 'muted small', 'No categories yet.'));

    const ask = el('button', 'btn btn-quiet', 'Request a new category…');
    ask.onclick = () => show('requests');
    wrap.appendChild(ask);

    return wrap;
  }

  /* == The request panel ==================================================
   *
   * Two tiers, and they are not the same mechanism:
   *
   *   EXACT   — canonical key match against an existing category. Blocks.
   *             The artist is told what it already is and no request is
   *             created, so duplicate requests never enter the queue.
   *
   *   NEAR    — trigram similarity. Does NOT block. It is shown here as a
   *             courtesy and shown to the admin at review time as
   *             "did you mean". Auto-merging on similarity would fold
   *             genuinely different categories together silently, which is
   *             worse than the duplicate it would prevent.
   *
   * Both come from one round trip to check_category_name().
   */
  function requestPanel() {
    const card = el('div', 'card req-panel');
    card.appendChild(el('h2', null, 'Request a new category'));

    const p = el('p', 'muted');
    p.textContent = 'Ask for anything you actually want to tag work with — a ' +
      'theme like “summertime” or “Texas”, a subject like “snakes”, or a ' +
      'drawing style. Kat approves it before it shows up on the kiosk, so the ' +
      'shop does not end up with three spellings of the same thing.';
    card.appendChild(p);

    const input = el('input', 'input');
    input.placeholder = 'e.g. summertime';
    input.setAttribute('autocapitalize', 'words');
    card.appendChild(input);

    const fb = el('div', 'req-feedback');
    card.appendChild(fb);

    const submit = el('button', 'btn btn-primary', 'Send request');
    submit.disabled = true;
    card.appendChild(submit);

    let timer = null;
    let seq = 0;            // guards against an old response landing last

    function say(cls, nodes) {
      fb.className = 'req-feedback ' + (cls || '');
      fb.innerHTML = '';
      nodes.forEach(n => fb.appendChild(n));
    }

    async function check() {
      const name = input.value.trim();
      submit.disabled = true;

      if (!name) { say('', []); return; }

      const mine = ++seq;
      const { data, error } = await sb.rpc('check_category_name', { p_name: name });
      if (mine !== seq) return;        // a later keystroke has already answered
      if (error) return fail('Checking that name', error);

      if (data.reason === 'empty') {
        say('req-exists', [el('span', null, data.message)]);
        return;
      }

      if (data.reason === 'exists') {
        const line = el('div');
        line.appendChild(document.createTextNode('That already exists as '));
        line.appendChild(el('strong', null, data.exact.name));
        line.appendChild(document.createTextNode(
          ' (' + data.exact.kind + '). Tag your work with it instead.'));
        say('req-exists', [line]);
        return;
      }

      if (data.reason === 'already_requested') {
        say('req-dupe', [el('div', null,
          'You already asked for “' + data.my_pending.requested_name + '” ' +
          when(data.my_pending.created_at) + '. It is still waiting on Kat.')]);
        return;
      }

      // Available. Near matches are advisory — the button stays enabled.
      const nodes = [el('div', null, 'Nobody has this one yet. Send it over.')];
      if (data.near && data.near.length) {
        const n = el('div', 'req-near');
        n.textContent = 'Close to what already exists: ' +
          data.near.map(x => x.name).join(', ') +
          '. Send it anyway if you mean something different — Kat decides ' +
          'whether they are the same thing.';
        nodes.push(n);
      }
      say('req-ok', nodes);
      submit.disabled = false;
    }

    input.oninput = () => { clearTimeout(timer); timer = setTimeout(check, 300); };
    input.onblur = check;

    submit.onclick = async () => {
      const name = input.value.trim();
      if (!name) return;
      submit.disabled = true;

      // requested_by is left to its column default, current_artist_id(). The
      // RLS check refuses anything else, so sending it from here would only
      // create a second place for it to be wrong.
      const { error } = await sb.from('category_requests')
        .insert({ requested_name: name });

      if (error) {
        // The database is allowed to know things the client does not — a
        // category created by someone else thirty seconds ago, for instance.
        submit.disabled = false;
        return fail('Sending request', error);
      }

      input.value = '';
      say('', []);
      toast('Sent. Kat will see it in her Requests tab.');
      await loadRequests();
      renderRequests();
    };

    return card;
  }

  /* == Requests view ======================================================
   * One tab, two audiences. An artist sees the ask-form and their own
   * history. An admin sees the review queue first, then the same history.
   */
  function renderRequests() {
    const v = $('#view-requests');
    v.innerHTML = '';

    if (state.isAdmin) v.appendChild(reviewQueue());

    v.appendChild(requestPanel());
    v.appendChild(myRequests());
  }

  function reviewQueue() {
    const wrap = el('div');

    const head = el('div', 'card');
    head.appendChild(el('h2', null, 'Category requests'));
    const p = el('p', 'muted');
    p.textContent = 'Approve to create the category, merge if the artist meant ' +
      'one we already have, or reject with a note so they know why. Nothing ' +
      'here is automatic — “did you mean” suggestions are similarity only, ' +
      'and similar is not the same.';
    head.appendChild(p);
    wrap.appendChild(head);

    const pending = state.requests.filter(r => r.status === 'pending');
    if (!pending.length) {
      wrap.appendChild(el('div', 'card muted', 'Nothing waiting.'));
      return wrap;
    }

    pending.forEach(r => wrap.appendChild(reviewCard(r)));
    return wrap;
  }

  function reviewCard(r) {
    const card = el('div', 'card req-item');

    card.appendChild(el('div', 'req-name', r.requested_name));

    const who = el('div', 'muted small req-who');
    who.textContent = (r.requested_by_name || 'Unknown') +
      (r.requested_by_handle ? ' (' + r.requested_by_handle + ')' : '') +
      ' · ' + when(r.created_at) +
      (r.pending_duplicates > 1
        ? ' · ' + r.pending_duplicates + ' artists have asked for this'
        : '');
    card.appendChild(who);

    const near = r.near_matches || [];
    if (near.length) {
      const n = el('div', 'req-near-list');
      n.appendChild(el('div', 'muted small', 'Did you mean:'));
      const row = el('div', 'row');
      near.forEach(m => {
        const b = el('button', 'btn btn-quiet',
          'Merge into ' + m.name + ' (' + Math.round(m.similarity * 100) + '% alike)');
        b.onclick = () => doMerge(r, m.id, null);
        row.appendChild(b);
      });
      n.appendChild(row);
      card.appendChild(n);
    }

    const actions = el('div', 'req-actions');

    // Kind defaults to theme: Joshua's whole complaint is that the existing
    // list is all styles and artists want themes. The common case should be
    // the zero-thought case.
    const kind = el('select', 'input');
    KINDS.forEach(([value, label]) => {
      const o = el('option', null, label);
      o.value = value;
      if (value === 'theme') o.selected = true;
      kind.appendChild(o);
    });
    kind.title = 'What kind of category is this?';

    const ok = el('button', 'btn btn-primary', 'Approve');
    ok.onclick = async () => {
      ok.disabled = true;
      const { data, error } = await sb.rpc('approve_category_request', {
        p_request_id: r.id, p_kind: kind.value,
      });
      if (error) { ok.disabled = false; return fail('Approving', error); }
      toast('Created “' + (data ? data.name : r.requested_name) + '”.');
      await Promise.all([loadCategories(), loadRequests()]);
      renderRequests();
    };

    // Merge into anything, not only the near matches — similarity is a hint,
    // not the whole list.
    const mergeSel = el('select', 'input');
    mergeSel.appendChild(el('option', null, 'Merge into…'));
    state.categories.forEach(c => {
      const o = el('option', null, c.name + ' · ' + (c.kind || 'style'));
      o.value = c.id;
      mergeSel.appendChild(o);
    });
    mergeSel.onchange = () => {
      if (!mergeSel.value) return;
      doMerge(r, mergeSel.value, null);
    };

    const no = el('button', 'btn btn-danger', 'Reject');
    no.onclick = async () => {
      const note = prompt('Why? The artist sees this.\n\n' +
        'e.g. "Too close to Floral — use that one."');
      if (note === null) return;
      const { error } = await sb.rpc('reject_category_request', {
        p_request_id: r.id, p_note: note,
      });
      if (error) return fail('Rejecting', error);
      await loadRequests();
      renderRequests();
    };

    actions.append(kind, ok, mergeSel, no);
    card.appendChild(actions);
    return card;
  }

  async function doMerge(r, categoryId, note) {
    const target = state.categories.find(c => c.id === categoryId);
    if (!confirm('Tell ' + (r.requested_by_name || 'them') + ' to use “' +
        (target ? target.name : 'that category') + '” instead of “' +
        r.requested_name + '”?')) return;
    const { error } = await sb.rpc('merge_category_request', {
      p_request_id: r.id, p_category_id: categoryId, p_note: note,
    });
    if (error) return fail('Merging', error);
    await loadRequests();
    renderRequests();
  }

  function myRequests() {
    const mine = state.requests.filter(r => r.requested_by === state.me.id);

    const card = el('div', 'card req-history');
    card.appendChild(el('h3', null, state.isAdmin ? 'Your own requests' : 'Your requests'));

    if (!mine.length) {
      card.appendChild(el('p', 'muted small',
        'Nothing yet. Anything you ask for shows up here with its answer, so ' +
        'you never have to wonder whether it went through.'));
      return card;
    }

    mine.forEach(r => {
      const row = el('div', 'req-item');
      row.appendChild(el('div', 'req-name', r.requested_name));

      const status = el('div', 'row status');
      const pillClass =
        r.status === 'approved' ? 'pill ok' :
        r.status === 'pending'  ? 'pill warn' : 'pill';
      status.appendChild(el('span', pillClass,
        r.status === 'merged' ? 'Use an existing one' :
        r.status.charAt(0).toUpperCase() + r.status.slice(1)));
      status.appendChild(el('span', 'muted small', 'asked ' + when(r.created_at)));
      row.appendChild(status);

      if (r.merged_into_category_id) {
        const c = state.categories.find(x => x.id === r.merged_into_category_id);
        if (c) row.appendChild(el('div', 'muted small', 'Tag with: ' + c.name));
      }
      if (r.review_note) {
        row.appendChild(el('div', 'muted small', '“' + r.review_note + '”'));
      }
      card.appendChild(row);
    });

    return card;
  }

  /* == Upload view == */
  function renderUpload() {
    const v = $('#view-upload');
    v.innerHTML = '';

    const head = el('div', 'card');
    head.appendChild(el('h2', null, 'Upload flash'));
    const p = el('p', 'muted');
    p.textContent = 'Pick as many files as you like. Tagging is optional — you ' +
      'can tag them all at once below, or upload now and tag later. Every ' +
      'upload is a flash sheet: any shape, at least 1080 pixels on the long ' +
      'side. Big files are resized to fit the wall — never cropped, and your ' +
      'original is kept.';
    head.appendChild(p);

    const pick = el('label', 'dropzone');
    pick.innerHTML = '<strong>Choose images</strong><span>or drag them here</span>';
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.multiple = true;
    input.hidden = true;
    input.onchange = () => stage([...input.files]);
    pick.appendChild(input);
    head.appendChild(pick);

    ;['dragover', 'dragenter'].forEach(ev =>
      pick.addEventListener(ev, e => { e.preventDefault(); pick.classList.add('is-over'); }));
    ;['dragleave', 'drop'].forEach(ev =>
      pick.addEventListener(ev, e => { e.preventDefault(); pick.classList.remove('is-over'); }));
    pick.addEventListener('drop', e => {
      if (e.dataTransfer && e.dataTransfer.files) stage([...e.dataTransfer.files]);
    });

    v.appendChild(head);

    const list = el('div', 'queue');
    list.id = 'queue';
    v.appendChild(list);

    // The affordance lives on the tagging screen, which is where an artist
    // discovers the vocabulary is missing something.
    v.appendChild(requestPanel());

    renderQueue();
  }

  async function stage(files) {
    for (const file of files) {
      let info;
      try { info = await readImage(file); }
      catch (e) { toast(`${file.name}: ${e.message}`, 'error'); continue; }

      const w = info.img.naturalWidth, h = info.img.naturalHeight;
      const type = classify(w, h);

      state.queue.push({
        id: Math.random().toString(36).slice(2),
        file, url: info.url, img: info.img,
        w, h, type,
        error: type ? null : specError(w, h),
        title: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim(),
        artistId: state.isAdmin ? (state.me ? state.me.id : '') : state.me.id,
        categories: [],
        publish: false,
        status: 'ready',
      });
    }
    renderQueue();
  }

  function renderQueue() {
    const list = $('#queue');
    if (!list) return;
    list.innerHTML = '';

    if (!state.queue.length) return;

    const bulk = el('div', 'card bulk');
    bulk.appendChild(el('h3', null, `${state.queue.length} file${state.queue.length === 1 ? '' : 's'} staged`));

    // Batch tagging — the PRD's actual complaint is that artists add work in
    // batches, so tagging one at a time is the thing to avoid.
    bulk.appendChild(el('div', 'muted small',
      'Tap a category to apply it to every staged file:'));
    bulk.appendChild(chipGroups([], c => {
      state.queue.forEach(item => {
        if (item.categories.indexOf(c.id) === -1) item.categories.push(c.id);
      });
      renderQueue();
      toast(`Tagged all ${state.queue.length} with ${c.name}`);
    }));

    const actions = el('div', 'row');
    const draftBtn = el('button', 'btn btn-quiet', 'Save all as drafts');
    draftBtn.onclick = () => uploadAll(false);
    const pubBtn = el('button', 'btn btn-primary', 'Publish all');
    pubBtn.onclick = () => uploadAll(true);
    const clearBtn = el('button', 'btn btn-quiet', 'Clear');
    clearBtn.onclick = () => { state.queue.forEach(q => URL.revokeObjectURL(q.url)); state.queue = []; renderQueue(); };
    actions.append(draftBtn, pubBtn, clearBtn);
    bulk.appendChild(actions);
    list.appendChild(bulk);

    state.queue.forEach(item => list.appendChild(queueCard(item)));
  }

  function queueCard(item) {
    const card = el('div', 'card item' + (item.error ? ' is-bad' : ''));

    const thumb = el('img', 'item-thumb');
    thumb.src = item.url;
    card.appendChild(thumb);

    const body = el('div', 'item-body');

    if (item.error) {
      body.appendChild(el('div', 'error', item.error));
    } else {
      const badge = el('span', 'pill', item.type === 'sheet' ? 'Flash sheet' : 'Single design');
      body.appendChild(badge);
      body.appendChild(el('span', 'muted small', ` ${item.w}×${item.h}`));
    }

    const title = el('input', 'input');
    title.value = item.title;
    title.placeholder = 'Title (optional)';
    title.oninput = () => { item.title = title.value; };
    body.appendChild(title);

    if (state.isAdmin) {
      const sel = el('select', 'input');
      state.artists.forEach(a => {
        const o = el('option', null, a.name + ' ' + (a.handle || ''));
        o.value = a.id;
        if (a.id === item.artistId) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => { item.artistId = sel.value; };
      body.appendChild(sel);
    }

    body.appendChild(chipGroups(item.categories, (c, on) => {
      const i = item.categories.indexOf(c.id);
      if (i === -1) item.categories.push(c.id); else item.categories.splice(i, 1);
      renderQueue();
    }));

    if (item.status !== 'ready') {
      body.appendChild(el('div', 'muted small', item.status));
    }

    const rm = el('button', 'btn btn-quiet', 'Remove');
    rm.onclick = () => {
      URL.revokeObjectURL(item.url);
      state.queue = state.queue.filter(q => q.id !== item.id);
      renderQueue();
    };
    body.appendChild(rm);

    card.appendChild(body);
    return card;
  }

  /* Publish or draft, tagged or not. There is deliberately no check here for
   * files without a category: an untagged design is allowed to be published,
   * it just matches no category filter on the kiosk until somebody tags it.
   * Refusing the whole batch over it is what was stopping artists uploading. */
  async function uploadAll(publish) {
    const usable = state.queue.filter(i => !i.error);
    if (!usable.length) { toast('Nothing uploadable staged.', 'error'); return; }

    let ok = 0;
    for (const item of usable) {
      try {
        item.status = 'uploading…'; renderQueue();
        await uploadOne(item, publish);
        item.status = 'done'; ok++;
      } catch (e) {
        item.status = 'failed';
        fail(item.file.name, e);
      }
      renderQueue();
    }

    if (ok) {
      toast(`${ok} uploaded${publish ? ' and published' : ' as drafts'}.`);
      state.queue = state.queue.filter(i => i.status !== 'done');
      renderQueue();
      await loadDesigns();
    }
  }

  async function uploadOne(item, publish) {
    const artistId = item.artistId || (state.me && state.me.id);
    if (!artistId) throw new Error('No artist selected');

    const stamp = Date.now().toString(36);
    const base = `${artistId}/${stamp}-${item.id}`;
    const ext = (item.file.type === 'image/png') ? 'png'
              : (item.file.type === 'image/webp') ? 'webp' : 'jpg';

    // Original first — if this fails there is nothing to clean up.
    const originalPath = `${base}/original.${ext}`;
    await put(originalPath, item.file, item.file.type);

    const urls = { image_url: publicUrl(originalPath) };

    /* Off-spec sizes: the kiosk shows a resized copy; the original upload
     * stays alongside it, untouched. Exact-spec files are shown as uploaded. */
    const spec = cfg.spec[item.type];
    if (item.w !== spec.w || item.h !== spec.h) {
      const fit = await fitInside(item.img, spec.w, item.type === 'sheet' ? cfg.spec.sheet.h : spec.h);
      if (!fit.blob) throw new Error('This browser could not resize the image. Try Safari or Chrome.');
      const kioskPath = `${base}/kiosk.webp`;
      await put(kioskPath, fit.blob, 'image/webp');
      urls.image_url = publicUrl(kioskPath);
      item.w = fit.w; item.h = fit.h;
    }

    for (const spec of cfg.derivatives) {
      const blob = await derive(item.img, spec);
      if (!blob) continue;
      const p = `${base}/${spec.name}.webp`;
      await put(p, blob, 'image/webp');
      if (spec.name === 'thumb') urls.thumb_url = publicUrl(p);
    }

    // ONE write, in the state it is meant to end up in. This used to insert
    // unpublished, attach categories, and then publish in a third statement —
    // a dance that existed only to get past a trigger that refused to publish
    // an untagged design. That trigger is gone, so the row is simply inserted
    // published or not, and the categories (if any) follow.
    const { data: row, error } = await sb.from('designs').insert({
      artist_id: artistId,
      title: item.title || null,
      type: item.type,
      image_url: urls.image_url,
      thumb_url: urls.thumb_url || null,
      width: item.w,
      height: item.h,
      published: publish,
      approved: !cfg.requireApproval,
      display_order: 0,
    }).select().single();
    if (error) throw error;

    if (item.categories.length) {
      const rows = item.categories.map(cid => ({ design_id: row.id, category_id: cid }));
      const { error: ce } = await sb.from('design_categories').insert(rows);
      if (ce) throw ce;
    }
  }

  async function put(path, body, contentType) {
    const { error } = await sb.storage.from(cfg.storageBucket)
      .upload(path, body, { contentType, upsert: false });
    if (error) throw error;
  }

  function publicUrl(path) {
    return sb.storage.from(cfg.storageBucket).getPublicUrl(path).data.publicUrl;
  }

  /* == Designs view == */
  function renderDesigns() {
    const v = $('#view-designs');
    v.innerHTML = '';

    const head = el('div', 'card');
    head.appendChild(el('h2', null, state.isAdmin ? 'All designs' : 'My designs'));
    if (!state.designs.length) {
      head.appendChild(el('p', 'muted', 'Nothing uploaded yet.'));
    }
    v.appendChild(head);

    const grid = el('div', 'dgrid');
    state.designs.forEach(d => grid.appendChild(designCard(d)));
    v.appendChild(grid);
  }

  function designCard(d) {
    const card = el('div', 'card design');

    const img = el('img', 'design-thumb');
    img.src = d.thumb_url || d.image_url;
    img.loading = 'lazy';
    card.appendChild(img);

    const body = el('div');
    body.appendChild(el('div', 'design-title', d.title || 'Untitled'));

    const meta = el('div', 'muted small');
    const artist = state.artists.find(a => a.id === d.artist_id);
    meta.textContent = [
      artist ? artist.name : 'Unassigned',
      d.type === 'sheet' ? 'Sheet' : 'Single',
      d.width && d.height ? `${d.width}×${d.height}` : null,
    ].filter(Boolean).join(' · ');
    body.appendChild(meta);

    const status = el('div', 'row status');
    status.appendChild(el('span', 'pill ' + (d.published ? 'ok' : 'draft'),
      d.published ? 'Published' : 'Draft'));
    if (!d.approved) status.appendChild(el('span', 'pill warn', 'Awaiting approval'));
    if (d.featured) status.appendChild(el('span', 'pill', 'Featured'));
    body.appendChild(status);

    // Categories. Adding and removing are both always allowed — including
    // taking the last one off a published design. The kiosk keeps showing it
    // under See All; it just stops matching a category filter.
    const mine = (d.design_categories || []).map(x => x.category_id);
    body.appendChild(chipGroups(mine, async (c, on) => {
      if (on) {
        const { error } = await sb.from('design_categories').delete()
          .eq('design_id', d.id).eq('category_id', c.id);
        if (error) return fail('Removing category', error);
      } else {
        const { error } = await sb.from('design_categories')
          .insert({ design_id: d.id, category_id: c.id });
        if (error) return fail('Adding category', error);
      }
      await loadDesigns(); renderDesigns();
    }));

    const row = el('div', 'row');

    const pub = el('button', 'btn btn-quiet', d.published ? 'Unpublish' : 'Publish');
    pub.onclick = async () => {
      const { error } = await sb.from('designs')
        .update({ published: !d.published }).eq('id', d.id);
      if (error) return fail(d.published ? 'Unpublishing' : 'Publishing', error);
      await loadDesigns(); renderDesigns();
    };
    row.appendChild(pub);

    const feat = el('button', 'btn btn-quiet', d.featured ? 'Unfeature' : 'Feature');
    feat.onclick = async () => {
      const { error } = await sb.from('designs')
        .update({ featured: !d.featured }).eq('id', d.id);
      if (error) return fail('Featuring', error);
      await loadDesigns(); renderDesigns();
    };
    row.appendChild(feat);

    const ord = el('input', 'input ord');
    ord.type = 'number';
    ord.value = d.display_order;
    ord.title = 'Display order — lower shows first';
    ord.onchange = async () => {
      const { error } = await sb.from('designs')
        .update({ display_order: parseInt(ord.value, 10) || 0 }).eq('id', d.id);
      if (error) return fail('Reordering', error);
      await loadDesigns(); renderDesigns();
    };
    row.appendChild(ord);

    const del = el('button', 'btn btn-danger', 'Delete');
    del.onclick = async () => {
      if (!confirm(`Delete "${d.title || 'Untitled'}" permanently? This cannot be undone.`)) return;
      const { error } = await sb.from('designs').delete().eq('id', d.id);
      if (error) return fail('Deleting', error);
      toast('Deleted.');
      await loadDesigns(); renderDesigns();
    };
    row.appendChild(del);

    body.appendChild(row);
    card.appendChild(body);
    return card;
  }

  /* == Artists view (admin) — see artists-tab.js == */
  function renderArtists() {
    window.ArtistsTab.render($('#view-artists'));
  }

  /* == Categories view (admin) == */
  function renderCategories() {
    const v = $('#view-categories');
    v.innerHTML = '';

    const add = el('div', 'card');
    add.appendChild(el('h2', null, 'Categories'));
    add.appendChild(el('p', 'muted',
      'A managed list, not free text. Postgres holds a canonical key for each ' +
      'name — lowercased with every space, hyphen and underscore stripped — ' +
      'behind a unique index, so “Water Sports”, “water-sports” and ' +
      '“watersports” cannot all exist. Adding a near-duplicate here is ' +
      'refused by the database, not just by this form.'));
    const nm = el('input', 'input'); nm.placeholder = 'New category name';

    const kindSel = el('select', 'input');
    KINDS.forEach(([value, label]) => {
      const o = el('option', null, label);
      o.value = value;
      kindSel.appendChild(o);
    });

    const b = el('button', 'btn btn-primary', 'Add');
    b.onclick = async () => {
      const name = nm.value.trim();
      if (!name) return;
      const { error } = await sb.from('categories').insert({
        name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        kind: kindSel.value,
        display_order: state.categories.length,
      });
      if (error) return fail('Adding category', error);
      nm.value = '';
      await loadCategories(); renderCategories();
    };
    add.append(nm, kindSel, b);
    v.appendChild(add);

    state.categories.forEach(c => {
      const card = el('div', 'card row');
      const i = el('input', 'input');
      i.value = c.name;
      i.onchange = async () => {
        const { error } = await sb.from('categories')
          .update({ name: i.value.trim() }).eq('id', c.id);
        if (error) return fail('Renaming', error);
        await loadCategories(); renderCategories(); toast('Renamed.');
      };
      card.appendChild(i);

      const k = el('select', 'input');
      KINDS.forEach(([value, label]) => {
        const o = el('option', null, label);
        o.value = value;
        if ((c.kind || 'style') === value) o.selected = true;
        k.appendChild(o);
      });
      k.onchange = async () => {
        const { error } = await sb.from('categories')
          .update({ kind: k.value }).eq('id', c.id);
        if (error) return fail('Changing kind', error);
        await loadCategories(); renderCategories(); toast('Updated.');
      };
      card.appendChild(k);

      const mergeSel = el('select', 'input');
      mergeSel.appendChild(el('option', null, 'Merge into…'));
      state.categories.filter(o => o.id !== c.id).forEach(o => {
        const opt = el('option', null, o.name); opt.value = o.id;
        mergeSel.appendChild(opt);
      });
      mergeSel.onchange = async () => {
        const target = mergeSel.value;
        if (!target) return;
        if (!confirm(`Move every design tagged "${c.name}" to "${
          (state.categories.find(x => x.id === target) || {}).name}" and delete "${c.name}"?`)) {
          mergeSel.selectedIndex = 0; return;
        }
        // Re-tag, then drop. Duplicates are possible where a design already
        // carried both, so ignore conflicts rather than failing the merge.
        const { data: links } = await sb.from('design_categories')
          .select('design_id').eq('category_id', c.id);
        for (const l of (links || [])) {
          await sb.from('design_categories')
            .insert({ design_id: l.design_id, category_id: target });
        }
        const { error } = await sb.from('categories').delete().eq('id', c.id);
        if (error) return fail('Merging', error);
        await Promise.all([loadCategories(), loadDesigns()]);
        renderCategories();
        toast('Merged.');
      };
      card.appendChild(mergeSel);

      const del = el('button', 'btn btn-danger', 'Delete');
      del.onclick = async () => {
        if (!confirm(`Delete "${c.name}"? Designs keep existing but lose this category.`)) return;
        const { error } = await sb.from('categories').delete().eq('id', c.id);
        if (error) return fail('Deleting', error);
        await Promise.all([loadCategories(), loadDesigns()]);
        renderCategories();
      };
      card.appendChild(del);

      v.appendChild(card);
    });
  }

  /* == Review view (admin) == */
  function renderReview() {
    const v = $('#view-review');
    v.innerHTML = '';

    const head = el('div', 'card');
    head.appendChild(el('h2', null, 'Approval'));
    const p = el('p', 'muted');
    p.textContent = cfg.requireApproval
      ? 'Approval is REQUIRED: a design stays off the kiosk until approved here, ' +
        'even if the artist has published it.'
      : 'Approval is currently NOT required — artists publish straight to the ' +
        'kiosk. The state is still tracked, so switching this on later gates ' +
        'the kiosk immediately without any migration.';
    head.appendChild(p);
    v.appendChild(head);

    const pending = state.designs.filter(d => !d.approved);
    if (!pending.length) {
      v.appendChild(el('div', 'card muted', 'Nothing awaiting approval.'));
      return;
    }

    pending.forEach(d => {
      const c = el('div', 'card design');
      const img = el('img', 'design-thumb');
      img.src = d.thumb_url || d.image_url; img.loading = 'lazy';
      c.appendChild(img);
      const body = el('div');
      body.appendChild(el('div', 'design-title', d.title || 'Untitled'));
      const a = state.artists.find(x => x.id === d.artist_id);
      body.appendChild(el('div', 'muted small', a ? a.name : 'Unassigned'));
      const ok = el('button', 'btn btn-primary', 'Approve');
      ok.onclick = async () => {
        const { error } = await sb.from('designs').update({ approved: true }).eq('id', d.id);
        if (error) return fail('Approving', error);
        await loadDesigns(); renderReview();
      };
      body.appendChild(ok);
      c.appendChild(body);
      v.appendChild(c);
    });
  }

  /* == Routing == */
  const RENDER = {
    upload: renderUpload,
    designs: renderDesigns,
    requests: renderRequests,
    artists: renderArtists,
    categories: renderCategories,
    review: renderReview,
  };

  // `requests` is deliberately absent from this list: every artist gets it.
  const ADMIN_VIEWS = ['artists', 'categories', 'review'];

  function show(view) {
    if (ADMIN_VIEWS.indexOf(view) !== -1 && !state.isAdmin) {
      view = 'upload';
    }
    state.view = view;
    $$('.pane').forEach(p => { p.hidden = true; });
    $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === view));
    const pane = $('#view-' + view);
    if (!pane) return;
    pane.hidden = false;
    RENDER[view]();
  }

  /* == Boot == */
  $('#sendLink').onclick = sendMagicLink;
  $('#email').addEventListener('keydown', e => { if (e.key === 'Enter') sendMagicLink(); });
  $('#signOut').onclick = signOut;
  $$('.tab').forEach(t => { t.onclick = () => show(t.dataset.view); });

  sb.auth.onAuthStateChange((_evt, session) => {
    const wasSignedIn = !!state.user;
    state.user = session ? session.user : null;
    if (state.user && !wasSignedIn) onSignedIn();
    if (!state.user && wasSignedIn) location.reload();
  });

  sb.auth.getSession().then(({ data }) => {
    if (data && data.session) {
      state.user = data.session.user;
      onSignedIn();
    } else {
      $('#signin').hidden = false;
    }
  });
})();
