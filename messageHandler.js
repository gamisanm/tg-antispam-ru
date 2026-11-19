const config = require('./config');
const Reputation = require('./reputation');
const Watchers = require('./watchers');
// Telegram lets bots delete only messages younger than 48h
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

// Bump this when rules change — printed at startup so it's obvious which
// version of the filter the running process has loaded.
const RULES_VERSION = '2026-11-19b';

const HOMOGLYPH_MAP = {
    // Latin → Cyrillic
    'a': 'а', 'e': 'е', 'o': 'о', 'p': 'р', 'c': 'с', 'x': 'х', 'y': 'у',
    'A': 'А', 'E': 'Е', 'O': 'О', 'P': 'Р', 'C': 'С', 'X': 'Х',
    'B': 'В', 'H': 'Н', 'K': 'К', 'M': 'М', 'T': 'Т', 'Y': 'У',
    // Greek → Cyrillic
    'Α': 'А', 'Β': 'В', 'Ε': 'Е', 'Ζ': 'З', 'Η': 'Н', 'Ι': 'И',
    'Κ': 'К', 'Μ': 'М', 'Ν': 'Н', 'Ο': 'О', 'Ρ': 'Р', 'Τ': 'Т',
    'Υ': 'У', 'Χ': 'Х', 'ο': 'о', 'ν': 'н', 'κ': 'к', 'α': 'а',
    'ε': 'е', 'ρ': 'р', 'τ': 'т', 'υ': 'у', 'χ': 'х',
};

function normalizeHomoglyphs(text) {
    return text.split('').map(ch => HOMOGLYPH_MAP[ch] || ch).join('');
}

// Zero-width and other invisible characters — spammers insert them mid-word
// ("strea​m") to break word filters. Humans never type these.
const INVISIBLE_CHARS = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g;

