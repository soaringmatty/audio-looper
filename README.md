# Audio Looper

A browser-based loopstation with five tracks, separate MIDI and audio modes, an on-screen piano and SoundFont playback. Audio processing, MIDI and loop recordings stay in the browser. No backend or audio upload is used by the app. Google Fonts are currently loaded externally.

Public site: **https://soaringmatty.github.io/audio-looper/**

## Requirements and local development

- Node.js 24.22.1 (see `.nvmrc`). Yarn 4.18.1 is included in `.yarn/releases`.
- Use a browser with Web Audio and, for hardware MIDI, Web MIDI support, such as a compatible Chrome/Edge version. Device access requires browser permission; use HTTPS or localhost.

```sh
node .yarn/releases/yarn-4.18.1.cjs install --immutable
node scripts/fetch-soundbanks.mjs
node .yarn/releases/yarn-4.18.1.cjs start
```

Open `http://localhost:4200`. Recordings are held in memory and are lost when the page is reloaded unless saved as a MIDI project first. Audio recordings cannot yet be saved. Browser/device permissions and preferences are local to each origin; they are not transferred from another installation.

## Production deployment

1. In repository **Settings → Pages**, select **GitHub Actions** as the source. Leave **Custom domain** empty. The account-level Pages site must not supply an inherited custom domain either; the workflow rejects any non-default Pages origin.
2. In **Actions → Deploy GitHub Pages**, select **Run workflow** on `main`.
3. Wait for the build and deployment jobs to finish, then open the public site.

Deployment is deliberately manual. A push alone does not publish a new version. The workflow installs locked dependencies, downloads and verifies pinned soundbanks, builds with `/audio-looper/` as the base path, and publishes only `dist/audio-looper/browser`. No custom domain or `CNAME` is configured. The release check is a focused safety check, not a general security audit.

For a local production build:

```sh
node .yarn/releases/yarn-4.18.1.cjs build:pages
node scripts/check-release.mjs
```

Serve that output mounted at `/audio-looper/`; do not open `index.html` as a local file. For changes to runtime audio behavior, test the intended MIDI/audio device setup in addition to code tests. GitHub hosting does not eliminate local audio latency.

## MIDI workspace

**Live / Editor** next to Save/Load switches the same five-track session without resetting or pausing playback. In a paused completed track, double-click to add notes. Drag an empty area for a marquee selection; Shift+marquee adds, Shift+click toggles individual notes. Drag a selected note to move the whole selection in time/pitch; one anchor is snapped and one shared delta/bound keeps relative offsets, intervals and durations. Arrows move the selection, Delete/Backspace deletes it, one undo per gesture. Edges/Shift+Left/Right resize single selected notes only. Empty click clears selection, Escape/cancel discards a drag. Wrapped segments remain one selection. No group resize, clipboard or pedal multiselect. Ctrl+Z / Ctrl+Shift+Z undo/redo; optional snap, zoom and internal scrolling, .aloop-v1 unchanged. The view switch shares MIDI/Audio segmented styling; track mute/delete actions have equal width and visible labels.

Editing currently requires a paused session with completed captures and no pending recording actions; use Stop to finish an open take. The roll shows played note length, not sustain-extended sounding duration. Independent note takes and unrelated controllers remain preserved. Inserted/changed notes have finite releases, including notes covering the whole cycle (release 0.001 ms before the seam); untouched recorded continuous ties remain held. Legacy saved holds cannot safely be classified as intentional versus accidental. Undo is editor-only, per track, in memory, and resets after capture/import/tempo changes replace the event data. Auto-Align provides exact nearest-grid quantization with preview and one undo step. Live editing is deferred; paused editing remains required. Audio editing and arrangement are not included.

The pedal lane below the notes selects Sustain (CC64), Sostenuto (66), Soft (67) or Hold 2 (69), showing the effective value across all overdub layers without binarizing intermediate values. Double-click to insert a value-127 interval, drag to move, drag edges to resize, and use the value field or Up/Down for exact 0–127 values. Left/Right moves, Shift+Left/Right changes duration; Delete/Backspace or Auswahl löschen paints the selected interval to zero across all contributing sources. Moving/extending overwrites the destination; outside the edited windows original source states resume. Notes and pedals share undo/redo and existing .aloop-v1 storage. Horizontal scrolling/zoom is shared; wrapped intervals remain one selection. The lane controls loop playback, not independently held live pedals. Missing CC67 recordings are not reconstructed when that pedal is assigned to loop control. Actual controller sound/half-pedal support depends on the synth/device.

Auto-Align snaps each selected note start exactly to the nearest local tempo-grid point (1/4–1/32), with no additional millisecond/percentage cap. With a selection it affects only those notes, otherwise the whole track. Free takes require the existing tempo division first. Different pitches may become simultaneous chords; this deliberately changes microtiming/groove and articulation. Durations stay unchanged by default; optional ends snap original release times too. Real same-pitch conflicts, zero/invalid durations, equidistant ambiguous targets, continuous holds and pedal-boundary crossings are skipped with reasons. Finite seam notes are handled cyclically. Amber suggestions/dashed originals remain preview-only until Übernehmen; Escape/Abbrechen discard and one undo restores the entire correction. Pedals/pitch/attack velocity/track phase/loop length stay unchanged. This is grid quantization, not musical-intent recognition.


Neutral anthracite surfaces with cyan selection, compact Routing/Metronome/Session cards, visible queued unmute and readable Full-HD controls. Session contains save/load, pause/resume, Stop, all mute/active and reset. Stop preserves captures and returns to the import start anchor. The input-dependent browser piano is 200 CSS-px high and supports mouse glissando.

