# Changelog

## v0.13.1 — 2026-11-16

- Fix MIDI metronome spacing: keep the time signature visible, constrain output selector width and align control heights and spacing.
- Keep the volume label on one line and separate the timing check from playback controls.
- Use deliberate responsive rows on smaller screens instead of shrinking controls.
- Layout checked at 1280, 960 and 390 px; local/public production builds. No audio, MIDI scheduling or transport behavior changed.

## v0.13.0 — 2026-11-15

- Global reset now restores all track volumes; clearing a single track preserves its volume.
- A non-blocking confirmation dialog keeps playback running until reset is confirmed. Cancel and Escape leave recordings unchanged.
- Shift+1–5 mutes/unmutes the corresponding track without changing track selection or releasing another track's live notes. Shift+M remains available.
- Speaker/MIDI metronome output is selected directly in the metronome controls; the redundant channel explanation is removed.
- Live MIDI BPM changes scale recorded events, note lengths and loop durations together with the metronome. A shared transition after queued output preserves loop phase and held voices without clearing MIDI queues. Free recordings must first receive a tempo division. Tempo is locked during recording, overdub and pending transport actions. Audio time-stretching is not included.
- Includes the current Angular feature/workspace refactoring. Three focused synthetic integration tests and local/public production builds; no physical MIDI/audio timing or hardware sound acceptance, no broad regression run.
