export type PetPlaybackOutcome = "ended" | "cancelled" | "failed";
export type PetPlaybackOwner = "auto" | "click";

type Playback = {
  key: string;
  owner: PetPlaybackOwner;
  ready: boolean;
  timer: number;
  resolve: (outcome: PetPlaybackOutcome) => void;
  onReady?: (media: HTMLVideoElement) => void;
};

/** A one-shot video belongs to one frame and one caller; late media events cannot finish a newer request. */
export function createPetPlayback() {
  let pending: Playback | null = null;

  const finish = (request: Playback, outcome: PetPlaybackOutcome) => {
    if (pending !== request) return;
    pending = null;
    window.clearTimeout(request.timer);
    request.resolve(outcome);
  };

  return {
    play(key: string, owner: PetPlaybackOwner, onReady?: (media: HTMLVideoElement) => void): Promise<PetPlaybackOutcome> {
      if (pending) finish(pending, "cancelled");
      return new Promise((resolve) => {
        const request: Playback = { key, owner, ready: false, timer: 0, resolve, onReady };
        pending = request;
        // A missing clip must not leave the pet's interaction or autonomous loop occupied forever.
        request.timer = window.setTimeout(() => finish(request, "failed"), 8000);
      });
    },
    matches(key: string) {
      return pending?.key === key;
    },
    ready(key: string, media: HTMLVideoElement) {
      const request = pending;
      if (!request || request.key !== key || request.ready) return;
      request.ready = true;
      window.clearTimeout(request.timer);
      // Actual ended drives the hand-off. This longer deadline only recovers a stalled decoder.
      const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration * 1000 : 0;
      request.timer = window.setTimeout(() => finish(request, "failed"), Math.min(120_000, Math.max(30_000, duration * 2 + 5000)));
      try {
        request.onReady?.(media);
      } catch {
        finish(request, "failed");
      }
    },
    ended(key: string) {
      if (pending?.key === key) finish(pending, "ended");
    },
    failed(key: string) {
      if (pending?.key === key) finish(pending, "failed");
    },
    cancel(owner?: PetPlaybackOwner) {
      if (pending && (owner === undefined || pending.owner === owner)) finish(pending, "cancelled");
    },
  };
}