function spamScore(dirtyText) {
    let score = 0;
    const reasons = [];

    // Strip invisible chars so word rules match the real text, and score the
    // evasion attempt itself. Only chars sandwiched BETWEEN letters count
    // ("strea​m") — that's the filter-evasion trick. Invisible chars at line
    // starts are copy-paste debris from Word/PDF, and ZWJ inside emoji is
    // normal — neither may trigger this.
    // The closing letter is a lookahead, not consumed — otherwise two evasion
    // spots sharing one letter between them ("Men‍g‌‍a") only count once,
    // since String.match() can't reuse a character across two matches.
    const midWordInvisibles = (dirtyText.match(
        /[a-zа-яё'ʼ][\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]+(?=[a-zа-яё'ʼ])/gi
    ) || []).length;
    // Spammers drop the space after commas to break \s+-based phrase regexes
    // ("для,одной девушки", "Доброе утро,Есть несколько,хороших"). Replacing
    // every comma with a space fixes this uniformly and is safe for amounts
    // too — "10,000р" becomes "10 000р", and the spaced-thousands amount regex
    // already treats plain space as a valid separator.
    const rawText = dirtyText.replace(INVISIBLE_CHARS, '').replace(/,/g, ' ');
    if (midWordInvisibles >= 2) {
        score += 5;
        reasons.push('invisible-chars');
    }

    // Loose variant that undoes dot-spacing and 0→о leetspeak obfuscation
    // ("баб.ок" → "бабок", "пом0гу" → "помогу"). Scoped to a handful of
    // money-lending-bait phrase checks below — NOT used for amount detection,
    // so real prices like "10.000р" are never touched.
    const deobfuscated = rawText
        .replace(/(?<=[а-яёА-ЯЁ])\.(?=[а-яёА-ЯЁ])/g, '')
        .replace(/(?<=[а-яёА-ЯЁ])0|0(?=[а-яёА-ЯЁ])/g, 'о')
        .toLowerCase();
    const matchesLoose = re => re.test(deobfuscated);

    // Words spelled letter-by-letter with dots, mixing scripts
    // ("К.Л.А.D.М.Е.Н", "Л.И.S.Т.О.V.Щ.И.К") — drug-shop buttons do this to dodge
    // word filters. 4+ letters required so "т.е.", "т.д.", "U.S.A." don't count.
    const DOTTED_WORD = /(?:\p{L}\.){3,}\p{L}/gu;
    const dottedWords = rawText.match(DOTTED_WORD) || [];
    if (dottedWords.length) {
        score += 3;
        reasons.push('dotted-letters');
    }
    // Collapsed variant fed to matches() below. Extra Latin lookalikes (D→Д,
    // S→С…) are mapped only inside dotted words — elsewhere they're real Latin.
    const DOTTED_LOOKALIKES = { D: 'Д', Z: 'З', S: 'С', V: 'В', N: 'Н', R: 'Р', L: 'Л' };
    const undotted = normalizeHomoglyphs(rawText.replace(DOTTED_WORD, w =>
        w.replace(/\./g, '').replace(/[DZSVNRL]/g, ch => DOTTED_LOOKALIKES[ch])
    )).toLowerCase();
    // Same, but dots only — keeps Latin words Latin ("U.S.D.T." → "usdt")
    const dotless = rawText.replace(DOTTED_WORD, w => w.replace(/\./g, '')).toLowerCase();

    // Message that LOOKS empty but consists of invisible chars — bot probe.
    // (JS trim() doesn't strip zero-width chars, so these sneak past the
    // empty-message early return in handleMessage.)
    if (!rawText.trim() && dirtyText.match(INVISIBLE_CHARS)) {
        score += 5;
        reasons.push('invisible-only');
    }

    // Homoglyph normalization turns Latin caps into Cyrillic (USDT → usdт),
    // which breaks Latin patterns — so every check runs on BOTH variants.
    const rawLower = rawText.toLowerCase();
    const text = normalizeHomoglyphs(rawText).toLowerCase();
    const matches = re => re.test(text) || re.test(rawLower) || re.test(undotted) || re.test(dotless);
    const containsPhrase = p => text.includes(p) || rawLower.includes(p);

    // English NSFW / "leak" spam vocabulary — alien to this chat's normal traffic
    if (matches(/onlyfans|uncensored|leaked|access\s+leak|play\s+(now|video)|watch\s+(now|before)|download\s+archive|see\s+photos|ppv\s+content|premium\s+ppv|direct\s+link/)) {
        score += 5;
        reasons.push('nsfw-en');
    }

    // Russian escort/adult-services ad vocabulary. Deliberately unambiguous terms
    // only — bare 2-3 letter abbreviations like "ОВР"/"МБР"/"МЖМ" are excluded:
    // ОВР is a real Russian bureaucracy term (visa office) this chat's immigrants
    // legitimately discuss, and МЖМ is ambiguous enough that people ask what it
    // means without it being an ad themselves.
    if (matches(/груб\S*\s+секс|поз[ауе]\s+наездниц|куни|залей\S*\s+(мне\s+)?рот\S*\s+сперм|сочная\s+жоп|минет\s+без\s+резинки|оральный\s+без\s+резинки|приезжай\s+ко\s+мне\s+прямо\s+сейчас/)) {
        score += 5;
        reasons.push('adult-services-ru');
    }

    // Hardcoded word list (kept for backwards compat, contributes to score)
    if (config.wordsToRemove.some(w => containsPhrase(w.toLowerCase()))) {
        score += 3;
        reasons.push('hardcoded-word');
    }

    // High-confidence phrases from the tg-spam dataset — enough to delete on their own
    if (config.strongSpamPhrases.some(containsPhrase)) {
        score += 5;
        reasons.push('tg-spam-phrase');
    }

    // Crypto buy/sell. [tт]/[cс] variants: spammers swap in Cyrillic lookalikes
    // (USDТ with Cyrillic Т) that survive our Latin→Cyrillic normalization.
    if (matches(/юсдт|ю[сд]{2}т|тезер|тез+р|usd[tт]|te[tт]her|крипт|[tт]r[cс]\s*-?20|тр[кс]?\s*-?20|er[cс]\s*-?20|би[tт]коин|btc/)) {
        score += 5;
        reasons.push('crypto');
    }

    // Redirect to DM: пиши/черкани/стукни/отпиши в лс/личку
    // "л[_.\-\s]?[ск]" lets "лс/лк" survive a separator inserted between the two
    // letters ("Л_С", "л.с") — the same evasion trick as invisible chars, just
    // typed out instead.
    const hasDMRedirect = matches(/(пиш[иите]*|писать|черкан[иьте]*|черкн[иите]*|стукн[иите]*|отпиш[иите]*|жд[уём]+)\s*[+()]*\s*(мне\s+|отклик\S*\s+)?в\s*(л[_.\-\s]?с|л[_.\-\s]?к|личк\S*|личные)|в\s*(л[_.\-\s]?с|л[_.\-\s]?к|личк\S*)\s*(пиш|писать|черкан|черкн|стукн|отпиш)|(^|[^а-яё])\+\s*в\s*(л[_.\-\s]?с|л[_.\-\s]?к|личк\S*)|в\s*(л[_.\-\s]?с|личк\S*)\s*\+|за\s+(деталями|подробност\S*)\s+в\s*(л[_.\-\s]?с|личк\S*|личн)/);
    if (hasDMRedirect) {
        score += 3;
        reasons.push('dm-redirect');
    }

    // Spaced letters (Р А Б О Т А)
    // Lookbehind/lookahead ensure the sequence starts/ends at a real word boundary,
    // not on the tail of a longer word (e.g. "за км и я в деле" must NOT match).
    if (/(?<![а-яёА-ЯЁ])([а-яё] ){3,}[а-яё](?![а-яёА-ЯЁ])/.test(text)) {
        score += 4;
        reasons.push('spaced-letters');
    }

    // "Первые N человек" — must have "человек/людей" after the number to avoid false positives
    // like "первые 3 сделал за 40 минут" (legitimate context)
    if (/первы[ехх]\s+\d+\s*(человек|людей|чел[.\s]|люде)/.test(text)) {
        score += 5;
        reasons.push('first-n-people');
    }

    // Quick money patterns: amount + urgency keyword
    // Amount: with currency symbol, or bare 4+ digit number, or "Nк/NK" shorthand
    // Note: \b doesn't work with Cyrillic in JS, so we avoid it for Cyrillic chars
    // Spaced thousands ("2 000") and $/€ added — scam ads quote salaries in dollars
    const hasAmount = matches(/(?<![\d+][\s ]?)\d{1,3}[.,\s ]\d{3}(?![\s ]?\d)|\d{3,}\s*(р(?:\s|$|[.,!?])|руб|рублей|₽|грн|гривен|гривн|\$|usd|долл|евро|€|зл|злот|zł|зел[её]н\S*)|\d{4,}|\d+\s*[кk](?!\d)|\d+\s*ты[сщ]/);
    // "сейчас/сегодня" removed — too common in everyday speech, causes false positives.
    // "быстр" narrowed to money context: "Быстрое оформление" in a rental ad is not urgency.
    const hasUrgency = /(за\s+выход|за\s+смену|бабки|бабок|быстр\S*\s*(деньг|заработ|доход|бабк|подним|поднять)|срочно|подработка|занятост|помочь|помоч|поможе)/.test(text);
    if (hasAmount && hasUrgency) {
        score += 4;
        reasons.push('quick-money');
    }

    // Physical labor offer + redirect to DM — classic low-skill job scam
    // Note: no \b — Cyrillic word boundaries are unreliable in JS regex
    const hasCasualLabor = matches(/(вынести|вывезти|погруз|разгруз|выгруз|выгруж|расстав|перетащить|перенести|помочь|поднять|прибрать|убрать|уложить|укладка|дрова|дров\s|поленниц|вскопать|копать|помыть|вымыть|помою|отмыть|покос|скосить|косить\s+трав|занести|мешк|цемент|покрасить|покраск|открутить|закрутить|болт|ценник|принять\s+доставку|перевозка\s+(корпоратив|отправлен|груз|посыл)|раздач\S*\s+листов|раздать\s+листовки|написание\s+текст|грузчик|сортир|шуруп[оа]в[её]рт|погуля\S*\s+с\s+собак|выгул\S*\s+собак|собрать\s+(шкаф|мебел|кроват|стол)|сборк\S*\s+мебел)/);
    if (hasCasualLabor && hasDMRedirect) {
        score += 4;
        reasons.push('labor-dm');
    }

    // Physical labor + payment amount ("Укладка дров в поленницу. 5500 р")
    if (hasCasualLabor && hasAmount) {
        score += 4;
        reasons.push('labor-pay');
    }

    // Vague shady task: "дельце", "нужен человек для/в одно дело", "есть дело на вечер",
    // "дам/есть пару заданий/задачек", "мелкие дела"
    if (matches(/дельце|нужен\s+человек\s+для|нужен\s+человек\s+в\s+(одно\s+)?дел|для\s+одного\s+дел|есть\s+дело\s+на|(дам|есть)\s+(пару\s+)?(задани|задач)|мелким\s+делам|по\s+мелким\s+дел/)) {
        score += 4;
        reasons.push('shady-task');
    }

    // "Дам в долг" — loan-shark offer (distinct from "закрою долги" debt-collection scam)
    if (matches(/да[юм]\s+(деньги\s+)?в\s+долг|дам\s+денег/)) {
        score += 4;
        reasons.push('loan-shark');
    }

    // Paid fake-review gig: "оставить отзыв" + payment amount OR "на карту/на руки"
    // (small bare amounts like "800" don't satisfy hasAmount's currency/digit-count
    // rules, but "на карту" makes the payment intent unambiguous on its own)
    if (matches(/остав\S*\s+отзыв|напиши\s+отзыв/) && (hasAmount || matches(/на\s+карту|на\s+руки/))) {
        score += 4;
        reasons.push('review-scam');
    }

    // "Личный помощник" recruiting — vague high-trust role offer, job-scam staple
    if (matches(/личн\S*\s+помощник/)) {
        score += 3;
        reasons.push('assistant-recruit');
    }

    // "на ход ноги закину" — pay-immediately cash slang
    if (matches(/на\s+ход\s+ноги/)) {
        score += 3;
        reasons.push('cash-slang');
    }

    // "пару минут свободных" — recruiting opener
    if (matches(/пару\s+минут\s+свободных|минут\s+свободного|свободных\s+пару\s+минут/)) {
        score += 3;
        reasons.push('free-minutes');
    }

    // "пиши мне / напиши мне / пиши-мне / пиши + / пши мне / пиши скорее / ставь +"
    // — DM invite without даже лс/личка. [\s-]+ (not \s+) so "Пиши-мне" still matches.
    if (matches(/(^|[^а-яё])(на)?пиш[иите]*[\s-]+(мне|нам|скорее)|пиш[иите]*\s*\+|(^|[^а-яё])пш[иь][\s-]+(мне|нам)|(^|[^а-яё])став[ьте]*\s*\+/)) {
        score += 3;
        reasons.push('write-me');
    }

    // "ищешь где заработать / хочешь заработать" — recruiting-question opener,
    // weak alone (combine-only) since it could theoretically be honest banter
    if (matches(/ищешь\s+где\s+заработать|хочешь\s+заработать|ищешь\s+(денеж|деньг|подработ|заработ)/)) {
        score += 2;
        reasons.push('income-question-bait');
    }

    // "расскажу лично / на месте / о чём речь / подробности в сообщениях" — DM bait
    if (matches(/расскажу\s+лично|лично\s+расскажу|расскажу\s+(все|всё)?\s*подробност|подробности\s+лично|детали\s+лично|подробности\s+в\s+сообщени|расскаж\S*\s+в\s+(личн|лс|личк)|расскажу\s+на\s+месте|расскажу\s+о\s+ч[её]м\s+речь/)) {
        score += 4;
        reasons.push('tell-in-person');
    }

    // "голяк по монете" — broke-slang money-lending bait opener
    if (matches(/голяк/)) {
        score += 4;
        reasons.push('broke-slang');
    }

    // "рабочая схема/схемка с доходом" — vague-scheme recruiting cliché
    if (matches(/рабоч\S*\s+схем|схем\S*\s+с\s+доход/)) {
        score += 3;
        reasons.push('scheme-slang');
    }

    // "дополнительная прибыль/доход" / "заработать дополнительно" — passive-income bait
    if (matches(/дополнительн\S*\s+(прибыл|доход|заработ)|заработать\s+дополнительно/)) {
        score += 3;
        reasons.push('extra-income-cliche');
    }

    // "без больших временных затрат / не уделяя много времени" — low-effort cliché
    if (matches(/без\s+больших\s+временных\s+затрат|не\s+уделяя\s+много\s+времени/)) {
        score += 2;
        reasons.push('low-effort-cliche');
    }

    // "открыты места / быстро выйти на работу" — quick-start recruiting cliché
    if (matches(/открыты\s+места|быстро\s+выйти\s+на\s+работу/)) {
        score += 2;
        reasons.push('quick-start-cliche');
    }

    // "1500 рублей за 10 минут" — implausibly quick payout for a short time window
    if (hasAmount && matches(/за\s+\d+\s*минут/)) {
        score += 3;
        reasons.push('quick-cash-minutes');
    }

    // "от 10000р" — job-ad income phrasing; rubles in a Poland-based chat
    if (matches(/от\s+\d[\d,.\s ]*\s*(р(?![а-яёa-z])|₽|руб)|от\s+\d[\d\s ]*\s+до\s+\d[\d,.\s ]*\s*(р(?![а-яёa-z])|₽|руб)|\d[\d\s ]{2,}\s*[-–]\s*\d[\d\s ]{2,}\s*(р(?![а-яёa-z])|₽|руб)/)) {
        score += 3;
        reasons.push('from-amount-rub');
    }

    // "на руки" / "налом" — weak (members legitimately discuss net pay), combine-only
    if (matches(/на\s+руки|налом/)) {
        score += 2;
        reasons.push('cash-in-hand');
    }

    // "подработка" — weak alone (members genuinely ask about side jobs),
    // deletes only combined with a DM invite or amounts
    if (matches(/п\s?одработк|подзаработ/)) {
        score += 2;
        reasons.push('gig-mention');
    }

    // "В кошельке ноль? Обращайся" — money-lending bait opener
    if (matches(/кошельке\s+ноль|в\s+кошельке\s+пусто/)) {
        score += 4;
        reasons.push('wallet-empty-bait');
    }

    // Money slang: бабки/бабло/баблишко. Restored (+2) — reputation now shields
    // regulars from the occasional false positive this used to cause.
    // Loose variant catches punctuation-split evasion ("баб.ок").
    if (matches(/бабк[иеуа]|бабок|бабл|бабос/) || matchesLoose(/бабк[иеуа]|бабок|бабл|бабос/)) {
        score += 2;
        reasons.push('money-slang');
    }

    // "напиши, помогу" — money-lending bait, checked loosely too
    // ("Нап.иши пом0гу" is the same phrase with dots/leetspeak inserted)
    if (matches(/напиш\S*\s+помог|пиш\S*\s+помог/) || matchesLoose(/напиш\S*\s+помог|пиш\S*\s+помог/)) {
        score += 4;
        reasons.push('help-bait');
    }

    // "выручу монетой" — financial-help bait, standalone
    if (matches(/выручу\s+монет/)) {
        score += 4;
        reasons.push('coin-slang');
    }

    // Mystery-shopper / drop scam: "проверить адреса" + pay, "фотоотчёт" + pay —
    // classic disguise for scouting drug-drop locations. "тайный проверяющий" and
    // "пройтись по городу и сфотографировать" are unambiguous on their own; the
    // other phrasings are common enough in honest work talk that they only count
    // paired with a payment amount.
    const isMysteryTask = matches(/провер\S*\s+(несколько\s+)?адрес|провер\S*\s+локаци|фотоотч[её]т|провер\S*\s+ремонт|провер\S*\s+упаковк|провер\S*\s+комплектност|провер\S*\s+вывеск|качеств\S*\s+печати|на\s+флаерах/);
    const isUnambiguousScoutTask = matches(/тайн\S*\s+проверя|пройтись\s+по\s+городу.{0,30}(фото|снимк)|сделать\s+фото.{0,30}(город|вывеск)/);
    if (isUnambiguousScoutTask || (isMysteryTask && hasAmount)) {
        score += 4;
        reasons.push('mystery-shopper');
    }

    // "берём/берем с 16 лет" — underage labor recruitment, distinct from
    // the 18+ age-gate rule (already covered separately)
    if (matches(/бер[её]м\s+с\s+1[4-7]\s+лет|принима[ею]м\s+с\s+1[4-7]\s+лет/)) {
        score += 4;
        reasons.push('underage-labor');
    }

    // "после смены наличными" — same-day cash payout, day-labor scam staple
    if (matches(/после\s+смены\s+наличн|наличными\s+после\s+смены/)) {
        score += 3;
        reasons.push('cash-after-shift');
    }

    // "есть тема / халтурка" — vague-gig openers. Alone it's a weak +3 (could
    // be an honest odd-job mention), but paired with any amount it's the
    // classic "vague task + payout" scam shape, so it earns a combined bonus.
    // No \b after "тема" — Cyrillic word boundaries are unreliable in JS regex
    const hasVagueGig = matches(/есть\s+тема(?![а-яё])|халтур/);
    if (hasVagueGig) {
        score += 3;
        reasons.push('vague-gig');
        if (hasAmount) {
            score += 3;
            reasons.push('vague-gig-paid');
        }
    }

    // Ukrainian-language recruiting: "житло надаємо" (жильё предоставляем),
    // "пиши в особисті" (пиши в личку), "шукаємо/запрошуємо українців"
    if (matches(/житло\s+над|шука[єe]мо\s+україн|запрошу[єe]мо\s+україн|роботу\s+за\s+кордоном|(пиш[іи]|напиш[іи])\S*\s+в\s+особист/)) {
        score += 5;
        reasons.push('ukr-recruit');
    }

    // "Нужда в …? / Нужны (срочно) деньги/деньжата / проблемы с деньгой" — money-offer opener
    if (matches(/нужда\s+в|нужн[аы]\s+(срочно\s+)?день[гж]\S*|нужен\s+доход|проблем\S*\s+с\s+деньг/)) {
        score += 3;
        reasons.push('need-money-opener');
    }
    if (matches(/обращайся|обращайтесь/)) {
        score += 2;
        reasons.push('contact-invite');
    }

    // Drug courier recruitment: тайники/кладмены/кидать закладки.
    // Bare "закладка" excluded — it also means a browser bookmark.
    // Листовщик/граффитчик — the same shops' "vacancies" for advertising on walls.
    if (matches(/тайник|тайничк|кладмен|закладчик|(кидать|раскид\S+|делать)\s+заклад|листовщик|граффитчик|графитчик|гашик|гашиш|мефедрон|спайс|амфетамин/)) {
        score += 5;
        reasons.push('drug-slang');
    }

    // Gig slang: шабашка/профит — spam staple, rare in legit messages
    if (matches(/шабашк|профит|подкинуть\s+работ/)) {
        score += 3;
        reasons.push('gig-slang');
    }

    // "нужны люди / нужен человек / нужен работник / ищем надёжных людей" — recruiting
    // opener; a single adjective (надёжных, трудолюбивых) is allowed between verb and noun
    const hasNeedPeople = matches(/(нуж[еныо]+|набира[юе]м|ищем|и[щш]у|возьму|необходим|в\s+поиске|приглаша[юе]\S*|набор)\s+(\S+\s+)?(человек|люд|рабоч[а-яё]*|работник\S*|сотрудник\S*|курьер\S*|водител[а-яё]*|чел(?![а-яё]))/);
    if (hasNeedPeople) {
        score += 3;
        reasons.push('need-people');
    }

    // Vague short-term gig ("на несколько дней / на пару дней") right after a
    // recruiting opener — a real short-term job post usually says what the
    // job actually is, not just its duration
    if (hasNeedPeople && matches(/на\s+несколько\s+дней|на\s+пару\s+дней/)) {
        score += 2;
        reasons.push('short-term-gig');
    }

    // "Возьму помощником продавца / курьером / водителем" — job-title recruit opener
    if (matches(/возьму\s+(помощник\S*|продавц\S*|курьер\S*|водител\S*)/)) {
        score += 3;
        reasons.push('job-title-recruit');
    }

    // "ничего тяжёлого нет / лёгкая работа" — reassurance cliché, weak alone
    if (matches(/ничего\s+тяжел\S*\s+нет|л[её]гкая\s+работа|работа\s+не\s+тяж[её]л/)) {
        score += 2;
        reasons.push('no-effort-cliche');
    }

    // "без стресса" — recruiting-pitch cliché
    if (matches(/без\s+стресса/)) {
        score += 3;
        reasons.push('no-stress-cliche');
    }

    // "всё просто и по делу" — vague recruiting-pitch closer
    if (matches(/вс[её]\s+просто\s+и\s+по\s+делу/)) {
        score += 2;
        reasons.push('simple-pitch');
    }

    // "только украинцы / только россияне" — ethnicity-restricted hiring, recruiting-scam marker
    if (matches(/только\s+украинц|только\s+россиян/)) {
        score += 3;
        reasons.push('ethnicity-restrict');
    }

    // "нужна работа" — genuine job-seekers say this too, so it only counts
    // paired with a pushy DM redirect (real questions don't shove "+в лс" at you)
    if (matches(/нужна\s+работа/) && hasDMRedirect) {
        score += 2;
        reasons.push('seeking-work-bait');
    }

    // "свободная вакансия / график любой / хороших вакансий" — vague recruiting cliché, weak alone
    if (matches(/свободн\S*\s+вакан|доступн\S*\s+вакан|график\s+любой|хорош\S*\s+вакан/)) {
        score += 2;
        reasons.push('open-vacancy');
    }

    // "ищу/ишу трудолюбивых" — recruiting without even saying "людей" (common
    // typo "ишу" for "ищу" kept deliberately, spammers make this exact typo)
    if (matches(/и[щш]у\s+трудолюбив/)) {
        score += 3;
        reasons.push('recruit-cliche');
    }

    // "личный автомобиль приветствуется / график подстраиваем" — flexible-job clichés
    if (matches(/приветствуется|график\s+подстраива/)) {
        score += 2;
        reasons.push('flexible-recruit');
    }

    // Photo-scouting task disguised as a city walk — classic drug-drop scouting scam
    if (matches(/сфотографир\S*\s+(три|\d+)\s+объект|адреса\s+и\s+примеры\s+скин|после\s+отправки\s+фото/)) {
        score += 5;
        reasons.push('photo-scout');
    }

    // "Менеджер по обработке заявок … принять заявку … передать дальше" — vague
    // claims-processing role, same family as chat-operator/mule recruitment
    if (matches(/менеджер\S*\s+по\s+обработке\s+заявок|принять\s+заявку.{0,60}передать\s+(обращение\s+)?дальше/)) {
        score += 5;
        reasons.push('claims-processor');
    }

    // "20000 за пару часов? Легко" — bare amount + easy-money bait, no task described
    if (hasAmount && matches(/(за|на)\s+пару\s+часов/)) {
        score += 4;
        reasons.push('easy-money');
    }

    // "На сегодня, 5 человек, пару часов работы" / "Завтра к 12:00 нужно 3 человека"
    // — headcount recruiting for today/tomorrow
    if (matches(/на\s+(сегодня|завтра).{0,20}\d+\s+человек|(сегодня|завтра).{0,20}нуж\S*\s+\d+\s+человек|\d+\s+человек.{0,20}на\s+(сегодня|завтра)/)) {
        score += 4;
        reasons.push('headcount-today');
    }

    // "заработать от 7000 за вечер / оплачиваем работу еженедельно / от 70к" — income clichés
    if (matches(/заработать\s+от\s+\d|от\s+\d[\d\s]*\s+за\s+(вечер|день|смену|час)|оплачива\S*\s+работ\S*\s+еженедельно|от\s+\d+\s*[кk](?!\d)[.\s]*$/)) {
        score += 3;
        reasons.push('income-cliche');
    }

    // "т?ребуется упаковщик/грузчик/..." — job-ad opener, typo-tolerant
    // ("ребуется" with the leading Т dropped is a common obfuscation)
    if (matches(/т?ребу[ею]тся\s+(упаковщик|грузчик|курьер|разнорабоч|сотрудник|человек)/)) {
        score += 3;
        reasons.push('vacancy-title');
    }

    // "плачу за поручения по городу / забрать-передать" — courier-mule euphemism
    if (matches(/поручени\S*\s+по\s+городу|забрать\s*\/\s*передать|забрать\s+и\s+передать/)) {
        score += 4;
        reasons.push('errand-scam');
    }

    // "куплю тез / юсдт" — crypto buy-sell slang, narrow bigram (bare "тез" alone is too risky)
    if (matches(/куплю\s+(тез|юсдт|usdt|крипт)/)) {
        score += 3;
        reasons.push('crypto-buysell-slang');
    }

    // "выплаты ежедневно / оплата ежедневно" — daily-payout gig red flag
    if (matches(/(оплат|выплат)\S*\s+в\s+тот\s+же\s+день|выплат\S*\s+ежедневно|оплата\s+ежедневно|плат\S*\s+кажд\S*\s+день/)) {
        score += 4;
        reasons.push('daily-payout');
    }

    // "кому нужен сегодня заработок" — income-offer recruiting opener
    if (matches(/нужен\s+сегодня\s+заработок|кому\s+нужен\s+заработок/)) {
        score += 3;
        reasons.push('today-income-offer');
    }

    // Polish drug-marketplace ad: "PRIV" repeated as a contact invite (2+ times
    // is the tell — a single mention could be innocuous), pharma slang with
    // leetspeak-obfuscated drug names (pregabal1na, medik1net, levomethad0ne)
    const privCount = (rawLower.match(/\bpriv\b/g) || []).length;
    if (privCount >= 2) {
        score += 5;
        reasons.push('priv-repeat');
    }
    if (matches(/medik[1i]net|levomethad[0o]ne|pregabal[1i]na|\balpra\b.{0,10}mg/)) {
        score += 5;
        reasons.push('pharma-slang');
    }

    // "актуальная тема/темка/ниша" — crypto-scam slang for the unnamed "opportunity"
    if (matches(/актуальн\S*\s+(тем[ак]|ниш)|нов\S*\s+ниш[ае]/)) {
        score += 4;
        reasons.push('trendy-topic');
    }

    // "выхлоп 12.000" — slang for profit, but ONLY next to a number:
    // in a drivers' chat "выхлоп" alone is just a car exhaust
    if (matches(/выхлоп[а-яё]*\s+(от\s+)?\d|\d\S*\s+выхлоп/)) {
        score += 3;
        reasons.push('profit-slang');
    }

    // "оплата по факту / сразу / после дела получаете" — day-labor scam payment phrasing
    if (matches(/оплата\s+по\s+факту|оплата\s+сразу|деньги\s+сразу|расчет\s+сразу|расчёт\s+сразу|после\s+дела\s+получ|получаете\s+\d/)) {
        score += 3;
        reasons.push('pay-terms');
    }

    // "N часов твоего/вашего времени" — recruiting cliché
    if (matches(/(час|минут)[а-яё]*\s+(тво|ва)[а-яё]*\s+времени/)) {
        score += 3;
        reasons.push('your-time');
    }

    // Cash exchange offer ("за наличные", "личная встреча" in money context)
    if (matches(/за\s+наличные|личн\S*\s+встреч/)) {
        score += 3;
        reasons.push('cash-deal');
    }

    // "за выход" — classic criminal job ad, high confidence
    if (/\d+.*за\s+выход|за\s+выход.*\d+/.test(text)) {
        score += 5;
        reasons.push('criminal-job');
    }

    // "с 18 лет" / bare "18+" — age gate is a strong spam marker in job ads, but
    // appears in legitimate questions too ("права с 18 лет?"), so no solo delete
    if (matches(/с\s+1[3-9]\s+(лет|до\s+\d+\s+лет)|(^|[\s,.:!—-])1[3-9]\s*\+/)) {
        score += 3;
        reasons.push('age-gate');
    }

    // "Пишите/писать … @username" — contact via personal account, job-scam staple
    if (/(пиш[иите]*|писать|стучи|черкн[иите]*)[^]{0,30}@[a-z0-9_]{4,}/i.test(rawText)) {
        score += 4;
        reasons.push('contact-username');
    }

    // Amount per day. Bare "в день" is allowed again now that hasAmount requires
    // a substantial number (currency word, 4+ digits, or spaced thousands) —
    // "12 часов в день" doesn't set hasAmount, so it no longer collides with this.
    if (hasAmount && /(день\s+\d+(\s*[-–]\s*\d+)?\s*[кk](?![а-яёa-z\d])|за\s+день|\-\s*день|в\s+сутки|\/\s*день|(?<!а\s)(?<!не\s)в\s+день|\d\s+день(?!\S))/.test(text)) {
        score += 4;
        reasons.push('per-day-pay');
    }

    // Amount per week ("630 евро в неделю")
    if (hasAmount && matches(/в\s+неделю/)) {
        score += 3;
        reasons.push('weekly-pay');
    }

    // Amount per month ("до 10 000$ в месяц")
    if (hasAmount && matches(/в\s+месяц/)) {
        score += 3;
        reasons.push('monthly-pay');
    }

    // "купить свою мечту" — dream-buying income cliché
    if (matches(/купить\s+(свою\s+)?мечту/)) {
        score += 3;
        reasons.push('dream-cliche');
    }

    // "чем больше часов, тем больше зп" — piece-rate cliché from job-scam ads
    if (matches(/чем\s+больше.{0,40}тем\s+больше/)) {
        score += 3;
        reasons.push('piece-rate-cliche');
    }

    // Spelled-out amount in words ("двадцать пять тысяч") — evades digit-only detection
    if (matches(/\S*дцать(\s+\S+)?\s+тысяч|(десять|пятнадцать)\s+тысяч/)) {
        score += 3;
        reasons.push('amount-words');
    }

    // "Пишите [Name]" without explicit DM link — name likely carries a hidden link
    if (/пишите\s+[А-ЯЁ][а-яё]+/.test(rawText)) {
        score += 3;
        reasons.push('write-to-name');
    }

    // "сразу на карту по 1000р" / "на карту 4к" — payout promised to a card,
    // in rubles or "к" shorthand (members talk about złoty payouts, not these)
    if (matches(/на\s+карт[уы]\s+(по\s+)?\d+\s*(р(?![а-яёa-z])|руб|₽|[кk](?![а-яёa-z\d]))|\d+\s*(р(?![а-яёa-z])|руб|₽|[кk])\s+на\s+карт[уы]/)) {
        score += 4;
        reasons.push('card-payout');
    }

    // "Первым кто напишет …" — race-to-DM bait
    if (matches(/перв(ым|ому|ые|ых)\s+(\S+\s+)?(кто\s+)?(напиш|отпиш|ответ)/)) {
        score += 3;
        reasons.push('first-to-write');
    }

    // Any ruble amount — rubles are alien to this Poland-based chat. Weak alone.
    if (matches(/\d+\s*(р(?![а-яёa-z])|руб|₽)/)) {
        score += 2;
        reasons.push('rub-amount');
    }

    // "есть две мисии в лс" / "пару задач с телефоном" — vague task bait
    if (matches(/(есть|пару|две|три|\d)\s+мис+и|задач\S*\s+с\s+телефон/)) {
        score += 4;
        reasons.push('mission-bait');
    }

    // "Сталкер-фотограф" — fake abandoned-site photo gig
    if (matches(/сталкер/)) {
        score += 3;
        reasons.push('stalker-gig');
    }

    // "интересно — пиши" — recruiting sign-off
    if (matches(/интересно[\s,—–-]+(пиш|пишите|напиш|в\s*лс|в\s*личк)/)) {
        score += 3;
        reasons.push('interested-write');
    }

    // "ещё один источник заработка" / "финансовый рост" — income-pitch clichés
    if (matches(/(^|[^а-яё])(ещ[её]\s+один|дополнительн\S*|втор\S*|нов\S*)\s+источник\S*\s+(заработ|доход)/)) {
        score += 4;
        reasons.push('income-source-bait');
    }
    if (matches(/финансов\S*\s+рост/)) {
        score += 3;
        reasons.push('financial-growth');
    }

    // "кто может помочь …, за деньги / за оплату" — paid-help opener. Weak alone.
    if (matches(/за\s+(деньги|оплату|плату|вознагражден)/)) {
        score += 2;
        reasons.push('paid-help');
    }

    // "помощь с лёгким монтажом" — video-editing bait. Not bare "монтаж":
    // drivers ask about шиномонтаж / монтаж шин.
    if (matches(/(помощ\S*|понимани\S*|опыт\S*)\s+(в|с)\s+(\S+\s+)?монтаж|видео\s?монтаж|монтаж\S*\s+видео/)) {
        score += 2;
        reasons.push('montage-bait');
    }

    // "Кто сидит без дела? … с быстрыми выплатами"
    if (matches(/сид(ит|ишь|ите)\s+без\s+дела/)) {
        score += 3;
        reasons.push('idle-bait');
    }
    if (matches(/быстр\S*\s+выплат/)) {
        score += 3;
        reasons.push('fast-payout');
    }

    // "Доход … р за один рейс" — drug/contraband courier pay in rubles
    if (matches(/\d\s*(р(?![а-яёa-z])|₽|руб)\S*\s+за\s+(один\s+)?рейс/)) {
        score += 3;
        reasons.push('per-trip-rub');
    }

    // "присоединиться к удалённому проекту", "свободное время приносило"
    if (matches(/удал[её]нн\S*\s+проект/)) {
        score += 3;
        reasons.push('remote-project');
    }
    if (matches(/свободн\S*\s+время\s+приносил/)) {
        score += 3;
        reasons.push('free-time-bait');
    }
    // "Напиши «СТАРТ» в личные сообщения" — code word to DM
    if (matches(/напиш\S*\s+[«"„“']?[^\s«»"„“']+[»"”']?\s+в\s+(личн|лс|личк)/)) {
        score += 3;
        reasons.push('keyword-dm');
    }

    // "на серую тему" — explicit grey/illegal work
    if (matches(/сер(ую|ой|ая|ые|ых)\s+(тем|схем|работ|заработ)/)) {
        score += 5;
        reasons.push('grey-scheme');
    }

    // "За моё спасение даю 6000" — dramatized paid-help bait
    if (matches(/за\s+(мо[её]\s+)?спасени/)) {
        score += 2;
        reasons.push('rescue-bait');
    }

    // "Сделаем с тебя профи" — recruiting promise
    if (matches(/сдела\S*\s+(с|из)\s+тебя\s+профи/)) {
        score += 2;
        reasons.push('make-you-pro');
    }

    // "Напиши мне и получи 100$" — free-money bait
    if (matches(/получи(шь|те)?\s+\d+\s*(\$|usd|долл|евро|€|руб|р(?![а-яёa-z])|₽|[кk](?![а-яёa-z\d]))/)) {
        score += 3;
        reasons.push('get-money-bait');
    }

    // "бабки за простые действия"
    if (matches(/за\s+прост\S*\s+(действи|задани|задач)/)) {
        score += 3;
        reasons.push('simple-actions');
    }

    // "не хватает на твои хотелки, дам работу, накопишь" — lifestyle bait
    if (matches(/хотелк/)) {
        score += 3;
        reasons.push('wishes-bait');
    }
    if (matches(/дам\s+работу/)) {
        score += 3;
        reasons.push('give-job');
    }
    if (matches(/устал\S*\s+сидеть\s+дома/)) {
        score += 2;
        reasons.push('bored-at-home');
    }

    // "под мутку" — slang for a shady deal
    if (matches(/мутк/)) {
        score += 4;
        reasons.push('shady-deal-slang');
    }

    // "набор людей на митинг, плачу 12к" — paid rally attendance
    if (hasAmount && matches(/митинг|протест/)) {
        score += 4;
        reasons.push('paid-rally');
    }

    // "межгород от 45.000 за рейс" — thousands per trip with no złoty: courier
    // pay from the drug/contraband ads, not a Polish delivery rate
    if (matches(/межгород/)) {
        score += 2;
        reasons.push('intercity');
    }
    if (matches(/\d{1,3}[.\s ]000\s+за\s+(один\s+)?рейс/)) {
        score += 3;
        reasons.push('per-trip-thousands');
    }

    // "персональный водитель, сопровождение работодателя"
    if (matches(/персональн\S*\s+водител|сопровожден\S*\s+работодател/)) {
        score += 3;
        reasons.push('personal-driver');
    }

    // "Рассматриваешь сейчас варианты …?"
    if (matches(/рассматрива\S*\s+(сейчас\s+)?вариант/)) {
        score += 2;
        reasons.push('considering-options');
    }

    // "предоставляем много вакансий"
    if (matches(/(много|куча|масса)\s+ваканси/)) {
        score += 2;
        reasons.push('many-vacancies');
    }

    // "есть вакансия для всех"
    if (matches(/ваканси\S*\s+для\s+всех/)) {
        score += 3;
        reasons.push('vacancy-for-all');
    }

    // Stolen-card shops ("CC store", "CVV", "fullz")
    if (matches(/(^|[^a-z])cc\s+(store|cards?|inventory|shop)|(^|[^a-z])cvv|fullz|carding/)) {
        score += 5;
        reasons.push('carding');
    }

    // Financial help / loan / debt offers (incl. "вытащим с ЧС", "закрою долги")
    if (matches(/помощ\S*\s+с\s+финанс|финанс\S*\s+помощ|до\s+получения\s+зарплат|трудн\S*\s+финансов|помощь\s+с\s+деньгами|вытащим\s+с\s+чс|без\s+залога|закро[юем]+\s+долг|закрыть\s+долги|спис[аше]\S*\s+долг|помо[гж]\S*\s+с\s+займ|займ\S*\s+без|без\s+(%|процент\S*)\s+и\s+провер|без\s+проверок|помо[гж]\S*\s+(закрыть|погасить)\s+(кредит|долг|займ)/)) {
        score += 5;
        reasons.push('loan-offer');
    }

    // "Оператор чата" vacancy — chat-operator scam (often trafficking recruitment)
    if (matches(/оператора?\s+чат[а-я]*|чат[\s-]+оператор/)) {
        score += 5;
        reasons.push('chat-operator');
    }

    // Relocation package: "оплачиваем переезд", "предоставляем жильё", "проживание включено",
    // "жильё от меня"
    if (matches(/оплачива\S*\s+переезд|переезд[^а-яё]{0,3}(за\s+наш|оплач|включ)|переезд[а-яё,\s]{0,20}включен|(жиль[её]|проживание)[^а-яё]{0,3}(предоставля|включ|от\s+меня|от\s+фирмы|от\s+компании|от\s+нас)|предоставля\S*\s+(жиль[её]|проживание)/)) {
        score += 5;
        reasons.push('relocation-offer');
    }

    // Ads targeting women specifically — trafficking marker
    if (matches(/помощь\s+девушкам|работа\s+для\s+девушек|девушк[иам]+\s+18|для\s+одной\s+девушки|для\s+одной\s+женщины/)) {
        score += 4;
        reasons.push('targets-women');
    }

    // "щедро отплачу / щедро заплачу" — generous-payment cliché
    if (matches(/щедро\s+отплачу|щедро\s+заплачу/)) {
        score += 3;
        reasons.push('generous-pay-cliche');
    }

    // Recruiting "into the team"
    if (matches(/(ищем|ищу|набираем|требу[юе]тся)\s+в\s+команду|в\s+команду\s+(оператор|менеджер|сотрудник|человек)/)) {
        score += 4;
        reasons.push('team-recruit');
    }

    // Cushy-job clichés: "высокий доход", "свободный график", "высокие суммы",
    // "гибкий формат/график", "совмещать с другими делами", "без фиксированного
    // графика", "стабильный доход", "оплата/зарплата высокая" — weak, combine-only
    if (matches(/высокий\s+доход|свободный\s+график|комфортные\s+условия|высок\S*\s+сумм|гибкий\s+(формат|график)|совмещать\s+с\s+другими\s+делами|без\s+фиксирован\S*.{0,25}график|стабильный\s+доход|(оплата|зарплата)\s+высок\S*/)) {
        score += 3;
        reasons.push('cushy-job');
    }

    // "опыт не важен / без опыта" — weak marker
    if (matches(/опыт\s+не\s+важен|без\s+опыта|опыт\s+необязателен/)) {
        score += 3;
        reasons.push('no-experience');
    }

    // Homoglyph attack: detect words that MIX Cyrillic and Latin/Greek lookalikes in the same word.
    // e.g. "вοдитeль" (о=Greek, e=Latin mixed with Cyrillic) — bots do this, humans don't.
    // Checking per-word (not total delta) prevents false positives from Polish words like "Błonie"
    // that happen to contain Latin letters mapped to Cyrillic (B, o, e) but are standalone Latin words.
    // Split on slashes/pipes too: "Аренда/Wynajem/RENT" is three words, not one
    const hasMixedScriptWord = rawText.split(/[\s\/|•]+/).some(word => {
        const hasCyrillic = /[а-яёА-ЯЁ]/.test(word);
        const hasMappedLatin = word.split('').some(ch => HOMOGLYPH_MAP[ch]);
        return hasCyrillic && hasMappedLatin;
    });
    if (hasMixedScriptWord) {
        score += 5;
        reasons.push('homoglyphs');
    }

    return { score, reasons };
}

