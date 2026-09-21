// Entry point for the landing pages. Deliberately does NOT import three.js or
// game.js: `/` is the SEO target and the page most first-time visitors see, so
// it ships the Supabase client and nothing else. The game's ~190 kB of renderer
// loads on /play, where it is actually used.
import {
  onAuthChange,
  signIn,
  signUp,
  signOut,
  signInWithGoogle,
  recordConsent,
  validateSession
} from './supabase.js';
import { createAuthPanel } from './ui/auth-panel.js';

const PLAY_URL = '/play';

const root = document.getElementById('auth-panel');

if (root !== null) {
  const panel = createAuthPanel({
    root,
    auth: {
      // None of the sign-in paths stamp consent. It is collected once,
      // explicitly, from the consent block that appears after a session exists
      // — the first moment it can be written to profiles.
      onSignIn({ email, password }) {
        return signIn({ email, password });
      },
      onSignUp({ email, password }) {
        return signUp({ email, password });
      },
      onSignOut() {
        return signOut();
      },
      onGoogleSignIn() {
        return signInWithGoogle();
      },
      onConsent() {
        return recordConsent();
      }
    },
    // Fires only on the transition into signed-in-and-consented, so finishing
    // the form carries you into the game while an already-signed-in visitor can
    // still read the page.
    onReady() {
      window.location.href = PLAY_URL;
    }
  });

  const modal = document.getElementById('auth-modal');
  let ready = false;

  // "Start training" means one thing and does the right one of two: an account
  // that can already play goes straight to the game, everyone else gets the
  // form. The button never changes its name, because the promise is the same.
  function openAuth() {
    if (ready) {
      window.location.href = PLAY_URL;
      return;
    }
    if (modal.open === false) modal.showModal();
  }

  for (const trigger of document.querySelectorAll('[data-modal="open"]')) {
    trigger.addEventListener('click', openAuth);
  }

  for (const trigger of document.querySelectorAll('[data-modal="close"]')) {
    trigger.addEventListener('click', () => modal.close());
  }

  // Clicking the backdrop closes. <dialog> gives Esc and focus trapping for
  // free but treats the backdrop as part of the element, so the only way to
  // tell them apart is to check whether the click landed outside the box.
  modal.addEventListener('click', (event) => {
    if (event.target !== modal) return;
    const box = modal.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (inside === false) modal.close();
  });

  onAuthChange((state) => {
    panel.render(state);
    ready = state.status === 'signed_in' && state.consented === true;
  });

  // supabase-js trusts the session it restores from localStorage without asking
  // the server, so a deleted or revoked account would render as signed in here
  // and then fail on /play. This is the round trip that corrects it.
  validateSession();
}
