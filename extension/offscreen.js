// Offscreen Audio Recording Engine

let audioContext = null;
let tabSource = null;
let micSource = null;
let processorNode = null;
let tabStream = null;
let micStream = null;
let sessionId = null;
let apiUrl = null;
let chunkInterval = null;
let audioBufferQueue = [];

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'START_OFFSCREEN_CAPTURE') {
    startCapture(message.streamId, message.apiUrl).catch(err => {
      console.error('Offscreen capture error:', err);
      chrome.storage.local.set({ status: 'error', errorMsg: err.message });
      stopAndCleanup();
    });
  } else if (message.type === 'STOP_OFFSCREEN_CAPTURE') {
    stopAndGenerate().catch(err => {
      console.error('Offscreen stop error:', err);
      chrome.storage.local.set({ status: 'error', errorMsg: err.message });
      stopAndCleanup();
    });
  }
});

async function startCapture(streamId, targetApiUrl) {
  apiUrl = targetApiUrl;
  audioBufferQueue = [];

  // 1. Capture the tab audio using the stream ID
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false // We only want audio
  });

  // 2. Capture the user's physical microphone
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false
  });

  // 3. Initialize the backend session
  const startResponse = await fetch(`${apiUrl}/api/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sampleRate: 16000,
      channels: 1,
      bitDepth: 16
    })
  });

  if (!startResponse.ok) {
    throw new Error('Failed to start session on backend.');
  }

  const startData = await startResponse.json();
  sessionId = startData.sessionId;
  await chrome.storage.local.set({ sessionId });

  // 4. Setup AudioContext at 16kHz for auto-downsampling
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

  tabSource = audioContext.createMediaStreamSource(tabStream);
  micSource = audioContext.createMediaStreamSource(micStream);

  // Connect tab audio to speakers (so user can hear the meeting)
  tabSource.connect(audioContext.destination);

  // Setup raw PCM script processor
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);

  // Mix both streams into the recorder processor
  tabSource.connect(processorNode);
  micSource.connect(processorNode);

  // Must connect processor to destination so audio process events fire
  // We connect it to a gain node set to 0 volume so it is silent, avoiding loopbacks/echoes
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  processorNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  // 5. Audio Process Handler (Float32 -> Int16 conversion)
  processorNode.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);
    const pcmBuffer = new Int16Array(inputData.length);
    
    for (let i = 0; i < inputData.length; i++) {
      let s = Math.max(-1, Math.min(1, inputData[i]));
      pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    audioBufferQueue.push(pcmBuffer.buffer);
  };

  // 6. Stream chunks to backend every 3 seconds
  chunkInterval = setInterval(sendQueuedChunks, 3000);

  console.log(`[Offscreen] Recording started. Session ID: ${sessionId}`);
}

async function sendQueuedChunks() {
  if (audioBufferQueue.length === 0 || !sessionId || !apiUrl) return;

  const totalLength = audioBufferQueue.reduce((acc, buf) => acc + buf.byteLength, 0);
  const combinedBuffer = new Uint8Array(totalLength);

  let offset = 0;
  for (const buf of audioBufferQueue) {
    combinedBuffer.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  audioBufferQueue = [];

  try {
    const response = await fetch(`${apiUrl}/api/session/${sessionId}/chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: combinedBuffer
    });

    if (!response.ok) {
      console.error('[Offscreen] Failed to upload chunk to backend.');
    }
  } catch (err) {
    console.error('[Offscreen] Network error uploading chunk:', err);
  }
}

async function stopAndGenerate() {
  console.log('[Offscreen] Stopping recording...');
  
  // 1. Clear timing and intervals
  clearInterval(chunkInterval);

  // 2. Stop audio tracks
  if (processorNode) {
    processorNode.disconnect();
  }
  if (tabSource) {
    tabSource.disconnect();
  }
  if (micSource) {
    micSource.disconnect();
  }
  if (audioContext) {
    await audioContext.close();
  }

  if (tabStream) {
    tabStream.getTracks().forEach(track => track.stop());
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
  }

  // 3. Send final buffered chunks
  await sendQueuedChunks();

  // 4. Request summary notes from backend
  try {
    const generateResponse = await fetch(`${apiUrl}/api/session/${sessionId}/generate`, {
      method: 'POST'
    });

    if (!generateResponse.ok) {
      const errData = await generateResponse.json();
      throw new Error(errData.detail || 'Failed to generate meeting notes.');
    }

    const data = await generateResponse.json();
    
    // Save final summary in extension storage
    await chrome.storage.local.set({
      status: 'completed',
      summary: data.summary
    });

  } catch (error) {
    console.error('[Offscreen] Summary generation failed:', error);
    await chrome.storage.local.set({
      status: 'error',
      errorMsg: error.message
    });
  } finally {
    stopAndCleanup();
  }
}

function stopAndCleanup() {
  // Reset local variables
  audioContext = null;
  tabSource = null;
  micSource = null;
  processorNode = null;
  tabStream = null;
  micStream = null;
  sessionId = null;
  apiUrl = null;
  chunkInterval = null;
  audioBufferQueue = [];

  // Close the offscreen document
  chrome.offscreen.closeDocument();
}