class MessageHandler {
    constructor(bot) {
        this.bot = bot;
        this.messageCache = new Set();
        this.reputation = new Reputation();
        // Deleted messages kept for the "restore" button in the log channel.
        // Keyed by a short id because callback_data is limited to 64 bytes.
        this.deletedMessages = new Map();
        this.nextDeletedId = 1;
        // Recent message ids per chat+user, so a ban can also wipe the
        // spammer's earlier messages — not just the one that got caught.
        this.recentMessages = new Map();
        // "chatId:messageId" already reported via /report — one report per message
        this.reportedMessages = new Set();
        this.watchers = new Watchers();
        // Watcher deletions awaiting the owner's verdict, keyed by a short id
        // (callback_data is limited to 64 bytes). Lost on restart — the ban /
        // keep buttons still work then, only "restore" loses the text.
        this.watchDeletions = new Map();
        this.nextWatchId = 1;
        this.watchDecided = new Set();
        this.botId = null;
        bot.getMe().then(me => { this.botId = me.id; }).catch(() => {});
    }

    isExempt(userId) {
        return config.exemptUserIds && config.exemptUserIds.includes(userId);
    }

    async handleNewMember(msg) {
        try {
            await this.bot.deleteMessage(msg.chat.id, msg.message_id);
        } catch (error) {
            console.error('Error deleting new member message:', error);
        }
    }

