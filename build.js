/*
 * Сборка content.js из puzzle.md.
 *
 * Запуск:
 *   node build.js            — один раз
 *   node build.js --watch    — пересобирать при каждом сохранении puzzle.md
 *
 * Исходники не требуют зависимостей и сборщика: на хостинге используется
 * уже сгенерированный content.js.
 */

const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'puzzle.md');
const targetPath = path.join(__dirname, 'content.js');

function readSections(markdown) {
  const sections = new Map();
  let current = null;

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }

  return sections;
}

function sectionLines(sections, ...names) {
  for (const name of names) {
    if (sections.has(name)) return sections.get(name);
  }
  return [];
}

function sectionText(sections, ...names) {
  const raw = sectionLines(sections, ...names).join('\n').trim();
  const fenced = raw.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  const body = fenced ? fenced[1].trim() : raw;
  return body.replace(/\s*\n\s*/g, ' ').trim();
}

function parseNodes(text) {
  const root = [];
  const stack = [{ nodes: root }];
  const source = String(text);

  const append = (value) => {
    const current = stack[stack.length - 1].nodes;
    const last = current[current.length - 1];
    if (last && last.type === 'text') last.text += value;
    else current.push({ type: 'text', text: value });
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (ch === '\\' && (source[i + 1] === '[' || source[i + 1] === ']')) {
      append('\u0000' + source[i + 1]);
      i++;
      continue;
    }

    const nodes = stack[stack.length - 1].nodes;
    if (ch === '[') {
      const node = { type: 'bracket', children: [] };
      nodes.push(node);
      stack.push({ nodes: node.children });
    } else if (ch === ']') {
      if (stack.length > 1) stack.pop();
    } else {
      append(ch);
    }
  }

  return root;
}

function parseSpec(tail) {
  const pieces = tail.split(';').map((part) => part.trim()).filter(Boolean);
  const accepted = pieces[0]
    .split(/[\/,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const spec = { accepted };

  for (const piece of pieces.slice(1)) {
    const meta = piece.match(/^(?:first|буква)\s*[:=]\s*(.+)$/i) ||
      piece.match(/^(?:full|слово)\s*[:=]\s*(.+)$/i);
    if (!meta) continue;
    const key = /^(?:first|буква)/i.test(piece) ? 'first' : 'full';
    spec[key] = meta[1].trim();
  }

  return spec;
}

function extractSpec(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.type !== 'text') continue;

    const arrow = node.text.lastIndexOf('=>');
    const unicodeArrow = node.text.lastIndexOf('→');
    const separator = Math.max(arrow, unicodeArrow);
    if (separator < 0) continue;

    const length = arrow >= unicodeArrow ? 2 : 1;
    const clue = node.text.slice(0, separator).replace(/[ \t]+$/, '');
    const spec = parseSpec(node.text.slice(separator + length));
    node.text = clue;
    return spec;
  }
  return null;
}

function processNodes(nodes, prefix, answers, order) {
  let index = 0;

  for (const node of nodes) {
    if (node.type !== 'bracket') continue;

    const path = prefix ? prefix + '.' + index : String(index);
    index++;
    order.push(path);

    const spec = extractSpec(node.children);
    if (spec && spec.accepted.length) answers[path] = spec;

    processNodes(node.children, path, answers, order);
  }
}

function unescapeLiterals(value) {
  return value.replace(/\u0000([\[\]])/g, (_, bracket) => '\\' + bracket);
}

function renderNodes(nodes) {
  return nodes.map((node) => (
    node.type === 'text'
      ? unescapeLiterals(node.text)
      : '[' + renderNodes(node.children) + ']'
  )).join('');
}

function plainText(nodes, answers, prefix) {
  let index = 0;
  return nodes.map((node) => {
    if (node.type === 'text') return unescapeLiterals(node.text);
    const path = prefix ? prefix + '.' + index : String(index);
    index++;
    const spec = answers[path];
    return spec ? (spec.full || spec.accepted[0]) : plainText(node.children, answers, path);
  }).join('');
}

function parseOverrides(lines) {
  const overrides = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--')) continue;

    const match = line.match(/^[-*]?\s*`?(\d+(?:\.\d+)*)`?\s*(?:=>|→|:=|:|=)\s*(.+)$/);
    if (!match) continue;

    const spec = parseSpec(match[2]);
    if (spec.accepted.length) overrides[match[1]] = spec;
  }

  return overrides;
}

function build() {
  const markdown = fs.readFileSync(sourcePath, 'utf8');
  const sections = readSections(markdown);
  const sourceText = sectionText(sections, 'текст', 'text');
  const resultText = sectionText(sections, 'финал', 'результат', 'result');
  const overrides = parseOverrides(sectionLines(sections, 'ответы', 'answers'));

  if (!sourceText) throw new Error('В puzzle.md нет секции «## Текст» с загадкой');

  const tree = parseNodes(sourceText);
  const answers = {};
  const order = [];
  const errors = [];

  processNodes(tree, '', answers, order);
  Object.assign(answers, overrides);

  for (const path of order) {
    if (!answers[path] || !answers[path].accepted.length) {
      errors.push('Нет ответа у загадки ' + path);
    }
  }

  const extra = Object.keys(answers).filter((key) => !order.includes(key));
  if (extra.length) errors.push('Ответы без загадок: ' + extra.join(', '));

  const puzzleText = renderNodes(tree).trim();
  if (puzzleText.includes('=>') || puzzleText.includes('→')) {
    errors.push('В тексте остался неразобранный ответ (=> или →)');
  }
  const generatedText = plainText(tree, answers, '').trim();

  if (errors.length) throw new Error(errors.join('\n'));

  const output = [];
  output.push('/* Сгенерировано из puzzle.md. Редактируйте puzzle.md, не этот файл. */');
  output.push('window.PUZZLE = {');
  output.push('  text: ' + JSON.stringify(puzzleText) + ',');
  if (resultText) output.push('  resultText: ' + JSON.stringify(resultText) + ',');
  output.push('  answers: {');

  order.forEach((path, index) => {
    const spec = answers[path];
    const fields = ['accepted: ' + JSON.stringify(spec.accepted)];
    if (spec.first) fields.push('first: ' + JSON.stringify(spec.first));
    if (spec.full) fields.push('full: ' + JSON.stringify(spec.full));
    output.push('    ' + JSON.stringify(path) + ': { ' + fields.join(', ') + ' }' +
      (index === order.length - 1 ? '' : ','));
  });

  output.push('  }');
  output.push('};');

  fs.writeFileSync(targetPath, output.join('\n') + '\n', 'utf8');
  console.log('content.js обновлён: ' + order.length + ' загадок');
  if (resultText) {
    const expected = resultText.trim();
    const match = generatedText === expected;
    console.log('Совпадение с финальным текстом: ' + match);
    if (!match) {
      let i = 0;
      while (i < Math.min(generatedText.length, expected.length) && generatedText[i] === expected[i]) i++;
      console.log('  первое расхождение на позиции ' + i + ':');
      console.log('  собрано: ' + JSON.stringify(generatedText.slice(Math.max(0, i - 25), i + 45)));
      console.log('  финал:  ' + JSON.stringify(expected.slice(Math.max(0, i - 25), i + 45)));
    }
  }
}

try {
  build();
  if (process.argv.includes('--watch')) {
    console.log('Слежу за puzzle.md… Ctrl+C для выхода');
    let timer = null;
    fs.watch(sourcePath, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { build(); } catch (error) { console.error(error.message); }
      }, 150);
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
