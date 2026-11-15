# Architektur

## Einstieg und Features

- `src/main.ts` bootstrapped die Standalone-Root `src/app/app.ts`. Sie wählt anhand des bestehenden URL-Parameters bzw. `looper-mode` das MIDI- oder Audio-Feature.
- `src/app/features/midi/`: `MidiLooper` komponiert Routing, Metronom, fünf `MidiTrack`-Instanzen, Piano und Einstellungen. `MidiWorkspace` besitzt die Session, Transport-Aktionen, Keyboard-/Pedalsteuerung und deren Ressourcen.
- `src/app/features/audio/`: `AudioLooper` komponiert Routing, Input FX, Metronom, fünf `AudioTrack`-Instanzen, FX-Details, Kalibrierung und Einstellungen. `AudioWorkspace` koordiniert diese Ansichten; `AudioSession` kapselt Geräte, AudioContext, Worklet-Kommunikation, FX- und Korrekturprofile.
- `src/app/shared/`: gemeinsame Tempo-, Shortcut- und Persistenzfunktionen. `shared/ui/` enthält Header, Moduswahl, Info-Tooltip, Tempo-Auswahl und Instrument-Fokusverhalten.
- `public/audio/`: direkt ladbare Worklets und gemeinsame PCM-/DSP-Module. Der generierte SpessaSynth-Processor bleibt ein versionsgebundenes Asset, kein Angular-Component-Code.

Dateien folgen der aktuellen Angular-Namenskonvention ohne `.component.ts`-/`.service.ts`-Suffix. Komponenten sind an `@Component`, Services an `@Injectable` erkennbar. Es gibt keine NgModules und keinen zusätzlichen Router für den bisherigen, bewusst neu ladenden Moduswechsel.

## State und Lifecycle

- Beide Workspace-Services werden **am jeweiligen Feature** bereitgestellt. Dadurch teilen dessen Komponenten dieselbe Session; Angular ruft beim Abbau `ngOnDestroy` auf. Worker, Animation, MIDI-/Browser-Listener und Audio-Ressourcen werden dort freigegeben.
- Keyboard-Events laufen über deklarative `host`-Bindings der Feature-Komponenten. Damit entfernt Angular sie zusammen mit der Ansicht. Bestehende Shortcut-, Wiederholungs- und Dialogregeln bleiben erhalten.
- Die Echtzeit-Engines bleiben bewusst normale, mutable TypeScript-/JavaScript-Objekte. MIDI wird weiterhin über absolute Zeitpunkte und Worker-Wecksignale geplant, PCM im AudioWorklet. Signals übernehmen **keine musikalische Zeitplanung**.
- Eine Signal-Revision an der Workspace-Grenze veröffentlicht Änderungen an die UI. `view` liefert denselben Workspace mit expliziter Invalidierung, ohne Engines, Audio-Daten oder Track-Identitäten zu kopieren. UI-Aktionen und externe Session-Callbacks lösen diese Aktualisierung aus. Das ist ein Adapter für die bestehenden Engines, kein vollständig immutable Signal-Store.
- Wiederverwendbare Komponenten nutzen `input()`, `output()` und `model()`, der Tooltip lokalen Signal-State. Standalone und OnPush sind die Defaults von Angular 22; entsprechende redundante Decorator-Flags entfallen.
- Bestehende `ngModel`-Controls bleiben erhalten. Ein Wechsel des Formularmodells wäre ein separater Verhaltensumbau und gehört nicht zum strukturellen Refactoring.

## DOM und Styles

- Feature-Teile wie `article[app-midi-track]` und `section[app-audio-routing]` verwenden Attribute-Selectors auf den bisherigen Elementen. Es entstehen keine zusätzlichen Grid-/Flex-Wrapper; IDs, ARIA-Bezüge, Event-Bubbling und Fokusziele bleiben erhalten.
- `src/styles/` enthält das gemeinsame visuelle System mit Workspace-, Audio- und Performance-Card-Regeln. Die vorhandene Cascade und Media Queries wurden beibehalten, nicht parallel zum Komponentenumbau neu gestaltet. Keine `ViewEncapsulation.None`- oder `::ng-deep`-Ausnahmen.
- Prettier-Konfiguration und EditorConfig vereinheitlichen TypeScript, Angular-Templates, CSS und die selbst geschriebenen Audio-Module. Vendor-/generierte Assets und Soundfonts sind ausgenommen.

## Entwicklung und Nachweise

- `.\yarn.cmd build`: Production-Build einschließlich Vorbereitung der Audio-Assets.
- `.\yarn.cmd test:refactor`: drei fokussierte Angular-/Engine-Integrationstests über den offiziellen Angular-Test-Builder mit Vitest und Happy DOM. Angular kompiliert dabei auch Signal-Inputs und externe Templates.
- `.\yarn.cmd test:unit src/tests/fixed-length.test.ts`: gezielt einen bestehenden Domain-Test ausführen. `.\yarn.cmd test` führt den gesamten Bestand und anschließend die drei Angular-Tests aus; nicht als Standardprüfung nach jeder Änderung verwenden.
- `.\yarn.cmd format` bzw. `.\yarn.cmd format:check`: reproduzierbarer Code Style.
- `tsconfig.json` enthält ausschließlich App-Code; `tsconfig.spec.json` ergänzt den gezielten Angular-Test. Test-Helfer werden nicht in den App-Build aufgenommen.

Storage-Keys, Geräteprofile, Soundfont-URLs, Worker-/Worklet-Protokolle und Reload-Verhalten bleiben kompatibel. Änderungen an NAS, Firewall, Startskripten oder Deployment sind nicht Teil dieses Refactorings. Konkrete Prüfergebnisse und Grenzen stehen in `VERIFICATION.md`.
