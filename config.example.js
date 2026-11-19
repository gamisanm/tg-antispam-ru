// Copy this file to config.js and adjust it for your chat:
//   cp config.example.js config.js
// config.js is git-ignored, so your ids and lists stay private.
//
// .env is looked up next to this file, then one folder up, then in the
// working directory. dotenv never overrides an already-set variable.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();
const config = {
    token: process.env.TOKEN_DELETE,
    // Chat/channel ids where deletion reports are sent (with a "restore" button).
    // Set LOG_CHAT_ID in .env, several ids comma-separated; logging is skipped if unset.
    logChatIds: (process.env.LOG_CHAT_ID || '').split(',').map(id => id.trim()).filter(Boolean),
    // Words/fragments scored +3 each (see spamScore). Links and @mentions are
    // here on purpose: a link from a newcomer is a weak spam signal.
    wordsToRemove: [
      "http",
      "t.me",
      ".ru",
      ".com",
      ".net",
      "bit.",
      "@",
      ".pl",
      "продам выпис",
      "продам wypis",
      "sell wypis",
      "куплю wypис",
      "куплю выпис",
      "продам аккаунт",
      "продам акаунт",
      "Продам выпис",
      "Продам wypис",
      "Sell wypis",
      "Куплю wypис",
      "Куплю выпис",
      "Продам аккаунт",
      "Продам акаунт",
      "Sell account",
      "sell account",
      "Buy account",
      "buy account",
      "buy wypis",
      "Buy wypis",
      "sotaman",
      "sotish",
      "sotiladigan",
      "казино",
      "Казино",
      "ᴋᴩиᴨᴛᴏᴋᴀɜинᴏ",
      "Кᴀɜинᴏ",
      "КАЗИНО",
      "pochta",
      "pochtalar",
      "sotiladi",
      "продам акаунти",
      "онлайн казино",
      "НАЙДИ ЕЕ ЖОПУ ЗДЕСЬ",
      "И.Н.Т.И.М",
      "Ищу партнёров",
      "скрытые фото",
      "рассылку",
      "рассылка",
      "инвайтинг",
      "пассивный заработок",
      "Разнорабочие",
      "Казик",
      "ищу водителей",
      // слабые маркеры из датасета tg-spam (+3 к счёту, сами по себе не удаляют)
      "ищу партнеров",
      "бесплатное обучение",
      "удаленного заработка",
      "совместного заработка",
      "доход в неделю",
      "закрытую команду",
    ],
    // High-confidence spam phrases curated from the tg-spam dataset
    // (github.com/umputun/tg-spam, /data, июль 2026). Score +5 — deletes on its own
    // for newcomers. Matched on lowercased, homoglyph-normalized text.
    strongSpamPhrases: [
      // крипто / "заработок"
      "своп-трейдинг",
      "разнице курсов",
      "цифровых актив",
      "цифровые активы",
      "цифровой валют",
      "сфере крипто",
      "заработок на крипте",
      "высокодоходн",
      "пассивный доход",
      "пассивный источник",
      "обучаем бесплатно",
      "обучение бесплатно",
      "без вложений",
      "набираю команду",
      "приватные схемы",
      "только 18+",
      "работа в дубае",
      "свободного времени в день",
      "часа свободного времени",
      "срочно сотрудник",
      "открыт набор",
      "набор в команду",
      "жилье предоставляем",
      "жильё предоставляем",
      "переезд за наш счет",
      "переезд за наш счёт",
      "только переписка",
      "выплаты каждую неделю",
      "курортной стране",
      // ставки
      "ставим на тотал",
      "ставка на тотал",
      "ставим строго на",
      "выигрышей в ряд",
      "крушим букмекера",
      // интим-боты
      "интим фото",
      "интимные фото",
      "оголенные фото",
      "обнаженные фото",
      "любой девушки",
      "без трусиков",
      // фальшивые деньги / серые услуги
      "фальш рубли",
      "фальш доллары",
      "фальшивые купюры",
      "фальшивые деньги",
      "любой банкомат",
      "поддельная валюта",
      "накручивает просмотры",
      "накрутка просмотров",
      "флуд почт",
      "в поиск телеграма",
      "в поиске телеграма",
    ],
    // Minimum spam score to delete a message (see messageHandler.js spamScore())
    spamScoreThreshold: 4,
    // Score at which the sender is also banned, not just the message deleted.
    // Reputation bonus is added on top, so regulars are shielded here too.
    banScoreThreshold: 7,
    // Whitelist: a message containing any of these is NOT checked at all.
    // Keep it to your own channels / trusted sites — spammers can type these too.
    wordsToKeep: [
      "youtube.com",
      "youtu.be",
      "docs.google.com",
      "telegra.ph",
      // "your_channel",
    ],
    // Users whose messages are never checked (admins, trusted regulars).
    // Telegram user ids, e.g. from @userinfobot.
    exemptUserIds: [
      // 123456789,
    ],
  };
  
  module.exports = config;
