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
 */
(function () {
  'use strict';

  const cfg = window.DASH_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  /* == State == */
  const state = {
    user: null,
    me: null,          // the artists row for this user
    isAdmin: false,
    artists: [],
    categories: [],
    designs: [],
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
    toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 3500);
  }

  function fail(where, error) {
    console.error(where, error);
    toast((error && error.message) ? `${where}: ${error.message}` : where, 'error');
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

    await Promise.all([loadArtists(), loadCategories()]);
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
  function classify(w, h) {
    const d = cfg.spec.design, s = cfg.spec.sheet;
    if (w === d.w && h === d.h) return 'design';
    if (w === s.w && h === s.h) return 'sheet';
    return null;
  }

  function specError(w, h) {
    const d = cfg.spec.design, s = cfg.spec.sheet;
    return `${w}×${h} is not a supported size. A ${d.label} must be exactly ` +
           `${d.w}×${d.h}, and a ${s.label} must be exactly ${s.w}×${s.h}. ` +
           `Resize or re-export at one of those sizes — we will not crop your ` +
           `artwork automatically.`;
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

  /* == Upload view == */
  function renderUpload() {
    const v = $('#view-upload');
    v.innerHTML = '';

    const head = el('div', 'card');
    head.appendChild(el('h2', null, 'Upload flash'));
    const p = el('p', 'muted');
    p.textContent = 'Pick as many files as you like — you can tag them all at ' +
      'once below. Singles must be ' + cfg.spec.design.w + '×' + cfg.spec.design.h +
      ', sheets ' + cfg.spec.sheet.w + '×' + cfg.spec.sheet.h + '.';
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
    const bulkCats = el('div', 'chips');
    state.categories.forEach(c => {
      const b = el('button', 'chip', c.name);
      b.onclick = () => {
        state.queue.forEach(item => {
          if (item.categories.indexOf(c.id) === -1) item.categories.push(c.id);
        });
        renderQueue();
        toast(`Tagged all ${state.queue.length} with ${c.name}`);
      };
      bulkCats.appendChild(b);
    });
    const bulkLabel = el('div', 'muted small', 'Tap a style to apply it to every staged file:');
    bulk.appendChild(bulkLabel);
    bulk.appendChild(bulkCats);

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

    const chips = el('div', 'chips');
    state.categories.forEach(c => {
      const on = item.categories.indexOf(c.id) !== -1;
      const b = el('button', 'chip' + (on ? ' is-on' : ''), c.name);
      b.onclick = () => {
        const i = item.categories.indexOf(c.id);
        if (i === -1) item.categories.push(c.id); else item.categories.splice(i, 1);
        renderQueue();
      };
      chips.appendChild(b);
    });
    body.appendChild(chips);

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

  async function uploadAll(publish) {
    const usable = state.queue.filter(i => !i.error);
    if (!usable.length) { toast('Nothing uploadable staged.', 'error'); return; }

    if (publish) {
      const untagged = usable.filter(i => !i.categories.length);
      if (untagged.length) {
        toast(`${untagged.length} file(s) have no style yet. A design needs at ` +
              `least one before it can be published — save as drafts, or tag them.`, 'error');
        return;
      }
    }

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
    for (const spec of cfg.derivatives) {
      const blob = await derive(item.img, spec);
      if (!blob) continue;
      const p = `${base}/${spec.name}.webp`;
      await put(p, blob, 'image/webp');
      if (spec.name === 'thumb') urls.thumb_url = publicUrl(p);
    }

    // Insert unpublished first, attach categories, THEN publish. The database
    // refuses to publish a design with no category, so doing it in this order
    // is what makes a one-shot "Publish all" work at all.
    const { data: row, error } = await sb.from('designs').insert({
      artist_id: artistId,
      title: item.title || null,
      type: item.type,
      image_url: urls.image_url,
      thumb_url: urls.thumb_url || null,
      width: item.w,
      height: item.h,
      published: false,
      approved: !cfg.requireApproval,
      display_order: 0,
    }).select().single();
    if (error) throw error;

    if (item.categories.length) {
      const rows = item.categories.map(cid => ({ design_id: row.id, category_id: cid }));
      const { error: ce } = await sb.from('design_categories').insert(rows);
      if (ce) throw ce;
    }

    if (publish) {
      const { error: pe } = await sb.from('designs')
        .update({ published: true }).eq('id', row.id);
      if (pe) throw pe;
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

    // Categories
    const chips = el('div', 'chips');
    const mine = (d.design_categories || []).map(x => x.category_id);
    state.categories.forEach(c => {
      const on = mine.indexOf(c.id) !== -1;
      const b = el('button', 'chip' + (on ? ' is-on' : ''), c.name);
      b.onclick = async () => {
        if (on) {
          if (mine.length === 1 && d.published) {
            toast('That is its only style, and it is published. Unpublish first, ' +
                  'or add another style — a published design needs at least one.', 'error');
            return;
          }
          const { error } = await sb.from('design_categories').delete()
            .eq('design_id', d.id).eq('category_id', c.id);
          if (error) return fail('Removing style', error);
        } else {
          const { error } = await sb.from('design_categories')
            .insert({ design_id: d.id, category_id: c.id });
          if (error) return fail('Adding style', error);
        }
        await loadDesigns(); renderDesigns();
      };
      chips.appendChild(b);
    });
    body.appendChild(chips);

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

  /* == Artists view (admin) == */
  function renderArtists() {
    const v = $('#view-artists');
    v.innerHTML = '';

    const add = el('div', 'card');
    add.appendChild(el('h2', null, 'Artists'));
    add.appendChild(el('p', 'muted',
      'Set an artist’s email here and their next sign-in link claims this ' +
      'card automatically. Until then they can sign in but will own nothing.'));

    const name = el('input', 'input'); name.placeholder = 'Name';
    const handle = el('input', 'input'); handle.placeholder = '@handle';
    const email = el('input', 'input'); email.placeholder = 'email (optional)';
    const btn = el('button', 'btn btn-primary', 'Add artist');
    btn.onclick = async () => {
      if (!name.value.trim()) return toast('Name required', 'error');
      const h = handle.value.trim();
      const { error } = await sb.from('artists').insert({
        name: name.value.trim(),
        handle: h || null,
        instagram_url: h ? 'https://instagram.com/' + h.replace(/^@/, '') : null,
        email: email.value.trim() || null,
        display_order: state.artists.length,
      });
      if (error) return fail('Adding artist', error);
      name.value = handle.value = email.value = '';
      await loadArtists(); renderArtists();
      toast('Artist added.');
    };
    add.append(name, handle, email, btn);
    v.appendChild(add);

    state.artists.forEach(a => {
      const c = el('div', 'card');
      c.appendChild(el('h3', null, a.name));

      const f = (label, key, transform) => {
        const wrap = el('label', 'field');
        wrap.appendChild(el('span', 'muted small', label));
        const i = el('input', 'input');
        i.value = a[key] || '';
        i.onchange = async () => {
          const patch = {};
          patch[key] = i.value.trim() || null;
          if (transform) Object.assign(patch, transform(i.value.trim()));
          const { error } = await sb.from('artists').update(patch).eq('id', a.id);
          if (error) return fail('Saving ' + label, error);
          await loadArtists(); toast('Saved.');
        };
        wrap.appendChild(i);
        return wrap;
      };

      c.appendChild(f('Name', 'name'));
      // Handle and Instagram URL are kept in step; the kiosk QR reads the URL
      // and a mismatch would send customers to the wrong profile.
      c.appendChild(f('Instagram handle', 'handle', v => ({
        instagram_url: v ? 'https://instagram.com/' + v.replace(/^@/, '') : null,
      })));
      c.appendChild(f('Email (for sign-in)', 'email'));
      c.appendChild(f('Bio', 'bio'));

      const roleRow = el('div', 'row');
      const roleSel = el('select', 'input');
      ['artist', 'admin'].forEach(r => {
        const o = el('option', null, r === 'admin' ? 'Admin' : 'Artist');
        o.value = r; if (a.role === r) o.selected = true;
        roleSel.appendChild(o);
      });
      roleSel.onchange = async () => {
        const { error } = await sb.from('artists').update({ role: roleSel.value }).eq('id', a.id);
        if (error) return fail('Changing role', error);
        await loadArtists(); toast('Role updated.');
      };
      roleRow.append(el('span', 'muted small', 'Role'), roleSel);

      const act = el('button', 'btn btn-quiet', a.active ? 'Hide from kiosk' : 'Show on kiosk');
      act.onclick = async () => {
        const { error } = await sb.from('artists').update({ active: !a.active }).eq('id', a.id);
        if (error) return fail('Updating visibility', error);
        await loadArtists(); renderArtists();
      };
      roleRow.appendChild(act);
      c.appendChild(roleRow);

      v.appendChild(c);
    });
  }

  /* == Categories view (admin) == */
  function renderCategories() {
    const v = $('#view-categories');
    v.innerHTML = '';

    const add = el('div', 'card');
    add.appendChild(el('h2', null, 'Categories'));
    add.appendChild(el('p', 'muted',
      'A managed list, not free text — this is what stops "blackwork" and ' +
      '"black work" both existing. Merge folds one into another and moves ' +
      'every design across.'));
    const nm = el('input', 'input'); nm.placeholder = 'New style name';
    const b = el('button', 'btn btn-primary', 'Add');
    b.onclick = async () => {
      const name = nm.value.trim();
      if (!name) return;
      const { error } = await sb.from('categories').insert({
        name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        display_order: state.categories.length,
      });
      if (error) return fail('Adding category', error);
      nm.value = '';
      await loadCategories(); renderCategories();
    };
    add.append(nm, b);
    v.appendChild(add);

    state.categories.forEach(c => {
      const card = el('div', 'card row');
      const i = el('input', 'input');
      i.value = c.name;
      i.onchange = async () => {
        const { error } = await sb.from('categories')
          .update({ name: i.value.trim() }).eq('id', c.id);
        if (error) return fail('Renaming', error);
        await loadCategories(); toast('Renamed.');
      };
      card.appendChild(i);

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
        if (!confirm(`Delete "${c.name}"? Designs keep existing but lose this style.`)) return;
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
    artists: renderArtists,
    categories: renderCategories,
    review: renderReview,
  };

  function show(view) {
    if ((view === 'artists' || view === 'categories' || view === 'review') && !state.isAdmin) {
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
