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

  // The hero button jumps to the form for a signed-out visitor and straight
  // into the game for someone who has already finished it. One control, one
  // name, two correct destinations.
  const cta = document.querySelectorAll('[data-cta="start"]');

  onAuthChange((state) => {
    panel.render(state);

    const ready = state.status === 'signed_in' && state.consented === true;
    for (const link of cta) link.setAttribute('href', ready ? PLAY_URL : '#join');
  });

  // supabase-js trusts the session it restores from localStorage without asking
  // the server, so a deleted or revoked account would render as signed in here
  // and then fail on /play. This is the round trip that corrects it.
  validateSession();
}
