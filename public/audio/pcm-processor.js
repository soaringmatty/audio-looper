import { PCMEngine } from './pcm-engine.js';
class PCMLooperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new PCMEngine(sampleRate);
    this.nextReport = 0;
    this.port.onmessage = ({ data }) => {
      this.engine.command(data);
      this.port.postMessage({ type: 'state', state: this.engine.snapshot(), ack: data.ack });
    };
  }
  process(inputs, outputs) {
    this.engine.render(inputs[0] ?? [], outputs[0], currentFrame);
    const c = this.engine.calibration;
    if (c?.done) {
      this.engine.calibration = null;
      this.port.postMessage(
        {
          type: 'calibration',
          method: c.method,
          samples: c.samples,
          starts: c.starts,
          rate: sampleRate,
        },
        [c.samples.buffer],
      );
    }
    if (currentFrame >= this.nextReport) {
      this.nextReport = currentFrame + sampleRate / 30;
      this.port.postMessage({ type: 'state', state: this.engine.snapshot() });
    }
    return true;
  }
}
registerProcessor('pcm-looper', PCMLooperProcessor);