    async handleLeftMember(msg) {
        try {
            await this.bot.deleteMessage(msg.chat.id, msg.message_id);
        } catch (error) {
            console.error('Error deleting left member message:', error);
        }
    }

    async handleMessage(msg) {
        console.log(`[DEBUG] Received message from ${msg.from.id}: "${msg.text || '[no text]'}"`);
        const messageId = `${msg.chat.id}:${msg.message_id}`;
        if (this.messageCache.has(messageId)) return;
        this.messageCache.add(messageId);

        // Runs before the exempt check — admins are usually exempt themselves
        if (/^\/spam(@\w+)?\s*$/i.test(msg.text || '') && msg.reply_to_message) {
            await this.handleSpamCommand(msg);
            return;
        }
        if (/^\/report(@\w+)?\s*$/i.test(msg.text || '') && msg.reply_to_message) {
            await this.handleReportCommand(msg);
            return;
        }
        if (/^\/delete(@\w+)?\s*$/i.test(msg.text || '') && msg.reply_to_message) {
            await this.handleDeleteCommand(msg);
            return;
        }
        if (msg.chat.type === 'private' && /^\/watch(\s|$)/i.test(msg.text || '')) {
            await this.handleWatchCommand(msg);
            return;
        }

        if (this.isExempt(msg.from.id)) return;
        if (this.botId && msg.from.id === this.botId) return;
        if (config.logChatIds.includes(String(msg.chat.id))) return;

        this.trackMessage(msg);
        const { buttons, fullText } = this.extractText(msg);
        if (!fullText.trim()) return;

        try {
            // Whitelist check — always keep messages with trusted links/names
            const lowerFull = fullText.toLowerCase();
            const whitelisted = config.wordsToKeep.some(w => lowerFull.includes(w.toLowerCase()));
            if (whitelisted) {
                console.log(`[DEBUG] Whitelisted message from ${msg.from.id}`);
                this.reputation.recordMessage(msg.chat.id, msg.from.id);
                return;
            }

            const { score, reasons } = spamScore(fullText);
            let totalScore = score;

            // Hidden hyperlink in message text (e.g. "Пишите Виктория" where name is a link).
            // Strong signal, but scored (not instant delete) so established members
            // posting formatted links aren't nuked.
            const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
            const hiddenLinks = entities.filter(e => e.type === 'text_link').length;
            if (hiddenLinks >= 2) {
                // Several disguised links ("[PLAY NOW]" x3) — no legit message does this
                totalScore += 6;
                reasons.push('hidden-links-multi');
            } else if (hiddenLinks === 1) {
                totalScore += 4;
                reasons.push('hidden-link');
            }

            // Premium "font" spam: every letter is a custom emoji from an
            // alphabet pack, so the text we get is just fallback smileys and no
            // word rule can match. Members use a handful of custom emoji at
            // most; dozens in one message is a lettering trick.
            const customEmoji = entities.filter(e => e.type === 'custom_emoji').length;
            if (customEmoji >= 25) {
                totalScore += 5;
                reasons.push(`custom-emoji-font(${customEmoji})`);
            } else if (customEmoji >= 10) {
                totalScore += 2;
                reasons.push(`custom-emoji-many(${customEmoji})`);
            }

            // A member forwarding a bot's ad with link buttons — no legit reason
            // to do that in this chat. Many link buttons from any forward is weaker.
            const origin = msg.forward_origin;
            const fwdFromBot = (origin && origin.type === 'user' && origin.sender_user && origin.sender_user.is_bot)
                || (msg.forward_from && msg.forward_from.is_bot);
            const isForward = Boolean(origin || msg.forward_date);
            const urlButtons = buttons.filter(b => b.url).length;
            if (fwdFromBot && urlButtons) {
                totalScore += 5;
                reasons.push('forwarded-bot-ad');
            } else if (isForward && urlButtons >= 3) {
                totalScore += 3;
                reasons.push('forwarded-link-buttons');
            }

            // Established members earn a higher deletion threshold
            const bonus = this.reputation.thresholdBonus(msg.chat.id, msg.from.id);
            const threshold = config.spamScoreThreshold + bonus;

            if (totalScore >= threshold) {
                console.log(`[DEBUG] Deleting spam (score=${totalScore}/${threshold}, reasons=${reasons.join(',')}): "${fullText.substring(0, 60)}..."`);
                await this.bot.deleteMessage(msg.chat.id, msg.message_id);

                // High score → ban the sender, not just delete the message
                let banned = false;
                let banError = null;
                let extraDeleted = 0;
                if (totalScore >= config.banScoreThreshold + bonus) {
                    try {
                        await this.bot.banChatMember(msg.chat.id, msg.from.id);
                        banned = true;
                        console.log(`[DEBUG] Banned user ${msg.from.id} (score=${totalScore})`);
                        extraDeleted = await this.purgeRecentMessages(msg.chat.id, msg.from.id, msg.message_id);
                    } catch (error) {
                        // Likely missing "ban users" admin right — deletion still worked.
                        // Surfaced in the log channel too, so this isn't invisible unless
                        // someone is watching the server console.
                        banError = error.message || String(error);
                        console.error('Error banning user:', banError);
                    }
                }

                await this.logDeletion(msg, fullText, totalScore, threshold, reasons, banned, banError, extraDeleted);
            } else {
                if (totalScore > 0) {
                    console.log(`[DEBUG] Keeping message (score=${totalScore}/${threshold}, reasons=${reasons.join(',')})`);
                }
                this.reputation.recordMessage(msg.chat.id, msg.from.id);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        } finally {
            setTimeout(() => this.messageCache.delete(messageId), 5000);
        }
    }

    extractText(msg) {
        // Forwarded bot/channel posts keep their inline URL buttons — and spam
        // often hides all its words there, with the "text" being just a picture.
        const buttons = ((msg.reply_markup && msg.reply_markup.inline_keyboard) || []).flat();
        const buttonText = buttons.map(b => b.text || '').join('\n');
        const fullText = (msg.text || '') + ' ' + (msg.caption || '') + ' ' + buttonText;
        return { buttons, fullText };
    }

    // Admins posting "as the group" (anonymous) or as the group's linked
    // channel arrive with sender_chat set and a service account in `from`.
    async isAdminIdentity(msg) {
        const sc = msg.sender_chat;
        if (sc) {
            if (sc.id === msg.chat.id || this.isExempt(sc.id)) return true;
            try {
                const chat = await this.bot.getChat(msg.chat.id);
                if (chat.linked_chat_id === sc.id) return true;
            } catch (error) {
                console.error('Error fetching chat info:', error.message || error);
            }
            return false;
        }
        return this.isChatAdmin(msg.chat.id, msg.from.id);
    }

    async isChatAdmin(chatId, userId) {
        if (this.isExempt(userId)) return true;
        try {
            const member = await this.bot.getChatMember(chatId, userId);
            return member.status === 'creator' || member.status === 'administrator';
        } catch (error) {
            console.error('Error checking admin status:', error);
            return false;
        }
    }

    // "/spam" sent by an admin as a reply to a missed spam message: delete it,
    // ban the author, and log it with the score it got — so we see which rule
    // to add. Non-admins' /spam is just removed.
    async handleSpamCommand(msg) {
        const chatId = msg.chat.id;
        const target = msg.reply_to_message;
        try {
            await this.bot.deleteMessage(chatId, msg.message_id);
        } catch (error) {
            console.error('Error deleting /spam command:', error);
        }

        if (!await this.isAdminIdentity(msg)) {
            console.log(`[DEBUG] /spam ignored: sender ${msg.from.id} (sender_chat ${msg.sender_chat && msg.sender_chat.id}) is not an admin`);
            return;
        }
        if (await this.isAdminIdentity(target) || (this.botId && target.from.id === this.botId)) {
            console.log(`[DEBUG] /spam ignored: target ${target.from.id} is an admin, exempt or the bot`);
            return;
        }

        const { banned, banError, extraDeleted } =
            await this.removeSpammer(chatId, target.from.id, target.message_id);

        const { fullText } = this.extractText(target);
        const { score, reasons } = spamScore(fullText);
        const threshold = config.spamScoreThreshold + this.reputation.thresholdBonus(chatId, target.from.id);
        const adminName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
        reasons.push(`👮 /spam от ${adminName}`);
        console.log(`[DEBUG] /spam by ${msg.from.id} on user ${target.from.id} (score was ${score})`);
        await this.logDeletion(target, fullText || '[без текста]', score, threshold, reasons, banned, banError, extraDeleted);
    }

    // Manual verdict (/spam or the report button): delete the message, ban the
    // author, and wipe the rest of their recent messages and reputation.
    async removeSpammer(chatId, userId, messageId) {
        // messageId 0 = already deleted (watcher flow)
        if (messageId) {
            try {
                await this.bot.deleteMessage(chatId, messageId);
            } catch (error) {
                console.error('Error deleting reported message:', error);
            }
        }

        let banned = false;
        let banError = null;
        try {
            await this.bot.banChatMember(chatId, userId);
            banned = true;
        } catch (error) {
            banError = error.message || String(error);
            console.error('Error banning reported user:', banError);
        }
        // The rest of their spam burst goes too, ban or not — an admin said so
        const extraDeleted = await this.purgeRecentMessages(chatId, userId, messageId);
        // Messages they got through counted as "good" — wipe that credit
        this.reputation.reset(chatId, userId);
        return { banned, banError, extraDeleted };
    }

    // "/report" from any member as a reply: forwards the suspect message to the
    // log chats with "delete + ban" / "not spam" buttons. Nothing is deleted
    // until someone there decides.
    async handleReportCommand(msg) {
        const chatId = msg.chat.id;
        const target = msg.reply_to_message;
        try {
            await this.bot.deleteMessage(chatId, msg.message_id);
        } catch (error) {
            console.error('Error deleting /report command:', error);
        }

        const key = `${chatId}:${target.message_id}`;
        let ignored = null;
        if (!config.logChatIds.length) ignored = 'LOG_CHAT_ID is not set';
        else if (target.from.id === msg.from.id) ignored = 'reported own message';
        else if (await this.isAdminIdentity(target) || (this.botId && target.from.id === this.botId)) ignored = 'target is an admin, exempt or the bot';
        if (ignored) {
            console.log(`[DEBUG] /report ignored: ${ignored}`);
            return;
        }
        // Short confirmation so the member knows it went through; removed
        // after a few seconds to keep the chat clean
        try {
            const ack = await this.bot.sendMessage(chatId, '✅ Жалоба отправлена админам');
            setTimeout(() => this.bot.deleteMessage(chatId, ack.message_id).catch(() => {}), 5000);
        } catch (error) {
            console.error('Error sending report ack:', error.message || error);
        }
        if (this.reportedMessages.has(key)) return;
        this.reportedMessages.add(key);
        if (this.reportedMessages.size > 1000) {
            this.reportedMessages.delete(this.reportedMessages.values().next().value);
        }

        const fullName = u => [u.first_name, u.last_name].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : '');
        // Private supergroups: t.me/c/<id without -100>/<msg>; public: t.me/<username>/<msg>
        const link = msg.chat.username
            ? `https://t.me/${msg.chat.username}/${target.message_id}`
            : `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${target.message_id}`;
        const { fullText } = this.extractText(target);
        const { score, reasons } = spamScore(fullText);
        const report =
            `⚠️ Жалоба в «${msg.chat.title || chatId}»\n` +
            `Пожаловался: ${fullName(msg.from)}, id ${msg.from.id}\n` +
            `На: ${fullName(target.from)}, id ${target.from.id}\n` +
            `Счёт: ${score} — ${reasons.join(', ') || 'нет совпадений'}\n` +
            `${link}\n\n` +
            (fullText.trim() || '[без текста]').substring(0, 3000);
        const buttons = [
            { text: '🗑 Удалить + бан', callback_data: `rspam:${chatId}:${target.message_id}:${target.from.id}` },
            { text: '✅ Не спам', callback_data: 'rkeep' },
        ];
        console.log(`[DEBUG] /report by ${msg.from.id} on user ${target.from.id} (score ${score})`);
        for (const logChatId of config.logChatIds) {
            try {
                await this.bot.sendMessage(logChatId, report, {
                    reply_markup: { inline_keyboard: [buttons] },
                    disable_web_page_preview: true,
                });
            } catch (error) {
                console.error(`Error sending report to ${logChatId}:`, error.message || error);
            }
        }
    }

