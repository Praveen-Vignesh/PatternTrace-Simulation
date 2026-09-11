// Sensitivity model on the Valorant scale: at in-game sens 1.0 the camera turns
// 0.07 degrees per mouse count. Pure math — no DOM, no Three.
export const VALORANT_DEG_PER_COUNT = 0.07;

// The radians-per-unit factor PointerLockControls applies to movementX/Y before
// its own pointerSpeed multiplier. Dividing by it converts our radians-per-count
// into the multiplier the control expects, leaving the input path one-to-one.
export const CONTROLS_RADIANS_PER_UNIT = 0.002;

const CM_PER_INCH = 2.54;

// countScale is counts per unit of reported movementX/Y. It is 1 on a standard
// display; it exists because the browser reports CSS pixels, which need not
// equal physical mouse counts on a scaled or HiDPI display.
export function createSensitivity({ dpi, sens, countScale = 1 }) {
  const degPerCount = sens * VALORANT_DEG_PER_COUNT;
  const radPerCount = (degPerCount * Math.PI) / 180;
  const radiansPerMovementUnit = radPerCount * countScale;

  return {
    dpi,
    sens,
    eDPI: dpi * sens,
    degPerCount,
    radPerCount,

    // Physical distance to turn a full circle. Independent of countScale — this
    // is the number to check against a real measurement on the mousepad.
    cm360: (360 * CM_PER_INCH) / (degPerCount * dpi),

    // What controls.js assigns to PointerLockControls.pointerSpeed.
    pointerSpeed: radiansPerMovementUnit / CONTROLS_RADIANS_PER_UNIT,

    // Radians of camera rotation per unit of reported movement. The DPI-aware
    // ground truth the rest of the app derives pointer speed from.
    radiansPerMovementUnit
  };
}
