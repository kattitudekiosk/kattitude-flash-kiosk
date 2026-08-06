/* The signed-in artist's own photo, in the top bar.
 *
 * Every artist needs a way to change their own headshot, and the dashboard
 * has no "profile" tab. Rather than add one (and a fifth thing to navigate),
 * the avatar IS the control: it is what you would tap anyway.
 *
 * Admins change other people's photos from the Artists tab; this is only
 * ever your own.
 */
window.MyAvatar = (function () {
  'use strict';

  let me = null;

  function paint() {
    const slot = document.getElementById('myAvatar');
    if (!slot || !me) return;
    slot.hidden = false;
    slot.innerHTML = '';
    slot.appendChild(window.AvatarKit.node(me, 'sm'));
    slot.setAttribute('aria-label', 'Change your profile photo');
    slot.title = 'Change your profile photo';
    slot.onclick = () => {
      window.AvatarKit.edit({
        artist: me,
        onSaved: patch => {
          Object.assign(me, patch);
          paint();
          // The Artists tab, if an admin has it open, is rendered from
          // app.js's own copy of the roster. Reloading is blunt but it is
          // one tap and it cannot show a stale face.
          const tab = document.querySelector('.tab[data-view="artists"]');
          if (tab && !tab.hidden) tab.click();
        },
        toast: msg => {
          const t = document.getElementById('toast');
          if (!t) return;
          t.textContent = msg;
          t.hidden = false;
          setTimeout(() => { t.hidden = true; }, 4000);
        },
      });
    };
  }

  function attach(artist) { me = artist; paint(); }

  return { attach };
})();
