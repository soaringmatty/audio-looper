export interface TraceEntry {
  seq: number;
  at: number;
  kind: string;
  detail: unknown;
}
export interface TraceDocument {
  version: 1;
  session: string;
  savedAt: string;
  reason: string;
  snapshot: unknown;
  events: TraceEntry[];
}

/** Bounded in-memory capture; IndexedDB writes happen outside the MIDI callback. No audio or uploads. */
export class MidiTrace {
  enabled = true;
  status = 'MIDI-Trace lokal aktiv';
  private readonly session = new Date().toISOString();
  private events: TraceEntry[] = [];
  private seq = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private db?: Promise<IDBDatabase | undefined>;
  private previous?: TraceDocument;
  private snapshot: () => unknown = () => ({});
  constructor() {
    try {
      this.enabled = localStorage.getItem('midi-trace-enabled') !== 'false';
    } catch {}
    this.db = this.open();
    if (!this.enabled) this.status = 'MIDI-Trace pausiert';
    void this.read('latest').then((value) => {
      this.previous = value;
    });
  }
  configure(snapshot: () => unknown): void {
    this.snapshot = snapshot;
  }
  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      localStorage.setItem('midi-trace-enabled', String(value));
    } catch {}
    this.status = value ? 'MIDI-Trace lokal aktiv' : 'MIDI-Trace pausiert';
    if (value)
      void this.db?.then((db) => {
        if (this.enabled && !db)
          this.status = 'Trace nur im RAM: lokales Speichern nicht verfügbar';
      });
  }
  record(kind: string, detail: unknown, at = performance.now()): void {
    if (!this.enabled) return;
    this.events.push({ seq: ++this.seq, at, kind, detail });
    if (this.events.length > 8192) this.events.splice(0, 1024);
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.save('latest', 'periodic');
      }, 2000);
  }
  document(reason: string): TraceDocument {
    return {
      version: 1,
      session: this.session,
      savedAt: new Date().toISOString(),
      reason,
      snapshot: this.snapshot(),
      events: [...this.events],
    };
  }
  checkpoint(reason: string, incident = false): void {
    if (!this.enabled) return;
    this.record('checkpoint', { reason });
    // JSON cloning is deferred together with persistence, never done inside MIDI receive().
    queueMicrotask(() => void this.save(incident ? 'incident' : 'latest', reason));
  }
  private open(): Promise<IDBDatabase | undefined> {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        this.status = 'Trace nur im RAM: IndexedDB nicht verfügbar';
        resolve(undefined);
        return;
      }
      try {
        const request = indexedDB.open('audio-looper-midi-trace-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('checkpoints');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          this.status = 'Trace nur im RAM: lokales Speichern fehlgeschlagen';
          resolve(undefined);
        };
        request.onblocked = () => {
          this.status = 'Trace-Speicher blockiert';
          resolve(undefined);
        };
      } catch {
        this.status = 'Trace nur im RAM: lokales Speichern nicht verfügbar';
        resolve(undefined);
      }
    });
  }
  async read(key: string): Promise<TraceDocument | undefined> {
    const db = await this.db;
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const request = db
          .transaction('checkpoints', 'readonly')
          .objectStore('checkpoints')
          .get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }
  async save(key: string, reason: string): Promise<void> {
    if (!this.enabled && reason !== 'export') return;
    const value = this.document(reason);
    const db = await this.db;
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction('checkpoints', 'readwrite');
        tx.objectStore('checkpoints').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => {
          this.status = 'Trace nur im RAM: Speichern fehlgeschlagen';
          resolve();
        };
      } catch {
        this.status = 'Trace nur im RAM: Speichern fehlgeschlagen';
        resolve();
      }
    });
  }
  async exportData(): Promise<unknown> {
    await this.save('latest', 'export');
    return {
      format: 'audio-looper-midi-trace',
      version: 1,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      current: this.document('export'),
      previous: this.previous,
      incident: await this.read('incident'),
      limitation:
        'External send/clear records are API acceptance, not acknowledgement from the MIDI instrument. MIDI notes and device names are included; no audio.',
    };
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    void this.save('latest', 'dispose').then(async () => (await this.db)?.close());
  }
}
