/* Artists tab — roster and onboarding.
 *
 * Split out of app.js because it is now the most involved surface in the
 * dashboard and it is the one Kat actually lives in.
 *
 * THE DESIGN CONSTRAINT, stated plainly: Kat is running a shop. Onboarding an
 * artist has to be type-the-email-and-tap-once. So "save the profile" and
 * "send that artist their sign-in link" are not two features here, they are
 * one button. The link is only sent when the email is genuinely new or
 * changed — Supabase's built-in sender caps at 2 per hour, and a re-send on
 * every incidental save would burn that quota and lock her out halfway
 * through the roster.
 *
 * SECURITY: everything below is an ordinary authenticated request. RLS
 * (`artists_admin_all`) is what actually decides whether Kat may edit someone
 * else's row, and the `artists_guard` trigger is what stops a non-admin
 * escalating their own `role` even if they craft the request by hand. This
 * file only decides what to render.
 *
 * PHOTOS ARE THE ONE THING AN ADMIN CANNOT TOUCH. A headshot belongs to the
 * person in it, so `portrait_url` and `portrait_thumb_url` are pinned by the
 * guard trigger unless the row's `auth_user_id` is the caller — and that
 * check runs before the trigger's is_admin() early-out, so being an admin is
 * not a way past it. The `avatars` bucket policies match. There is therefore
 * no photo control on these cards: not hidden, not disabled, absent, because
 * the request behind it would be refused.
 *
 * signInWithOtp() works with the publishable key and needs no service role,
 * which is why onboarding can live in a static page at all.
 */
