# Changelog

## v0.15.0 — 2026-11-18

- Redesign the MIDI workspace with neutral anthracite surfaces, cyan selection, readable Full-HD controls and compact Routing/Metronome/Session cards. Preserve established recording/playback/overdub circle colors; clearly distinguish muted tracks and queued unmute countdowns.
- Put MIDI project/transport actions in two full-width Session rows; add Stop that finishes active captures, cancels queues, pauses and returns to the import start anchor without deleting loops.
- Replace normal MIDI tempo controls with proposals until selection. Remove custom division from MIDI and audio; keep normal tempo/signature controls.
- Tie the 200-px browser piano to the selected input, support mouse glissando and show its full-surface focus outline only during Tab navigation.
- Apply the design to MIDI settings/reset/import overlays. Keep the pre-existing settings-close performance-focus issue explicit; audio workspace redesign is not included.
- Move MIDI timing calibration into a modal opened from Routing, with six-tap progress, result/spread, repeat/cancel and keyboard piano support while transport/pedal shortcuts are blocked. Routing shows offset without fabricating a zero reading.
- Production builds and focused release safety checks; no broad regression or hardware/sound acceptance. Calibration browser check remains formally partial because of stale test-fixture assumptions, not a proven product failure.


## v0.14.0 — 2026-11-17

- Center MIDI track circles between the heading and instrument selector without state-dependent movement or shrinking their original size. Remove the small per-track status row at the user's request; use the freed space as equal top/bottom dial padding. Keep existing action state/countdown in the main button's accessible label. MIDI template/component styles only, no audio/engine changes. Original sizing formula and three synthetic browser states checked at 1280/960/390 px; production build passed.
- Add MIDI-only versioned `.aloop` project export/import with validation and replace confirmation. Export completed layers anytime without changing active recording/overdub; load paused at a common loop zero, or the longest loop's beginning while preserving relative phases if no shared zero exists. No standard MIDI/audio export or device/calibration import.
- Add true global MIDI pause/resume for transport, capture and metronome. All mute sets actual individual track mutes, permits selective reactivation, and becomes All active when all are muted; no extra mute overlay. Chase held loop voices on resume; keep existing external MIDI queue-clear limitations explicit.
- Group project/transport controls beside reset in the footer, remove pause status copy, and size workspace/metronome rows by content to prevent overlap.
- Verify project roundtrip/import guards, canonical start/fallback, pause/resume and individual mutes in three focused synthetic tests (`midi-project.test.ts`), plus production build. Isolated browser layout checked at 1280, 960 and 390 px, including footer controls, pause text removal and individual mutes. No hardware acceptance.
- End the previous track's overdub immediately when changing tracks in MIDI/audio; cancel queued overdub starts without changing loop phase or length.
- Offer the browser drum kit on every track and keep live monitoring independent of loop mute, including held notes and pedals.
- Extend the German physical keyboard mapping from `<` through `-` across eleven white notes with dynamically matching black notes above. Left/right moves by one white key, up/down by one full octave.
- Remember each track's piano range; default and confirmed global reset start at B3 (German H3) for melodic instruments and B1 (H1) for drum kits, so Y plays C4/C2. Single-track clear and reset cancellation preserve ranges.
- Focused synthetic tests and production builds are documented in the verification record. No broad regression or hardware acceptance.

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
