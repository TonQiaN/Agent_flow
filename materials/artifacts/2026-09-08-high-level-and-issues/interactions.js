(() => {
  const cards = [...document.querySelectorAll('.issue-card')];
  const search = document.getElementById('search');
  const origin = document.getElementById('origin');
  const area = document.getElementById('area');
  function filter() {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    cards.forEach(c => {
      const text = c.dataset.search.toLocaleLowerCase();
      c.hidden = !terms.every(t => text.includes(t)) || (origin.value !== 'all' && c.dataset.origin !== origin.value) || (area.value !== 'all' && c.dataset.area !== area.value);
    });
    const shown = cards.filter(c => !c.hidden);
    document.getElementById('result-count').textContent = `显示 ${shown.length} / 25 项 · 其中额外 ${shown.filter(c => c.dataset.origin === 'extra').length} 项`;
    document.getElementById('empty-result').hidden = shown.length !== 0;
  }
  search.addEventListener('input', filter);
  origin.addEventListener('change', filter);
  area.addEventListener('change', filter);
  document.getElementById('expand').addEventListener('click', () => cards.filter(c => !c.hidden).forEach(c => c.open = true));
  document.getElementById('collapse').addEventListener('click', () => cards.forEach(c => c.open = false));
  function followHash() {
    let target;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return; }
    if (target?.classList.contains('issue-card')) {
      if (target.hidden) { search.value = ''; origin.value = 'all'; area.value = 'all'; filter(); }
      target.open = true;
      target.scrollIntoView({block: 'start'});
    }
  }
  addEventListener('hashchange', followHash);
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]');
    if (a && a.hash === location.hash) followHash();
  });
  let printState;
  addEventListener('beforeprint', () => { printState = cards.map(c => c.open); cards.forEach(c => c.open = true); });
  addEventListener('afterprint', () => { cards.forEach((c, i) => c.open = printState?.[i] ?? false); });
  filter(); followHash();
})();
