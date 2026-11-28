// Ballistic throw, wall bounce, slingshot release, and landing squash math
// adapted from PC2005-cloud/dsh-pet (MIT), dsh-pet/src/shared/physics/*.
// Copyright (c) 2026 PC2005-cloud. See THIRD_PARTY_NOTICES.md for source and license.

export interface PointerSample {
  t: number;
  x: number;
  y: number;
}

export interface ThrowBounds {
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

export type ContactEdge = "left" | "right" | "ceiling" | "floor";
export type PetImpactKind = "app-icon" | "sprite" | "behavior";

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

const TRAIL_KEEP_MS = 220;
const RELEASE_WINDOW_MS = 180;
const RELEASE_STALE_MS = 180;
const MIN_SPAN_MS = 20;
const SEG_MIN_DT_MS = 8;

export const DEAD_ZONE_SPEED = 360;
/** 触发角色专属受击动画片段的最小法向碰撞速度（轻擦微弹只做形变缓冲）。 */
export const HIT_ACTION_MIN_SPEED = 380;
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

const SQ_DURATION_MS = 220;
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
  if (segSpeeds.length < 2) return null;
  const peakSpeed = Math.max(...segSpeeds.map((item) => item.speed));

  let accel = 0;
  const firstSeg = segSpeeds[0];
  const lastSeg = segSpeeds[segSpeeds.length - 1];
  accel =
    (lastSeg.speed - firstSeg.speed) /
    Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, MIN_SPAN_MS / 1000);
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

/** 已被拖到贴紧某侧屏幕边界时，剔除继续往墙里推的分量，同时返回贴边猛撞的受击边与速度。 */
export function clampLaunchAtBounds(
  origin: { x: number; y: number },
  velocity: { vx: number; vy: number },
  bounds: ThrowBounds,
): { velocity: { vx: number; vy: number } | null; blockedHit: { edge: ContactEdge; speed: number } | null } {
  let { vx, vy } = velocity;
  let blockedHit: { edge: ContactEdge; speed: number } | null = null;
  const recordBlocked = (edge: ContactEdge, speed: number) => {
    if (!blockedHit || speed > blockedHit.speed) blockedHit = { edge, speed };
  };
  if (origin.x <= bounds.minX + 0.5 && vx < 0) {
    recordBlocked("left", Math.abs(vx));
    vx = 0;
  }
  if (origin.x >= bounds.maxX - 0.5 && vx > 0) {
    recordBlocked("right", Math.abs(vx));
    vx = 0;
  }
  if (origin.y <= bounds.minY + 0.5 && vy < 0) {
    recordBlocked("ceiling", Math.abs(vy));
    vy = 0;
  }
  if (origin.y >= bounds.maxY - 0.5 && vy > 0) {
    recordBlocked("floor", Math.abs(vy));
    vy = 0;
  }
  return {
    velocity: Math.hypot(vx, vy) < DEAD_ZONE_SPEED ? null : { vx, vy },
    blockedHit,
  };
}

/**
 * 按碰撞法线方向与角色类型生成带「贴壁顿帧（hitstop）」与受击高光的形变关键帧：
 * - app-icon：贴壁顿帧压扁 + 受击闪白 + 大角度果冻多段回弹
 * - sprite（GIF/普通素材）：贴壁顿帧压扁 + 受击闪白 + 眩晕左右抖动
 * - behavior（大肥鱼等）：贴壁顿帧 Q 弹大压扁 + 水润回弹
 */
