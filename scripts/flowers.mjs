// Коллекция цветов-иллюстраций в одном стиле с ранункулюсом (brand/ranunculus.svg).
// Запуск: node scripts/flowers.mjs → miniapp/img/flowers/*.svg
// Общий стиль: розовые оттенки, белый тонкий контур, мятные листья; viewBox 120×120.
import fs from 'node:fs';

const OUT = 'miniapp/img/flowers';
fs.mkdirSync(OUT, { recursive: true });
const f = (v) => Math.round(v * 10) / 10;
const wrap = (body) =>
  `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="0.9" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const LEAF = '#9fe8c0';
const leaf = (d) => `<path d="${d}" fill="rgba(159,232,192,.5)" stroke="${LEAF}" stroke-width="2"/>`;
const stem = (d) => `<path d="${d}" stroke="${LEAF}" stroke-width="2.4"/>`;

// Роза: высокий бутон со спиралью, по бокам обнимающие лепестки, спереди — отогнутый.
function rose() {
  const bud = '<path d="M60 22 C73 26 75 44 69 55 C65 60 55 60 51 55 C45 44 47 26 60 22Z" fill="#d94f83"/>';
  const spiral = '<path d="M55 33 C59 28 67 31 64 38 C61 43 54 40 57 35 C59 33 62 34 61 37" stroke="#fde3ec" stroke-width="1.5"/>';
  const left = '<path d="M41 38 C35 55 45 71 60 74 C53 65 49 51 52 37 C48 35 44 36 41 38Z" fill="#ea779e"/>';
  const right = '<path d="M79 38 C85 55 75 71 60 74 C67 65 71 51 68 37 C72 35 76 36 79 38Z" fill="#f193b2"/>';
  const front = '<path d="M43 55 C47 73 73 73 77 55 C70 62 50 62 43 55Z" fill="#f7b0c6"/>';
  const sepal = '<path d="M47 72 L60 78 L73 72 L65 82 L55 82Z" fill="rgba(159,232,192,.6)" stroke="#9fe8c0" stroke-width="1.6"/>';
  return wrap(stem('M60 80 C60 92 58 102 56 114') + leaf('M58 100 C46 94 39 98 35 107 C46 109 53 107 58 100Z') +
    leaf('M59 90 C70 82 79 86 83 93 C73 98 65 97 59 90Z') + sepal + left + right + bud + spiral + front);
}

// Тюльпан: три вытянутых лепестка-капли, бокал.
function tulip() {
  const back = '<path d="M60 22 C76 30 80 52 72 70 C66 76 54 76 48 70 C40 52 44 30 60 22Z" fill="#f193b2"/>';
  const left = '<path d="M40 34 C38 52 44 70 58 76 C50 64 48 48 52 34 C48 34 44 34 40 34Z" fill="#ea779e"/>';
  const right = '<path d="M80 34 C82 52 76 70 62 76 C70 64 72 48 68 34 C72 34 76 34 80 34Z" fill="#df5b8a"/>';
  const front = '<path d="M60 40 C70 48 70 66 60 76 C50 66 50 48 60 40Z" fill="#f7b0c6"/>';
  return wrap(stem('M60 76 C60 92 60 104 60 114') +
    leaf('M60 112 C46 104 38 88 40 72 C50 82 58 96 60 112Z') + leaf('M60 104 C72 96 80 84 80 70 C70 78 62 90 60 104Z') +
    back + left + right + front);
}

// Пион: пышный, лепестки неровными кругами в несколько слоёв с «рваным» краем.
function peony() {
  const out = [];
  const cx = 60, cy = 50;
  const layers = [[30, 15, 9, '#fbd3df'], [24, 13, 9, '#f8bfd0'], [18, 11, 8, '#f4a8c0'], [12, 9, 7, '#ef8fb0'], [6, 7, 6, '#e8789f'], [2, 5, 4, '#de6290']];
  layers.forEach(([d, r, n, c], i) => {
    for (let k = 0; k < n; k++) {
      const a = i * 0.7 + (k * 2 * Math.PI) / n;
      const x = cx + d * Math.cos(a), y = cy + d * Math.sin(a) * 0.85;
      // круглый лепесток с волнистым краем
      const pts = [];
      for (let j = 0; j <= 16; j++) {
        const t = (j / 16) * 2 * Math.PI;
        const rr = r * (1 + 0.08 * Math.sin(t * 5 + k));
        pts.push(`${f(x + rr * Math.cos(t))} ${f(y + rr * 0.8 * Math.sin(t))}`);
      }
      out.push(`<path d="M${pts.join(' L')}Z" fill="${c}"/>`);
    }
  });
  out.push('<circle cx="60" cy="50" r="3.5" fill="#f9e27d" stroke="none"/>');
  return wrap(stem('M60 82 C60 94 58 104 56 114') + leaf('M58 100 C44 94 36 98 32 107 C44 109 52 107 58 100Z') +
    leaf('M59 92 C72 84 82 88 86 95 C74 100 66 99 59 92Z') + out.join(''));
}

// Эвкалипт: веточка с круглыми листьями-монетками.
function eucalyptus() {
  const leaves = [];
  const pts = [[60, 20, 9], [48, 32, 10], [72, 38, 10], [46, 52, 11], [74, 58, 11], [48, 74, 12], [72, 80, 11], [52, 96, 10]];
  pts.forEach(([x, y, r], i) => {
    leaves.push(`<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${f(r * 0.9)}" fill="${i % 2 ? '#8fd3b0' : '#a8e6c6'}" stroke="rgba(255,255,255,.7)" stroke-width="0.9"/>`);
    leaves.push(`<path d="M${x} ${y} L${60} ${f(y + 6)}" stroke="#6fbf98" stroke-width="1.2"/>`);
  });
  return wrap('<path d="M60 14 C58 40 62 70 58 114" stroke="#6fbf98" stroke-width="2.4"/>' + leaves.join(''));
}

const set = { rose: rose(), tulip: tulip(), peony: peony(), eucalyptus: eucalyptus() };
for (const [name, svg] of Object.entries(set)) fs.writeFileSync(`${OUT}/${name}.svg`, svg);
fs.copyFileSync('brand/ranunculus.svg', `${OUT}/ranunculus.svg`);
// Лист-обзор для проверки глазами.
fs.writeFileSync('brand/_flowers.html', `<html><body style="margin:0;background:#24545d;display:flex;gap:10px;padding:10px">${
  ['ranunculus', 'rose', 'tulip', 'peony', 'eucalyptus'].map((n) => `<img src="../miniapp/img/flowers/${n}.svg" width="180" height="180">`).join('')}</body></html>`);
console.log('готово:', Object.keys(set).join(', '), '+ ranunculus');
