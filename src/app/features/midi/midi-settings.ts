import { Component, inject, OnDestroy } from '@angular/core';
import { MidiWorkspace } from './midi-workspace';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { InfoHint } from '../../shared/ui/info-hint';
import { focusPerformance } from '../../shared/ui/performance-focus';

@Component({
  selector: 'section[app-midi-settings]',
  imports: [FormsModule, DecimalPipe, InfoHint],
  templateUrl: './midi-settings.html',
})
export class MidiSettings implements OnDestroy {
  readonly workspace = inject(MidiWorkspace);

  ngOnDestroy(): void {
    // Wait until the same render has removed the panel and main's inert flag.
    // Do not steal focus when settings are replaced by another dialog.
    queueMicrotask(() => {
      const vm = this.workspace;
      if (!vm.settingsOpen && !vm.timingOpen && !vm.resetOpen && !vm.pendingProject)
        focusPerformance();
    });
  }
}
