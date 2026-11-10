// Инструкции для флориста и владелицы: бот и касса читают один и тот же текст; кнопки, которые в нём названы, существуют.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Guide = require('../apps-script/core/guide.js');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'miniapp', 'js', 'app.js'), 'utf8');

test('копия инструкции в кассе совпадает с серверной (иначе бот и касса расскажут по-разному)', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'core', 'guide.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'miniapp', 'js', 'guide.js'), 'utf8');
  assert.equal(b, a, 'скопируйте apps-script/core/guide.js в miniapp/js/guide.js (это делает npm run deploy)');
});

test('у каждой роли есть разделы, шаги не пустые, поддержка названа', () => {
  for (const role of ['florist', 'owner']) {
    const sections = Guide.sections(role);
    assert.ok(sections.length >= 6, role + ': мало разделов');
    sections.forEach((s) => {
      assert.ok(s.title && s.icon && s.steps.length > 0, role + ': пустой раздел ' + s.title);
      s.steps.forEach((t) => assert.ok(t.trim().length > 10, role + ': пустой шаг в «' + s.title + '»'));
    });
  }
  assert.equal(Guide.SUPPORT.name, '@kirillST_tpq');
  assert.equal(Guide.SUPPORT.url, 'https://t.me/kirillST_tpq');
});

test('сообщения для чата: короче лимита Telegram, поддержка в конце, нет сырых < > &', () => {
  for (const role of ['florist', 'owner']) {
    const parts = Guide.botMessages(role);
    assert.ok(parts.length >= 1);
    parts.forEach((p) => {
      assert.ok(p.length < 4000, role + ': сообщение слишком длинное: ' + p.length);
      const withoutTags = p.replace(/<\/?b>/g, '');
      assert.ok(!/[<>&]/.test(withoutTags), role + ': в тексте есть символ HTML');
    });
    assert.ok(parts[parts.length - 1].includes('@kirillST_tpq'));
  }
  assert.ok(Guide.botMessages('owner')[0].includes('Инструкция для владелицы'));
  assert.ok(Guide.botMessages('florist')[0].includes('Инструкция для флориста'));
});

test('кнопки, которые названы в инструкции, есть в кассе', () => {
  const named = ['Открыть смену', 'Только я', 'Нал', 'Безнал', 'Провести', 'Чек клиенту картинкой', 'Принять товар', 'Провести приход', 'Списать брак',
    'Отмена продажи', 'Возврат', 'Расход', 'Владелица забрала из кассы', 'Закрыть смену', 'Настройки', 'Сотрудники', 'Добавить флориста',
    'Отправить в Telegram', 'Выбрать из типовых', 'Расходы месяца', 'Исправить', 'Снять чек', 'Я в смене', 'Кабинет', 'Контроль'];
  const text = Guide.sections('florist').concat(Guide.sections('owner')).map((s) => s.steps.join(' ')).join(' ');
  const missingInApp = named.filter((n) => !appSrc.includes(n));
  assert.deepEqual(missingInApp, [], 'в кассе нет кнопок: ' + missingInApp.join(', '));
  const notMentioned = named.filter((n) => !text.includes(n));
  assert.ok(notMentioned.length <= 4, 'в инструкции не упомянуты: ' + notMentioned.join(', '));
});

test('экран «Как пользоваться» и плитки на месте', () => {
  assert.ok(/SCREENS\.help = function/.test(appSrc));
  assert.ok(appSrc.includes("'Как пользоваться'"));
  assert.ok(appSrc.includes('guideBanner'));
});
