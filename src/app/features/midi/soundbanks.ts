export const SOUND_BANKS = [
  {
    id: 'generaluser',
    name: 'GeneralUser GS 2.0.3',
    file: 'generaluser-gs-2.0.3.sf2',
    bytes: 32319396,
    version: '9575028c7a1f589f',
    license: 'GeneralUser-LICENSE.txt',
  },
  {
    id: 'fluidr3',
    name: 'FluidR3 GM',
    file: 'fluidr3-gm.sf2',
    bytes: 148398306,
    version: '74594e8f4250680a',
    license: 'FluidR3-COPYING.txt',
  },
] as const;
export type SoundBankId = (typeof SOUND_BANKS)[number]['id'];
export class SoundBankLoader {
  private inflight = new Map<string, Promise<ArrayBuffer>>();
  async load(id: SoundBankId, progress: (text: string) => void = () => {}): Promise<ArrayBuffer> {
    const bank = SOUND_BANKS.find((b) => b.id === id)!;
    const existing = this.inflight.get(id);
    if (existing) return (await existing).slice(0);
    const promise = (async () => {
      const url = new URL(`soundfonts/${bank.file}?v=${bank.version}`, document.baseURI).href;
      let cache: Cache | undefined;
      try {
        cache = await caches.open('audio-looper-sf2-v1');
      } catch {
        /* Optional storage. */
      }
      let response: Response | undefined;
      try {
        response = await cache?.match(url);
      } catch {
        /* Fall through. */
      }
      if (response) {
        progress('Soundbank aus Browser-Cache');
        return response.arrayBuffer();
      }
      progress('Soundbank wird geladen …');
      response = await fetch(url);
      if (!response.ok) throw Error(`Soundbank HTTP ${response.status}`);
      const reader = response.body?.getReader();
      let data: ArrayBuffer;
      if (reader) {
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          progress(`Soundbank ${Math.round((loaded / bank.bytes) * 100)} %`);
        }
        const bytes = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        data = bytes.buffer;
      } else data = await response.arrayBuffer();
      if (data.byteLength !== bank.bytes) throw Error('Unvollständige Soundbank');
      try {
        await cache?.put(
          url,
          new Response(data.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } }),
        );
      } catch {
        /* Playable without cache. */
      }
      return data;
    })();
    this.inflight.set(id, promise);
    try {
      return (await promise).slice(0);
    } finally {
      this.inflight.delete(id);
    }
  }
}
