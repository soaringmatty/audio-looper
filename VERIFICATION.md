
## v0.15.0 — 2026-11-18

- Original and Pages production builds passed: 726.46 kB initial, 76.46 kB above the unchanged 650-kB warning budget. No build errors.
- Focused calibration browser check: compact desktop routing, 960/390-px modal containment, Tab/Escape and performance-main focus return passed. Synthetic start/cancel/repeat/result, keyboard-piano forwarding and transport/pedal blocking passed; offset summary and unchanged tempo-proposal geometry reached. Final selection assertion timed out because the stale fixture used raw select value 0 instead of Angular's actual option value. Full script is therefore PARTIAL, not passed. Earlier fixture used KeyY instead of the physical German Y position KeyZ; corrected only in an ignored release-check copy. No app changes made to accommodate tests.
- Known pre-existing MIDI settings-close focus issue remains; click workspace if shortcuts do not respond. Audio redesign and real hardware/sound acceptance excluded. No broad regression run.
- Release-file and staged privacy checks required before publication.

## v0.15.1 — MIDI settings/calibration focus regression

- Reproduced settings Escape closure leaving focus on BODY. Fixed MIDI settings teardown to restore performance focus after render, not before removal of main's inert flag.
- Reproduced diagnostics → calibration → close losing focus because the opener no longer exists. Added a performance-surface fallback while preserving focus of replacement dialogs.
- Three focused browser areas passed in an isolated fresh context with empty mocked MIDI ports and synthetic timing: (1) settings close by Escape/button/backdrop with actual track-keyboard control, Tab containment and calibration handoff, plus compact desktop routing; (2) 960/390-px modal containment, Shift+Tab/Escape and restored workspace focus; (3) measurement start/cancel/result/repeat/close, six synthetic taps, piano forwarding with blocked transport/pedal shortcuts, offset summary and real tempo-proposal selection without geometry changes. No page errors.
- Regression check: scripts/browser-checks/midi-dialogs.js is a Playwright host-page function for browser_run_code_unsafe. For the configured tool roots, copy it to .tools/browser-checks/compact-routing-timing.js and run that filename against the existing development server. Physical German Y uses KeyZ; tempo selection uses the visible proposal label.
- Production build passed: 726.67 kB initial, 76.67 kB above the unchanged 650-kB warning budget. No broad regression or physical hardware/sound test; no audio redesign. Release publication is a separate phase from these checks.

### Release preparation

- Pages production build passed: 727.69 kB initial / 77.69 kB above the unchanged warning budget. Main bundle matches the focused-fix build (main-G536OGGO.js). CSS hash differs only in externally inlined Google Fonts font-face definitions; app stylesheet rules and all src files are identical between the original and public projects.
- Release check passed for 19 output files. Staged privacy scan passed for 128 files plus production text artifacts. No audio implementation or NAS/devserver configuration changes.
