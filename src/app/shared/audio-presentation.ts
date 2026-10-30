/** Browser estimates, not an acoustic or key-to-sound measurement. */
export function outputDelayMs(context?: AudioContext): number | null {
  if (!context) return null;
  const base = context.baseLatency,
    output = context.outputLatency;
  return Number.isFinite(base) && Number.isFinite(output) && base >= 0 && output >= 0
    ? (base + output) * 1000
    : null;
}

/** Presentation position only. Never changes capture timestamps or engine state. */
export function audibleNow(context: AudioContext | undefined, now: number): number {
  if (!context || context.state !== 'running') return now;
  try {
    const stamp = context.getOutputTimestamp?.();
    if (
      stamp &&
      typeof stamp.performanceTime === 'number' &&
      typeof stamp.contextTime === 'number' &&
      stamp.performanceTime > 0 &&
      stamp.contextTime >= 0 &&
      Math.abs(now - stamp.performanceTime) < 1000
    ) {
      const heardContextTime = stamp.contextTime + (now - stamp.performanceTime) / 1000;
      const behindMs = (context.currentTime - heardContextTime) * 1000;
      if (behindMs >= 0 && behindMs <= 1000) return now - behindMs;
    }
  } catch {
    /* Unsupported output clock: use the explicitly labelled estimate. */
  }
  const delay = outputDelayMs(context);
  return delay === null || delay > 1000 ? now : now - delay;
}
