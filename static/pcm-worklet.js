// Collects mono microphone samples into ~100 ms float32 chunks and posts them
// to the main thread, which forwards them to the server over the WebSocket.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.round(sampleRate * 0.1);
    this.chunk = new Float32Array(this.chunkSize);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.chunk[this.filled++] = channel[i];
        if (this.filled === this.chunkSize) {
          const out = this.chunk;
          this.port.postMessage(out, [out.buffer]);
          // Not out.length: transferring the buffer detaches it, so that reads 0.
          this.chunk = new Float32Array(this.chunkSize);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
