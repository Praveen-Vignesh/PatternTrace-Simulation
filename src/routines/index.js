import { createFlickRoutine } from './flick.js';
import { createGridshotRoutine } from './gridshot.js';
import { createSpidershotRoutine } from './spidershot.js';
import { createStrafingRoutine } from './strafing.js';
import { createSwitchingRoutine } from './switching.js';

// Catalogue the home screen renders. A routine is listed from the start so the
// roadmap is visible, but `available` gates the tile until the phase that
// implements it lands. Never flip that flag ahead of the implementation.
export const ROUTINES = [
  {
    id: 'flick',
    name: 'Precision Flick',
    blurb: 'One target at a time. Flick, click, repeat.',
    phase: 1,
    available: true
  },
  {
    id: 'gridshot',
    name: 'Static Flicking',
    blurb: 'Three to four static targets held on screen.',
    phase: 2,
    available: true
  },
  {
    id: 'spidershot',
    name: 'Dynamic Reflex',
    blurb: 'One target, on a timer. Hit it before it vanishes.',
    phase: 2,
    available: true
  },
  {
    id: 'strafing',
    name: 'Reactive Strafing',
    blurb: 'Track a target that changes direction without warning.',
    phase: 3,
    available: true
  },
  {
    id: 'switching',
    name: 'Target Switching',
    blurb: 'Several moving targets. Destroy one, acquire the next.',
    phase: 4,
    available: true
  }
];

const FACTORIES = {
  flick: createFlickRoutine,
  gridshot: createGridshotRoutine,
  spidershot: createSpidershotRoutine,
  strafing: createStrafingRoutine,
  switching: createSwitchingRoutine
};

export function routineById(id) {
  return ROUTINES.find((routine) => routine.id === id) ?? null;
}

export function isAvailable(id) {
  const routine = routineById(id);
  return routine !== null && routine.available && FACTORIES[id] !== undefined;
}

// Every routine exposes the same shape: a live `targets` array to raycast
// against, start/update/stop, hit and miss resolution, and aimTarget() — the
// engaged target whose position each telemetry frame records.
export function createRoutine(id, deps) {
  const factory = FACTORIES[id] ?? FACTORIES.flick;
  return factory(deps);
}
