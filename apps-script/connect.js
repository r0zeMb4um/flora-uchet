/**
 * Подключение бота. Запускается из редактора: выбрать connectBot → «Выполнить».
 * Нужны свойства скрипта: BOT_TOKEN (вставляет владелец проекта сам) и DEPLOYMENT_ID (ставит deploy).
 * Делает: секретный ключ вебхука, setWebhook (по одному обновлению за раз), команды, проверку и ссылки-приглашения.
 */
function connectBot() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BOT_TOKEN')) throw new Error('Сначала добавьте BOT_TOKEN в «Свойства скрипта»');
  var deployment = props.getProperty('DEPLOYMENT_ID') || (typeof DEPLOYMENT_ID !== 'undefined' ? DEPLOYMENT_ID : '');
  if (!deployment) throw new Error('Нет DEPLOYMENT_ID — сначала разверните веб-приложение');

  var key = props.getProperty('WEBHOOK_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('WEBHOOK_KEY', key);
  }
  var url = 'https://script.google.com/macros/s/' + deployment + '/exec?k=' + key;
  Tg.call('setWebhook', {
    url: url, max_connections: 1, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true
  });
  Tg.call('setMyCommands', { commands: [{ command: 'start', description: 'Меню' }] });
  // Кнопка «Касса» слева от поля ввода — открывает Mini App.
  Tg.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Касса', web_app: { url: MINIAPP_URL } } });
  var me = Tg.call('getMe');
  props.setProperty('BOT_USERNAME', me.username);

  var info = Tg.call('getWebhookInfo');
  Logger.log('Бот: @' + me.username);
  Logger.log('Вебхук: ' + (info.url ? 'подключён' : 'НЕ подключён') +
    ', ошибок: ' + (info.last_error_message || 'нет') + ', в очереди: ' + info.pending_update_count);

  var store = SheetsStore.open();
  store.rows('invites').filter(function (i) { return i.status === 'active' && i.expires_at > nowIso(); })
    .forEach(function (i) {
      var s = store.find('staff', 'staff_id', i.staff_id)[0];
      Logger.log('Приглашение для «' + (s ? s.name : i.staff_id) + '»: https://t.me/' + me.username + '?start=' + i.token);
    });
}

/** Проверка здоровья вебхука (будет вызываться и триггером каждый день). */
function checkWebhook() {
  var info = Tg.call('getWebhookInfo');
  Logger.log(JSON.stringify({ url_set: !!info.url, pending: info.pending_update_count, last_error: info.last_error_message || '' }));
  return info;
}
