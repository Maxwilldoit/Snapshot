// Ballistic throw, wall bounce, slingshot release, and landing squash math
// adapted from PC2005-cloud/dsh-pet (MIT), dsh-pet/src/shared/physics/*.
// Copyright (c) 2026 PC2005-cloud. See THIRD_PARTY_NOTICES.md for source and license.

export interface PointerSample {
  t: number;
  x: number;
  y: number;
}

interface ThrowBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface ThrowState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

type ContactEdge = "left" | "right" | "ceiling" | "floor";

interface ThrowHit {
  edge: ContactEdge;
  speed: number;
}

interface ThrowStepResult extends ThrowState {
  bounced: boolean;
  atRest: boolean;
  hit: ThrowHit | null;
}

/** 两次左键按下间隔小于此阈值（ms）进入双击弹弓 / 双击哄睡判定。 */
export const SLINGSHOT_DOUBLE_MS = 220;

const TRAIL_KEEP_MS = 200;
const RELEASE_WINDOW_MS = 150;
const RELEASE_STALE_MS = 150;
const MIN_SPAN_MS = 20;
const SEG_MIN_DT_MS = 8;

export const DEAD_ZONE_SPEED = 500;
const MAX_THROW_SPEED = 3600;
const PEAK_WEIGHT = 0.5;
const ACCEL_REF = 8000;
const ACCEL_GAIN_MAX = 0.6;

const THROW_GRAVITY = 1400;
const RESTITUTION = 0.78;
const GROUND_FRICTION = 2.5;
const REST_NORMAL = 40;
const REST_TANGENT = 15;
const REST_NORMAL_EPS = 1;
const MAX_STEP_DT = 0.05;

const SLINGSHOT_REF_RATIO = 0.6;
const THROW_SPEED_ANCHOR = 1200;
const SUBSTEP_PX = 8;
const SUBSTEP_MAX = 64;

export const SQ_DURATION_MS = 220;
const SQ_SOFT_SPEED = 300;
const SQ_HARD_SPEED = 1500;
export const SQ_MAX_SQUASH = 0.55;

const CONTACT_NORMALS: Record<ContactEdge, { nx: number; ny: number }> = {
  left: { nx: 1, ny: 0 },
  right: { nx: -1, ny: 0 },
  ceiling: { nx: 0, ny: 1 },
  floor: { nx: 0, ny: -1 },
};

function softClampSpeed(speed: number): number {
  if (!(speed > 0) || !Number.isFinite(speed)) return 0;
  return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED));
}

export function trimPointerTrail(trail: readonly PointerSample[], now: number): PointerSample[] {
  const cutoff = now - TRAIL_KEEP_MS;
  let idx = 0;
  while (idx < trail.length && trail[idx].t < cutoff) idx += 1;
  return idx === 0 ? [...trail] : trail.slice(idx);
}

export function estimateThrowVelocity(
  trail: readonly PointerSample[],
  now: number,
): { vx: number; vy: number } | null {
  if (!trail.length) return null;
  const last = trail[trail.length - 1];
  if (now - last.t > RELEASE_STALE_MS) return null;
  const win = trail.filter((sample) => now - sample.t <= RELEASE_WINDOW_MS);
  if (win.length < 2) return null;
  const first = win[0];
  const end = win[win.length - 1];
  const spanMs = end.t - first.t;
  if (spanMs < MIN_SPAN_MS) return null;

  const baseVx = ((end.x - first.x) / spanMs) * 1000;
  const baseVy = ((end.y - first.y) / spanMs) * 1000;
  const baseSpeed = Math.hypot(baseVx, baseVy);
  if (baseSpeed < 1e-6) return null;

  const segSpeeds: Array<{ speed: number; tEnd: number }> = [];
  let px = first.x;
  let py = first.y;
  let pt = first.t;
  for (let i = 1; i < win.length; i += 1) {
    const sample = win[i];
    const dt = sample.t - pt;
    if (dt >= SEG_MIN_DT_MS) {
      segSpeeds.push({
        speed: (Math.hypot(sample.x - px, sample.y - py) / dt) * 1000,
        tEnd: sample.t,
      });
      px = sample.x;
      py = sample.y;
      pt = sample.t;
    }
  }
  const peakSpeed = segSpeeds.length
    ? Math.max(...segSpeeds.map((item) => item.speed))
    : baseSpeed;

  let accel = 0;
  if (segSpeeds.length >= 2) {
    const firstSeg = segSpeeds[0];
    const lastSeg = segSpeeds[segSpeeds.length - 1];
    accel =
      (lastSeg.speed - firstSeg.speed) /
      Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, MIN_SPAN_MS / 1000);
  }
  const rawSpeed =
    ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) *
    (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX);
  const speed = softClampSpeed(rawSpeed);
  if (speed < DEAD_ZONE_SPEED) return null;
  return {
    vx: (baseVx / baseSpeed) * speed,
    vy: (baseVy / baseSpeed) * speed,
  };
}

