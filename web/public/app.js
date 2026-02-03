(function () {
  const SESSION_KEY = 'chatSessionId';

  function getSessionId() {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id || id.length < 8) {
      id = crypto.randomUUID ? crypto.randomUUID() : 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  function setSessionId(id) {
    localStorage.setItem(SESSION_KEY, id);
  }

  function apiUrl(path, query) {
    const base = window.API_BASE || '';
    const url = new URL(base + path, window.location.origin);
    if (query) Object.keys(query).forEach(k => url.searchParams.set(k, query[k]));
    return url.toString();
  }

  function setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  function addToTranscript(role, content) {
    const transcript = document.getElementById('transcript');
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = '<span class="role">' + (role === 'user' ? 'You' : 'Assistant') + '</span>: ' + escapeHtml(content);
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  async function post(path, body) {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    return data;
  }

  async function get(path, query) {
    const res = await fetch(apiUrl(path, query));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    return data;
  }

  const sendBtn = document.getElementById('sendBtn');
  const messageInput = document.getElementById('messageInput');
  const summarizeBtn = document.getElementById('summarizeBtn');
  const exportBtn = document.getElementById('exportBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const summaryEl = document.getElementById('summary');
  const transcriptEl = document.getElementById('transcript');

  sendBtn.addEventListener('click', async function () {
    const message = messageInput.value.trim();
    if (!message) return;
    sendBtn.disabled = true;
    setStatus('Sending...');
    try {
      addToTranscript('user', message);
      messageInput.value = '';
      const { data } = await post('/api/chat', { sessionId: getSessionId(), message });
      addToTranscript('assistant', data.reply);
      setStatus('');
    } catch (e) {
      setStatus('Error: ' + e.message);
    } finally {
      sendBtn.disabled = false;
    }
  });

  messageInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  summarizeBtn.addEventListener('click', async function () {
    summarizeBtn.disabled = true;
    setStatus('Summarizing...');
    try {
      const { data } = await post('/api/summarize', { sessionId: getSessionId() });
      summaryEl.textContent = data.summary;
      summaryEl.style.display = 'block';
      setStatus('Summary updated.');
    } catch (e) {
      setStatus('Error: ' + e.message);
    } finally {
      summarizeBtn.disabled = false;
    }
  });

  exportBtn.addEventListener('click', function () {
    const url = apiUrl('/api/export', { sessionId: getSessionId() });
    window.open(url, '_blank', 'noopener');
    setStatus('Export opened in new tab.');
  });

  newChatBtn.addEventListener('click', function () {
    setSessionId('s-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12));
    summaryEl.textContent = '';
    summaryEl.style.display = 'none';
    transcriptEl.innerHTML = '';
    setStatus('New chat started.');
  });

  getSessionId();
})();
