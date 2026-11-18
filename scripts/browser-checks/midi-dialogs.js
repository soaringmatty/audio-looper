// Focused Playwright check: run with browser_run_code_unsafe filename.
// Uses a fresh isolated context, empty MIDI ports and synthetic timing; no hardware access.
async (host) => {
  const ctx = await host
    .context()
    .browser()
    .newContext({ viewport: { width: 1910, height: 900 } });
  const page = await ctx.newPage(),
    errors = [],
    results = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    navigator.requestMIDIAccess = async () => ({
      inputs: new Map(),
      outputs: new Map(),
      onstatechange: null,
    });
  });
  const check = (v, m) => {
    if (!v) throw Error(m);
  };
  const settle = () =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const geometry = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [
          '.setup-grid',
          '.metronome-card',
          '.tempo-control-slot',
          '.metro-secondary',
          '.tracks',
          '.piano-dock',
        ].map((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return [s, { top: r.top, height: r.height }];
        }),
      ),
    );
  try {
    await page.goto('http://127.0.0.1:4200/?mode=midi');
    await page.locator('.route-calibration').waitFor();
    await page.evaluate(() => {
      const vm = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
      vm.worker.terminate();
      cancelAnimationFrame(vm.animation);
    });
    await page.waitForFunction(
      () =>
        ng.getComponent(document.querySelector('app-midi-looper')).workspace.audioStatus ===
        'Startet beim Spielen',
    );
    await settle();
    // 1. Three compact, aligned desktop cards, one routing footer row.
    const desktop = await page.locator('.setup-grid').evaluate((e) => {
      const rect = (x) => {
        const r = x.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      };
      return {
        cards: [...e.children].map(rect),
        footer: [...e.querySelector('.route-status').children].map(rect),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check(
      !desktop.overflow &&
        desktop.cards.every((r) => r.height === desktop.cards[0].height) &&
        desktop.cards[0].height < 190,
      'Desktop cards not compact/aligned',
    );
    check(
      Math.max(...desktop.footer.map((r) => r.top)) <
        Math.min(...desktop.footer.map((r) => r.bottom)),
      'Routing footer wraps on desktop',
    );
    check((await page.locator('.timing-setup').count()) === 0, 'Old timing footer remains');
    check(
      !(await page
        .locator('.route-calibration')
        .innerText()
        .then((t) => t.includes('0 ms'))),
      'Missing result shown as measured zero',
    );
    // Settings must release inert and return actual keyboard control, not just disappear.
    const settings = [];
    for (const close of ['escape', 'button', 'backdrop']) {
      await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
      await page.locator('#close-settings').waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'close-settings');
      await page.keyboard.press('Shift+Tab');
      check(
        await page.locator('.settings-panel').evaluate((e) => e.contains(document.activeElement)),
        'Settings focus escaped',
      );
      if (close === 'escape') await page.keyboard.press('Escape');
      else if (close === 'button') await page.locator('#close-settings').click();
      else await page.locator('.settings-backdrop').click({ position: { x: 2, y: 2 } });
      await page.locator('.settings-panel').waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () =>
          document.activeElement === document.querySelector('main[data-performance]') &&
          !document.activeElement.inert,
        {},
        { timeout: 2000 },
      );
      await page.keyboard.press('Digit2');
      check(
        await page.evaluate(
          () =>
            ng.getComponent(document.querySelector('app-midi-looper')).workspace.engine.selected ===
            1,
        ),
        'Track shortcut lost after ' + close,
      );
      await page.keyboard.press('Digit1');
      settings.push(close);
    }
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    await page.getByRole('button', { name: 'Diagnose', exact: true }).click();
    await page.getByRole('button', { name: 'Kalibrierung öffnen', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Kalibrierung öffnen', exact: true }).click();
    await page.locator('app-midi-timing-dialog dialog[open]').waitFor();
    await settle();
    check(
      await page.locator('dialog[open]').evaluate((e) => e.contains(document.activeElement)),
      'Settings teardown stole modal focus',
    );
    await page.keyboard.press('Escape');
    await page.locator('app-midi-timing-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => document.activeElement === document.querySelector('main[data-performance]'),
      {},
      { timeout: 2000 },
    );
    results.push({ case: 'Settings focus / dialog handoff / desktop routing', settings, desktop });
    // 2. Narrow layouts, accessible modal containment / focus / escape.
    const narrow = [];
    for (const width of [960, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await settle();
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Page overflow ' + width,
      );
      await page.getByRole('button', { name: 'Kalibrieren', exact: true }).click();
      await page.locator('app-midi-timing-dialog dialog[open]').waitFor();
      await settle();
      const r = await page.locator('app-midi-timing-dialog dialog').evaluate((e) => {
        const r = e.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          overflow: e.scrollWidth > e.clientWidth,
        };
      });
      check(
        r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= 900 && !r.overflow,
        'Dialog overflow ' + width,
      );
      await page.keyboard.press('Shift+Tab');
      check(
        await page
          .locator('app-midi-timing-dialog dialog')
          .evaluate((e) => e.contains(document.activeElement)),
        'Focus escaped dialog',
      );
      await page.keyboard.press('Escape');
      await page.locator('app-midi-timing-dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.tagName === 'MAIN');
      check(
        await page.locator('main').evaluate((e) => e === document.activeElement && !e.inert),
        'Performance focus not restored',
      );
      narrow.push({ width, dialog: r });
    }
    results.push({ case: 'Narrow layouts and native modal focus', narrow });
    // 3. Real start/cancel/result flow with synthetic timing input; piano keys
    // forwarded while transport/pedal shortcuts remain blocked, stable tempo slot.
    await page.setViewportSize({ width: 1910, height: 900 });
    await settle();
    await page.evaluate(() => {
      const vm = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
      vm.midi.outputId = '';
      vm.metro.enabled = true;
      vm.metro.origin = 0;
      vm.now = () => 2000;
      vm.testNotes = [];
      vm.piano.downNote = (source, note) => vm.testNotes.push({ source, note });
      vm.refresh();
    });
    await page.getByRole('button', { name: 'Kalibrieren', exact: true }).click();
    await page.locator('dialog[open]').waitFor();
    await page.getByRole('button', { name: 'Messung starten', exact: true }).click();
    await page.waitForFunction(
      () => ng.getComponent(document.querySelector('app-midi-looper')).workspace.timing.active,
    );
    await page.keyboard.press('KeyZ');
    await page.keyboard.press('Digit1');
    await page.keyboard.press('KeyT');
    check(
      await page.evaluate(() => {
        const vm = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
        vm.midi.onLoopPedal();
        return vm.testNotes.length === 1 && !vm.engine.busy && vm.timing.active && vm.metro.enabled;
      }),
      'Piano keys blocked or recording shortcut active',
    );
    await page.getByRole('button', { name: 'Messung abbrechen', exact: true }).click();
    check(
      await page.evaluate(
        () => !ng.getComponent(document.querySelector('app-midi-looper')).workspace.timing.active,
      ),
      'Cancel failed',
    );
    await page.getByRole('button', { name: 'Messung starten', exact: true }).click();
    const result = await page.evaluate(() => {
      const vm = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
      for (let i = 0; i < 6; i++)
        vm.timing.input(3000 + i * 500 + [-30, -20, -10, -20, -30, -20][i]);
      vm.syncMetronomeAdvance();
      vm.refresh();
      return vm.timing.result;
    });
    await settle();
    check(result.samples === 6 && result.offsetMs === -20, 'Synthetic measurement failed');
    check(
      (await page.locator('.measurement-result').innerText()).includes('Streuung'),
      'Result quality missing from dialog',
    );
    await page.getByRole('button', { name: 'Erneut messen', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('app-midi-timing-dialog').waitFor({ state: 'hidden' });
    check(
      await page.evaluate(
        () => !ng.getComponent(document.querySelector('app-midi-looper')).workspace.timing.active,
      ),
      'Close did not cancel measurement',
    );
    const summary = await page.locator('.route-calibration').innerText();
    check(summary.includes('-20') && !summary.includes('Streuung'), 'Main summary incorrect');
    const before = await geometry();
    await page.evaluate(() => {
      const vm = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
      vm.tempoCandidates = [{ bpm: 120, bars: 2, beats: 4, denominator: 4, score: 0 }];
      vm.tempoConfirmed = false;
      vm.engine.reference = 4000;
      vm.refresh();
    });
    await settle();
    const choosing = await geometry();
    check(JSON.stringify(before) === JSON.stringify(choosing), 'Tempo suggestions shift layout');
    await page
      .getByRole('combobox', { name: 'Tempo-Vorschlag', exact: true })
      .selectOption({ label: '120 BPM · 4/4 · 2 Takte' });
    await settle();
    check(
      await page.evaluate(() => {
        const vm = ng.getComponent(document.querySelector('app-midi-looper')).workspace;
        return vm.tempoConfirmed && vm.engine.bpm === 120 && !vm.showTempoChoice;
      }),
      'Tempo choice not applied',
    );
    const after = await geometry();
    check(JSON.stringify(before) === JSON.stringify(after), 'Tempo selection shifts layout');
    await page.getByRole('button', { name: 'Kalibrieren', exact: true }).click();
    await page.locator('dialog[open]').waitFor();
    await page.getByRole('button', { name: 'Schließen', exact: true }).click();
    results.push({
      case: 'Calibration lifecycle / keys / stable tempo',
      result,
      summary,
      before,
      choosing,
      after,
    });
    check(errors.length === 0, errors.join('; '));
    return { results, pageErrors: errors };
  } finally {
    await ctx.close();
  }
}
