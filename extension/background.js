// Background Service Worker

// Keep track of the active session state in storage
const INITIAL_STATE = {
  status: 'ready', // 'ready', 'recording', 'processing', 'completed', 'error'
  sessionId: null,
  summary: null,
  errorMsg: null
};

// Reset state on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set(INITIAL_STATE);
});

// Listen for messages from popup or offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_RECORDING') {
    startCaptureFlow().catch(err => {
      console.error('Failed to start capture:', err);
      chrome.storage.local.set({ status: 'error', errorMsg: err.message });
    });
    sendResponse({ success: true });
  } else if (message.type === 'STOP_RECORDING') {
    stopCaptureFlow().catch(err => {
      console.error('Failed to stop capture:', err);
    });
    sendResponse({ success: true });
  }
  return true;
});

async function startCaptureFlow() {
  // 1. Set status to starting
  await chrome.storage.local.set({ status: 'recording', errorMsg: null, summary: null });

  try {
    // 2. Get active tab ID
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      throw new Error('No active tab found.');
    }

    // 3. Get Media Stream ID for the active tab audio
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    if (!streamId) {
      throw new Error('Failed to get media stream ID from tab.');
    }

    // 4. Create offscreen document if it doesn't exist
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture and process tab audio and physical microphone stream.',
      });
    }

    // 5. Read backend URL configuration (default to localhost)
    const settings = await chrome.storage.local.get(['apiUrl']);
    const apiUrl = settings.apiUrl || 'http://127.0.0.1:3000';

    // 6. Send start message with streamId to the offscreen document
    // We delay slightly to ensure the document is fully loaded and listening
    setTimeout(() => {
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'START_OFFSCREEN_CAPTURE',
        streamId,
        apiUrl
      });
    }, 500);

  } catch (error) {
    console.error('Capture flow error:', error);
    await chrome.storage.local.set({ status: 'error', errorMsg: error.message });
    await closeOffscreenDocument();
  }
}

async function stopCaptureFlow() {
  await chrome.storage.local.set({ status: 'processing' });
  
  // Send stop trigger to offscreen
  try {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'STOP_OFFSCREEN_CAPTURE'
    });
  } catch (err) {
    console.error('Error telling offscreen to stop:', err);
    await chrome.storage.local.set({ status: 'error', errorMsg: 'Failed to stop offscreen capture.' });
  }
}

// Helper to close offscreen document
async function closeOffscreenDocument() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) {
    await chrome.offscreen.closeDocument();
  }
}
