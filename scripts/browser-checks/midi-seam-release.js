async (host) => {
  const context = await host.context().browser().newContext({ viewport: { width: 1910, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => navigator.requestMIDIAccess = async () => ({ inputs: new Map(), outputs: new Map(), onstatechange: null }));
    await page.goto('http://127.0.0.1:4200/?mode=midi');
    await page.locator('.session-files').waitFor();
    const tempo = page.getByRole('spinbutton', { name: 'Tempo', exact: true });
    const before = Number(await tempo.inputValue()), box = await tempo.boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    if (!await tempo.evaluate(el => document.activeElement === el)) throw Error('Text click lost focus');
    for (const delta of [1, -1]) {
      const old = Number(await tempo.inputValue());
      await page.mouse.move(box.x + box.width - 16, box.y + box.height / 2 + (delta > 0 ? -4 : 4));
      await page.mouse.down(); await page.waitForTimeout(80);
      if (!await tempo.evaluate(el => document.activeElement === el)) throw Error('Spinner lost focus before release');
      await page.mouse.up();
      const actual = await tempo.evaluate(el => ({ value: Number(el.value), focused: document.activeElement?.matches('main[data-performance]') }));
      if (!actual.focused || actual.value !== old + delta) throw Error(JSON.stringify({ delta, old, actual }));
    }
    await tempo.fill('132');
    if (!await tempo.evaluate(el => document.activeElement === el)) throw Error('Typing lost focus');
    await tempo.press('Enter');
    if (!await page.evaluate(() => document.activeElement?.matches('main[data-performance]'))) throw Error('Enter did not restore focus');
    const focus = { nativeUpDown: true, textEntryRetained: true, enterRestored: true, before };
    await page.evaluate(async () => {
      const v = window.__seamWorkspace = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
      v.worker.terminate(); cancelAnimationFrame(v.animation);
      await v.midi.browser.enable(v.engine.tracks.map(t => t.program));
      const t = v.engine.tracks[0], now = performance.now();
      v.engine.reference = 1000; v.engine.origin = now;
      Object.assign(t, { state: 'overdub', length: 1000, start: now, takeStart: now, cursor: now,
        layers: [[{ at: 100, data: [144, 60, 90] }, { at: 200, data: [128, 60, 0] }]],
        events: [{ at: 100, data: [144, 60, 90] }, { at: 200, data: [128, 60, 0] }], program: 16 });
      v.midi.configure(0); v.refresh();
      window.__seamTimer = setInterval(() => v.engine.tick(performance.now()), 5);
      document.querySelector('main[data-performance]').focus();
    });
    await page.waitForTimeout(850);
    for (const key of ['c', 'v', 'b']) await page.keyboard.down(key);
    await page.waitForTimeout(250);
    for (const key of ['c', 'v', 'b']) await page.keyboard.up(key);
    const synth = await page.evaluate(async () => {
      const v = window.__seamWorkspace, t = v.engine.tracks[0], wait = ms => new Promise(r => setTimeout(r, ms));
      clearInterval(window.__seamTimer);
      const captured = structuredClone(v.editor.notes.filter(n => [64, 65, 67].includes(n.pitch)));
      if (captured.length !== 3 || captured.some(n => n.continuous || n.duration < 200 || n.duration > 400 || n.start < 800)) throw Error('Invalid keyboard seam capture: ' + JSON.stringify(captured));
      v.engine.finishCaptures(performance.now());
      const source = v.editor.notes, group = source.filter(n => [64, 65, 67].includes(n.pitch));
      if (v.editor.changeMany(source, group.map(n => ({ id: n.id, patch: { start: 850 } })))?.length !== 3) throw Error('Editor move rejected');
      if (!v.editor.change(null, { pitch: 64, start: 950, duration: 200 })) throw Error('Editor addition rejected');
      const edited = structuredClone(v.editor.notes);
      const results = [];
      for (const program of [16, 0]) {
        await v.midi.browser.loadProgram(0, program); t.program = program;
        const start = performance.now() + 50;
        t.start = start; t.takeStart = start; t.cursor = start;
        v.engine.pausedAt = start; v.engine.resume(start);
        v.engine.tick(start, start + 2300);
        await wait(1000);
        const held = v.midi.browser.synth.midiChannels[0].voiceCount;
        await wait(4000);
        const snapshot = await v.midi.browser.synth.getSnapshot();
        const final = { program, held, voices: v.midi.browser.synth.midiChannels[0].voiceCount, sustain: snapshot.midiChannels[0].midiControllers[64] };
        if (!held || final.voices || final.sustain) throw Error(JSON.stringify(final));
        results.push(final);
        v.engine.pause(performance.now());
      }
      return { captured, edited, results };
    });
    if (errors.length) throw Error(errors.join(';'));
    return { passed: true, focus, synth, errors, kind: 'Isolated synthetic session, actual keyboard/native spinner and GeneralUser AudioWorklet; no user data/hardware/acoustic acceptance' };
  } finally { await context.close(); }
}
