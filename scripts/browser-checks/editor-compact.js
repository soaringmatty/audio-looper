async (host) => {
  const context = await host.context().browser().newContext({ viewport: { width: 1910, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const state = () => page.evaluate(() => {
    const w = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
    return { pedals: w.editor.pedals, layers: w.editor.track.layers, notes: w.editor.notes };
  });
  const lane = cc => page.locator(`.pedal-canvas[data-cc="${cc}"]`);
  const partial = () => lane(64).locator('.pedal-step[title*="Zwischenwert 80"]').first();
  try {
    await page.addInitScript(() => navigator.requestMIDIAccess = async () => ({ inputs: new Map(), outputs: new Map(), onstatechange: null }));
    await page.goto('http://127.0.0.1:4200/?mode=midi');
    await page.locator('.session-files').waitFor();
    await page.evaluate(() => {
      const w = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
      w.worker.terminate(); cancelAnimationFrame(w.animation); w.midi.outputId = '';
      w.engine.pausedAt = 1000; w.engine.origin = 0; w.engine.reference = 2000; w.engine.mode = 'tempo'; w.engine.bpm = 120;
      const layers = [[
        { at: 100, data: [144, 60, 90] }, { at: 250, data: [176, 64, 80] },
        { at: 500, data: [176, 64, 32] }, { at: 600, data: [128, 60, 0] }, { at: 750, data: [176, 64, 0] },
      ]];
      Object.assign(w.engine.tracks[0], { state: 'playing', start: 0, length: 2000, layers, events: structuredClone(layers[0]), carry: [], cursor: 1000 });
      w.refresh();
    });
    await page.getByRole('button', { name: 'Editor', exact: true }).click();
    await partial().waitFor(); await settle();
    const original = await state();

    // 1. Default, grouped toolbar and native help popover do not change data/layout.
    check(await page.getByLabel('Notenraster', { exact: true }).inputValue() === '2', 'Default is not 1/8');
    check(await page.locator('.roll-tool-group').count() === 3, 'Missing toolbar groups');
    check(await page.locator('.roll-tool-group').nth(1).evaluate(e => getComputedStyle(e).borderLeftWidth === '1px'), 'Missing group separator');
    check(await page.locator('.pedal-canvas').count() === 2, 'Expected Sustain and Sostenuto only');
    check(await page.locator('.pedal-toolbar,.roll-hint,input[aria-label="Pedalwert"]').count() === 0, 'Old UI remains');
    const beforeHelp = await page.locator('.roll-viewport').boundingBox();
    await page.getByRole('button', { name: 'Editor-Hilfe', exact: true }).click();
    check(await page.locator('#roll-help').evaluate(e => e.matches(':popover-open')), 'Help did not open');
    check((await page.locator('#roll-help').innerText()).includes('Fläche'), 'Broken help encoding');
    check(JSON.stringify(beforeHelp) === JSON.stringify(await page.locator('.roll-viewport').boundingBox()), 'Help consumes note height');
    await page.getByLabel('Soft einblenden', { exact: true }).check(); await settle();
    check(await lane(67).count() === 1, 'Cannot reveal optional pedal');
    await page.getByLabel('Soft einblenden', { exact: true }).uncheck();
    await page.keyboard.press('Escape'); await settle();
    check(!await page.locator('#roll-help').evaluate(e => e.matches(':popover-open')), 'Escape did not close help');
    check(await page.getByRole('button', { name: 'Editor-Hilfe', exact: true }).evaluate(e => e === document.activeElement), 'Help did not restore focus');
    check(JSON.stringify((await state()).layers) === JSON.stringify(original.layers), 'View controls changed MIDI');

    // 2. Actual pointer/keyboard edits, shared history and preserved intermediate data.
    await partial().click(); await page.keyboard.press('ArrowLeft'); await settle();
    check((await state()).pedals.some(p => p.cc === 64 && p.value === 80 && p.start === 0), 'Move lost intermediate value');
    check((await state()).pedals.some(p => p.value === 32 && p.start === 500), 'Untouched intermediate value lost');
    await page.keyboard.press('Shift+ArrowRight'); await settle();
    check((await state()).pedals.some(p => p.value === 80 && p.duration === 500), 'Resize lost value/duration');
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click();
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); await settle();
    check(JSON.stringify((await state()).layers) === JSON.stringify(original.layers), 'Undo did not restore exact layers');
    await page.getByRole('button', { name: 'Wiederholen', exact: true }).click(); await settle();
    check((await state()).pedals.some(p => p.value === 80 && p.start === 0), 'Redo lost pedal edit');
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); await settle();
    const box = await partial().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 4 });
    await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
    check(JSON.stringify((await state()).layers) === JSON.stringify(original.layers), 'Escape committed pointer draft');
    const dragWidth = await lane(64).locator('.pedal-grid').evaluate(e => e.clientWidth);
    const dragPedal = async edge => {
      const b = await partial().boundingBox();
      const x = edge === 'end' ? b.x + b.width - 3 : b.x + b.width / 2, y = b.y + b.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + (edge === 'end' ? 1 : -1) * dragWidth / 8, y, { steps: 5 });
      await page.mouse.up(); await settle();
    };
    await dragPedal('move'); await dragPedal('end');
    check((await state()).pedals.some(p => p.value === 80 && p.start === 0 && p.duration === 500), 'Pointer move/resize failed');
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click();
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); await settle();
    const width = await lane(66).locator('.pedal-grid').evaluate(e => e.clientWidth);
    const r = await lane(66).boundingBox();
    await page.mouse.dblclick(r.x + 60 + width / 2, r.y + 11); await settle();
    check((await state()).pedals.some(p => p.cc === 66 && p.value === 127 && p.start === 1000 && p.duration === 250), 'Lane add is not binary/on eighth grid');
    const added = lane(66).locator('.pedal-step').first();
    await added.click(); await page.keyboard.press('ArrowDown'); await settle();
    check(!(await state()).pedals.some(p => p.cc === 66), 'Off did not clear interval');
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); await settle();
    await added.click(); await page.keyboard.press('Delete'); await settle();
    check(!(await state()).pedals.some(p => p.cc === 66), 'Delete did not clear interval');
    check((await state()).pedals.some(p => p.value === 32), 'Binary edit destroyed unrelated values');
    check(JSON.stringify((await state()).notes) === JSON.stringify(original.notes), 'Pedal edit changed notes');
    await page.evaluate(() => {
      const w = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
      w.editor.changePedal(69, null, { start: 1250, duration: 250, value: 127 }); w.refresh();
    }); await settle();
    check(await lane(69).count() === 1, 'Existing optional data hidden');
    await page.getByLabel('Piano-Roll-Zoom').selectOption('2'); await settle();
    await page.locator('.roll-viewport').evaluate(e => e.scrollLeft = 150); await settle();
    check(await page.locator('.pedal-viewport').evaluate(e => e.scrollLeft === 150), 'Note-to-pedal scroll differs');
    await page.locator('.pedal-viewport').evaluate(e => e.scrollLeft = 300); await settle();
    check(await page.locator('.roll-viewport').evaluate(e => e.scrollLeft === 300), 'Pedal-to-note scroll differs');
    await page.getByLabel('Piano-Roll-Zoom').selectOption('1'); await settle();
    const stable = JSON.stringify((await state()).layers);
    await page.evaluate(() => { const w = ng.getComponent(document.querySelector('app-midi-looper')).workspace; w.engine.pausedAt = null; w.refresh(); }); await settle();
    await partial().click(); await page.keyboard.press('Delete'); await settle();
    check(JSON.stringify((await state()).layers) === stable, 'Running playback accepted edit');
    check((await page.locator('.roll-lock').innerText()).includes('pausieren'), 'Playback lock reason hidden');
    await page.evaluate(() => { const w = ng.getComponent(document.querySelector('app-midi-looper')).workspace; w.engine.pausedAt = 1000; w.refresh(); });

    // 3. Desktop and laptop CSS viewports; every lane equals one key row.
    const layout = [];
    for (const size of [{ width: 1910, height: 900 }, { width: 1536, height: 754 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(size); await settle();
      const metrics = await page.evaluate(() => {
        const rect = s => document.querySelector(s).getBoundingClientRect();
        const panel = rect('.roll-panel'), notes = rect('.roll-viewport'), pedals = rect('.pedal-viewport');
        return { width: innerWidth, height: innerHeight, noteHeight: notes.height, panelBottom: panel.bottom,
          pedalBottom: pedals.bottom, rowHeight: rect('.roll-row').height,
          laneHeights: [...document.querySelectorAll('.pedal-canvas')].map(e => e.getBoundingClientRect().height),
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          verticalOverflow: document.documentElement.scrollHeight > innerHeight,
          helpHidden: !document.querySelector('#roll-help').matches(':popover-open') };
      });
      const safeMinimumScroll = size.width === 1280 && metrics.verticalOverflow && metrics.noteHeight <= 185;
      check(!metrics.horizontalOverflow && (!metrics.verticalOverflow || safeMinimumScroll) && metrics.pedalBottom <= metrics.panelBottom && metrics.noteHeight >= 180, 'Editor clipped/overflowed before content minimum: ' + JSON.stringify(metrics));
      metrics.intentionalMinimumScroll = safeMinimumScroll;
      check(metrics.laneHeights.every(h => h === metrics.rowHeight && h === 22), 'Pedal/key rows differ');
      layout.push(metrics);
      if (size.width === 1910 && process.env.AUDIO_LOOPER_SCREENSHOT)
        await page.screenshot({ path: process.env.AUDIO_LOOPER_SCREENSHOT, fullPage: true });
    }
    check(!errors.length, errors.join(';'));
    return { passed: true, areas: ['toolbar/default/help', 'pedals/history/data/guard/scroll', 'desktop/laptop-height'], layout, errors, synthetic: true };
  } finally { await context.close(); }
}