    // The owner = whoever receives reports in a private chat with the bot
    isOwner(userId) {
        return config.logChatIds.includes(String(userId));
    }

    // In the bot's DM, owner only:
    //   /watch add <id>, /watch remove <id>, /watch list
    async handleWatchCommand(msg) {
        if (!this.isOwner(msg.from.id)) return;
        const [, action, rawId] = (msg.text || '').trim().split(/\s+/);
        const id = Number(rawId);
        let reply;
        if (action === 'add' && id) {
            this.watchers.add(id);
            reply = `✅ ${id} — сторож. Может удалять сообщения командой /delete (ответом на сообщение).`;
        } else if (action === 'remove' && id) {
            reply = this.watchers.remove(id) ? `🗑 ${id} больше не сторож.` : `${id} не был сторожем.`;
        } else if (action === 'list') {
            const ids = Object.keys(this.watchers.list);
            reply = ids.length
                ? 'Сторожа:\n' + ids.map(w => {
                    const st = this.watchers.list[w];
                    return `${w} — точность ${this.watchers.accuracy(w)}${st.disabled ? ' ⛔ отключён' : ''}`;
                }).join('\n')
                : 'Сторожей пока нет.';
        } else {
            reply = 'Команды:\n/watch add <id> — назначить сторожа (или включить обратно)\n/watch remove <id> — снять\n/watch list — список и точность';
        }
        await this.bot.sendMessage(msg.chat.id, reply);
    }

