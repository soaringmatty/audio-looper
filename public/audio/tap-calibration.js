// Main-thread analysis of raw input. This is a personal timing estimate, not a pure hardware measurement.
const median = (values) => {
  const a = [...values].sort((a, b) => a - b);
  return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : 0;
};
export function analyzeTaps(samples, starts, rate) {
  const hop = Math.max(1, Math.round(rate * 0.005)),
    window = Math.max(1, Math.round(rate * 0.01));
  const envelope = new Float32Array(Math.ceil(samples.length / hop));
  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    energy += samples[i] * samples[i];
    if (i >= window) energy -= samples[i - window] * samples[i - window];
    if (i % hop === 0) envelope[Math.floor(i / hop)] = Math.sqrt(Math.max(0, energy) / window);
  }
  const offsets = [];
  for (const start of starts) {
    const from = Math.max(1, Math.floor((start - rate * 0.12) / hop)),
      to = Math.min(envelope.length - 1, Math.ceil((start + rate) / hop));
    const region = Array.from(envelope.slice(from, to)).sort((a, b) => a - b);
    const noise = region[Math.floor(region.length * 0.2)] ?? 0,
      peak = region.at(-1) ?? 0;
    const threshold = Math.max(0.003, noise * 4, peak * 0.15);
    let last = -1e9;
    const candidates = [];
    for (let j = from; j <= to; j++) {
      if (
        envelope[j] >= threshold &&
        envelope[j - 1] < threshold &&
        j - last > (rate * 0.12) / hop
      ) {
        candidates.push(j);
        last = j;
      }
    }
    // Ambiguous repeated sounds are not silently assigned to the beat.
    if (candidates.length === 1) offsets.push(((candidates[0] * hop - start) / rate) * 1000);
    else offsets.push(null);
  }
  const valid = offsets.filter((v) => v !== null),
    center = median(valid),
    mad = median(valid.map((v) => Math.abs(v - center)));
  const accepted = valid.filter((v) => Math.abs(v - center) <= Math.max(35, 3 * mad));
  const offsetMs = median(accepted),
    spreadMs = accepted.length ? Math.max(...accepted) - Math.min(...accepted) : 0;
  const ok =
    accepted.length >= 6 && mad <= 25 && spreadMs <= 100 && offsetMs >= -50 && offsetMs <= 1000;
  const reason =
    accepted.length < 6
      ? 'Zu wenige eindeutige Klanganfänge. Pro Takt nur einen kurzen, deutlichen Klang machen.'
      : offsetMs < -50
        ? 'Die Klänge liegen deutlich vor dem Takt. Nicht auf den Klick reagieren, sondern nach dem Einzählen im Rhythmus mitspielen.'
        : !ok
          ? 'Der Abstand schwankt zu stark. Mit Kopfhörern und gleichmäßigen, kurzen Klängen erneut versuchen.'
          : '';
  return {
    ok,
    offsetMs,
    suggestedMs: Math.max(0, Math.min(1000, Math.round(offsetMs))),
    spreadMs,
    accepted: accepted.length,
    rejected: starts.length - accepted.length,
    offsets,
    reason,
  };
}
