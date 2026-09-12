// Formats a duration as m:ss. Exported because the results and pause screens
// show the same clock and one implementation is enough.
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function createHud() {
  const scoreEl = document.getElementById('hud-score');
  const attemptsEl = document.getElementById('hud-attempts');
  const accuracyEl = document.getElementById('hud-accuracy');
  const avgTimeEl = document.getElementById('hud-avg-time');
  const timeLeftEl = document.getElementById('hud-time-left');
  const modeEl = document.getElementById('hud-mode');

  // The last whole second written, so setTimeLeft() can skip the DOM when
  // nothing visible changed. -1 never equals a real value, so the first write
  // of a run always lands.
  let lastSeconds = -1;

  return {
    // Names the running routine and difficulty, so two single-target
    // routines are never mistaken for each other. Called once per run, which is
    // also when the cached countdown has to be invalidated — without that, a
    // second run of the same length would skip its first write and start blank.
    setMode(label) {
      modeEl.textContent = label;
      lastSeconds = -1;
    },

    // Called every frame. The DOM is touched only when the displayed second
    // changes: a per-frame textContent write is exactly the layout thrash that
    // would show up in the timing features measured off the render loop.
    setTimeLeft(seconds) {
      const clamped = Math.max(0, Math.floor(seconds));
      if (clamped === lastSeconds) return;

      lastSeconds = clamped;
      timeLeftEl.textContent = formatClock(clamped * 1000);
    },

    // Called once per attempt, and once with zeroes when a session starts.
    // clicks counts only attempts that ended in a shot: a target that
    // expired belongs in accuracy but would distort the average time.
    update({ hits, attempts, clicks, totalTimeMs }) {
      const timed = clicks ?? attempts;

      scoreEl.textContent = hits;
      attemptsEl.textContent = attempts;
      accuracyEl.textContent =
        attempts === 0 ? '0%' : `${Math.round((hits / attempts) * 100)}%`;
      avgTimeEl.textContent = timed === 0 ? '0 ms' : `${Math.round(totalTimeMs / timed)} ms`;
    }
  };
}
