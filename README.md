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

Open `http://localhost:4200`. Recordings are held in memory and are lost when the page is reloaded. Browser/device permissions and preferences are local to each origin; they are not transferred from another installation.

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

## Controls

- `1`–`5`: select track; `Space`/`Enter`: record/play/overdub action.
- `Shift+M`: mute/unmute selected track; `Delete`: clear recording.
- `T`: metronome; `+`/`−`: piano keyboard octave.
- Fixed bar counts survive clearing a single track. The field's × or confirmed global reset clears the preset.
- The main-page six-tap timing check can calibrate laptop metronome clicks when using an external MIDI output. It does not accelerate live audio playback or move recorded notes. Measured compensation can be disabled/reset in settings.

## Third-party assets and licensing

- SpessaSynth lib/core: Apache-2.0, license copies in `public/audio`. `scripts/prepare-audio.mjs` generates the processor with a marked MessagePort adapter for cancellable MIDI scheduling.
- GeneralUser GS 2.0.3: its own license, included in `public/soundfonts/GeneralUser-LICENSE.txt`. That license discusses uncertainty about some sample origins; review it for your use case.
- FluidR3 GM: license copy in `public/soundfonts/FluidR3-COPYING.txt`.
- Soundbank source URLs, exact sizes and SHA-256 hashes are pinned in `public/soundfonts/sources.json`. SF2 binaries are downloaded during deployment, not stored in Git.

No project-source license has been selected yet. Public visibility alone is not an open-source license grant. Third-party components retain their respective licenses.
