document.addEventListener('DOMContentLoaded', () => {
  const statusLine = document.getElementById('statusLine');
  if (!statusLine) {
    return;
  }

  const version = window.myBackup && window.myBackup.version ? window.myBackup.version : 'unknown';
  statusLine.textContent = `Shell ready. Foundation state: ${version}.`;
});