    async setMuted(chatId, userId, muted) {
        const perms = ['can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos',
            'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls',
            'can_send_other_messages', 'can_add_web_page_previews'];
        const form = { permissions: JSON.stringify(Object.fromEntries(perms.map(p => [p, !muted]))) };
        // Safety net: if nobody reviews the report, the mute lifts itself in 24h
        if (muted) form.until_date = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
        try {
            await this.bot.restrictChatMember(chatId, userId, form);
            return true;
        } catch (error) {
            console.error(`Error ${muted ? 'muting' : 'unmuting'} user:`, error.message || error);
            return false;
        }
    }

    // "/delete" from a night watcher as a reply: delete now, mute the author,
    // and let the owner decide (ban / keep deleted / restore) from the report.
    // Protected authors and over-limit watchers fall back to a plain /report.
    async handleDeleteCommand(msg) {
        const chatId = msg.chat.id;
        const target = msg.reply_to_message;
        const watcherId = msg.from.id;

        if (!this.watchers.isActive(watcherId)) {
            console.log(`[DEBUG] /delete ignored: ${watcherId} is not an active watcher`);
            try {
                await this.bot.deleteMessage(chatId, msg.message_id);
            } catch (error) {
                console.error('Error deleting /delete command:', error);
            }
            return;
        }

        const protectedTarget = target.from.id === watcherId
            || (this.botId && target.from.id === this.botId)
            || this.watchers.isWatcher(target.from.id)
            || this.reputation.messageCount(chatId, target.from.id) >= 25
            || await this.isAdminIdentity(target);
        if (protectedTarget || !this.watchers.takeQuota(watcherId)) {
            console.log(`[DEBUG] /delete by ${watcherId} downgraded to /report (${protectedTarget ? 'protected author' : 'hourly limit'})`);
            await this.handleReportCommand(msg);
            return;
        }

        try {
            await this.bot.deleteMessage(chatId, msg.message_id);
        } catch (error) {
            console.error('Error deleting /delete command:', error);
        }
        try {
            await this.bot.deleteMessage(chatId, target.message_id);
        } catch (error) {
            console.error('Error deleting watched message:', error);
        }
        const muted = await this.setMuted(chatId, target.from.id, true);

        const { fullText } = this.extractText(target);
        const text = fullText.trim() || '[без текста]';
        const id = this.nextWatchId++;
        this.watchDeletions.set(id, { text, from: target.from });
        if (this.watchDeletions.size > 500) {
            this.watchDeletions.delete(this.watchDeletions.keys().next().value);
        }

        const fullName = u => [u.first_name, u.last_name].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : '');
        const { score, reasons } = spamScore(fullText);
        const report =
            `🌙 Удалено сторожем в «${msg.chat.title || chatId}»\n` +
            `Сторож: ${fullName(msg.from)}, id ${watcherId} — точность ${this.watchers.accuracy(watcherId)}\n` +
            `Автор: ${fullName(target.from)}, id ${target.from.id}` +
            (muted ? ' — заглушён до решения (макс. 24ч)\n' : ' — ⚠️ заглушить не удалось\n') +
            `Счёт: ${score} — ${reasons.join(', ') || 'нет совпадений'}\n\n` +
            text.substring(0, 3000);
        // id:chat:user:watcher — everything but the text survives a restart
        const tail = `${id}:${chatId}:${target.from.id}:${watcherId}`;
        const buttons = [
            { text: '🚫 Бан', callback_data: `wban:${tail}` },
            { text: '✅ Оставить удалённым', callback_data: `wkeep:${tail}` },
            { text: '↩️ Вернуть', callback_data: `wret:${tail}` },
        ];
        console.log(`[DEBUG] /delete by watcher ${watcherId} on user ${target.from.id}`);
        for (const logChatId of config.logChatIds) {
            try {
                await this.bot.sendMessage(logChatId, report, { reply_markup: { inline_keyboard: [buttons] } });
            } catch (error) {
                console.error(`Error sending watcher report to ${logChatId}:`, error.message || error);
            }
        }
    }

    async handleWatchDecision(query, action, id, chatId, userId, watcherId) {
        const entry = this.watchDeletions.get(id);
        // Several log chats get the same buttons — only the first press counts
        if (this.watchDecided.has(`${chatId}:${userId}:${id}`)) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Уже решено' });
            return;
        }
        this.watchDecided.add(`${chatId}:${userId}:${id}`);

        let status;
        if (action === 'wban') {
            const { banned, banError, extraDeleted } = await this.removeSpammer(chatId, userId, 0);
            status = banned ? '🚫 Забанен' : `⚠️ бан не удался: ${banError}`;
            if (extraDeleted) status += `, ещё сообщений: ${extraDeleted}`;
            this.watchers.recordCorrect(watcherId);
        } else if (action === 'wkeep') {
            await this.setMuted(chatId, userId, false);
            status = '✅ Оставлено удалённым, ограничение снято';
            this.watchers.recordCorrect(watcherId);
        } else {
            await this.setMuted(chatId, userId, false);
            if (entry) {
                const name = [entry.from.first_name, entry.from.last_name].filter(Boolean).join(' ');
                await this.bot.sendMessage(chatId, `↩️ Восстановлено сообщение от ${name}:\n\n${entry.text}`);
                status = '↩️ Возвращено в чат, ограничение снято';
            } else {
                status = '↩️ Ограничение снято (текст недоступен — бот перезапускался)';
            }
            if (this.watchers.recordMistake(watcherId)) {
                status += `\n⛔ Сторож ${watcherId} отключён: ${Watchers.MAX_MISTAKES} ошибки. Включить: /watch add ${watcherId}`;
            }
        }
        this.watchDeletions.delete(id);

        await this.bot.answerCallbackQuery(query.id, { text: status.split('\n')[0] });
        await this.bot.editMessageText(
            `${query.message.text}\n\n${status}`,
            { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
    }

    trackMessage(msg) {
        const key = `${msg.chat.id}:${msg.from.id}`;
        const now = Date.now();
        // Re-insert so Map order stays "least recently active first" for the cap below
        const list = (this.recentMessages.get(key) || []).filter(m => now - m.ts < RECENT_WINDOW_MS);
        this.recentMessages.delete(key);
        list.push({ id: msg.message_id, ts: now });
        this.recentMessages.set(key, list.slice(-100));
        if (this.recentMessages.size > 5000) {
            this.recentMessages.delete(this.recentMessages.keys().next().value);
        }
    }

    // Deletes the user's other tracked messages in this chat; returns how many
    // were attempted. Tracking is in-memory, so messages from before the last
    // restart can't be found.
    async purgeRecentMessages(chatId, userId, exceptMessageId) {
        const key = `${chatId}:${userId}`;
        const now = Date.now();
        const ids = (this.recentMessages.get(key) || [])
            .filter(m => now - m.ts < RECENT_WINDOW_MS && m.id !== exceptMessageId)
            .map(m => m.id);
        this.recentMessages.delete(key);
        if (!ids.length) return 0;
        try {
            // Already-deleted ids are skipped by Telegram, not an error
            await this.bot.deleteMessages(chatId, ids);
        } catch (error) {
            console.error('Error deleting earlier messages:', error.message || error);
        }
        return ids.length;
    }

    async handleEditedMessage(msg) {
        // Re-run the full pipeline on the edited text. Drop the message from the
        // dedupe cache first so handleMessage doesn't skip it, and note that the
        // author gets no extra reputation credit for edits (recordMessage runs
        // again, which slightly overcounts — acceptable).
        this.messageCache.delete(`${msg.chat.id}:${msg.message_id}`);
        await this.handleMessage(msg);
    }

    async logDeletion(msg, fullText, score, threshold, reasons, banned = false, banError = null, extraDeleted = 0) {
        if (!config.logChatIds.length) return;
        try {
            const id = this.nextDeletedId++;
            this.deletedMessages.set(id, {
                chatId: msg.chat.id,
                userId: msg.from.id,
                text: fullText.trim(),
                from: msg.from,
            });
            // Cap memory: drop oldest entries beyond 500
            if (this.deletedMessages.size > 500) {
                const oldest = this.deletedMessages.keys().next().value;
                this.deletedMessages.delete(oldest);
            }

            const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
            const username = msg.from.username ? ` (@${msg.from.username})` : '';
            const statusLine = banned
                ? '🚫 Удалено + БАН'
                : banError
                    ? `🗑 Удалено (⚠️ бан не удался: ${banError})`
                    : '🗑 Удалено';
            const report =
                `${statusLine} в «${msg.chat.title || msg.chat.id}»\n` +
                `От: ${name}${username}, id ${msg.from.id}\n` +
                `Счёт: ${score}/${threshold} — ${reasons.join(', ')}\n` +
                (extraDeleted ? `Удалено ещё сообщений этого автора: ${extraDeleted}\n` : '') +
                '\n' +
                fullText.trim().substring(0, 3000);

            const buttons = [{ text: '↩️ Вернуть в чат', callback_data: `restore:${id}` }];
            if (banned) {
                buttons.push({ text: '♻️ Разбанить', callback_data: `unban:${msg.chat.id}:${msg.from.id}` });
            }
            // Separate sends, so one unreachable log chat (e.g. a person who
            // never pressed /start in the bot) doesn't block the others
            for (const logChatId of config.logChatIds) {
                try {
                    await this.bot.sendMessage(logChatId, report, {
                        reply_markup: { inline_keyboard: [buttons] },
                    });
                } catch (error) {
                    console.error(`Error sending deletion log to ${logChatId}:`, error.message || error);
                }
            }
        } catch (error) {
            console.error('Error sending deletion log:', error);
        }
    }

    async handleCallback(query) {
        try {
            const watch = /^(wban|wkeep|wret):(\d+):(-?\d+):(\d+):(\d+)$/.exec(query.data || '');
            if (watch) {
                if (!query.message || !config.logChatIds.includes(String(query.message.chat.id))) return;
                await this.handleWatchDecision(query, watch[1], Number(watch[2]),
                    Number(watch[3]), Number(watch[4]), Number(watch[5]));
                return;
            }

            const rspam = /^rspam:(-?\d+):(\d+):(\d+)$/.exec(query.data || '');
            if (rspam || query.data === 'rkeep') {
                // Only the log chats get these buttons
                if (!query.message || !config.logChatIds.includes(String(query.message.chat.id))) return;
                let status = '✅ Не спам';
                if (rspam) {
                    const { banned, banError, extraDeleted } =
                        await this.removeSpammer(Number(rspam[1]), Number(rspam[3]), Number(rspam[2]));
                    status = banned ? '🚫 Удалено + БАН' : `🗑 Удалено (⚠️ бан не удался: ${banError})`;
                    if (extraDeleted) status += `, ещё сообщений: ${extraDeleted}`;
                }
                await this.bot.answerCallbackQuery(query.id, { text: status });
                await this.bot.editMessageText(
                    `${query.message.text}\n\n${status}`,
                    { chat_id: query.message.chat.id, message_id: query.message.message_id, disable_web_page_preview: true }
                );
                return;
            }

            const unban = /^unban:(-?\d+):(\d+)$/.exec(query.data || '');
            if (unban) {
                await this.bot.unbanChatMember(Number(unban[1]), Number(unban[2]), { only_if_banned: true });
                await this.bot.answerCallbackQuery(query.id, { text: 'Разбанен ✅ (сможет зайти заново)' });
                if (query.message) {
                    await this.bot.editMessageText(
                        `${query.message.text}\n\n♻️ Разбанен`,
                        { chat_id: query.message.chat.id, message_id: query.message.message_id }
                    );
                }
                return;
            }

            const match = /^restore:(\d+)$/.exec(query.data || '');
            if (!match) return;
            const entry = this.deletedMessages.get(Number(match[1]));
            if (!entry) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Сообщение уже недоступно (бот перезапускался).' });
                return;
            }

            const name = [entry.from.first_name, entry.from.last_name].filter(Boolean).join(' ');
            const username = entry.from.username ? ` (@${entry.from.username})` : '';
            await this.bot.sendMessage(entry.chatId, `↩️ Восстановлено сообщение от ${name}${username}:\n\n${entry.text}`);

            // False positive — credit the author so future messages get a softer threshold
            this.reputation.recordMessage(entry.chatId, entry.userId);
            this.deletedMessages.delete(Number(match[1]));

            await this.bot.answerCallbackQuery(query.id, { text: 'Восстановлено ✅' });
            if (query.message) {
                await this.bot.editMessageText(
                    `${query.message.text}\n\n✅ Восстановлено`,
                    { chat_id: query.message.chat.id, message_id: query.message.message_id }
                );
            }
        } catch (error) {
            console.error('Error handling callback:', error);
        }
    }
}

module.exports = MessageHandler;
module.exports.RULES_VERSION = RULES_VERSION;