Routing → Kalibrieren opens the six-tap timing dialog; offset remains visible in Routing. Measurement includes playing behavior, not isolated hardware latency. MIDI settings/reset/import overlays share the design; audio retains its separate layout. Custom tempo division has been removed from both modes.

Closing MIDI settings returns focus to the performance surface after render. Opening calibration from diagnostics retains modal focus; closing it falls back to the performance surface if the original button no longer exists. Hardware/sound acceptance and audio redesign remain separate.

## v0.14.0

- Save/load MIDI sessions as versioned `.aloop` files: five tracks, completed note/pedal layers, instruments, volumes, mutes, keyboard ranges and shared timing. Saving during recording/overdub leaves the active take out without stopping it. No standard MIDI/audio export.
- Import validates before replacement confirmation (16 MiB / 200,000 events); cancel or invalid files preserve the session. Load paused at a shared loop zero, otherwise at the longest loop's beginning with relative phases preserved. Ports, permissions and calibrations are not imported.
- Pause/resume freezes MIDI transport, capture and metronome; live playing remains audible but unrecorded while paused. Resume chases held loop voices. All mute sets individual track mutes; tracks can be enabled separately, or all immediately with All active. These controls are in the Session card.
- Track changes immediately finish the previous overdub in MIDI/audio without restarting loops. Browser drums are available on every track; loop mute does not mute live monitoring. External GM drums still share channel 10; devices without queue-clear retain their existing output limitation.
- German physical keyboard: `< Y X C V B N M , . -` always play eleven white notes; matching black notes use A through Ö with dynamic gaps. Left/right shifts one white note, up/down one octave. Each track remembers its range. Defaults and confirmed global reset start at B3 (German H3), or B1 for drums, so Y plays C4/C2. Single-track clear and reset cancellation preserve ranges.
- MIDI circles retain their original size with symmetric spacing and no small status row. Content-sized workspace rows prevent metronome/track overlap.

Release preparation: three focused synthetic cases passed (project export/import guards, MIDI/PCM track switching and keyboard mapping/reset); three other cases intentionally skipped. Both production builds passed: 699.65 kB initial, 49.65 kB above the unchanged warning budget. Release file check passed for 19 files. No broad regression or hardware/sound acceptance.

See [CHANGELOG.md](CHANGELOG.md). Synthetic checks do not replace hardware/sound acceptance; no broad regression was run. Audio save/load and pause are not included.

## v0.13.1

MIDI metronome layout fixes: visible time signature, compact output selector, aligned controls, single-line volume label and responsive timing-check separation. Layout checked at 1280, 960 and 390 px; no audio or scheduling changes. See [CHANGELOG.md](CHANGELOG.md).

## v0.13.0

Non-blocking reset confirmation, global volume reset, direct track mute shortcuts, main-page metronome output and live MIDI BPM changes. See [CHANGELOG.md](CHANGELOG.md). Run the three focused checks with `node .yarn/releases/yarn-4.18.1.cjs test:performance`. Free loops require a confirmed tempo division; recording, overdub and pending transport actions lock BPM. Audio loops are not stretched. A tempo change takes effect after the already scheduled output window, including compensated speaker clicks.

## Controls

- `1`–`5`: select track; `Space`/`Enter`: record/play/overdub action.
- `Shift+1`–`Shift+5`: mute/unmute that track without selection changes; `Shift+M`: selected track; `Delete`: clear recording.
- `T`: metronome; left/right: one white key; up/down: piano octave.
- Fixed bar counts survive clearing a single track. The field's × or confirmed global reset clears the preset.
- The six-tap timing dialog opened from Routing can calibrate laptop metronome clicks when using an external MIDI output. It does not accelerate live audio playback or move recorded notes. Measured compensation can be disabled/reset in settings.

## MIDI performance and metronome output

- Known recording ends, overdub cycles and queued unmute prepare their first playback ahead of the boundary without ending capture early. Spontaneous free recording stops cannot be predicted. Unchanged instruments are not reselected at every transition.
- Choose speaker or MIDI click directly in the metronome controls. MIDI click uses reserved channel 11 with vibraphone, accented downbeats and the existing volume control. No visible track or click recording; CLP-625 receive mode must be ALL. This is not remote control of Yamaha's built-in metronome.
- MIDI click bypasses laptop audio and its latency correction. The laptop calibration stays saved for switching back. Output choice persists without metronome autostart; device loss never silently falls back to laptop sound.
- A queued recording's progress ring shows one bar when tempo is established, independently of the reference loop length.
- Three focused synthetic tests: `node .yarn/releases/yarn-4.18.1.cjs exec ng test --watch=false --include=tests/midi-performance-start.test.ts`. Hardware sound/timing acceptance remains necessary; no broad regression test. Outputs without native MIDI queue cancellation still use release fallbacks rather than guaranteed physical cancellation.

## Third-party assets and licensing

- SpessaSynth lib/core: Apache-2.0, license copies in `public/audio`. `scripts/prepare-audio.mjs` generates the processor with a marked MessagePort adapter for cancellable MIDI scheduling.
- GeneralUser GS 2.0.3: its own license, included in `public/soundfonts/GeneralUser-LICENSE.txt`. That license discusses uncertainty about some sample origins; review it for your use case.
- FluidR3 GM: license copy in `public/soundfonts/FluidR3-COPYING.txt`.
- Soundbank source URLs, exact sizes and SHA-256 hashes are pinned in `public/soundfonts/sources.json`. SF2 binaries are downloaded during deployment, not stored in Git.

No project-source license has been selected yet. Public visibility alone is not an open-source license grant. Third-party components retain their respective licenses.
