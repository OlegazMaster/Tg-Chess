// Собственный набор фигур (SVG, viewBox 0 0 100 100)
const BODY = {
  p: `<circle cx="50" cy="29" r="12"/>
      <path d="M40 47 C40 58 34 67 30 76 L70 76 C66 67 60 58 60 47 Z"/>
      <ellipse cx="50" cy="46" rx="15" ry="5"/>
      <rect x="22" y="76" width="56" height="11" rx="4"/>`,
  r: `<path d="M27 20 H38 V28 H45 V20 H55 V28 H62 V20 H73 V40 H27 Z"/>
      <path d="M33 40 H67 L65 76 H35 Z"/>
      <rect x="27" y="40" width="46" height="6" rx="2"/>
      <rect x="22" y="76" width="56" height="11" rx="4"/>`,
  n: `<path d="M70 77 C73 57 71 39 60 26 C56 21 52 18 50 12 L46 21 C40 22 34 26 30 33 L21 47 C19 52 22 56 27 56 C31 56 34 53 38 50 L45 47 C46 53 41 59 35 65 C31 69 30 73 30 77 Z"/>
      <rect x="22" y="76" width="56" height="11" rx="4"/>`,
  b: `<circle cx="50" cy="13" r="5"/>
      <path d="M50 18 C64 29 66 45 58 55 L42 55 C34 45 36 29 50 18 Z"/>
      <ellipse cx="50" cy="57" rx="13" ry="4.5"/>
      <path d="M42 60 C42 67 36 72 32 76 L68 76 C64 72 58 67 58 60 Z"/>
      <rect x="22" y="76" width="56" height="11" rx="4"/>`,
  q: `<path d="M21 34 L29 56 L36 27 L43 50 L50 22 L57 50 L64 27 L71 56 L79 34 L70 67 L30 67 Z"/>
      <circle cx="21" cy="32" r="5"/><circle cx="36" cy="25" r="5"/><circle cx="50" cy="19" r="5"/>
      <circle cx="64" cy="25" r="5"/><circle cx="79" cy="32" r="5"/>
      <path d="M30 67 H70 L67 76 H33 Z"/>
      <rect x="22" y="76" width="56" height="11" rx="4"/>`,
  k: `<rect x="46.5" y="6" width="7" height="20" rx="1.5"/>
      <rect x="40" y="11.5" width="20" height="7" rx="1.5"/>
      <path d="M50 38 C44 25 22 26 26 46 C28 54 32 60 33 67 L67 67 C68 60 72 54 74 46 C78 26 56 25 50 38 Z"/>
      <path d="M33 67 H67 L65 76 H35 Z"/>
      <rect x="22" y="76" width="56" height="11" rx="4"/>`,
};

// Дополнительные линии-детали поверх силуэта
const DETAIL = {
  p: '',
  r: '<path d="M35 52 H65 M34 66 H66"/>',
  n: '<circle cx="42" cy="31" r="2.6" class="eye"/><path d="M58 30 C63 40 65 55 64 70"/>',
  b: '<path d="M54 29 L45 41"/>',
  q: '<path d="M33 60 H67"/>',
  k: '<path d="M50 38 V64 M34 58 C44 54 56 54 66 58"/>',
};

export function pieceSVG(color, type) {
  const white = color === 'w';
  const fill = white ? '#fbf8f1' : '#2d2a26';
  const stroke = white ? '#24211d' : '#0d0c0a';
  const detail = white ? '#24211d' : '#e9e2d3';
  return `<svg viewBox="0 0 100 100" class="piece-svg" aria-hidden="true">
    <g fill="${fill}" stroke="${stroke}" stroke-width="3.2" stroke-linejoin="round">${BODY[type]}</g>
    <g fill="none" stroke="${detail}" stroke-width="2.6" stroke-linecap="round">${DETAIL[type]
      .replace('class="eye"', `fill="${detail}" stroke="none"`)}</g>
  </svg>`;
}

export const PIECE_NAMES = { p: 'пешка', n: 'конь', b: 'слон', r: 'ладья', q: 'ферзь', k: 'король' };