export function impactDeformation(
  edge: ContactEdge,
  impactSpeed: number,
  kind: PetImpactKind,
  mirrored = false,
  subjectBox?: { left: number; top: number; width: number; height: number } | null,
): { keyframes: Keyframe[]; duration: number } {
  const comp = Math.max(0.5, landingSquash(impactSpeed) - 0.08);
  const delta = 1 - comp;
  const stretch = Number(Math.min(1.24, 1 + delta * 0.54).toFixed(3));
  const mirror = mirrored ? "scaleX(-1) " : "";
  const horizontal = edge === "left" || edge === "right";
  const box = subjectBox && subjectBox.width > 0 && subjectBox.height > 0
    ? subjectBox
    : { left: 0, top: 0, width: 1, height: 1 };
  const cx = Math.round((box.left + box.width * 0.5) * 100);
  const topY = Math.round(box.top * 100);
  const bottomY = Math.round((box.top + box.height) * 100);
  const midY = Math.round((box.top + box.height * 0.55) * 100);
  const origin = edge === "floor"
    ? `${cx}% ${bottomY}%`
    : edge === "ceiling"
      ? `${cx}% ${topY}%`
      : `50% ${midY}%`;
  const sx = horizontal ? Number(comp.toFixed(3)) : stretch;
  const sy = horizontal ? stretch : Number(comp.toFixed(3));
  // 按实际人物可见宽度比例计算贴墙位移，避免宽透明画布把角色推出裁剪窗外。
  const wallShift = horizontal
    ? `${edge === "left" ? "-" : ""}${Number((delta * box.width * 48).toFixed(2))}%`
    : "0%";
  const reboundX = horizontal ? Number((1 + delta * 0.28).toFixed(3)) : 0.91;
  const reboundY = horizontal ? 0.91 : Number((1 + delta * 0.28).toFixed(3));

  if (kind === "app-icon") {
    const iconComp = Number(Math.max(0.48, comp - 0.04).toFixed(3));
    const iconDelta = 1 - iconComp;
    const iconStretch = Number(Math.min(1.2, 1 + iconDelta * 0.46).toFixed(3));
    const iconSx = horizontal ? iconComp : iconStretch;
    const iconSy = horizontal ? iconStretch : iconComp;
    const iconWallShift = horizontal
      ? `${edge === "left" ? "-" : ""}${Number((iconDelta * 50).toFixed(2))}%`
      : "0%";
    const tilt = edge === "left" ? 18 : edge === "right" ? -18 : 14;
    const rippleX = horizontal ? 0.93 : 1.08;
    const rippleY = horizontal ? 1.08 : 0.93;
    return {
      duration: 580,
      keyframes: [
        { transform: "translateX(0%) rotate(0deg) scale(1, 1)", filter: "brightness(1)", transformOrigin: origin },
        { transform: `translateX(${iconWallShift}) rotate(${tilt}deg) scale(${iconSx}, ${iconSy})`, filter: "brightness(1.38)", transformOrigin: origin, offset: 0.07 },
        { transform: `translateX(${iconWallShift}) rotate(${tilt}deg) scale(${iconSx}, ${iconSy})`, filter: "brightness(1.12)", transformOrigin: origin, offset: 0.24 },
        { transform: `translateX(0%) rotate(${-Math.round(tilt * 0.65)}deg) scale(${reboundX}, ${reboundY})`, filter: "brightness(1)", transformOrigin: origin, offset: 0.5 },
        { transform: `translateX(0%) rotate(${Math.round(tilt * 0.35)}deg) scale(${rippleX}, ${rippleY})`, filter: "brightness(1)", transformOrigin: origin, offset: 0.76 },
        { transform: "translateX(0%) rotate(0deg) scale(1, 1)", filter: "brightness(1)", transformOrigin: origin },
      ],
    };
  }

  if (kind === "sprite") {
    const shakeA = horizontal ? "translateY(-5px) rotate(-8deg)" : "translateX(-6px) rotate(-8deg)";
    const shakeB = horizontal ? "translateY(5px) rotate(8deg)" : "translateX(6px) rotate(8deg)";
    return {
      duration: 540,
      keyframes: [
        { transform: `translateX(0%) ${mirror}scale(1, 1)`, filter: "brightness(1)", transformOrigin: origin },
        { transform: `translateX(${wallShift}) ${mirror}scale(${sx}, ${sy})`, filter: "brightness(1.42)", transformOrigin: origin, offset: 0.07 },
        { transform: `translateX(${wallShift}) ${mirror}scale(${sx}, ${sy})`, filter: "brightness(1.1)", transformOrigin: origin, offset: 0.22 },
        { transform: `${shakeA} ${mirror}scale(${reboundX}, ${reboundY})`, filter: "brightness(1)", transformOrigin: origin, offset: 0.48 },
        { transform: `${shakeB} ${mirror}scale(1.04, 0.96)`, filter: "brightness(1)", transformOrigin: origin, offset: 0.74 },
        { transform: `translateX(0%) ${mirror}scale(1, 1)`, filter: "brightness(1)", transformOrigin: origin },
      ],
    };
  }

  return {
    duration: 460,
    keyframes: [
      { transform: `translateX(0%) ${mirror}scale(1, 1)`, filter: "brightness(1)", transformOrigin: origin },
      { transform: `translateX(${wallShift}) ${mirror}scale(${sx}, ${sy})`, filter: "brightness(1.28)", transformOrigin: origin, offset: 0.08 },
      { transform: `translateX(${wallShift}) ${mirror}scale(${sx}, ${sy})`, filter: "brightness(1.06)", transformOrigin: origin, offset: 0.24 },
      { transform: `translateX(0%) ${mirror}scale(${reboundX}, ${reboundY})`, filter: "brightness(1)", transformOrigin: origin, offset: 0.56 },
      { transform: `translateX(0%) ${mirror}scale(0.97, 1.04)`, filter: "brightness(1)", transformOrigin: origin, offset: 0.8 },
      { transform: `translateX(0%) ${mirror}scale(1, 1)`, filter: "brightness(1)", transformOrigin: origin },
    ],
  };
}
