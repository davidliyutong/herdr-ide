document.getElementById('copy-btn')?.addEventListener('click', async function () {
  const text = document.getElementById('install-cmd')?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    this.textContent = 'Copied';
    setTimeout(() => (this.textContent = 'Copy'), 1500);
  } catch {
    // clipboard API unavailable or denied
  }
});
