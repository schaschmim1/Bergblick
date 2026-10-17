// Kameramodell: Lochkamera mit Basisvektoren im Ost-Nord-Oben-System.
import { D2R, R2D } from './terrain.js';

// Basis aus Blickrichtung (Azimut), Neigung und Rollwinkel in Grad
export function basisFromHPR(heading, pitch, roll = 0) {
  const h = heading * D2R, p = pitch * D2R, r = roll * D2R;
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
  const f = [sh * cp, ch * cp, sp];
  const r0 = [ch, -sh, 0];
  const u0 = [-sh * sp, -ch * sp, cp];
  const cr = Math.cos(r), sr = Math.sin(r);
  return {
    f,
    r: [r0[0] * cr + u0[0] * sr, r0[1] * cr + u0[1] * sr, r0[2] * cr + u0[2] * sr],
    u: [u0[0] * cr - r0[0] * sr, u0[1] * cr - r0[1] * sr, u0[2] * cr - r0[2] * sr],
  };
}

// Basis aus DeviceOrientation (alpha absolut, also 0 = Gerät-Oberkante nach Norden)
// screenAngle: screen.orientation.angle
export function basisFromDevice(alpha, beta, gamma, screenAngle = 0) {
  const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // R = Rz(a) * Rx(b) * Ry(g)
  const R = [
    ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg,
    sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg,
    -cb * sg, sb, cb * cg,
  ];
  const mul = (v) => [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
  const t = screenAngle * D2R;
  return {
    f: mul([0, 0, -1]),
    u: mul([Math.sin(t), Math.cos(t), 0]),
    r: mul([Math.cos(t), -Math.sin(t), 0]),
  };
}

// Dreht die Basis um die Hochachse (Kompasskorrektur)
export function rotateYaw(B, deg) {
  const c = Math.cos(-deg * D2R), s = Math.sin(-deg * D2R);
  const rot = (v) => [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
  return { f: rot(B.f), r: rot(B.r), u: rot(B.u) };
}

export function hprFromBasis(B) {
  const heading = (Math.atan2(B.f[0], B.f[1]) * R2D + 360) % 360;
  const pitch = Math.asin(Math.max(-1, Math.min(1, B.f[2]))) * R2D;
  const ref = basisFromHPR(heading, pitch, 0);
  const roll = Math.atan2(dot(B.r, ref.u), dot(B.r, ref.r)) * R2D;
  return { heading, pitch, roll };
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Brennweite in Pixeln aus horizontalem Bildwinkel
export function focalPx(width, hfovDeg) { return width / 2 / Math.tan(hfovDeg * D2R / 2); }

// Projiziert Einheitsvektor v; gibt null zurück, wenn hinter der Kamera
export function project(v, cam) {
  const Z = v[0] * cam.f[0] + v[1] * cam.f[1] + v[2] * cam.f[2];
  if (Z <= 1e-3) return null;
  const X = v[0] * cam.r[0] + v[1] * cam.r[1] + v[2] * cam.r[2];
  const Y = v[0] * cam.u[0] + v[1] * cam.u[1] + v[2] * cam.u[2];
  return [cam.cx + cam.F * X / Z, cam.cy - cam.F * Y / Z];
}

// Bildwinkel aus 35-mm-äquivalenter Brennweite (bezogen auf die Bilddiagonale)
export function hfovFrom35mm(f35, w, h) {
  const diag = 43.2666;
  const sensorW = diag * w / Math.hypot(w, h);
  return 2 * Math.atan(sensorW / (2 * f35)) * R2D;
}
