'use strict';
(() => {
  const search = document.getElementById('scenario-search');
  const kind = document.getElementById('scenario-kind');
  const cards = Array.from(document.querySelectorAll('.scenario'));
  const count = document.getElementById('scenario-count');
  const empty = document.getElementById('no-scenarios');
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    let n = 0;
    cards.forEach(card => {
      const visible = (kind.value === 'all' || card.dataset.kinds.split(',').includes(kind.value)) && card.dataset.search.toLocaleLowerCase().includes(query);
      card.hidden = !visible;
      if (visible) n++;
    });
    count.textContent = `${n} / ${cards.length} 个场景`;
    empty.hidden = n !== 0;
  }
  search.addEventListener('input', filter);
  kind.addEventListener('change', filter);
  document.getElementById('scenarios-expand').addEventListener('click', () => cards.forEach(card => {if (!card.hidden) card.open = true;}));
  document.getElementById('scenarios-reset').addEventListener('click', () => {search.value = '';kind.value = 'all';cards.forEach(card => {card.open = false;});filter();});
  const meanings = {
    feature: '建议归为功能：交付新增或改变的产品行为，范围内可以包含必要研究与决策。',
    bug: '建议归为缺陷：先核对已约定行为；根因未知或尚未复现仍须保留修复目标。',
    research: '建议归为研究：回答有界未知事实，明确证据方法、限制与停止条件。',
    decision: '建议归为决策：比较真实方案，形成自足决定、确认范围和落实交接。',
    maintenance: '建议归为维护：落实工程、模板或指南等结果；不是只写研究结论。'
  };
  const chooser = document.getElementById('work-question');
  const result = document.getElementById('chooser-result');
  chooser.addEventListener('change', () => {
    result.textContent = meanings[chooser.value] || '这是分类辅助，不替代范围判断；混合工作按主结果分类。';
    if (meanings[chooser.value]) {
      const a = document.createElement('a');
      a.href = '#template-' + chooser.value;
      a.textContent = '查看模板 →';
      result.appendChild(a);
    }
  });
  function revealAnchor() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    const element = document.getElementById(id);
    if (!element) return;
    if (element.matches('.scenario') && element.hidden) {search.value='';kind.value='all';filter();}
    if (element.tagName === 'DETAILS') element.open = true;
    if (id.startsWith('example-')) {
      const block = element.parentElement.tagName === 'P' ? element.parentElement : element;
      const next = block.nextElementSibling;
      if (next && next.tagName === 'DETAILS') next.open = true;
    }
  }
  window.addEventListener('hashchange', revealAnchor);
  window.addEventListener('beforeprint', () => document.querySelectorAll('details').forEach(d => {d.dataset.wasOpen = String(d.open);d.open = true;}));
  window.addEventListener('afterprint', () => document.querySelectorAll('details').forEach(d => {d.open = d.dataset.wasOpen === 'true';}));
  filter();revealAnchor();
})();
