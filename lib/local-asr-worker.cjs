// Keep the native recognizer in a child process so an addon failure cannot close Study Desk.
const path = require('node:path');
const sherpa = require(path.join(__dirname, '..', 'local-asr', 'node_modules', 'sherpa-onnx-node'));
const model = process.argv[2];
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    paraformer: { encoder: path.join(model, 'encoder.int8.onnx'), decoder: path.join(model, 'decoder.int8.onnx') },
    tokens: path.join(model, 'tokens.txt'), numThreads: 2, provider: 'cpu',
  },
  decodingMethod: 'greedy_search', enableEndpoint: true,
  rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2,
  rule3MinUtteranceLength: 20,
});
const stream = recognizer.createStream();
let samplesSeen = 0;
let segmentStart = 0;
let lastText = '';
let stopped = false;
const emit = (type, text, endMs) => process.send?.({ type, text, t0: Math.round(segmentStart / 16), t1: endMs });
function decode() {
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = recognizer.getResult(stream).text.trim();
  const endMs = Math.round(samplesSeen / 16);
  if (text && text !== lastText) { lastText = text; emit('partial', text, endMs); }
  if (recognizer.isEndpoint(stream)) {
    if (text) emit('final', text, endMs);
    recognizer.reset(stream);
    lastText = '';
    segmentStart = samplesSeen;
  }
}
process.on('message', msg => {
  try {
    if (msg.type === 'audio' && !stopped) {
      const pcm = Buffer.from(msg.pcm, 'base64');
      const samples = new Float32Array(pcm.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
      samplesSeen += samples.length;
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      decode();
    } else if (msg.type === 'stop' && !stopped) {
      stopped = true;
      stream.inputFinished();
      decode();
      const text = recognizer.getResult(stream).text.trim();
      if (text) emit('final', text, Math.round(samplesSeen / 16));
      process.send?.({ type: 'done', durationMs: Math.round(samplesSeen / 16) });
    }
  } catch (error) {
    process.send?.({ type: 'error', message: String(error.message || error) });
    process.exitCode = 1;
  }
});
process.on('disconnect', () => process.exit(0));
process.send?.({ type: 'ready' });