function slingshotRefDist(petWidth: number): number {
  return petWidth > 0 ? petWidth * SLINGSHOT_REF_RATIO : 0;
}

export function slingshotPower(pullDist: number, petWidth: number): number {
  const ref = slingshotRefDist(petWidth);
  if (!(ref > 0) || !(pullDist > 0) || !Number.isFinite(pullDist)) return 0;
  return pullDist / ref;
}

export function slingshotLaunchVelocity(
  pullX: number,
  pullY: number,
  petWidth: number,
): { vx: number; vy: number; dist: number; power: number } | null {
  const dist = Math.hypot(pullX, pullY);
  const power = slingshotPower(dist, petWidth);
  const speed = THROW_SPEED_ANCHOR * power;
  if (!(speed > 0) || !(dist > 0)) return null;
  return {
    vx: (-pullX / dist) * speed,
    vy: (-pullY / dist) * speed,
    dist,
    power,
  };
}

function resolveContact(
  vx: number,
  vy: number,
  edge: ContactEdge,
  dt: number,
): { vx: number; vy: number } {
  const { nx, ny } = CONTACT_NORMALS[edge];
  const tx = -ny;
  const ty = nx;
  const vn = vx * nx + vy * ny;
  const vt = vx * tx + vy * ty;
  const normalSpeed = Math.abs(vn) < REST_NORMAL ? 0 : Math.abs(vn) * RESTITUTION;
  const tangentSpeed = vt * Math.max(0, 1 - GROUND_FRICTION * dt);
  return {
    vx: normalSpeed * nx + tangentSpeed * tx,
    vy: normalSpeed * ny + tangentSpeed * ty,
  };
}

function isRestingOnContacts(edges: readonly ContactEdge[], vx: number, vy: number, gravityOn: boolean): boolean {
  if (!gravityOn) {
    return Math.hypot(vx, vy) < REST_TANGENT;
  }
  if (!edges.length) return false;
  return edges.every((edge) => {
    const { nx, ny } = CONTACT_NORMALS[edge];
    const normal = Math.abs(vx * nx + vy * ny);
    const tangent = Math.abs(vx * -ny + vy * nx);
    return normal < REST_NORMAL_EPS && tangent < REST_TANGENT;
  });
}

function throwSubsteps(vx: number, vy: number, dtRaw: number): number {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
  const travel = Math.hypot(vx, vy) * dt;
  if (!(travel > SUBSTEP_PX)) return 1;
  return Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX));
}

export function stepThrow(
  state: ThrowState,
  dtRaw: number,
  bounds: ThrowBounds,
  gravityOn = true,
): ThrowStepResult {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
  const substeps = throwSubsteps(state.vx, state.vy, dt);
  const subDt = dt / substeps;
  let { x, y, vx, vy } = state;
  let bounced = false;
  let strongestHit: ThrowHit | null = null;
  let lastContacts: ContactEdge[] = [];

  for (let step = 0; step < substeps; step += 1) {
    if (gravityOn) {
      vy += THROW_GRAVITY * subDt;
    } else {
      const damping = Math.max(0, 1 - GROUND_FRICTION * subDt);
      vx *= damping;
      vy *= damping;
    }
    x += vx * subDt;
    y += vy * subDt;

    const contacts: ContactEdge[] = [];
    const recordHit = (edge: ContactEdge, speed: number) => {
      contacts.push(edge);
      if (!strongestHit || speed > strongestHit.speed) {
        strongestHit = { edge, speed };
      }
    };

    if (x < bounds.minX) {
      recordHit("left", Math.abs(vx));
      x = bounds.minX;
      ({ vx, vy } = resolveContact(vx, vy, "left", subDt));
      bounced = true;
    } else if (x > bounds.maxX) {
      recordHit("right", Math.abs(vx));
      x = bounds.maxX;
      ({ vx, vy } = resolveContact(vx, vy, "right", subDt));
      bounced = true;
    }

    if (y < bounds.minY) {
      recordHit("ceiling", Math.abs(vy));
      y = bounds.minY;
      ({ vx, vy } = resolveContact(vx, vy, "ceiling", subDt));
      bounced = true;
    } else if (y >= bounds.maxY) {
      recordHit("floor", Math.abs(vy));
      y = bounds.maxY;
      ({ vx, vy } = resolveContact(vx, vy, "floor", subDt));
      bounced = true;
    }
    lastContacts = contacts;
    if (isRestingOnContacts(contacts, vx, vy, gravityOn)) {
      return { x, y, vx: 0, vy: 0, bounced, atRest: true, hit: strongestHit };
    }
  }

  return {
    x,
    y,
    vx,
    vy,
    bounced,
    atRest: isRestingOnContacts(lastContacts, vx, vy, gravityOn),
    hit: strongestHit,
  };
}

export function landingSquash(impactSpeed: number): number {
  const t = Math.min(
    Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0),
    1,
  );
  return Math.min(0.8, 1 - t * (1 - SQ_MAX_SQUASH));
}
