// Popup UI Logic

const btnAction = document.getElementById('btnAction');
const btnSettings = document.getElementById('btnSettings');
const btnCopy = document.getElementById('btnCopy');
const settingsPanel = document.getElementById('settingsPanel');
const apiUrlInput = document.getElementById('apiUrl');
const timerText = document.getElementById('timer');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const summaryCard = document.getElementById('summaryCard');
const summaryContent = document.getElementById('summaryContent');

let timerInterval = null;

// Initialize Popup
document.addEventListener('DOMContentLoaded', async () => {
  // Load state and settings
  const state = await chrome.storage.local.get(['status', 'apiUrl', 'recordingStartTime', 'summary', 'errorMsg']);
  
  // Set API URL
  const apiUrl = state.apiUrl || 'http://127.0.0.1:3000';
  apiUrlInput.value = apiUrl;
  if (!state.apiUrl) {
    await chrome.storage.local.set({ apiUrl });
  }

  updateUI(state);

  // Bind settings input
  apiUrlInput.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ apiUrl: e.target.value.trim() });
  });

  // Bind settings panel toggle
  btnSettings.addEventListener('click', () => {
    settingsPanel.classList.toggle('visible');
  });

  // Bind primary action button
  btnAction.addEventListener('click', handleActionClick);

  // Bind copy button
  btnCopy.addEventListener('click', copyMarkdown);
});

// Reactively listen for background state updates (completed, error, etc.)
chrome.storage.onChanged.addListener((changes) => {
  chrome.storage.local.get(['status', 'recordingStartTime', 'summary', 'errorMsg'], (state) => {
    updateUI(state);
  });
});

function formatTime(seconds) {
  const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function updateUI(state) {
  const status = state.status || 'ready';
  
  // Reset visual badge styles
  statusBadge.className = 'status-badge status-' + status;
  clearInterval(timerInterval);
  timerInterval = null;

  // Clear timers text if not recording
  if (status !== 'recording') {
    timerText.textContent = '00:00';
  }

  // Hide summary card by default
  summaryCard.classList.remove('visible');

  if (status === 'ready') {
    statusText.textContent = 'Ready';
    btnAction.disabled = false;
    btnAction.className = 'btn btn-start';
    btnAction.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
      <span>Record Meeting Audio</span>
    `;
  } 
  
  else if (status === 'recording') {
    statusText.textContent = 'Recording tab & mic...';
    btnAction.disabled = false;
    btnAction.className = 'btn btn-stop';
    btnAction.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>
      <span>Stop & Generate Notes</span>
    `;

    // Start timer calculations
    const startTime = state.recordingStartTime || Date.now();
    const updateTimer = () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      timerText.textContent = formatTime(elapsed);
    };
    updateTimer(); // Initial call
    timerInterval = setInterval(updateTimer, 1000);
  } 
  
  else if (status === 'processing') {
    statusText.textContent = 'Generating Notes...';
    btnAction.disabled = true;
    btnAction.className = 'btn btn-start';
    btnAction.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
      <span>Processing...</span>
    `;
  } 
  
  else if (status === 'completed') {
    statusText.textContent = 'Notes Generated';
    btnAction.disabled = false;
    btnAction.className = 'btn btn-start';
    btnAction.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
      <span>Record New Session</span>
    `;

    // Render markdown notes
    if (state.summary) {
      summaryContent.innerHTML = typeof marked !== 'undefined' 
        ? marked.parse(state.summary) 
        : state.summary.replace(/\n/g, '<br>');
      summaryCard.classList.add('visible');
    }
  } 
  
  else if (status === 'error') {
    statusText.textContent = 'Error';
    btnAction.disabled = false;
    btnAction.className = 'btn btn-start';
    btnAction.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
      <span>Retry Session</span>
    `;
    
    // Display error message
    summaryContent.innerHTML = `<span style="color: var(--accent-red); font-weight: 500;">Failed: ${state.errorMsg || 'Unknown error occurred.'}</span>`;
    summaryCard.classList.add('visible');
  }
}

async function handleActionClick() {
  const state = await chrome.storage.local.get(['status']);
  const status = state.status || 'ready';

  if (status === 'ready' || status === 'completed' || status === 'error') {
    // Save recording start time
    await chrome.storage.local.set({ recordingStartTime: Date.now() });
    // Tell background to start capture
    chrome.runtime.sendMessage({ type: 'START_RECORDING' });
  } else if (status === 'recording') {
    // Tell background to stop capture
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  }
}

function copyMarkdown() {
  const mdText = summaryContent.innerText;
  navigator.clipboard.writeText(mdText).then(() => {
    const prevText = btnCopy.textContent;
    btnCopy.textContent = 'Copied!';
    btnCopy.style.borderColor = 'var(--accent-emerald)';
    btnCopy.style.color = 'var(--accent-emerald)';
    setTimeout(() => {
      btnCopy.textContent = prevText;
      btnCopy.style.borderColor = 'var(--border-color)';
      btnCopy.style.color = 'var(--text-primary)';
    }, 2000);
  });
}
