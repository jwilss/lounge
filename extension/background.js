// Passes Continue watching reports from web apps to lounged on the box.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'lounge-recent') return;
  fetch('http://127.0.0.1:8737/api/recent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg.body),
  }).catch(() => { /* box service restarting; the next report will catch up */ });
});