window.ArtistsTab = (function () {
  'use strict';

  /* Injected by app.js so this file has no opinion about the client, the
   * toast implementation or how the roster is reloaded. */
  let sb, state, el, toast, fail, reload;

  function init(deps) {
    sb = deps.sb; state = deps.state; el = deps.el;
    toast = deps.toast; fail = deps.fail; reload = deps.reload;
  }

  /* Two addresses are "the same" if they differ only by case or padding.
   * Getting this wrong means a stray capital letter re-sends a link and
   * spends one of the two per hour. */
  function sameEmail(a, b) {
    return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
  }

  function handleToUrl(h) {
    const clean = (h || '').trim().replace(/^@/, '');
    return clean ? 'https://instagram.com/' + clean : null;
  }

  /* Where the magic link lands. Deriving it from the current page rather than
   * hardcoding it means a preview deployment invites people back to that same
   * preview instead of bouncing them to production. */
  function redirectTo() {
    return window.location.origin + window.location.pathname;
  }

  /**
   * Send an artist their sign-in link.
   * Returns { sent: true } or { sent: false, message } — never throws, because
   * the caller has usually already saved the profile and must not report that
   * save as failed.
   */
  async function sendInvite(email) {
    const { error } = await sb.auth.signInWithOtp({
      email: email,
      // shouldCreateUser defaults to true, which is what we want: a brand new
      // artist has no auth user yet, and claim_artist_row() attaches their
      // card to it the moment they sign in.
      options: { emailRedirectTo: redirectTo() },
    });
    if (error) return { sent: false, message: error.message };
    return { sent: true };
  }

  function statusPill(a) {
    if (a.auth_user_id) return el('span', 'pill ok', 'Signed in');
    if (a.email) return el('span', 'pill warn', 'Invited, not signed in yet');
    return el('span', 'pill', 'No email yet');
  }

  /* Their face, shown and nothing more. Deliberately not a button: an admin
   * cannot change another artist's photo, so a tappable circle here would be
   * an offer the database refuses. Falls back to the generated monogram,
   * which is most of the roster until people sign in and pick one. */
  function avatarFor(a) {
    return window.AvatarKit.node(a, 'md');
  }

  /* == Add an artist ====================================================== */
  function addCard() {
    const card = el('div', 'card');
    card.appendChild(el('h2', null, 'Artists'));
    card.appendChild(el('p', 'muted',
      'Add someone, or open a card below and edit it. Putting an email on a ' +
      'card and tapping Update changes both saves the card and sends that ' +
      'artist their sign-in link — there is no separate invite step.'));

    // Honest about delivery. The action succeeding is not the same as the
    // email arriving, and saying otherwise would send Kat chasing artists who
    // never got anything.
    const caveat = el('p', 'muted small');
    caveat.textContent = 'Heads up: until custom SMTP is switched on, ' +
      'Supabase’s built-in sender only delivers to addresses on Joshua’s ' +
      'own Supabase account, and only 2 an hour. The link is genuinely ' +
      'requested either way — it just may not land yet.';
    card.appendChild(caveat);

    const name = el('input', 'input'); name.placeholder = 'Name';
    const handle = el('input', 'input'); handle.placeholder = '@handle';
    const email = el('input', 'input'); email.placeholder = 'email (optional)';
    email.type = 'email'; email.autocapitalize = 'off'; email.spellcheck = false;

    const btn = el('button', 'btn btn-primary', 'Add artist');
    btn.onclick = async () => {
      if (!name.value.trim()) return toast('Name required', 'error');
      btn.disabled = true;

      const addr = email.value.trim();
      const { error } = await sb.from('artists').insert({
        name: name.value.trim(),
        handle: handle.value.trim() || null,
        instagram_url: handleToUrl(handle.value),
        email: addr || null,
        display_order: state.artists.length,
      });

      if (error) { btn.disabled = false; return fail('Adding artist', error); }

      // Saved. Now the invite — reported separately, because it can fail on
      // its own and the artist card still exists either way.
      if (addr) {
        const r = await sendInvite(addr);
        toast(r.sent
          ? 'Added ' + name.value.trim() + '. Sign-in link sent to ' + addr + '.'
          : 'Added ' + name.value.trim() + ', but the sign-in link did NOT go ' +
            'out: ' + r.message + ' The card is saved — use Resend link once ' +
            'that clears.',
          r.sent ? null : 'error');
      } else {
        toast('Added ' + name.value.trim() + '. No email yet, so no link sent.');
      }

      name.value = handle.value = email.value = '';
      btn.disabled = false;
      await reload();
    };

    card.append(name, handle, email, btn);
    return card;
  }

  /* == Edit an artist ===================================================== */
  function artistCard(a) {
    const card = el('div', 'card');

    const head = el('div', 'row');
    head.appendChild(avatarFor(a));
    head.appendChild(el('h3', null, a.name));
    head.appendChild(statusPill(a));
    card.appendChild(head);

    card.appendChild(el('div', 'muted small',
      a.portrait_url
        ? 'Their photo. Only they can change it.'
        : 'No photo yet — their initials show on the kiosk until they sign in ' +
          'and add one themselves.'));

    const fields = {};
    function field(label, key, opts) {
      const wrap = el('label', 'field');
      wrap.appendChild(el('span', 'muted small', label));
      const i = el('input', 'input');
      i.value = a[key] || '';
      if (opts && opts.type) i.type = opts.type;
      if (opts && opts.placeholder) i.placeholder = opts.placeholder;
      if (opts && opts.plain) { i.autocapitalize = 'off'; i.spellcheck = false; }
      wrap.appendChild(i);
      fields[key] = i;
      card.appendChild(wrap);
      return i;
    }

    field('Name', 'name');
    // Handle and Instagram URL are kept in step; the kiosk QR reads the URL
    // and a mismatch would send customers to the wrong profile.
    field('Instagram handle', 'handle', { plain: true, placeholder: '@handle' });
    field('Email (this is also their sign-in)', 'email',
          { type: 'email', plain: true, placeholder: 'name@example.com' });
    field('Phone', 'phone', { type: 'tel', placeholder: 'optional' });
    field('Bio', 'bio');

    const note = el('div', 'muted small');
    note.textContent = a.email
      ? 'Changing the email sends a fresh sign-in link to the new address.'
      : 'Adding an email sends them a sign-in link when you tap Update changes.';
    card.appendChild(note);

    /* One action. She should not have to hunt for it or wonder which of
     * several buttons is the one that saves. */
    const save = el('button', 'btn btn-primary', 'Update changes');
    save.onclick = async () => {
      save.disabled = true;
      save.textContent = 'Saving…';

      const nextEmail = fields.email.value.trim();
      const emailIsNew = !!nextEmail && !sameEmail(nextEmail, a.email);

      const patch = {
        name: fields.name.value.trim() || a.name,   // never blank out the name
        handle: fields.handle.value.trim() || null,
        instagram_url: handleToUrl(fields.handle.value),
        email: nextEmail || null,
        phone: fields.phone.value.trim() || null,
        bio: fields.bio.value.trim() || null,
      };

      const { error } = await sb.from('artists').update(patch).eq('id', a.id);

      if (error) {
        // Nothing saved, so nothing is invited. Do not send a link into a
        // failed save — that is how someone gets an invite to a card that
        // does not carry their address.
        save.disabled = false;
        save.textContent = 'Update changes';
        return fail('Saving ' + a.name, error);
      }

      if (!emailIsNew) {
        // Guard against accidental re-sends. Two magic links an hour is the
        // whole budget; spending one on a bio edit is how she gets locked out.
        toast(nextEmail
          ? 'Saved. Email unchanged, so no new sign-in link was sent.'
          : 'Saved.');
      } else {
        const r = await sendInvite(nextEmail);
        if (r.sent) {
          toast('Saved. Sign-in link sent to ' + nextEmail + '.');
        } else {
          // Both halves, told apart. Implying the artist was invited when the
          // send failed is the failure that costs her a phone call.
          toast('Profile SAVED, but the sign-in link did NOT go out: ' +
                r.message + ' The email is stored — tap Resend link to try again.',
                'error');
        }
      }

      save.disabled = false;
      save.textContent = 'Update changes';
      await reload();
    };
    card.appendChild(save);

    const row = el('div', 'row');

    /* Deliberate re-send, for the case where a link expired or never arrived.
     * Separate from the automatic one because this is her choosing to spend
     * one of the two per hour, not something that happens behind her. */
    if (a.email) {
      const again = el('button', 'btn btn-quiet', 'Resend link');
      again.onclick = async () => {
        again.disabled = true;
        const r = await sendInvite(a.email);
        toast(r.sent ? 'Sign-in link sent to ' + a.email + '.'
                     : 'Could not send: ' + r.message, r.sent ? null : 'error');
        again.disabled = false;
      };
      row.appendChild(again);
    }

    /* Clearing someone's tutorial so they get the walkthrough again. Kat asks
     * for this the moment an artist says "I don't know where anything is" —
     * it is stored on the row rather than in the browser precisely so she
     * can do it from her own phone. */
    const retour = el('button', 'btn btn-quiet',
      a.tutorial_seen_at ? 'Replay their tutorial' : 'Tutorial not done yet');
    retour.disabled = !a.tutorial_seen_at;
    retour.onclick = async () => {
      const { error } = await sb.from('artists')
        .update({ tutorial_seen_at: null }).eq('id', a.id);
      if (error) return fail('Resetting the tutorial', error);
      toast(a.name + ' gets the walkthrough again next time they sign in.');
      await reload();
    };
    row.appendChild(retour);

    const roleSel = el('select', 'input');
    ['artist', 'admin'].forEach(r => {
      const o = el('option', null, r === 'admin' ? 'Admin' : 'Artist');
      o.value = r; if (a.role === r) o.selected = true;
      roleSel.appendChild(o);
    });
    roleSel.onchange = async () => {
      const { error } = await sb.from('artists')
        .update({ role: roleSel.value }).eq('id', a.id);
      if (error) return fail('Changing role', error);
      toast('Role updated.');
      await reload();
    };
    row.append(el('span', 'muted small', 'Role'), roleSel);

    const act = el('button', 'btn btn-quiet', a.active ? 'Hide from kiosk' : 'Show on kiosk');
    act.onclick = async () => {
      const { error } = await sb.from('artists').update({ active: !a.active }).eq('id', a.id);
      if (error) return fail('Updating visibility', error);
      await reload();
    };
    row.appendChild(act);

    card.appendChild(row);
    return card;
  }

  function render(container) {
    container.innerHTML = '';
    container.appendChild(addCard());
    state.artists.forEach(a => container.appendChild(artistCard(a)));
  }

  return { init, render, _sameEmail: sameEmail, _handleToUrl: handleToUrl };
})();
