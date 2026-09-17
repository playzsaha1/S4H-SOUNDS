function encodeWav(audioBuffer) {
      const numberOfChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;
      const format = 1;
      const bitDepth = 16;
      const bytesPerSample = bitDepth / 8;
      const blockAlign = numberOfChannels * bytesPerSample;
      const dataLength = audioBuffer.length * blockAlign;
      const arrayBuffer = new ArrayBuffer(44 + dataLength);
      const view = new DataView(arrayBuffer);

      const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) {
          view.setUint8(offset + i, text.charCodeAt(i));
        }
      };

      writeString(0, 'RIFF');
      view.setUint32(4, 36 + dataLength, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, format, true);
      view.setUint16(22, numberOfChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * blockAlign, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitDepth, true);
      writeString(36, 'data');
      view.setUint32(40, dataLength, true);

      let offset = 44;
      for (let i = 0; i < audioBuffer.length; i += 1) {
        for (let channel = 0; channel < numberOfChannels; channel += 1) {
          const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[i]));
          view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
          offset += 2;
        }
      }

      return new Blob([arrayBuffer], { type: 'audio/wav' });
    }

self.onmessage = ({ data }) => {
  try {
    const { channels, sampleRate, length } = data;
    const blob = encodeWav({ numberOfChannels: channels.length, sampleRate, length,
      getChannelData: index => channels[index] });
    self.postMessage({ blob });
  } catch { self.postMessage({ error: 'WAV encoding failed. Try a smaller file.' }); }
};
