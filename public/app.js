import { parseInvoiceText } from './purchase-parse.js';
import { ensureThree, mountScene3D, SCENE_ROLE_META } from './scene3d.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const tokenKey = 'shawa_ceo_token';
const langKey = 'shawa_ceo_lang';
let token = localStorage.getItem(tokenKey) || '';
let lang = localStorage.getItem(langKey) || 'ru';
let appState = null;
let bootstrap = { companyName: 'SHAWA GRILL & MANGAL', hasOwner: false, locations: [] };
let currentTab = 'home';
let deferredInstallPrompt = null;
/* 3D location view state */
let sceneLocId = null;
let sceneReturnTab = 'home';
let sceneApi = null;
let sceneData = null;
let sceneSelectedKey = null;
let sceneMountSeq = 0;

const I18N = {
  ru: {
    authEyebrow: 'Выручка · заказы · кухня · команда', authTitle: 'Вход в SHAWA CEO',
    authHint: 'Первый профиль становится владельцем. Дальше — только по приглашениям руководителя.',
    login: 'Вход', register: 'Регистрация', contact: 'Телефон или email', password: 'Пароль', loginBtn: 'Войти',
    firstName: 'Имя', lastName: 'Фамилия', inviteCode: 'Код приглашения от руководителя', next: 'Далее',
    regHint: 'Код приглашения выдаёт ваш руководитель — по нему подставятся должность, точка и роль.',
    codeFromEmail: 'Код из письма', confirm: 'Подтвердить', resend: 'Отправить код ещё раз',
    newPassword: 'Придумайте пароль', createProfile: 'Создать профиль', logout: 'Выйти',
    home: 'Главная', orders: 'Заказы', kitchen: 'Кухня и склад', team: 'Команда', menu: 'Меню', settings: 'Настройки',
    finance: 'Финансы', finSub: 'PnL · налог · поставщики', finFrom: 'С', finTo: 'По', finApply: 'Показать',
    finThisMonth: 'Этот месяц', finPrevMonth: 'Прошлый месяц', finDays30: '30 дней',
    finGross: 'Выручка (с налогом)', finTax: 'Налог собранный', finNet: 'Выручка нетто', finFood: 'Фудкост',
    finLabor: 'Труд', finOpex: 'Операц. расходы', finEbitda: 'EBITDA', finTotal: 'Итого',
    finTaxCov: 'налог известен у', finOrdersWord: 'заказов', finMapped: 'техкарты покрывают', finPriced: 'с ценами закупок',
    finOfRevenue: 'выручки', finLaborCov: 'ставки заданы для', finLaborHours: 'часов',
    finOwnerOnly: 'Суммы труда и EBITDA видит только владелец (ставки — его данные).',
    dr15Title: 'Sales Tax · DR-15 (Флорида)', dr15Month: 'Месяц', dr15Due: 'Подать до', dr15Gross: 'A · Gross sales',
    dr15Taxable: 'C · Taxable sales', dr15Tax: 'D · Tax collected', dr15Allowance: 'Allowance за срок',
    dr15Note: 'Сводка для ручной подачи на floridarevenue.com. Налог берётся из чеков Clover; где налог по заказу неизвестен — покрытие ниже 100%, проверьте месяц в Clover перед подачей.',
    expTitle: 'Операционные расходы', expCategory: 'Категория', expAmount: 'Сумма, $', expDate: 'Дата', expAdd: 'Добавить расход',
    expNetwork: 'Сеть (общие)', expDelete: 'Удалить',
    supTitle: 'Поставщики', supAdd: 'Добавить поставщика', supContact: 'Контактное лицо', supPhone: 'Телефон',
    supInvoiced: 'Начислено', supPaid: 'Оплачено', supBalance: 'К оплате', supDocs: 'Счета', supPayments: 'Оплаты',
    supPayAdd: 'Отметить оплату', supMethod: 'Способ (ACH, чек…)', supOldest: 'старейший открытый', supNoDocs: 'Счетов пока нет',
    supNoPays: 'Оплат пока нет', supNote: 'Комментарий',
    disputes: 'Споры', dispSub: 'Adjustments агрегаторов и chargeback — реестр, дедлайны, пакеты доказательств',
    dispOpen: 'Открыто', dispOverdue: 'Просрочено', dispDueSoon: 'Срок ≤ 3 дней', dispWithheld: 'Удержано (открытые)', dispWonBack: 'Возвращено',
    dispNew: 'Новый спор', dispChannel: 'Канал', dispOrderId: 'Заказ в канале', dispCloverId: 'Заказ Clover (необязательно)',
    dispAmount: 'Сумма удержания, $', dispFee: 'Комиссия (fee), $', dispOrderDate: 'Дата заказа', dispDisputeDate: 'Дата спора',
    dispDeadline: 'Дедлайн', dispDeadlineHint: 'Пусто = посчитать по правилу канала (Uber/Grubhub +30 дн., DoorDash +10 дн.). Для Clover — обязательна дата из уведомления.',
    dispImport: 'Импорт CSV-выгрузки портала', dispImportBtn: 'Импортировать', dispImportHint: 'Файл Transactions/Payouts из портала канала. Дубли по номеру заказа пропускаются.',
    dispAll: 'Все', dispOpenCase: 'Открыть', dispPack: 'Пакет доказательств', dispCopy: 'Копировать текст', dispPrint: 'Печать / PDF',
    dispPortal: 'Открыть портал', dispChecklist: 'Что в пакете', dispText: 'Готовый текст оспаривания', dispOutcome: 'Возвращено по итогу, $',
    dispCreated: 'Спор заведён', dispImported: 'Импорт готов', dispNoCases: 'Споры не найдены', dispDays: 'дн.', dispToday: 'сегодня',
    dispLate: 'просрочено на', dispSub_: '',
    checklists: 'Чек-листы', clDay: 'День', clAllLocations: 'Все точки', clLoading: 'Загружаю чек-листы…',
    clWeekSummary: 'Неделя по точкам', clOfExpected: 'закрыто полностью из ожидаемых', clEarlyWord: 'досрочно',
    clRunsWord: 'прогонов', clItemsPct: 'пунктов выполнено', clStartedBy: 'Запустил', clClosedBy: 'Закрыл',
    clStatusCompleted: 'Завершён', clStatusEarly: 'Закрыт досрочно', clMissed: 'Пропущено',
    clNoRuns: 'За этот день чек-листов нет. Их запускает персонал командой /checklist в группе точки; сюда попадают завершённые прогоны.',
    clManagerOnly: 'Чек-листы доступны управляющему и выше.', clShifts: 'Смена (MyTeam)', clItems: 'Пункты',
    temps: 'Температуры', tempSub: 'Контроль температур холодильников и морозильников',
    tempAddReading: '+ Замер', tempHistory: 'История', tempValue: 'Температура, °F',
    tempHumidity: 'Влажность, % (необязательно)', tempSaveReading: 'Сохранить замер',
    tempNorm: 'Норма', tempNoReadings: 'Замеров пока нет', tempStatusOk: 'В норме',
    tempStatusDeviation: 'Отклонение', tempStatusStale: 'Нет свежего замера (>6ч)', tempStatusNone: 'Нет замеров',
    tempJournal: 'Журнал за день', tempPrint: 'Печать', tempAddEquipment: 'Добавить оборудование',
    tempEquipName: 'Название оборудования', tempType: 'Тип',
    tempTypeFridge: 'Холодильник', tempTypeFreezer: 'Морозильник', tempTypeWalkin: 'Walk-in', tempTypeStorage: 'Хранение / склад',
    tempMin: 'Мин, °F', tempMax: 'Макс, °F', tempAdd: 'Добавить', tempTime: 'Время',
    tempAuthor: 'Кто внёс', tempSource: 'Источник', tempEquipment: 'Оборудование',
    tempReadingSaved: 'Замер сохранён', tempOff: 'Выключено', tempLoading: 'Загружаю температуры…',
    tempShowJournal: 'Показать журнал', tempDay: 'День',
    revenueToday: 'Выручка сегодня', revenueWeek: 'Выручка за 7 дней', ordersWord: 'заказов',
    openByLocation: 'Открытые заказы по точкам', lowStock: 'Ниже минимума', onShiftNow: 'Сейчас на смене',
    nobody: 'Никого', allGood: 'Всё в наличии', dashboardSub: 'Ключевые цифры сети',
    newOrder: 'Новый заказ', table: 'Стол', takeaway: 'Навынос', delivery: 'Доставка', dinein: 'В зале',
    location: 'Точка', addLine: '+ Позиция', create: 'Создать', statusNew: 'Новые', statusCooking: 'Готовятся', statusReady: 'Готовы',
    toCooking: '→ Готовить', toReady: '→ Готов', toServed: '→ Выдан', cancel: 'Отменить', empty: 'Пусто',
    ingredients: 'Ингредиенты', name: 'Название', unit: 'Ед.', stock: 'Остаток', min: 'Минимум', costUnit: 'Себест./ед.',
    addIngredient: 'Добавить ингредиент', purchase: 'Закупка', writeoff: 'Списание', stocktake: 'Инвентаризация',
    qty: 'Количество', totalCost: 'Сумма закупки, $', reason: 'Причина', actualQty: 'Фактический остаток', save: 'Сохранить',
    purchases: 'Закупки', scanInvoice: 'Сканировать счёт', supplier: 'Поставщик', docDate: 'Дата счёта', comment: 'Комментарий',
    lineTotal: 'Сумма строки, $', postPurchase: 'Провести закупку', addRow: '+ Строка',
    draftTitle: 'Счёт распознан — проверьте строки',
    ocrWarn: 'Распознавание может ошибаться — обязательно проверьте каждую строку, количество и сумму перед проведением.',
    recognizing: 'Распознаю счёт…', scanFailed: 'Не удалось распознать счёт. Попробуйте фото почётче или заведите закупку вручную.',
    newIngredientOpt: '+ Создать новый ингредиент', ingName: 'Название ингредиента', historyTitle: 'История закупок',
    photo: 'Фото', close: 'Закрыть', scannedBadge: 'скан', selectIngredient: '— выберите ингредиент —', posted: 'Закупка проведена',
    emailBadge: 'почта', inboxTitle: 'Входящие инвойсы', inboxHint: 'Счета поставщиков с почты invoices@shawa.work. Ничего не проводится автоматически — проверьте строки и подтвердите вручную.',
    inboxEmpty: 'Входящих инвойсов нет', inboxOpen: 'Проверить', inboxReject: 'Отклонить', inboxRejected: 'Черновик отклонён',
    inboxDraftTitle: 'Инвойс из почты — проверьте строки', inboxFrom: 'От', inboxRaw: 'Текст письма и вложения', inboxStatusPending: 'ждёт проверки',
    inboxStatusConfirmed: 'проведён', inboxStatusRejected: 'отклонён', inboxRecognize: 'Распознать фото (OCR)',
    apply: 'Провести', recipes: 'Техкарты', dish: 'Блюдо', cost: 'Себестоимость', foodcost: 'Фудкост',
    clockIn: 'Я пришёл', clockOut: 'Я ушёл', onShift: 'На смене с', timesheet: 'Табель', hours: 'Часы', pay: 'Сумма',
    invites: 'Приглашения', createInvite: 'Создать приглашение', position: 'Должность', boundContact: 'Телефон/email человека',
    rate: 'Ставка $/час', company: 'Компания', clover: 'Clover', cloverNote: 'Общие Merchant ID и токен — запасной вариант для точек без своих данных Clover. Видны только владельцу, токен никогда не показывается.',
    merchantId: 'Merchant ID', cloverToken: 'Токен Clover', tokenSaved: 'Токен сохранён', tokenNotSet: 'Токен не задан',
    cloverByLocation: 'Clover по точкам', cloverLocNote: 'У каждой точки свой Merchant ID и токен. Продажи подтягиваются автоматически каждые 15 минут, кнопка «Синхронизировать» — вручную.',
    checkClover: 'Проверить', syncClover: 'Синхронизировать', publishMenuClover: 'Опубликовать меню в Clover',
    connectedWord: 'Подключено', notChecked: 'Не проверено', notConnectedWord: 'Не подключено', lastSync: 'Синхронизация',
    usingGlobal: 'используются общие данные', syncedOk: 'Синхронизация готова', publishedOk: 'Меню опубликовано', checkedOk: 'Подключение работает',
    locations: 'Точки', address: 'Адрес', status: 'Статус', addLocation: 'Добавить точку', addItem: 'Добавить блюдо',
    price: 'Цена, $', category: 'Категория', stop: 'Стоп', activeWord: 'В продаже', myPassword: 'Мой пароль и PIN',
    catPublish: 'Publish — каталог сайта', catPublishedOk: 'Каталог сайта опубликован', catOnSite: 'На сайте', catNotOnSite: 'Не на сайте',
    catVersion: 'Версия каталога', catNameEn: 'Название EN', catDescEn: 'Описание EN (для сайта)', catPhoto: 'Фото блюда',
    catPhotoUrl: 'Ссылка на фото (или загрузите файл)', catUpload: 'Загрузить фото (JPEG, один раз)', catClearPhoto: 'Убрать загруженное фото',
    catTags: 'Теги (через запятую)', catKcal: 'Ккал', catProtein: 'Белок, г', catPublishedFlag: 'Показывать на сайте (каталог)',
    catBindings: 'Clover ID по точкам', catPriceNote: 'Цены сайта берутся только из Clover и здесь не редактируются.',
    kioskPin: 'PIN для киоска отметок', change: 'Изменить', saved: 'Сохранено', today: 'Сегодня',
    view3d: '3D', sceneBack: '← Назад', sceneStaff: 'Персонал точки',
    sceneStaffHint: 'Клик по строке или по человеку в 3D — карточка сотрудника',
    sceneDemo: 'Демо-данные: реальные люди, часы и ставки появятся, когда персонал точки внесут в приложение.',
    sceneOnShift: 'На смене', sceneCalledWord: 'Вызвано', sceneHoursToday: 'Часы сегодня', scenePayrollDay: 'Фонд оплаты дня',
    sceneCall: 'Вызвать на смену', sceneCalledBtn: 'Вызван на смену', sceneCancelCall: 'Отменить вызов', sceneAlreadyOn: 'Уже на смене',
    sceneWorkedToday: 'отработал сегодня', sceneHoursWeek: 'отработал за неделю',
    sceneEarnedToday: 'заработал сегодня', sceneEarnedWeek: 'заработал за неделю',
    sceneRate: 'Ставка', scenePerHour: '/час', sceneRating: 'Рейтинг', scenePoints: 'баллов',
    sceneCleanWeeks: 'Чистых недель', sceneAwards: 'наград вручную',
    scenePayHidden: 'Ставки и суммы заработка видит только владелец.',
    sceneHint: 'Тяните, чтобы вращать · колесо — масштаб · клик по сотруднику — его карточка',
    sceneCamHall: 'Зал', sceneCamTop: 'Сверху', sceneCamKitchen: 'Кухня', sceneCamTables: 'Столы',
    sceneWhoIsWho: 'Кто есть кто', sceneStatusOn: 'на смене', sceneStatusOff: 'не на смене',
    sceneLoading: 'Загружаю 3D…', sceneNotFound: 'Точка не найдена'
  },
  en: {
    authEyebrow: 'Revenue · orders · kitchen · team', authTitle: 'Sign in to SHAWA CEO',
    authHint: 'The first profile becomes the owner. After that, registration is by manager invite only.',
    login: 'Sign in', register: 'Register', contact: 'Phone or email', password: 'Password', loginBtn: 'Sign in',
    firstName: 'First name', lastName: 'Last name', inviteCode: 'Invite code from your manager', next: 'Next',
    regHint: 'Your manager gives you the invite code — it sets your position, location and role.',
    codeFromEmail: 'Code from the email', confirm: 'Confirm', resend: 'Send the code again',
    newPassword: 'Create a password', createProfile: 'Create profile', logout: 'Log out',
    home: 'Home', orders: 'Orders', kitchen: 'Kitchen & stock', team: 'Team', menu: 'Menu', settings: 'Settings',
    finance: 'Finance', finSub: 'PnL · tax · suppliers', finFrom: 'From', finTo: 'To', finApply: 'Show',
    finThisMonth: 'This month', finPrevMonth: 'Last month', finDays30: '30 days',
    finGross: 'Gross (tax incl.)', finTax: 'Tax collected', finNet: 'Net revenue', finFood: 'Food cost',
    finLabor: 'Labor', finOpex: 'Operating expenses', finEbitda: 'EBITDA', finTotal: 'Total',
    finTaxCov: 'tax known for', finOrdersWord: 'orders', finMapped: 'recipes cover', finPriced: 'with purchase prices',
    finOfRevenue: 'of revenue', finLaborCov: 'rates set for', finLaborHours: 'hours',
    finOwnerOnly: 'Labor amounts and EBITDA are owner-only (rates are the owner’s data).',
    dr15Title: 'Sales Tax · DR-15 (Florida)', dr15Month: 'Month', dr15Due: 'File by', dr15Gross: 'A · Gross sales',
    dr15Taxable: 'C · Taxable sales', dr15Tax: 'D · Tax collected', dr15Allowance: 'On-time allowance',
    dr15Note: 'Summary for manual filing at floridarevenue.com. Tax comes from Clover receipts; where an order’s tax is unknown the coverage is below 100% — cross-check the month in Clover before filing.',
    expTitle: 'Operating expenses', expCategory: 'Category', expAmount: 'Amount, $', expDate: 'Date', expAdd: 'Add expense',
    expNetwork: 'Network (shared)', expDelete: 'Delete',
    supTitle: 'Suppliers', supAdd: 'Add supplier', supContact: 'Contact person', supPhone: 'Phone',
    supInvoiced: 'Invoiced', supPaid: 'Paid', supBalance: 'Balance due', supDocs: 'Invoices', supPayments: 'Payments',
    supPayAdd: 'Record payment', supMethod: 'Method (ACH, check…)', supOldest: 'oldest open', supNoDocs: 'No invoices yet',
    supNoPays: 'No payments yet', supNote: 'Note',
    disputes: 'Disputes', dispSub: 'Marketplace adjustments & chargebacks — registry, deadlines, evidence packs',
    dispOpen: 'Open', dispOverdue: 'Overdue', dispDueSoon: 'Due ≤ 3 days', dispWithheld: 'Withheld (open)', dispWonBack: 'Won back',
    dispNew: 'New dispute', dispChannel: 'Channel', dispOrderId: 'Channel order ID', dispCloverId: 'Clover order ID (optional)',
    dispAmount: 'Withheld amount, $', dispFee: 'Fee, $', dispOrderDate: 'Order date', dispDisputeDate: 'Dispute date',
    dispDeadline: 'Deadline', dispDeadlineHint: 'Empty = channel rule (Uber/Grubhub +30d, DoorDash +10d). For Clover the date from the acquirer notice is required.',
    dispImport: 'Import a portal CSV export', dispImportBtn: 'Import', dispImportHint: 'Transactions/Payouts file from the channel portal. Duplicate order IDs are skipped.',
    dispAll: 'All', dispOpenCase: 'Open', dispPack: 'Evidence pack', dispCopy: 'Copy text', dispPrint: 'Print / PDF',
    dispPortal: 'Open portal', dispChecklist: 'Pack contents', dispText: 'Ready dispute text', dispOutcome: 'Credited back, $',
    dispCreated: 'Dispute created', dispImported: 'Import done', dispNoCases: 'No disputes found', dispDays: 'd', dispToday: 'today',
    dispLate: 'overdue by', dispSub_: '',
    checklists: 'Checklists', clDay: 'Day', clAllLocations: 'All locations', clLoading: 'Loading checklists…',
    clWeekSummary: 'Week by location', clOfExpected: 'fully closed of expected', clEarlyWord: 'early',
    clRunsWord: 'runs', clItemsPct: 'items done', clStartedBy: 'Started by', clClosedBy: 'Closed by',
    clStatusCompleted: 'Completed', clStatusEarly: 'Finished early', clMissed: 'Missed',
    clNoRuns: 'No checklists for this day. Staff start them with /checklist in the location group; finished runs land here.',
    clManagerOnly: 'Checklists are available to managers and above.', clShifts: 'Shift (MyTeam)', clItems: 'Items',
    temps: 'Temperatures', tempSub: 'Fridge and freezer temperature control',
    tempAddReading: '+ Reading', tempHistory: 'History', tempValue: 'Temperature, °F',
    tempHumidity: 'Humidity, % (optional)', tempSaveReading: 'Save reading',
    tempNorm: 'Norm', tempNoReadings: 'No readings yet', tempStatusOk: 'OK',
    tempStatusDeviation: 'Deviation', tempStatusStale: 'No fresh reading (>6h)', tempStatusNone: 'No readings',
    tempJournal: 'Daily journal', tempPrint: 'Print', tempAddEquipment: 'Add equipment',
    tempEquipName: 'Equipment name', tempType: 'Type',
    tempTypeFridge: 'Fridge', tempTypeFreezer: 'Freezer', tempTypeWalkin: 'Walk-in', tempTypeStorage: 'Storage',
    tempMin: 'Min, °F', tempMax: 'Max, °F', tempAdd: 'Add', tempTime: 'Time',
    tempAuthor: 'Entered by', tempSource: 'Source', tempEquipment: 'Equipment',
    tempReadingSaved: 'Reading saved', tempOff: 'Off', tempLoading: 'Loading temperatures…',
    tempShowJournal: 'Show journal', tempDay: 'Day',
    revenueToday: 'Revenue today', revenueWeek: 'Revenue, 7 days', ordersWord: 'orders',
    openByLocation: 'Open orders by location', lowStock: 'Below minimum', onShiftNow: 'On shift now',
    nobody: 'Nobody', allGood: 'All stocked', dashboardSub: 'Network key numbers',
    newOrder: 'New order', table: 'Table', takeaway: 'Takeaway', delivery: 'Delivery', dinein: 'Dine-in',
    location: 'Location', addLine: '+ Item', create: 'Create', statusNew: 'New', statusCooking: 'Cooking', statusReady: 'Ready',
    toCooking: '→ Start cooking', toReady: '→ Ready', toServed: '→ Served', cancel: 'Cancel', empty: 'Empty',
    ingredients: 'Ingredients', name: 'Name', unit: 'Unit', stock: 'Stock', min: 'Minimum', costUnit: 'Cost/unit',
    addIngredient: 'Add ingredient', purchase: 'Purchase', writeoff: 'Write-off', stocktake: 'Stock count',
    qty: 'Quantity', totalCost: 'Purchase total, $', reason: 'Reason', actualQty: 'Actual stock', save: 'Save',
    purchases: 'Purchases', scanInvoice: 'Scan invoice', supplier: 'Supplier', docDate: 'Invoice date', comment: 'Comment',
    lineTotal: 'Line total, $', postPurchase: 'Post purchase', addRow: '+ Line',
    draftTitle: 'Invoice scanned — review the lines',
    ocrWarn: 'Recognition can make mistakes — please check every line, quantity and amount before posting.',
    recognizing: 'Reading the invoice…', scanFailed: 'Could not read the invoice. Try a sharper photo or enter the purchase manually.',
    newIngredientOpt: '+ Create new ingredient', ingName: 'Ingredient name', historyTitle: 'Purchase history',
    photo: 'Photo', close: 'Close', scannedBadge: 'scan', selectIngredient: '— choose an ingredient —', posted: 'Purchase posted',
    emailBadge: 'email', inboxTitle: 'Invoice inbox', inboxHint: 'Supplier invoices from invoices@shawa.work. Nothing is posted automatically — review the lines and confirm manually.',
    inboxEmpty: 'No inbound invoices', inboxOpen: 'Review', inboxReject: 'Reject', inboxRejected: 'Draft rejected',
    inboxDraftTitle: 'Invoice from email — review the lines', inboxFrom: 'From', inboxRaw: 'Message & attachment text', inboxStatusPending: 'awaiting review',
    inboxStatusConfirmed: 'posted', inboxStatusRejected: 'rejected', inboxRecognize: 'Recognize photo (OCR)',
    apply: 'Apply', recipes: 'Recipe cards', dish: 'Dish', cost: 'Cost', foodcost: 'Food cost',
    clockIn: 'Clock in', clockOut: 'Clock out', onShift: 'On shift since', timesheet: 'Timesheet', hours: 'Hours', pay: 'Pay',
    invites: 'Invites', createInvite: 'Create invite', position: 'Position', boundContact: 'Person phone/email',
    rate: 'Rate $/hour', company: 'Company', clover: 'Clover', cloverNote: 'Shared Merchant ID and token — a fallback for locations without their own Clover credentials. Owner-only; the token is never shown.',
    merchantId: 'Merchant ID', cloverToken: 'Clover token', tokenSaved: 'Token saved', tokenNotSet: 'No token set',
    cloverByLocation: 'Clover by location', cloverLocNote: 'Each location has its own Merchant ID and token. Sales sync automatically every 15 minutes; “Sync” pulls them manually.',
    checkClover: 'Check', syncClover: 'Sync', publishMenuClover: 'Publish menu to Clover',
    connectedWord: 'Connected', notChecked: 'Not checked', notConnectedWord: 'Not connected', lastSync: 'Sync',
    usingGlobal: 'using shared credentials', syncedOk: 'Sync done', publishedOk: 'Menu published', checkedOk: 'Connection works',
    locations: 'Locations', address: 'Address', status: 'Status', addLocation: 'Add location', addItem: 'Add dish',
    price: 'Price, $', category: 'Category', stop: 'Stop', activeWord: 'On sale', myPassword: 'My password & PIN',
    catPublish: 'Publish — website catalog', catPublishedOk: 'Website catalog published', catOnSite: 'On website', catNotOnSite: 'Not on website',
    catVersion: 'Catalog version', catNameEn: 'Name EN', catDescEn: 'Description EN (for the website)', catPhoto: 'Dish photo',
    catPhotoUrl: 'Photo URL (or upload a file)', catUpload: 'Upload photo (JPEG, once)', catClearPhoto: 'Remove uploaded photo',
    catTags: 'Tags (comma-separated)', catKcal: 'Calories (kcal)', catProtein: 'Protein, g', catPublishedFlag: 'Show on website (catalog)',
    catBindings: 'Clover item ID by location', catPriceNote: 'Website prices come only from Clover and are not edited here.',
    kioskPin: 'Kiosk clock-in PIN', change: 'Change', saved: 'Saved', today: 'Today',
    view3d: '3D', sceneBack: '← Back', sceneStaff: 'Location staff',
    sceneStaffHint: 'Click a row or a person in 3D to open the employee card',
    sceneDemo: 'Demo data: real people, hours and rates appear once the location staff is added in the app.',
    sceneOnShift: 'On shift', sceneCalledWord: 'Called', sceneHoursToday: 'Hours today', scenePayrollDay: 'Day payroll',
    sceneCall: 'Call to shift', sceneCalledBtn: 'Called to shift', sceneCancelCall: 'Cancel call', sceneAlreadyOn: 'Already on shift',
    sceneWorkedToday: 'worked today', sceneHoursWeek: 'worked this week',
    sceneEarnedToday: 'earned today', sceneEarnedWeek: 'earned this week',
    sceneRate: 'Rate', scenePerHour: '/hour', sceneRating: 'Rating', scenePoints: 'points',
    sceneCleanWeeks: 'Clean weeks', sceneAwards: 'manual awards',
    scenePayHidden: 'Rates and pay amounts are visible to the owner only.',
    sceneHint: 'Drag to rotate · scroll to zoom · click an employee for the card',
    sceneCamHall: 'Hall', sceneCamTop: 'Top', sceneCamKitchen: 'Kitchen', sceneCamTables: 'Tables',
    sceneWhoIsWho: 'Who is who', sceneStatusOn: 'on shift', sceneStatusOff: 'off shift',
    sceneLoading: 'Loading 3D…', sceneNotFound: 'Location not found'
  }
};
const t = (key) => (I18N[lang] && I18N[lang][key]) || I18N.ru[key] || key;
const TABS = [
  ['home', '🏠'], ['orders', '🧾'], ['disputes', '⚖️'], ['kitchen', '🥘'], ['finance', '💰'], ['checklists', '✅'], ['temps', '🌡️'], ['team', '👥'], ['menu', '🍽️'], ['settings', '⚙️']
];
const RANK_LEVEL = { staff: 1, manager: 2, director: 3, owner: 4 };
const STANDARD_ROLES = ['Директор', 'Менеджер', 'Шеф-повар', 'Повар', 'Официант', 'Кассир'];

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3600);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}
function formObject(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) data[key] = value;
  for (const checkbox of $$('input[type="checkbox"]', form)) data[checkbox.name] = checkbox.checked;
  return data;
}
const money = (v) => `$${Number(v || 0).toFixed(2)}`;
function fmtHours(n) {
  if (n == null) return '—';
  const text = String(Math.round(n * 10) / 10).replace('.', lang === 'en' ? '.' : ',');
  return lang === 'en' ? `${text} h` : `${text} ч`;
}
function fmtTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'ru-RU', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function fmtDay(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'ru-RU', { timeZone: 'America/New_York', dateStyle: 'medium' }).format(new Date(value));
}
function fmtDayKey(key) {
  if (!key) return '—';
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return String(key);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'ru-RU', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(Date.UTC(y, m - 1, d)));
}
function locationName(id) { return appState?.locations.find(l => l.id === Number(id))?.name || '—'; }
function can(rank) { return (appState?.me.rankLevel || 0) >= (RANK_LEVEL[rank] || 99); }
function setAuthError(message) {
  const el = $('#authError');
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function applyI18n() {
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $('#langToggle').textContent = lang === 'ru' ? 'EN' : 'RU';
  $('#logoutButton').textContent = t('logout');
}

async function loadBootstrap() {
  bootstrap = await api('/api/bootstrap');
  $('#companyName').textContent = bootstrap.companyName || 'SHAWA CEO';
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) {
    $('#showRegister').click();
    $('#regStep1Form [name="inviteCode"]').value = invite.toUpperCase();
  }
}

async function loadState() {
  appState = await api('/api/state');
  $('#companyName').textContent = appState.companyName || 'SHAWA CEO';
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#bottomNav').classList.remove('hidden');
  $('#sideNav').classList.remove('hidden');
  $('#profileChip').classList.remove('hidden');
  $('#logoutButton').classList.remove('hidden');
  $('#profileChip').textContent = `${appState.me.name} · ${appState.me.rankLabel}`;
  renderNav();
  render();
}

function showAuth() {
  destroyScene3D();
  token = '';
  localStorage.removeItem(tokenKey);
  appState = null;
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#bottomNav').classList.add('hidden');
  $('#sideNav').classList.add('hidden');
  $('#profileChip').classList.add('hidden');
  $('#logoutButton').classList.add('hidden');
}

function renderNav() {
  const html = TABS.map(([tab, icon]) => `<button data-tab="${tab}" class="${tab === currentTab ? 'active' : ''}">${icon}<span>${t(tab)}</span></button>`).join('');
  $('#bottomNav').innerHTML = html;
  $('#sideNav').innerHTML = html;
  for (const nav of [$('#bottomNav'), $('#sideNav')]) {
    $$('button', nav).forEach(b => b.addEventListener('click', () => { currentTab = b.dataset.tab; renderNav(); render(); }));
  }
}

function render() {
  if (!appState) return;
  if (currentTab !== 'scene3d') destroyScene3D();
  const page = $('#pageContent');
  ({ home: renderHome, orders: renderOrders, disputes: renderDisputes, kitchen: renderKitchen, finance: renderFinance, checklists: renderChecklists, temps: renderTemps, team: renderTeam, menu: renderMenu, settings: renderSettings, scene3d: renderScene3D }[currentTab] || renderHome)(page);
}
function pageHead(title, subtitle) { return `<div class="page-head"><div><p>${esc(subtitle || '')}</p><h1>${esc(title)}</h1></div></div>`; }
async function refresh(patch = {}) {
  Object.assign(appState, patch);
  appState = await api('/api/state');
  render();
}

/* ---------------- Home ---------------- */
function renderHome(page) {
  const d = appState.dashboard;
  page.innerHTML = `
    ${pageHead(t('home'), `${fmtDay(new Date())} · ${t('dashboardSub')}`)}
    <div class="kpi-grid">
      <div class="card"><div class="metric">${money(d.revenueToday)}</div><div class="metric-label">${t('revenueToday')} · ${d.revenueTodayOrders} ${t('ordersWord')}</div></div>
      <div class="card"><div class="metric">${money(d.revenueWeek)}</div><div class="metric-label">${t('revenueWeek')} · ${d.revenueWeekOrders} ${t('ordersWord')}</div></div>
      <div class="card"><div class="metric">${d.openOrdersByLocation.reduce((s, l) => s + l.open, 0)}</div><div class="metric-label">${t('openByLocation')}</div>
        <div class="list" style="margin-top:8px">${d.openOrdersByLocation.map(l => `<div class="row"><span>${esc(l.name)}</span><span><span class="badge">${l.open}</span> <button class="secondary" type="button" data-open3d="${l.locationId}">🧊 ${t('view3d')}</button></span></div>`).join('')}</div></div>
      <div class="card"><div class="metric">${d.onShift.length}</div><div class="metric-label">${t('onShiftNow')}</div>
        <div class="list" style="margin-top:8px">${d.onShift.length ? d.onShift.map(p => `<div class="row"><span>${esc(p.name)}</span><span class="badge gray">${esc(locationName(p.locationId))} · ${fmtTime(p.clockIn)}</span></div>`).join('') : `<span class="muted">${t('nobody')}</span>`}</div></div>
    </div>
    <section class="section"><div class="card"><h2>⚠️ ${t('lowStock')}</h2>
      ${d.lowStock.length ? `<div class="list">${d.lowStock.map(i => `<div class="row"><span>${esc(i.name)}</span><span class="badge red">${i.stock} / ${t('min')} ${i.minStock} ${esc(i.unit)}</span></div>`).join('')}</div>` : `<p class="muted">${t('allGood')}</p>`}
    </div></section>`;
}

/* ---------------- Checklists (bot results, read-only) ---------------- */
let clDay = '';
let clLocation = '';
const CL_AREA_ICON = { kitchen: '🍳', front: '🛎️' };
const CL_KIND_ICON = { opening: '🌅', closing: '🌙' };
async function renderChecklists(page) {
  if (!can('manager')) {
    page.innerHTML = `${pageHead(t('checklists'))}<div class="card"><p class="muted">🔒 ${t('clManagerOnly')}</p></div>`;
    return;
  }
  if (!clDay) clDay = bootstrap.today || '';
  page.innerHTML = `
    ${pageHead(t('checklists'), fmtDayKey(clDay))}
    <div class="card form-card"><div class="form-grid">
      <label>${t('location')}<select id="clLocation"><option value="">${t('clAllLocations')}</option>${appState.locations.map(l => `<option value="${esc(l.name)}" ${l.name === clLocation ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label>${t('clDay')}<input id="clDay" type="date" value="${esc(clDay)}"></label>
    </div></div>
    <div id="clBody"><p class="muted">${t('clLoading')}</p></div>`;
  $('#clLocation').addEventListener('change', e => { clLocation = e.target.value; renderChecklists(page); });
  $('#clDay').addEventListener('change', e => { if (e.target.value) { clDay = e.target.value; renderChecklists(page); } });
  let data;
  try {
    data = await api(`/api/checklists?day=${encodeURIComponent(clDay)}${clLocation ? `&location=${encodeURIComponent(clLocation)}` : ''}`);
  } catch (error) {
    const body = $('#clBody');
    if (body && currentTab === 'checklists') body.innerHTML = `<div class="alert">${esc(error.message)}</div>`;
    return;
  }
  const body = $('#clBody');
  if (!body || currentTab !== 'checklists') return;
  const weekRows = data.week.map(w => `<div class="row">
      <span><strong>${esc(w.location)}</strong><br><span class="muted">${w.completed}/${w.expected} ${t('clOfExpected')} · ${w.runs} ${t('clRunsWord')}${w.finishedEarly ? ` · ${w.finishedEarly} ${t('clEarlyWord')}` : ''}${w.itemsPct != null ? ` · ${w.itemsPct}% ${t('clItemsPct')}` : ''}</span></span>
      <span class="badge ${w.pct == null ? 'gray' : w.pct >= 100 ? 'green' : w.pct > 0 ? '' : 'red'}">${w.pct == null ? '—' : `${w.pct}%`}</span>
    </div>`).join('');
  const runCards = data.runs.map(run => {
    const statusBadge = run.status === 'completed'
      ? `<span class="badge green">${t('clStatusCompleted')}</span>`
      : `<span class="badge red">${t('clStatusEarly')}</span>`;
    const pctBadge = `<span class="badge ${run.pct >= 100 ? 'green' : run.pct >= 50 ? '' : 'red'}">${run.doneItems}/${run.totalItems} · ${run.pct}%</span>`;
    const items = run.detail.map(d => `<div class="row"><span>${d.done ? '✅' : '⬜'} ${esc(d.item)}</span>${d.done ? `<span class="badge gray">${esc(d.by)} · ${fmtTime(d.at)}</span>` : `<span class="badge red">${t('clMissed')}</span>`}</div>`).join('');
    return `<div class="card" style="margin-bottom:12px">
      <div class="row"><strong>${CL_AREA_ICON[run.area] || ''} ${esc(run.areaLabel)} · ${CL_KIND_ICON[run.kind] || ''} ${esc(run.kindLabel)} — ${esc(run.location)}</strong><span>${statusBadge} ${pctBadge}</span></div>
      <p class="muted" style="margin:6px 0">${fmtTime(run.startedAt)} → ${fmtTime(run.finishedAt)} · ${t('clStartedBy')}: ${esc(run.startedBy || '—')}${run.closedBy ? ` · ${t('clClosedBy')}: ${esc(run.closedBy)}` : ''}</p>
      ${run.shifts.length ? `<p class="muted" style="margin:6px 0">👥 ${t('clShifts')}: ${run.shifts.map(s => esc(s.employee)).join(', ')}</p>` : ''}
      ${run.missed.length ? `<p style="margin:6px 0"><span class="badge red">${t('clMissed')}: ${run.missed.length}</span> <span class="muted">${run.missed.map(esc).join(' · ')}</span></p>` : ''}
      <details class="inline-edit"><summary>${t('clItems')} · ${run.doneItems}/${run.totalItems}</summary><div class="list" style="margin-top:10px">${items}</div></details>
    </div>`;
  }).join('');
  body.innerHTML = `
    <section class="section" style="margin-top:0"><div class="card"><h2>📊 ${t('clWeekSummary')} · ${fmtDayKey(data.weekStart)} — ${fmtDayKey(data.weekEnd)}</h2>
      <div class="list">${weekRows}</div></div></section>
    <section class="section">${data.runs.length ? runCards : `<div class="card"><p class="muted">${t('clNoRuns')}</p></div>`}</section>`;
}

/* ---------------- Temperatures (SANEKS control) ---------------- */
let tempsData = null;
let tempsOpenForm = null;
let tempsHistoryId = null;
let tempsHistoryData = null;
let tempsJournalDay = '';
let tempsJournalLoc = '';
let tempsJournalData = null;
const TEMP_TYPE_LABEL = () => ({
  fridge: t('tempTypeFridge'), freezer: t('tempTypeFreezer'), walkin: t('tempTypeWalkin'), storage: t('tempTypeStorage')
});
function tempNormLabel(eq) {
  const hasMin = eq.norm_min_f != null;
  const hasMax = eq.norm_max_f != null;
  if (hasMin && hasMax) return `${eq.norm_min_f}–${eq.norm_max_f}°F`;
  if (!hasMin && hasMax) return `≤${eq.norm_max_f}°F`;
  if (hasMin && !hasMax) return `≥${eq.norm_min_f}°F`;
  return '—';
}
function tempStatusBadge(status) {
  if (status === 'ok') return `<span class="badge green">${t('tempStatusOk')}</span>`;
  if (status === 'deviation') return `<span class="badge red">${t('tempStatusDeviation')}</span>`;
  if (status === 'stale') return `<span class="badge">${t('tempStatusStale')}</span>`;
  return `<span class="badge gray">${t('tempStatusNone')}</span>`;
}
function tempStatusColor(status) {
  return status === 'ok' ? '#1a7f37' : status === 'deviation' ? '#c0392b' : status === 'stale' ? '#b7791f' : '#777';
}
function tempChartSvg(readings, equipment) {
  const pointsAsc = [...readings].reverse();
  if (pointsAsc.length < 2) return '';
  const values = pointsAsc.map(r => Number(r.value_f));
  let lo = Math.min(...values); let hi = Math.max(...values);
  if (equipment.norm_min_f != null) lo = Math.min(lo, Number(equipment.norm_min_f));
  if (equipment.norm_max_f != null) hi = Math.max(hi, Number(equipment.norm_max_f));
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.15 || 1; hi += pad; lo -= pad;
  const W = 640; const H = 180; const PL = 36; const PR = 10; const PT = 10; const PB = 22;
  const x = (i) => PL + (i * (W - PL - PR)) / Math.max(1, pointsAsc.length - 1);
  const y = (v) => PT + ((hi - v) * (H - PT - PB)) / (hi - lo);
  const line = pointsAsc.map((r, i) => `${x(i).toFixed(1)},${y(Number(r.value_f)).toFixed(1)}`).join(' ');
  const normLines = [
    equipment.norm_min_f != null ? `<line x1="${PL}" y1="${y(Number(equipment.norm_min_f))}" x2="${W - PR}" y2="${y(Number(equipment.norm_min_f))}" stroke="#c0392b" stroke-dasharray="5 4" stroke-width="1"/><text x="2" y="${y(Number(equipment.norm_min_f)) + 3}" font-size="10" fill="#c0392b">${esc(equipment.norm_min_f)}</text>` : '',
    equipment.norm_max_f != null ? `<line x1="${PL}" y1="${y(Number(equipment.norm_max_f))}" x2="${W - PR}" y2="${y(Number(equipment.norm_max_f))}" stroke="#c0392b" stroke-dasharray="5 4" stroke-width="1"/><text x="2" y="${y(Number(equipment.norm_max_f)) + 3}" font-size="10" fill="#c0392b">${esc(equipment.norm_max_f)}</text>` : ''
  ].join('');
  const dots = pointsAsc.map((r, i) => `<circle cx="${x(i)}" cy="${y(Number(r.value_f))}" r="3" fill="#FF6B00"><title>${esc(r.created_at)} · ${esc(r.value_f)}°F</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;background:#fff;border:1px solid #eee;border-radius:8px" role="img">${normLines}<polyline fill="none" stroke="#FF6B00" stroke-width="2" points="${line}"/>${dots}</svg>`;
}
async function renderTemps(page) {
  const mgr = can('manager');
  if (!tempsJournalDay) tempsJournalDay = bootstrap.today || '';
  if (!tempsJournalLoc && appState.locations.length) tempsJournalLoc = String(appState.locations[0].id);
  page.innerHTML = `${pageHead(t('temps'), t('tempSub'))}<div class="card"><p class="muted">${t('tempLoading')}</p></div>`;
  let data;
  try { data = await api('/api/temperatures'); tempsData = data; } catch (error) {
    page.innerHTML = `${pageHead(t('temps'), t('tempSub'))}<div class="card"><p class="muted">${esc(error.message)}</p></div>`; return;
  }
  if (currentTab !== 'temps') return;
  const typeLabels = TEMP_TYPE_LABEL();
  const sections = (data.locations || []).map(group => {
    const locName = group.location?.name || group.name || '';
    const locId = group.location?.id || group.location_id;
    const cards = (group.equipment || []).map(eq => {
      const last = eq.lastReading || eq.last_reading || eq.last;
      const isOpen = tempsOpenForm === eq.id;
      const isHistory = tempsHistoryId === eq.id;
      const histHtml = isHistory && tempsHistoryData && tempsHistoryData.equipment?.id === eq.id ? `
        <div style="margin-top:10px">
          ${tempChartSvg(tempsHistoryData.readings || [], eq)}
          <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>${t('tempTime')}</th><th>°F</th><th>%</th><th>${t('tempAuthor')}</th><th>${t('tempSource')}</th></tr></thead>
          <tbody>${(tempsHistoryData.readings || []).map(r => `<tr><td>${esc(fmtDay(r.created_at))} ${esc(fmtTime(r.created_at))}</td><td>${esc(r.value_f)}</td><td>${r.humidity_pct != null ? esc(r.humidity_pct) : '—'}</td><td>${esc(r.entered_by || '')}</td><td>${esc(r.source || '')}</td></tr>`).join('') || `<tr><td colspan="5">${t('tempNoReadings')}</td></tr>`}</tbody></table></div>
        </div>` : '';
      return `<div class="card" style="margin-bottom:12px">
        <div class="row"><strong>${esc(eq.name)}</strong><span>${tempStatusBadge(eq.status)}${eq.active ? '' : ` <span class="badge gray">${t('tempOff')}</span>`}</span></div>
        <p class="muted" style="margin:4px 0">${esc(typeLabels[eq.type] || eq.type)} · ${t('tempNorm')}: ${esc(tempNormLabel(eq))}</p>
        ${last ? `<div style="font-size:34px;font-weight:700;color:${tempStatusColor(eq.status)};line-height:1.1">${esc(last.value_f)}°F${last.humidity_pct != null ? `<span style="font-size:16px;color:#555"> · ${esc(last.humidity_pct)}%</span>` : ''}</div>
          <p class="muted" style="margin:4px 0">${esc(fmtDay(last.created_at))} ${esc(fmtTime(last.created_at))} · ${esc(last.entered_by || '')} · ${esc(last.source || '')}</p>`
        : `<div style="font-size:22px;color:#777">—</div><p class="muted">${t('tempNoReadings')}</p>`}
        <div class="row" style="margin-top:8px;gap:8px;justify-content:flex-start">
          ${eq.active ? `<button class="primary" type="button" data-temp-add="${eq.id}">${t('tempAddReading')}</button>` : ''}
          <button class="secondary" type="button" data-temp-history="${eq.id}">${t('tempHistory')}</button>
          ${mgr ? `<button class="secondary" type="button" data-temp-toggle="${eq.id}" data-temp-active="${eq.active ? '0' : '1'}">${eq.active ? '⏸ Off' : '▶ On'}</button>` : ''}
        </div>
        ${isOpen ? `<form data-temp-form="${eq.id}" class="stack" style="margin-top:10px">
          <div class="form-grid">
            <label>${t('tempValue')}<input name="value_f" type="number" step="0.1" min="-60" max="160" required autofocus></label>
            <label>${t('tempHumidity')}<input name="humidity_pct" type="number" step="0.1" min="0" max="100"></label>
          </div>
          <button class="primary" type="submit">${t('tempSaveReading')}</button>
        </form>` : ''}
        ${histHtml}
      </div>`;
    }).join('');
    const addForm = mgr ? `<div class="card form-card" style="margin-bottom:12px"><h3>${t('tempAddEquipment')} · ${esc(locName)}</h3>
      <form data-temp-equip-form="${locId}" class="stack">
        <div class="form-grid">
          <label>${t('tempEquipName')}<input name="name" required></label>
          <label>${t('tempType')}<select name="type"><option value="fridge">${t('tempTypeFridge')}</option><option value="freezer">${t('tempTypeFreezer')}</option><option value="walkin">${t('tempTypeWalkin')}</option><option value="storage">${t('tempTypeStorage')}</option></select></label>
          <label>${t('tempMin')}<input name="norm_min_f" type="number" step="0.1"></label>
          <label>${t('tempMax')}<input name="norm_max_f" type="number" step="0.1"></label>
        </div>
        <button class="primary" type="submit">${t('tempAdd')}</button>
      </form></div>` : '';
    return `<section class="section"><h2 style="margin:0 0 10px">🌡️ ${esc(locName)}</h2>${cards || `<div class="card"><p class="muted">${t('tempNoReadings')}</p></div>`}${addForm}</section>`;
  }).join('');
  const journal = tempsJournalData;
  const journalRows = journal ? (journal.readings || []).map(r => `<tr><td>${esc(fmtTime(r.created_at))}</td><td>${esc(r.equipment_name || '')}</td><td>${esc(r.value_f)}°F</td><td>${r.humidity_pct != null ? esc(r.humidity_pct) : '—'}</td><td>${esc(r.entered_by || '')}</td><td>${esc(r.source || '')}</td></tr>`).join('') : '';
  page.innerHTML = `
    ${pageHead(t('temps'), t('tempSub'))}
    ${sections}
    <section class="section"><div class="card"><h2>📓 ${t('tempJournal')}</h2>
      <form id="tempJournalForm" class="stack">
        <div class="form-grid">
          <label>${t('location')}<select id="tempJournalLoc">${appState.locations.map(l => `<option value="${l.id}" ${String(l.id) === String(tempsJournalLoc) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
          <label>${t('tempDay')}<input id="tempJournalDay" type="date" value="${esc(tempsJournalDay)}"></label>
        </div>
        <div class="row" style="justify-content:flex-start;gap:8px">
          <button class="primary" type="submit">${t('tempShowJournal')}</button>
          <button class="secondary" type="button" id="tempPrintBtn">${t('tempPrint')}</button>
        </div>
      </form>
      <div id="tempJournalBody" style="margin-top:12px">
        ${journal ? `<div class="table-wrap"><table><thead><tr><th>${t('tempTime')}</th><th>${t('tempEquipment')}</th><th>°F</th><th>%</th><th>${t('tempAuthor')}</th><th>${t('tempSource')}</th></tr></thead><tbody>${journalRows || `<tr><td colspan="6">${t('tempNoReadings')}</td></tr>`}</tbody></table></div>
        <p class="muted">${esc(journal.day)} · ${(journal.equipment || []).length} ${t('tempEquipment')}: ${(journal.equipment || []).map(e => esc(e.name)).join(', ')}</p>` : `<p class="muted">${t('tempNoReadings')}</p>`}
      </div>
    </div></section>`;
  $$('[data-temp-add]', page).forEach(btn => btn.addEventListener('click', () => {
    const id = Number(btn.dataset.tempAdd);
    tempsOpenForm = tempsOpenForm === id ? null : id;
    renderTemps(page);
  }));
  $$('[data-temp-history]', page).forEach(btn => btn.addEventListener('click', async () => {
    const id = Number(btn.dataset.tempHistory);
    if (tempsHistoryId === id) { tempsHistoryId = null; tempsHistoryData = null; renderTemps(page); return; }
    try {
      tempsHistoryData = await api(`/api/temperatures/history?equipment_id=${id}&days=7`);
      tempsHistoryId = id;
      renderTemps(page);
    } catch (error) { toast(error.message); }
  }));
  $$('[data-temp-toggle]', page).forEach(btn => btn.addEventListener('click', async () => {
    try {
      await api(`/api/temperatures/equipment/${btn.dataset.tempToggle}/active`, { method: 'POST', body: JSON.stringify({ active: btn.dataset.tempActive === '1' }) });
      renderTemps(page);
    } catch (error) { toast(error.message); }
  }));
  $$('[data-temp-form]', page).forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const id = Number(form.dataset.tempForm);
    const d = formObject(form);
    try {
      const payload = { equipment_id: id, value_f: Number(d.value_f) };
      if (d.humidity_pct !== '' && d.humidity_pct != null) payload.humidity_pct = Number(d.humidity_pct);
      const res = await api('/api/temperatures/readings', { method: 'POST', body: JSON.stringify(payload) });
      tempsOpenForm = null;
      toast(res.deviation ? `${t('tempReadingSaved')} · ${t('tempStatusDeviation')}` : t('tempReadingSaved'));
      renderTemps(page);
    } catch (error) { toast(error.message); }
  }));
  $$('[data-temp-equip-form]', page).forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const locId = Number(form.dataset.tempEquipForm);
    const d = formObject(form);
    try {
      const payload = { location_id: locId, name: d.name, type: d.type };
      if (d.norm_min_f !== '' && d.norm_min_f != null) payload.norm_min_f = Number(d.norm_min_f);
      if (d.norm_max_f !== '' && d.norm_max_f != null) payload.norm_max_f = Number(d.norm_max_f);
      await api('/api/temperatures/equipment', { method: 'POST', body: JSON.stringify(payload) });
      toast(t('saved'));
      renderTemps(page);
    } catch (error) { toast(error.message); }
  }));
  const journalForm = $('#tempJournalForm', page);
  if (journalForm) journalForm.addEventListener('submit', async e => {
    e.preventDefault();
    tempsJournalLoc = $('#tempJournalLoc').value;
    tempsJournalDay = $('#tempJournalDay').value || tempsJournalDay;
    try {
      tempsJournalData = await api(`/api/temperatures/journal?location_id=${encodeURIComponent(tempsJournalLoc)}&day=${encodeURIComponent(tempsJournalDay)}`);
      renderTemps(page);
    } catch (error) { toast(error.message); }
  });
  const printBtn = $('#tempPrintBtn', page);
  if (printBtn) printBtn.addEventListener('click', () => window.print());
}

/* ---------------- Orders ---------------- */
let orderLines = [];
function orderCard(order) {
  const next = { new: ['cooking', t('toCooking')], cooking: ['ready', t('toReady')], ready: ['served', t('toServed')] }[order.status];
  const place = order.kind === 'dinein' ? `${t('table')} ${order.tableNo}` : order.kind === 'takeaway' ? t('takeaway') : t('delivery');
  const closed = order.status === 'served' || order.status === 'cancelled';
  return `<div class="order-card">
    <div class="row"><strong>#${order.id} · ${esc(place)}</strong><span>${order.source === 'clover' ? '<span class="badge green">Clover</span> ' : ''}<span class="badge">${money(order.total)}</span></span></div>
    <div class="muted">${esc(locationName(order.locationId))} · ${fmtTime(order.createdAt)}</div>
    <ul>${order.items.map(i => `<li>${esc(i.name)} × ${i.qty}</li>`).join('')}</ul>
    ${order.note ? `<p class="muted">${esc(order.note)}</p>` : ''}
    ${closed ? '' : `<div class="row">
      ${next ? `<button class="primary" data-advance="${order.id}" data-status="${next[0]}">${next[1]}</button>` : ''}
      <button class="secondary" data-cancel-order="${order.id}">${t('cancel')}</button>
    </div>`}</div>`;
}
function renderOrders(page) {
  const columns = [['new', t('statusNew')], ['cooking', t('statusCooking')], ['ready', t('statusReady')]];
  const menuOptions = appState.menu.filter(m => !m.stopped).map(m => `<option value="${m.id}">${esc(m.name)} — ${money(m.price)}</option>`).join('');
  page.innerHTML = `
    ${pageHead(t('orders'), fmtDay(new Date()))}
    <div class="card form-card"><h2>${t('newOrder')}</h2>
      <form id="orderForm" class="stack">
        <div class="form-grid">
          <label>${t('location')}<select name="locationId">${appState.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
          <label>${t('status')}<select name="kind" id="orderKind"><option value="dinein">${t('dinein')}</option><option value="takeaway">${t('takeaway')}</option><option value="delivery">${t('delivery')}</option></select></label>
          <label>${t('table')}<input name="tableNo" type="number" min="1" max="10" value="1"></label>
        </div>
        <div id="orderLines" class="list"></div>
        <button class="secondary" type="button" id="addLine">${t('addLine')}</button>
        <button class="primary" type="submit">${t('create')}</button>
      </form>
    </div>
    <div class="board">
      ${columns.map(([status, label]) => `<div class="board-col"><h3>${label} <span class="badge">${appState.orders.filter(o => o.status === status).length}</span></h3>
        <div class="list">${appState.orders.filter(o => o.status === status).map(orderCard).join('') || `<p class="muted">${t('empty')}</p>`}</div></div>`).join('')}
    </div>`;
  const linesEl = $('#orderLines');
  function drawLines() {
    linesEl.innerHTML = orderLines.map((line, idx) => `<div class="row"><select data-line-item="${idx}">${menuOptions}</select>
      <input data-line-qty="${idx}" type="number" min="1" max="99" value="${line.qty}" style="max-width:76px">
      <button class="secondary" type="button" data-line-del="${idx}">✕</button></div>`).join('');
    orderLines.forEach((line, idx) => { $(`[data-line-item="${idx}"]`).value = String(line.menuItemId); });
    $$('[data-line-item]').forEach(sel => sel.addEventListener('change', () => { orderLines[Number(sel.dataset.lineItem)].menuItemId = Number(sel.value); }));
    $$('[data-line-qty]').forEach(inp => inp.addEventListener('change', () => { orderLines[Number(inp.dataset.lineQty)].qty = Number(inp.value) || 1; }));
    $$('[data-line-del]').forEach(btn => btn.addEventListener('click', () => { orderLines.splice(Number(btn.dataset.lineDel), 1); drawLines(); }));
  }
  if (!orderLines.length && appState.menu.length) orderLines = [{ menuItemId: appState.menu[0].id, qty: 1 }];
  drawLines();
  $('#addLine').addEventListener('click', () => { orderLines.push({ menuItemId: appState.menu[0]?.id, qty: 1 }); drawLines(); });
  $('#orderForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try {
      await api('/api/orders', { method: 'POST', body: JSON.stringify({ locationId: Number(d.locationId), kind: d.kind, tableNo: Number(d.tableNo) || null, items: orderLines }) });
      orderLines = [];
      toast(t('saved'));
      await refresh();
    } catch (error) { toast(error.message); }
  });
  $$('[data-advance]').forEach(btn => btn.addEventListener('click', async () => {
    try { await api(`/api/orders/${btn.dataset.advance}/status`, { method: 'POST', body: JSON.stringify({ status: btn.dataset.status }) }); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-cancel-order]').forEach(btn => btn.addEventListener('click', async () => {
    try { await api(`/api/orders/${btn.dataset.cancelOrder}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) }); await refresh(); }
    catch (error) { toast(error.message); }
  }));
}

/* ---------------- Disputes ---------------- */
let disputesData = null;
let disputeDetail = null;
let disputeEvidence = null;
const DISPUTE_CHANNELS_UI = [['uber', 'Uber Eats'], ['doordash', 'DoorDash'], ['grubhub', 'Grubhub'], ['clover', 'Clover / Fiserv']];
const DISPUTE_STATUSES_UI = ['new', 'evidence_ready', 'submitted', 'won', 'lost', 'expired', 'skipped'];
const DISPUTE_STATUS_LABEL_UI = {
  ru: { new: 'Новый', evidence_ready: 'Пакет готов', submitted: 'Подан', won: 'Выигран', lost: 'Проигран', expired: 'Просрочен', skipped: 'Не спорим' },
  en: { new: 'New', evidence_ready: 'Pack ready', submitted: 'Submitted', won: 'Won', lost: 'Lost', expired: 'Expired', skipped: 'Skipped' }
};
const dispStatusLabel = (s) => (DISPUTE_STATUS_LABEL_UI[lang] || DISPUTE_STATUS_LABEL_UI.ru)[s] || s;

function disputeDeadlineBadge(d) {
  if (d.terminal) return `<span class="badge gray">${esc(d.deadlineAt || '—')}</span>`;
  if (d.daysLeft == null) return '<span class="badge gray">—</span>';
  if (d.daysLeft < 0) return `<span class="badge red">${t('dispLate')} ${-d.daysLeft} ${t('dispDays')} · ${esc(d.deadlineAt)}</span>`;
  if (d.daysLeft === 0) return `<span class="badge red">${t('dispToday')} · ${esc(d.deadlineAt)}</span>`;
  if (d.daysLeft <= 3) return `<span class="badge red">${d.daysLeft} ${t('dispDays')} · ${esc(d.deadlineAt)}</span>`;
  return `<span class="badge gray">${d.daysLeft} ${t('dispDays')} · ${esc(d.deadlineAt)}</span>`;
}

async function loadDisputes() {
  disputesData = await api('/api/disputes');
}

async function renderDisputes(page) {
  if (!can('manager')) {
    page.innerHTML = `${pageHead(t('disputes'), t('dispSub'))}<div class="card"><p class="muted">403</p></div>`;
    return;
  }
  if (!disputesData) {
    page.innerHTML = `${pageHead(t('disputes'), t('dispSub'))}<div class="card"><p class="muted">…</p></div>`;
    try { await loadDisputes(); } catch (error) { page.innerHTML = `${pageHead(t('disputes'), '')}<div class="card"><p class="muted">${esc(error.message)}</p></div>`; return; }
  }
  const s = disputesData.summary;
  const locationOptions = appState.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  const channelOptions = DISPUTE_CHANNELS_UI.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  page.innerHTML = `
    ${pageHead(t('disputes'), t('dispSub'))}
    <div class="kpi-grid">
      <div class="card"><div class="metric">${s.open}</div><div class="metric-label">${t('dispOpen')}</div></div>
      <div class="card"><div class="metric">${s.overdue}</div><div class="metric-label">${t('dispOverdue')}</div></div>
      <div class="card"><div class="metric">${s.dueSoon}</div><div class="metric-label">${t('dispDueSoon')}</div></div>
      <div class="card"><div class="metric">${money(s.openAmount)}</div><div class="metric-label">${t('dispWithheld')}</div></div>
      <div class="card"><div class="metric">${money(s.wonAmount)}</div><div class="metric-label">${t('dispWonBack')}</div></div>
    </div>
    <div id="disputeDetail"></div>
    <section class="section"><div class="card"><h2>⚖️ ${t('disputes')}</h2>
      <div class="list">${disputesData.disputes.length ? disputesData.disputes.map(d => `<div class="row">
        <span><span class="badge">${esc(d.channelLabel)}</span> <strong>${money(d.amount)}${d.fee ? ` + ${money(d.fee)} fee` : ''}</strong>
        · ${esc(d.locationName || '—')} · ${esc(d.channelOrderId || d.cloverOrderId || (d.panelOrderId ? '#' + d.panelOrderId : '—'))}
        ${d.reason ? `<br><span class="muted">${esc(d.reason)}</span>` : ''}</span>
        <span>${disputeDeadlineBadge(d)} <span class="badge ${d.terminal ? 'gray' : 'green'}">${esc(dispStatusLabel(d.status))}</span>
        <button class="secondary" type="button" data-disp-open="${d.id}">${t('dispOpenCase')}</button></span></div>`).join('') : `<p class="muted">${t('dispNoCases')}</p>`}
      </div>
    </div></section>
    <div class="grid two">
      <div class="card form-card"><h3>${t('dispNew')}</h3>
        <form id="disputeForm" class="stack">
          <div class="form-grid">
            <label>${t('dispChannel')}<select name="channel">${channelOptions}</select></label>
            <label>${t('location')}<select name="locationId">${locationOptions}</select></label>
            <label>${t('dispOrderId')}<input name="channelOrderId" required></label>
            <label>${t('dispCloverId')}<input name="cloverOrderId"></label>
            <label>${t('dispAmount')}<input name="amount" type="number" step="0.01" min="0" required></label>
            <label>${t('dispFee')}<input name="fee" type="number" step="0.01" min="0" value="0"></label>
            <label>${t('dispOrderDate')}<input name="orderDate" type="date"></label>
            <label>${t('dispDisputeDate')}<input name="disputeDate" type="date"></label>
            <label>${t('dispDeadline')}<input name="deadlineAt" type="date"></label>
          </div>
          <p class="hint">${t('dispDeadlineHint')}</p>
          <label>${t('reason')}<input name="reason"></label>
          <label>${t('comment')}<input name="note"></label>
          <button class="primary" type="submit">${t('create')}</button>
        </form>
      </div>
      <div class="card form-card"><h3>${t('dispImport')}</h3>
        <form id="disputeImportForm" class="stack">
          <label>${t('dispChannel')}<select name="channel">${DISPUTE_CHANNELS_UI.filter(([v]) => v !== 'clover').map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}</select></label>
          <label>${t('location')}<select name="locationId">${locationOptions}</select></label>
          <label>CSV<input name="file" type="file" accept=".csv,text/csv" required></label>
          <p class="hint">${t('dispImportHint')}</p>
          <button class="primary" type="submit">${t('dispImportBtn')}</button>
        </form>
      </div>
    </div>`;
  $('#disputeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try {
      await api('/api/disputes', {
        method: 'POST',
        body: JSON.stringify({
          channel: d.channel, locationId: Number(d.locationId) || null,
          channelOrderId: d.channelOrderId, cloverOrderId: d.cloverOrderId,
          amount: Number(d.amount), fee: Number(d.fee || 0),
          orderDate: d.orderDate, disputeDate: d.disputeDate, deadlineAt: d.deadlineAt,
          reason: d.reason, note: d.note
        })
      });
      disputesData = null;
      toast(t('dispCreated'));
      render();
    } catch (error) { toast(error.message); }
  });
  $('#disputeImportForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const d = formObject(form);
    const file = form.querySelector('[name="file"]').files[0];
    if (!file) return;
    try {
      const csv = await file.text();
      const result = await api('/api/disputes/import', { method: 'POST', body: JSON.stringify({ channel: d.channel, locationId: Number(d.locationId) || null, csv }) });
      disputesData = null;
      toast(`${t('dispImported')}: +${result.created}, skip ${result.skipped}`);
      render();
    } catch (error) { toast(error.message); }
  });
  $$('[data-disp-open]').forEach(btn => btn.addEventListener('click', () => openDisputeDetail(Number(btn.dataset.dispOpen))));
  if (disputeDetail) drawDisputeDetail();
}

async function openDisputeDetail(id) {
  try {
    const data = await api(`/api/disputes/${id}`);
    disputeDetail = data.dispute;
    disputeEvidence = null;
    drawDisputeDetail();
    $('#disputeDetail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { toast(error.message); }
}

function drawDisputeDetail() {
  const holder = $('#disputeDetail');
  if (!holder || !disputeDetail) return;
  const d = disputeDetail;
  const ev = d.evidence || {};
  holder.innerHTML = `<section class="section"><div class="card">
    <div class="row"><h3 style="margin:0">${esc(d.channelLabel)} · ${money(d.amount)}${d.fee ? ` + ${money(d.fee)} fee` : ''}</h3>
    <span>${disputeDeadlineBadge(d)} <span class="badge ${d.terminal ? 'gray' : 'green'}">${esc(dispStatusLabel(d.status))}</span></span></div>
    <div class="list" style="margin-top:10px">
      <div class="row"><span class="muted">${t('location')}</span><span>${esc(d.locationName || '—')}</span></div>
      <div class="row"><span class="muted">${t('dispOrderId')}</span><span>${esc(d.channelOrderId || '—')}</span></div>
      <div class="row"><span class="muted">Clover</span><span>${esc(d.cloverOrderId || '—')}${d.panelOrderId ? ` · панель #${d.panelOrderId}` : ''}</span></div>
      <div class="row"><span class="muted">${t('dispOrderDate')} / ${t('dispDisputeDate')}</span><span>${esc(d.orderDate || '—')} / ${esc(d.disputeDate || '—')}</span></div>
      <div class="row"><span class="muted">${t('dispDeadline')}</span><span>${esc(d.deadlineAt || '—')} (${d.deadlineSource === 'notice' ? 'из уведомления' : 'по правилу канала'})</span></div>
      ${d.reason ? `<div class="row"><span class="muted">${t('reason')}</span><span>${esc(d.reason)}</span></div>` : ''}
      ${d.submittedAt ? `<div class="row"><span class="muted">${esc(dispStatusLabel('submitted'))}</span><span>${fmtDay(d.submittedAt)} · ${esc(d.submittedByName || '')}</span></div>` : ''}
      ${d.outcomeAmount != null ? `<div class="row"><span class="muted">${t('dispOutcome')}</span><span>${money(d.outcomeAmount)}</span></div>` : ''}
      ${d.note ? `<div class="row"><span class="muted">${t('comment')}</span><span>${esc(d.note)}</span></div>` : ''}
    </div>
    <h4>${t('dispChecklist')}</h4>
    <div class="list">
      <label class="row"><span>🎥 CCTV</span><input type="checkbox" id="dispEvCctv" ${ev.cctv ? 'checked' : ''}></label>
      <label class="row"><span>📷 ${lang === 'en' ? 'Sealed-bag photo' : 'Фото запечатанного пакета'}</span><input type="checkbox" id="dispEvPhoto" ${ev.photo ? 'checked' : ''}></label>
    </div>
    <div class="row" style="margin-top:12px; flex-wrap:wrap; gap:8px; justify-content:flex-start">
      <button class="primary" type="button" id="dispBuildBtn">${t('dispPack')}</button>
      <select id="dispStatusSel">${DISPUTE_STATUSES_UI.map(s => `<option value="${s}" ${s === d.status ? 'selected' : ''}>${esc(dispStatusLabel(s))}</option>`).join('')}</select>
      <button class="secondary" type="button" id="dispStatusBtn">${t('save')}</button>
      <label>${t('dispOutcome')}<input id="dispOutcomeAmt" type="number" step="0.01" min="0" value="${d.outcomeAmount ?? ''}" style="max-width:120px"></label>
    </div>
    <div id="dispEvidenceBox" style="margin-top:14px"></div>
  </div></section>`;
  const patchEvidence = async () => {
    try {
      const data = await api(`/api/disputes/${d.id}`, { method: 'PATCH', body: JSON.stringify({ evidence: { cctv: $('#dispEvCctv').checked, photo: $('#dispEvPhoto').checked } }) });
      disputeDetail = data.dispute;
    } catch (error) { toast(error.message); }
  };
  $('#dispEvCctv').addEventListener('change', patchEvidence);
  $('#dispEvPhoto').addEventListener('change', patchEvidence);
  $('#dispStatusBtn').addEventListener('click', async () => {
    try {
      const outcome = $('#dispOutcomeAmt').value;
      const data = await api(`/api/disputes/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: $('#dispStatusSel').value, ...(outcome !== '' ? { outcomeAmount: Number(outcome) } : {}) })
      });
      disputeDetail = data.dispute;
      disputesData = null;
      toast(t('saved'));
      render();
    } catch (error) { toast(error.message); }
  });
  $('#dispBuildBtn').addEventListener('click', async () => {
    try {
      const data = await api(`/api/disputes/${d.id}/evidence`);
      disputeEvidence = data.evidence;
      drawDisputeEvidence();
    } catch (error) { toast(error.message); }
  });
  if (disputeEvidence) drawDisputeEvidence();
}

function drawDisputeEvidence() {
  const box = $('#dispEvidenceBox');
  if (!box || !disputeEvidence) return;
  const e = disputeEvidence;
  const items = e.order ? e.order.items.map(i => `<div class="row"><span>${esc(i.name)} × ${i.qty}</span><span>${money(i.price * i.qty)}</span></div>`).join('') : '';
  box.innerHTML = `
    ${e.order ? `<h4>${lang === 'en' ? 'Order' : 'Заказ'} ${esc(e.order.cloverOrderId || '#' + e.order.id)} · ${money(e.order.total)}</h4><div class="list">${items}</div>
    <p class="muted">${esc(e.location?.name || '')} · ${fmtDay(e.order.createdAt)} ${fmtTime(e.order.createdAt)} → ${e.order.servedAt ? fmtTime(e.order.servedAt) : '—'}</p>`
    : `<p class="muted">${lang === 'en' ? 'Panel order not linked — the pack contains case data only.' : 'Заказ панели не привязан — пакет собран только по данным кейса.'}</p>`}
    <h4>${t('dispChecklist')}</h4>
    <div class="list">${e.checklist.map(c => `<div class="row"><span>${c.present ? '✅' : '⬜'} ${esc(c.label)}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</span></div>`).join('')}</div>
    <h4>${t('dispText')}</h4>
    <textarea id="dispTextArea" rows="12" readonly style="width:100%">${esc(e.text)}</textarea>
    <div class="row" style="margin-top:10px; flex-wrap:wrap; gap:8px; justify-content:flex-start">
      <button class="secondary" type="button" id="dispCopyBtn">${t('dispCopy')}</button>
      <button class="secondary" type="button" id="dispPrintBtn">${t('dispPrint')}</button>
      ${e.portalUrl ? `<a class="secondary" href="${esc(e.portalUrl)}" target="_blank" rel="noopener" style="padding:9px 14px; border-radius:12px; text-decoration:none">${t('dispPortal')}</a>` : ''}
    </div>
    <p class="hint">${esc(e.portalName || '')}${e.portalEmail ? ` · email: ${esc(e.portalEmail)}` : ''}</p>`;
  $('#dispCopyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(e.text); toast(t('saved')); } catch { $('#dispTextArea').select(); document.execCommand('copy'); }
  });
  $('#dispPrintBtn').addEventListener('click', () => printDisputePack(e));
}

function printDisputePack(e) {
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked'); return; }
  const rows = e.order ? e.order.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>$${(i.price * i.qty).toFixed(2)}</td></tr>`).join('') : '';
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Dispute pack</title>
  <style>body{font-family:Arial,sans-serif;margin:32px;color:#111}h1{font-size:20px}h2{font-size:15px;margin-top:22px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:6px 8px;text-align:left}pre{white-space:pre-wrap;font-family:inherit;border:1px solid #bbb;padding:12px}.muted{color:#555}</style></head><body>
  <h1>${esc(e.companyName || '')} — dispute evidence pack</h1>
  <p>${esc(e.channelLabel)} · ${esc(e.location?.name || '')}${e.location?.address ? `, ${esc(e.location.address)}` : ''}</p>
  ${e.order ? `<h2>Order ${esc(e.order.cloverOrderId || '#' + e.order.id)} — $${Number(e.order.total).toFixed(2)}</h2>
  <p class="muted">Placed: ${esc(e.order.createdAt)} · Served: ${esc(e.order.servedAt || '—')} · Kind: ${esc(e.order.kind)}</p>
  <table><tr><th>Item</th><th>Qty</th><th>Amount</th></tr>${rows}</table>` : '<p>No linked panel order.</p>'}
  <h2>Evidence checklist</h2>
  ${e.checklist.map(c => `<p>${c.present ? '☑' : '☐'} ${esc(c.label)}${c.note ? ` — ${esc(c.note)}` : ''}</p>`).join('')}
  <h2>Dispute text</h2><pre>${esc(e.text)}</pre>
  </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

/* ---------------- Kitchen & stock ---------------- */
function movementForm(kind, title) {
  const options = appState.ingredients.map(i => `<option value="${i.id}">${esc(i.name)} (${i.stock} ${esc(i.unit)})</option>`).join('');
  const extra = kind === 'purchase' ? `<label>${t('totalCost')}<input name="totalCost" type="number" step="0.01" min="0"></label>`
    : kind === 'writeoff' ? `<label>${t('reason')}<input name="reason"></label>`
    : `<label>${t('actualQty')}<input name="actualQty" type="number" step="any" min="0" required></label>`;
  return `<div class="card"><h3>${title}</h3><form data-move="${kind}" class="stack">
    <label>${t('ingredients')}<select name="ingredientId">${options}</select></label>
    ${kind !== 'stocktake' ? `<label>${t('qty')}<input name="qty" type="number" step="any" min="0" required></label>` : ''}
    ${extra}
    <button class="primary" type="submit">${t('apply')}</button></form></div>`;
}
/* -------- Purchase documents & invoice scan -------- */
let scanDraft = null;

function nyToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function mountPurchaseLines(holder, lines, { showRaw = false } = {}) {
  function draw() {
    holder.innerHTML = `<div class="list">${lines.map((line, idx) => `<div class="item">
      ${showRaw && line.raw ? `<p class="hint">OCR: ${esc(line.raw)}</p>` : ''}
      <div class="row"><select data-pl-ing="${idx}" style="flex:1">
        <option value="">${t('selectIngredient')}</option>
        ${appState.ingredients.map(i => `<option value="${i.id}">${esc(i.name)} (${i.stock} ${esc(i.unit)})</option>`).join('')}
        <option value="__new">${t('newIngredientOpt')}</option></select>
      <button class="secondary" type="button" data-pl-del="${idx}">✕</button></div>
      <div class="${line.ingredientId === '__new' ? '' : 'hidden'}" style="margin-top:8px">
        <div class="grid two"><label>${t('ingName')}<input data-pl-newname="${idx}" value="${esc(line.newName || '')}"></label>
        <label>${t('unit')}<input data-pl-newunit="${idx}" value="${esc(line.newUnit || 'г')}"></label></div>
      </div>
      <div class="grid two" style="margin-top:8px">
        <label>${t('qty')}${line.unitHint ? ` · ${esc(line.unitHint)}` : ''}<input data-pl-qty="${idx}" type="number" step="any" min="0" value="${line.qty ?? ''}"></label>
        <label>${t('lineTotal')}<input data-pl-total="${idx}" type="number" step="0.01" min="0" value="${line.totalCost ?? ''}"></label>
      </div>
    </div>`).join('')}</div>`;
    lines.forEach((line, idx) => {
      const sel = holder.querySelector(`[data-pl-ing="${idx}"]`);
      if (sel) sel.value = String(line.ingredientId ?? '');
    });
    $$('[data-pl-ing]', holder).forEach(sel => sel.addEventListener('change', () => {
      const line = lines[Number(sel.dataset.plIng)];
      line.ingredientId = sel.value === '__new' ? '__new' : sel.value === '' ? '' : Number(sel.value);
      draw();
    }));
    $$('[data-pl-qty]', holder).forEach(inp => inp.addEventListener('input', () => { lines[Number(inp.dataset.plQty)].qty = inp.value; }));
    $$('[data-pl-total]', holder).forEach(inp => inp.addEventListener('input', () => { lines[Number(inp.dataset.plTotal)].totalCost = inp.value; }));
    $$('[data-pl-newname]', holder).forEach(inp => inp.addEventListener('input', () => { lines[Number(inp.dataset.plNewname)].newName = inp.value; }));
    $$('[data-pl-newunit]', holder).forEach(inp => inp.addEventListener('input', () => { lines[Number(inp.dataset.plNewunit)].newUnit = inp.value; }));
    $$('[data-pl-del]', holder).forEach(btn => btn.addEventListener('click', () => { lines.splice(Number(btn.dataset.plDel), 1); draw(); }));
  }
  draw();
  return {
    getLines: () => lines,
    addLine: () => { lines.push({ ingredientId: '', qty: '', totalCost: '', newName: '', newUnit: 'г' }); draw(); }
  };
}

function serializePurchaseLines(lines) {
  const out = [];
  for (const line of lines) {
    const qty = Number(line.qty);
    if (!(qty > 0)) continue;
    const totalCost = Number(line.totalCost || 0);
    if (line.ingredientId === '__new') {
      const name = String(line.newName || '').trim();
      if (!name) continue;
      out.push({ newIngredient: { name, unit: String(line.newUnit || 'г').trim() || 'г' }, qty, totalCost });
    } else if (line.ingredientId) {
      out.push({ ingredientId: Number(line.ingredientId), qty, totalCost });
    }
  }
  return out;
}

let tesseractLoading = null;
function ensureTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('OCR library failed to load'));
      document.head.appendChild(script);
    });
  }
  return tesseractLoading;
}

// Downscale to max 1600 px BEFORE OCR and BEFORE saving: recognition is
// faster and the stored JPEG stays small.
async function fileToDownscaledJpeg(file, maxSide = 1600) {
  let source = null;
  let width = 0;
  let height = 0;
  if ('createImageBitmap' in window) {
    try { source = await createImageBitmap(file); width = source.width; height = source.height; } catch { source = null; }
  }
  if (!source) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    source = img; width = img.naturalWidth; height = img.naturalHeight;
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
  return { canvas, photoJpeg: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

async function runInvoiceScan(file) {
  const status = $('#scanStatus');
  const setStatus = (text) => { const el = $('#scanStatus'); if (el) el.textContent = text; };
  setStatus(t('recognizing'));
  try {
    const { canvas, photoJpeg } = await fileToDownscaledJpeg(file);
    await ensureTesseract();
    const worker = await window.Tesseract.createWorker('eng+rus', 1, {
      logger: m => { if (m.status === 'recognizing text') setStatus(`${t('recognizing')} ${Math.round((m.progress || 0) * 100)}%`); }
    });
    try {
      const { data } = await worker.recognize(canvas);
      const parsed = parseInvoiceText(data.text, appState.ingredients);
      scanDraft = {
        photoJpeg, supplier: '', docDate: nyToday(), note: '',
        lines: parsed.length
          ? parsed.map(p => ({ ingredientId: p.ingredientId ?? '', qty: p.qty, totalCost: p.totalCost, unitHint: p.unit, raw: p.raw, newName: '', newUnit: 'г' }))
          : [{ ingredientId: '', qty: '', totalCost: '', newName: '', newUnit: 'г' }]
      };
    } finally {
      await worker.terminate().catch(() => {});
    }
    setStatus('');
    renderScanDraft();
    $('#scanDraftBox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus('');
    toast(t('scanFailed'));
  }
}

function renderScanDraft() {
  const box = $('#scanDraftBox');
  if (!box) return;
  if (!scanDraft) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="item" style="border:2px solid var(--orange);margin:14px 0">
    <h3>📷 ${t('draftTitle')}</h3>
    <p class="hint">${t('ocrWarn')}</p>
    <div class="form-grid">
      <label>${t('supplier')}<input id="draftSupplier" value="${esc(scanDraft.supplier)}"></label>
      <label>${t('docDate')}<input id="draftDate" type="date" value="${esc(scanDraft.docDate)}"></label>
      <label>${t('comment')}<input id="draftNote" value="${esc(scanDraft.note)}"></label>
    </div>
    <div id="draftLines" style="margin-top:10px"></div>
    <div class="row" style="margin-top:10px">
      <button class="secondary" type="button" id="draftAddLine">${t('addRow')}</button>
      <button class="secondary" type="button" id="draftCancel">${t('cancel')}</button>
      <button class="primary" type="button" id="draftPost">${t('postPurchase')}</button>
    </div></div>`;
  const editor = mountPurchaseLines($('#draftLines'), scanDraft.lines, { showRaw: true });
  $('#draftAddLine').addEventListener('click', () => editor.addLine());
  $('#draftCancel').addEventListener('click', () => { scanDraft = null; renderScanDraft(); });
  $('#draftPost').addEventListener('click', async () => {
    scanDraft.supplier = $('#draftSupplier').value;
    scanDraft.docDate = $('#draftDate').value;
    scanDraft.note = $('#draftNote').value;
    const lines = serializePurchaseLines(editor.getLines());
    if (!lines.length) { toast(t('selectIngredient')); return; }
    try {
      await api('/api/purchase-documents', { method: 'POST', body: JSON.stringify({ supplier: scanDraft.supplier, docDate: scanDraft.docDate, note: scanDraft.note, source: 'scan', photoJpeg: scanDraft.photoJpeg, lines }) });
      scanDraft = null;
      toast(t('posted'));
      await refresh();
    } catch (error) { toast(error.message); }
  });
}

async function loadPurchaseHistory() {
  const box = $('#purchaseHistoryBox');
  if (!box) return;
  try {
    const data = await api('/api/purchase-documents');
    box.classList.remove('muted');
    box.innerHTML = data.documents.length ? `<div class="list">${data.documents.map(doc => `<div class="item">
      <div class="row"><div><strong>${esc(doc.supplier || '—')}</strong>${doc.source === 'scan' ? ` <span class="badge">📷 ${t('scannedBadge')}</span>` : ''}${doc.emailOrigin ? ` <span class="badge">✉️ ${t('emailBadge')}</span>` : ''}
        <p class="muted">${esc(doc.docDate || '')} · ${money(doc.total)} · ${esc(doc.createdByName || '')}</p>
        <p class="muted">${doc.lines.map(l => `${esc(l.name)} × ${l.qty} ${esc(l.unit)}`).join(', ')}</p>
        ${doc.note ? `<p class="muted">${esc(doc.note)}</p>` : ''}</div>
        ${doc.hasPhoto ? `<button class="secondary" type="button" data-doc-photo="${doc.id}">📷 ${t('photo')}</button>` : ''}
      </div></div>`).join('')}</div>
      <dialog id="docPhotoDialog"><div class="dialog-card"><img id="docPhotoImg" alt="" style="width:100%;border-radius:14px">
      <button class="secondary" type="button" id="docPhotoClose">${t('close')}</button></div></dialog>`
      : `<p class="muted">${t('empty')}</p>`;
    const dialog = $('#docPhotoDialog');
    if (dialog) {
      $('#docPhotoClose').addEventListener('click', () => dialog.close());
      $$('[data-doc-photo]', box).forEach(btn => btn.addEventListener('click', async () => {
        try {
          const photo = await api(`/api/purchase-documents/${btn.dataset.docPhoto}/photo`);
          $('#docPhotoImg').src = `data:image/jpeg;base64,${photo.photoJpeg}`;
          dialog.showModal();
        } catch (error) { toast(error.message); }
      }));
    }
  } catch { box.textContent = '—'; }
}

/* -------- Inbound invoice drafts (email channel) -------- */
let inboxDraft = null;

async function loadInvoiceInbox() {
  const box = $('#invoiceInboxBox');
  if (!box) return;
  try {
    const data = await api('/api/invoice-drafts');
    const pending = data.drafts.filter(d => d.status === 'pending');
    const done = data.drafts.filter(d => d.status !== 'pending').slice(0, 5);
    box.classList.remove('muted');
    const row = (d) => `<div class="item"><div class="row"><div>
      <strong>${esc(d.supplier || d.subject || '—')}</strong> <span class="badge">✉️ ${t('emailBadge')}</span>
      <span class="badge">${d.status === 'pending' ? t('inboxStatusPending') : d.status === 'confirmed' ? t('inboxStatusConfirmed') : t('inboxStatusRejected')}</span>
      <p class="muted">${t('inboxFrom')}: ${esc(d.sender || '—')}${d.subject && d.supplier ? ` · ${esc(d.subject)}` : ''}</p>
      <p class="muted">${esc(d.docDate || '')} · ${money(d.total)} · ${d.lines.length} поз.${d.attachmentName ? ` · 📎 ${esc(d.attachmentName)}` : ''}</p></div>
      ${d.status === 'pending' ? `<button class="primary" type="button" data-inbox-open="${d.id}">${t('inboxOpen')}</button>` : ''}
    </div></div>`;
    box.innerHTML = (pending.length || done.length)
      ? `<div class="list">${pending.map(row).join('')}${done.map(row).join('')}</div>`
      : `<p class="muted">${t('inboxEmpty')}</p>`;
    $$('[data-inbox-open]', box).forEach(btn => btn.addEventListener('click', () => openInboxDraft(Number(btn.dataset.inboxOpen))));
  } catch { box.textContent = '—'; }
}

async function openInboxDraft(id) {
  try {
    const { draft } = await api(`/api/invoice-drafts/${id}`);
    inboxDraft = {
      id: draft.id, supplier: draft.supplier || '', docDate: draft.docDate || nyToday(), note: draft.note || '',
      sender: draft.sender || '', subject: draft.subject || '', rawText: draft.rawText || '', hasPhoto: draft.hasPhoto,
      lines: draft.lines.length
        ? draft.lines.map(p => ({ ingredientId: p.ingredientId ?? '', qty: p.qty, totalCost: p.totalCost, unitHint: p.unit, raw: p.raw, newName: '', newUnit: 'г' }))
        : [{ ingredientId: '', qty: '', totalCost: '', newName: '', newUnit: 'г' }]
    };
    renderInboxDraft();
    $('#inboxDraftBox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { toast(error.message); }
}

function renderInboxDraft() {
  const box = $('#inboxDraftBox');
  if (!box) return;
  if (!inboxDraft) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="item" style="border:2px solid var(--orange);margin:14px 0">
    <h3>✉️ ${t('inboxDraftTitle')}</h3>
    <p class="hint">${t('inboxFrom')}: ${esc(inboxDraft.sender || '—')}${inboxDraft.subject ? ` · ${esc(inboxDraft.subject)}` : ''}</p>
    <div class="form-grid">
      <label>${t('supplier')}<input id="inboxSupplier" value="${esc(inboxDraft.supplier)}"></label>
      <label>${t('docDate')}<input id="inboxDate" type="date" value="${esc(inboxDraft.docDate)}"></label>
      <label>${t('comment')}<input id="inboxNote" value="${esc(inboxDraft.note)}"></label>
    </div>
    <div id="inboxLines" style="margin-top:10px"></div>
    ${inboxDraft.rawText ? `<details style="margin-top:10px"><summary>${t('inboxRaw')}</summary><pre style="white-space:pre-wrap;max-height:220px;overflow:auto">${esc(inboxDraft.rawText.slice(0, 6000))}</pre></details>` : ''}
    <div class="row" style="margin-top:10px">
      <button class="secondary" type="button" id="inboxAddLine">${t('addRow')}</button>
      ${inboxDraft.hasPhoto ? `<button class="secondary" type="button" id="inboxPhotoBtn">📷 ${t('photo')}</button>
      <button class="secondary" type="button" id="inboxOcrBtn">${t('inboxRecognize')}</button>` : ''}
      <button class="secondary" type="button" id="inboxCancel">${t('cancel')}</button>
      <button class="secondary" type="button" id="inboxReject">${t('inboxReject')}</button>
      <button class="primary" type="button" id="inboxPost">${t('postPurchase')}</button>
    </div></div>
    <dialog id="inboxPhotoDialog"><div class="dialog-card"><img id="inboxPhotoImg" alt="" style="width:100%;border-radius:14px">
    <button class="secondary" type="button" id="inboxPhotoClose">${t('close')}</button></div></dialog>`;
  const editor = mountPurchaseLines($('#inboxLines'), inboxDraft.lines, { showRaw: true });
  $('#inboxAddLine').addEventListener('click', () => editor.addLine());
  $('#inboxCancel').addEventListener('click', () => { inboxDraft = null; renderInboxDraft(); });
  $('#inboxReject').addEventListener('click', async () => {
    try {
      await api(`/api/invoice-drafts/${inboxDraft.id}/reject`, { method: 'POST', body: '{}' });
      inboxDraft = null;
      renderInboxDraft();
      toast(t('inboxRejected'));
      loadInvoiceInbox();
    } catch (error) { toast(error.message); }
  });
  $('#inboxPost').addEventListener('click', async () => {
    inboxDraft.supplier = $('#inboxSupplier').value;
    inboxDraft.docDate = $('#inboxDate').value;
    inboxDraft.note = $('#inboxNote').value;
    const lines = serializePurchaseLines(editor.getLines());
    if (!lines.length) { toast(t('selectIngredient')); return; }
    try {
      await api(`/api/invoice-drafts/${inboxDraft.id}/confirm`, { method: 'POST', body: JSON.stringify({ supplier: inboxDraft.supplier, docDate: inboxDraft.docDate, note: inboxDraft.note, lines }) });
      inboxDraft = null;
      toast(t('posted'));
      await refresh();
    } catch (error) { toast(error.message); }
  });
  const dialog = $('#inboxPhotoDialog');
  if (dialog && inboxDraft.hasPhoto) {
    $('#inboxPhotoClose').addEventListener('click', () => dialog.close());
    $('#inboxPhotoBtn').addEventListener('click', async () => {
      try {
        const photo = await api(`/api/invoice-drafts/${inboxDraft.id}/photo`);
        $('#inboxPhotoImg').src = `data:image/jpeg;base64,${photo.photoJpeg}`;
        dialog.showModal();
      } catch (error) { toast(error.message); }
    });
    $('#inboxOcrBtn').addEventListener('click', async () => {
      try {
        const photo = await api(`/api/invoice-drafts/${inboxDraft.id}/photo`);
        const blob = await (await fetch(`data:image/jpeg;base64,${photo.photoJpeg}`)).blob();
        const file = new File([blob], 'invoice.jpg', { type: 'image/jpeg' });
        const { canvas } = await fileToDownscaledJpeg(file);
        await ensureTesseract();
        const ocr = await window.Tesseract.createWorker('eng+rus', 1);
        try {
          const { data } = await ocr.recognize(canvas);
          const parsed = parseInvoiceText(data.text, appState.ingredients);
          if (parsed.length) {
            inboxDraft.lines = parsed.map(p => ({ ingredientId: p.ingredientId ?? '', qty: p.qty, totalCost: p.totalCost, unitHint: p.unit, raw: p.raw, newName: '', newUnit: 'г' }));
            if (!inboxDraft.rawText) inboxDraft.rawText = data.text;
            renderInboxDraft();
          } else toast(t('scanFailed'));
        } finally { await ocr.terminate().catch(() => {}); }
      } catch (error) { toast(t('scanFailed')); }
    });
  }
}

function renderKitchen(page) {
  const mgr = can('manager');
  page.innerHTML = `
    ${pageHead(t('kitchen'), '')}
    <div class="card"><h2>${t('ingredients')}</h2>
      <div class="table-wrap"><table><thead><tr><th>${t('name')}</th><th>${t('stock')}</th><th>${t('min')}</th><th>${t('costUnit')}</th>${mgr ? '<th></th>' : ''}</tr></thead>
      <tbody>${appState.ingredients.map(i => `<tr><td>${esc(i.name)} ${i.belowMin ? `<span class="badge red">⚠️</span>` : ''}</td><td>${i.stock} ${esc(i.unit)}</td><td>${i.minStock}</td><td>${money(i.costPerUnit)}</td>
        ${mgr ? `<td><details class="inline-edit"><summary>${t('change')}</summary><form data-ing-edit="${i.id}" class="stack">
          <label>${t('min')}<input name="minStock" type="number" step="any" value="${i.minStock}"></label>
          <label>${t('costUnit')}<input name="costPerUnit" type="number" step="0.01" value="${i.costPerUnit}"></label>
          <button class="primary" type="submit">${t('save')}</button></form></details></td>` : ''}</tr>`).join('')}</tbody></table></div>
    </div>
    ${mgr ? `<section class="section"><div class="card">
      <div class="row"><h2>${t('purchases')}</h2><button class="primary" type="button" id="scanBtn">📷 ${t('scanInvoice')}</button></div>
      <input type="file" id="scanFile" accept="image/*" capture="environment" class="hidden">
      <p class="hint">${t('ocrWarn')}</p>
      <p class="hint" id="scanStatus"></p>
      <div id="scanDraftBox"></div>
      <form id="purchaseDocForm" class="stack">
        <div class="form-grid">
          <label>${t('supplier')}<input name="supplier" placeholder="Sysco, Restaurant Depot…"></label>
          <label>${t('docDate')}<input name="docDate" type="date" value="${nyToday()}"></label>
          <label>${t('comment')}<input name="note"></label>
        </div>
        <div id="purchaseLines"></div>
        <div class="row"><button class="secondary" type="button" id="purchaseAddLine">${t('addRow')}</button>
        <button class="primary" type="submit">${t('postPurchase')}</button></div>
      </form>
    </div></section>
    <section class="section"><div class="card"><h2>${t('historyTitle')}</h2><div id="purchaseHistoryBox" class="muted">…</div></div></section>
    <section class="section"><div class="card"><h2>✉️ ${t('inboxTitle')}</h2><p class="hint">${t('inboxHint')}</p><div id="inboxDraftBox"></div><div id="invoiceInboxBox" class="muted">…</div></div></section>
    <section class="section grid three">
      <div class="card"><h3>${t('addIngredient')}</h3><form id="ingForm" class="stack">
        <label>${t('name')}<input name="name" required></label>
        <div class="grid two"><label>${t('unit')}<input name="unit" value="г"></label><label>${t('stock')}<input name="stock" type="number" step="any" value="0"></label></div>
        <div class="grid two"><label>${t('min')}<input name="minStock" type="number" step="any" value="0"></label><label>${t('costUnit')}<input name="costPerUnit" type="number" step="0.01" value="0"></label></div>
        <button class="primary" type="submit">${t('save')}</button></form></div>
      ${movementForm('writeoff', t('writeoff'))}
      ${movementForm('stocktake', t('stocktake'))}
    </section>
    <section class="section"><div class="card"><h2>${t('recipes')}</h2>
      <div class="table-wrap"><table><thead><tr><th>${t('dish')}</th><th>${t('price')}</th><th>${t('cost')}</th><th>${t('foodcost')}</th><th></th></tr></thead>
      <tbody>${appState.menu.map(m => `<tr><td>${esc(m.name)}</td><td>${money(m.price)}</td><td>${money(m.cost)}</td><td>${m.foodCostPct == null ? '—' : `${m.foodCostPct}%`}</td>
        <td><details class="inline-edit"><summary>${t('change')}</summary><div data-recipe-editor="${m.id}"></div></details></td></tr>`).join('')}</tbody></table></div>
    </div></section>` : ''}`;
  if (!mgr) return;
  const manualEditor = mountPurchaseLines($('#purchaseLines'), [{ ingredientId: '', qty: '', totalCost: '', newName: '', newUnit: 'г' }]);
  $('#purchaseAddLine').addEventListener('click', () => manualEditor.addLine());
  $('#purchaseDocForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    const lines = serializePurchaseLines(manualEditor.getLines());
    if (!lines.length) { toast(t('selectIngredient')); return; }
    try {
      await api('/api/purchase-documents', { method: 'POST', body: JSON.stringify({ supplier: d.supplier, docDate: d.docDate, note: d.note, source: 'manual', lines }) });
      toast(t('posted'));
      await refresh();
    } catch (error) { toast(error.message); }
  });
  $('#scanBtn').addEventListener('click', () => $('#scanFile').click());
  $('#scanFile').addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) runInvoiceScan(file);
  });
  renderScanDraft();
  loadPurchaseHistory();
  renderInboxDraft();
  loadInvoiceInbox();
  $('#ingForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try { await api('/api/ingredients', { method: 'POST', body: JSON.stringify({ name: d.name, unit: d.unit, stock: Number(d.stock), minStock: Number(d.minStock), costPerUnit: Number(d.costPerUnit) }) }); await refresh(); }
    catch (error) { toast(error.message); }
  });
  $$('[data-ing-edit]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(form);
    try { await api(`/api/ingredients/${form.dataset.ingEdit}`, { method: 'PATCH', body: JSON.stringify({ minStock: Number(d.minStock), costPerUnit: Number(d.costPerUnit) }) }); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-move]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(form);
    const kind = form.dataset.move;
    const payload = kind === 'purchase' ? { ingredientId: Number(d.ingredientId), qty: Number(d.qty), totalCost: Number(d.totalCost || 0) }
      : kind === 'writeoff' ? { ingredientId: Number(d.ingredientId), qty: Number(d.qty), reason: d.reason || '' }
      : { ingredientId: Number(d.ingredientId), actualQty: Number(d.actualQty) };
    try { await api(`/api/${kind}s`, { method: 'POST', body: JSON.stringify(payload) }); toast(t('saved')); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-recipe-editor]').forEach(holder => {
    const item = appState.menu.find(m => m.id === Number(holder.dataset.recipeEditor));
    const ingOptions = appState.ingredients.map(i => `<option value="${i.id}">${esc(i.name)} (${esc(i.unit)})</option>`).join('');
    let lines = (item.recipe || []).map(r => ({ ...r }));
    function draw() {
      holder.innerHTML = `<div class="list">${lines.map((line, idx) => `<div class="row"><select data-r-ing="${idx}">${ingOptions}</select>
        <input data-r-qty="${idx}" type="number" step="any" min="0" value="${line.qty}" style="max-width:90px">
        <button class="secondary" type="button" data-r-del="${idx}">✕</button></div>`).join('')}</div>
        <div class="row" style="margin-top:8px"><button class="secondary" type="button" data-r-add>${t('addLine')}</button>
        <button class="primary" type="button" data-r-save>${t('save')}</button></div>`;
      lines.forEach((line, idx) => { holder.querySelector(`[data-r-ing="${idx}"]`).value = String(line.ingredientId); });
      $$('[data-r-ing]', holder).forEach(sel => sel.addEventListener('change', () => { lines[Number(sel.dataset.rIng)].ingredientId = Number(sel.value); }));
      $$('[data-r-qty]', holder).forEach(inp => inp.addEventListener('change', () => { lines[Number(inp.dataset.rQty)].qty = Number(inp.value) || 0; }));
      $$('[data-r-del]', holder).forEach(btn => btn.addEventListener('click', () => { lines.splice(Number(btn.dataset.rDel), 1); draw(); }));
      $('[data-r-add]', holder).addEventListener('click', () => { lines.push({ ingredientId: appState.ingredients[0]?.id, qty: 0 }); draw(); });
      $('[data-r-save]', holder).addEventListener('click', async () => {
        try { await api(`/api/menu/${item.id}/recipe`, { method: 'PUT', body: JSON.stringify({ lines }) }); toast(t('saved')); await refresh(); }
        catch (error) { toast(error.message); }
      });
    }
    draw();
  });
}

/* ---------------- Finance ---------------- */
const EXP_CATS = {
  rent: ['Аренда', 'Rent'], utilities: ['Коммуналка', 'Utilities'], aggregator: ['Комиссии агрегаторов', 'Aggregator fees'],
  processing: ['Процессинг карт', 'Card processing'], marketing: ['Маркетинг', 'Marketing'], repairs: ['Ремонт', 'Repairs'],
  supplies: ['Хоз. расходы', 'Supplies'], other: ['Прочее', 'Other']
};
const expCat = (k) => (EXP_CATS[k] || EXP_CATS.other)[lang === 'en' ? 1 : 0];
let finFrom = '';
let finTo = '';
let finMonth = '';
function finDefaults() {
  const today = nyToday();
  if (!finFrom) finFrom = `${today.slice(0, 7)}-01`;
  if (!finTo) finTo = today;
  if (!finMonth) finMonth = today.slice(0, 7);
}
function finShiftDays(key, days) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
async function renderFinance(page) {
  finDefaults();
  const mgr = can('manager');
  page.innerHTML = `${pageHead(t('finance'), t('finSub'))}<div class="card"><p class="muted">…</p></div>`;
  if (!mgr) return;
  let pnl; let dr15; let suppliers; let expenses;
  try {
    [pnl, dr15, suppliers, expenses] = await Promise.all([
      api(`/api/finance/pnl?from=${finFrom}&to=${finTo}`),
      api(`/api/finance/dr15?month=${finMonth}`),
      api('/api/suppliers'),
      api(`/api/expenses?from=${finFrom}&to=${finTo}`)
    ]);
  } catch (error) { toast(error.message); return; }
  const P = pnl.pnl;
  const total = P.total;
  const cols = [...P.locations, total];
  const owner = P.ownerView;
  const pnlRows = [
    [t('finGross'), v => money(v.gross), ''],
    [t('finTax'), v => `−${money(v.taxCollected)}`, ''],
    [t('finNet'), v => `<strong>${money(v.netRevenue)}</strong>`, ''],
    [t('finFood'), v => `${money(v.foodCost)} · ${v.foodCostPct}%`, ''],
    [t('finLabor'), v => owner ? `${money(v.laborCost)} · ${v.laborHours}${lang === 'en' ? 'h' : 'ч'}` : `${v.laborHours} ${t('finLaborHours')}`, ''],
    [t('finOpex'), v => money(v.opex), '']
  ];
  if (owner) pnlRows.push([t('finEbitda'), v => `<strong>${money(v.ebitda)}</strong> · ${v.ebitdaPct}%`, '']);
  const opexBreakdown = Object.entries(total.opexByCategory || {}).filter(([, v]) => v > 0)
    .map(([k, v]) => `${expCat(k)} ${money(v)}`).join(' · ');
  page.innerHTML = `
    ${pageHead(t('finance'), `${appState.companyName} · ${t('finSub')}`)}
    <div class="card form-card"><form id="finPeriodForm" class="stack">
      <div class="row">
        <button class="secondary" type="button" data-fin-preset="this">${t('finThisMonth')}</button>
        <button class="secondary" type="button" data-fin-preset="prev">${t('finPrevMonth')}</button>
        <button class="secondary" type="button" data-fin-preset="d30">${t('finDays30')}</button>
      </div>
      <div class="form-grid">
        <label>${t('finFrom')}<input type="date" id="finFromInput" value="${finFrom}"></label>
        <label>${t('finTo')}<input type="date" id="finToInput" value="${finTo}"></label>
      </div>
      <button class="primary" type="submit">${t('finApply')}</button>
    </form></div>
    <div class="kpi-grid" style="margin-top:14px">
      <div class="card"><div class="metric">${money(total.netRevenue)}</div><div class="metric-label">${t('finNet')} · ${total.orders} ${t('finOrdersWord')}</div></div>
      <div class="card"><div class="metric">${total.foodCostPct}%</div><div class="metric-label">${t('finFood')} · ${money(total.foodCost)}</div></div>
      <div class="card"><div class="metric">${owner ? money(total.ebitda) : `${total.laborHours}`}</div><div class="metric-label">${owner ? `${t('finEbitda')} · ${total.ebitdaPct}%` : `${t('finLabor')} · ${t('finLaborHours')}`}</div></div>
      <div class="card"><div class="metric">${money(total.taxCollected)}</div><div class="metric-label">${t('finTax')} · ${t('finTaxCov')} ${total.taxCoveragePct}%</div></div>
    </div>
    <section class="section"><div class="card"><h2>PnL · ${esc(P.period.from)} — ${esc(P.period.to)}</h2>
      <div class="table-wrap"><table><thead><tr><th></th>${cols.map(v => `<th>${esc(v.locationId === 0 ? t('finTotal') : v.name)}</th>`).join('')}</tr></thead>
      <tbody>${pnlRows.map(([label, fn]) => `<tr><td>${label}</td>${cols.map(v => `<td>${fn(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="hint">${t('finTaxCov')} ${total.taxCoveragePct}% ${t('finOrdersWord')} · ${t('finMapped')} ${total.coverage.mappedPct}% · ${t('finPriced')} ${total.coverage.pricedPct}% ${t('finOfRevenue')} · ${t('finLaborCov')} ${total.laborCoveragePct}%</p>
      ${opexBreakdown ? `<p class="hint">${t('finOpex')}: ${esc(opexBreakdown)}</p>` : ''}
      ${owner ? '' : `<p class="hint">${t('finOwnerOnly')}</p>`}
    </div></section>
    <section class="section"><div class="card"><h2>${t('expTitle')}</h2>
      <form id="expForm" class="stack">
        <div class="form-grid">
          <label>${t('location')}<select name="locationId"><option value="">${t('expNetwork')}</option>${appState.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
          <label>${t('expCategory')}<select name="category">${Object.keys(EXP_CATS).map(k => `<option value="${k}">${expCat(k)}</option>`).join('')}</select></label>
          <label>${t('expAmount')}<input name="amount" type="number" step="0.01" min="0" required></label>
          <label>${t('expDate')}<input name="date" type="date" value="${finTo}"></label>
        </div>
        <label>${t('supNote')}<input name="note"></label>
        <button class="primary" type="submit">${t('expAdd')}</button>
      </form>
      <div class="list" style="margin-top:12px">${expenses.expenses.length ? expenses.expenses.map(x => `<div class="row"><span>${esc(x.date)} · ${esc(x.locationId ? locationName(x.locationId) : t('expNetwork'))} · ${esc(expCat(x.category))}${x.note ? ` · ${esc(x.note)}` : ''}</span><span><span class="badge">${money(x.amount)}</span> <button class="secondary" type="button" data-exp-del="${x.id}">✕</button></span></div>`).join('') : `<p class="muted">${t('empty')}</p>`}</div>
    </div></section>
    <section class="section"><div class="card"><h2>${t('dr15Title')}</h2>
      <form id="dr15Form" class="row"><label>${t('dr15Month')}<input type="month" id="dr15MonthInput" value="${finMonth}"></label>
      <button class="primary" type="submit">${t('finApply')}</button>
      <span class="badge">${t('dr15Due')}: ${esc(dr15.dr15.dueDate)}</span></form>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th></th><th>${t('dr15Gross')}</th><th>${t('dr15Taxable')}</th><th>${t('dr15Tax')}</th><th>%</th><th>${t('dr15Allowance')}</th></tr></thead>
      <tbody>${[...dr15.dr15.locations, dr15.dr15.total].map(v => `<tr><td>${esc(v.locationId === 0 ? t('finTotal') : v.name)}</td><td>${money(v.grossSales)}</td><td>${money(v.taxableSales)}</td><td>${money(v.taxCollected)}</td><td>${v.taxCoveragePct}%</td><td>${money(v.allowance)}</td></tr>`).join('')}</tbody></table></div>
      <p class="hint">${t('dr15Note')}</p>
    </div></section>
    <section class="section"><div class="card"><h2>${t('supTitle')}</h2>
      <div class="list">${suppliers.suppliers.length ? suppliers.suppliers.map(s => `<div class="item">
        <div class="row"><div><strong>${esc(s.name)}</strong>${s.active ? '' : ' · ⛔'}
          <p class="muted">${esc(s.contactName || '')}${s.phone ? ` · ${esc(s.phone)}` : ''}${s.email ? ` · ${esc(s.email)}` : ''}</p>
          <p class="muted">${t('supDocs')}: ${s.docsCount} · ${t('supInvoiced')} ${money(s.invoiced)} · ${t('supPaid')} ${money(s.paid)}${s.oldestOpenDate ? ` · ${t('supOldest')} ${esc(s.oldestOpenDate)}` : ''}</p></div>
          <span class="badge ${s.balance > 0 ? 'red' : 'green'}">${t('supBalance')}: ${money(s.balance)}</span></div>
        <details class="inline-edit" data-sup-detail="${s.id}"><summary>${t('supPayments')} / ${t('supDocs')}</summary><div data-sup-body="${s.id}"><p class="muted">…</p></div></details>
      </div>`).join('') : `<p class="muted">${t('empty')}</p>`}</div>
      <form id="supForm" class="stack" style="margin-top:14px">
        <div class="form-grid">
          <label>${t('name')}<input name="name" required placeholder="Sysco, Restaurant Depot…"></label>
          <label>${t('supContact')}<input name="contactName"></label>
          <label>${t('supPhone')}<input name="phone"></label>
          <label>Email<input name="email"></label>
        </div>
        <label>${t('supNote')}<input name="note"></label>
        <button class="primary" type="submit">${t('supAdd')}</button>
      </form>
    </div></section>`;
  const reload = () => renderFinance(page);
  $$('[data-fin-preset]', page).forEach(btn => btn.addEventListener('click', () => {
    const today = nyToday();
    if (btn.dataset.finPreset === 'this') { finFrom = `${today.slice(0, 7)}-01`; finTo = today; }
    if (btn.dataset.finPreset === 'prev') {
      const first = `${today.slice(0, 7)}-01`;
      finTo = finShiftDays(first, -1);
      finFrom = `${finTo.slice(0, 7)}-01`;
    }
    if (btn.dataset.finPreset === 'd30') { finFrom = finShiftDays(today, -29); finTo = today; }
    reload();
  }));
  $('#finPeriodForm').addEventListener('submit', e => {
    e.preventDefault();
    finFrom = $('#finFromInput').value || finFrom;
    finTo = $('#finToInput').value || finTo;
    reload();
  });
  $('#dr15Form').addEventListener('submit', e => {
    e.preventDefault();
    finMonth = $('#dr15MonthInput').value || finMonth;
    reload();
  });
  $('#expForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try {
      await api('/api/expenses', { method: 'POST', body: JSON.stringify({ locationId: d.locationId ? Number(d.locationId) : null, category: d.category, amount: Number(d.amount), date: d.date || undefined, note: d.note }) });
      toast(t('saved'));
      reload();
    } catch (error) { toast(error.message); }
  });
  $$('[data-exp-del]', page).forEach(btn => btn.addEventListener('click', async () => {
    try { await api(`/api/expenses/${btn.dataset.expDel}`, { method: 'DELETE' }); reload(); }
    catch (error) { toast(error.message); }
  }));
  $('#supForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try {
      await api('/api/suppliers', { method: 'POST', body: JSON.stringify({ name: d.name, contactName: d.contactName, phone: d.phone, email: d.email, note: d.note }) });
      toast(t('saved'));
      reload();
    } catch (error) { toast(error.message); }
  });
  $$('[data-sup-detail]', page).forEach(details => details.addEventListener('toggle', async () => {
    if (!details.open) return;
    const id = details.dataset.supDetail;
    const holder = $(`[data-sup-body="${id}"]`, details);
    if (!holder || holder.dataset.loaded) return;
    holder.dataset.loaded = '1';
    try {
      const data = await api(`/api/suppliers/${id}`);
      holder.innerHTML = `
        ${data.documents.length ? `<p class="muted">${t('supDocs')}</p><div class="list">${data.documents.map(d => `<div class="row"><span>#${d.id} · ${esc(d.docDate || '')} · ${esc(d.supplier || '')}</span><span class="badge">${money(d.total)}</span></div>`).join('')}</div>` : `<p class="muted">${t('supNoDocs')}</p>`}
        ${data.payments.length ? `<p class="muted" style="margin-top:10px">${t('supPayments')}</p><div class="list">${data.payments.map(p => `<div class="row"><span>${esc(p.paidDate || '')} · ${esc(p.method || '')}${p.note ? ` · ${esc(p.note)}` : ''}</span><span><span class="badge green">${money(p.amount)}</span> <button class="secondary" type="button" data-pay-del="${p.id}">✕</button></span></div>`).join('')}</div>` : `<p class="muted" style="margin-top:10px">${t('supNoPays')}</p>`}
        <form data-pay-form="${id}" class="stack" style="margin-top:10px">
          <div class="form-grid">
            <label>${t('expAmount')}<input name="amount" type="number" step="0.01" min="0" required></label>
            <label>${t('expDate')}<input name="date" type="date" value="${nyToday()}"></label>
            <label>${t('supMethod')}<input name="method"></label>
          </div>
          <label>${t('supNote')}<input name="note"></label>
          <button class="primary" type="submit">${t('supPayAdd')}</button>
        </form>`;
      $(`[data-pay-form="${id}"]`, holder).addEventListener('submit', async e => {
        e.preventDefault();
        const d = formObject(e.target);
        try {
          await api(`/api/suppliers/${id}/payments`, { method: 'POST', body: JSON.stringify({ amount: Number(d.amount), date: d.date || undefined, method: d.method, note: d.note }) });
          toast(t('saved'));
          reload();
        } catch (error) { toast(error.message); }
      });
      $$('[data-pay-del]', holder).forEach(btn => btn.addEventListener('click', async () => {
        try { await api(`/api/suppliers/${id}/payments/${btn.dataset.payDel}`, { method: 'DELETE' }); reload(); }
        catch (error) { toast(error.message); }
      }));
    } catch (error) { holder.innerHTML = `<p class="muted">${esc(error.message)}</p>`; }
  }));
}

/* ---------------- Team ---------------- */
async function renderTeam(page) {
  const mgr = can('manager');
  const myOpen = appState.punches.find(p => p.employeeId === appState.me.id && !p.clockOut);
  page.innerHTML = `
    ${pageHead(t('team'), appState.companyName)}
    <div class="card"><div class="row"><div><h2>${esc(appState.me.name)}</h2>
      <p class="muted">${myOpen ? `${t('onShift')} ${fmtTime(myOpen.clockIn)} · ${esc(locationName(myOpen.locationId))}` : esc(appState.me.position || '')}</p></div>
      <button class="primary" id="punchBtn">${myOpen ? t('clockOut') : t('clockIn')}</button></div></div>
    <section class="section"><div class="card"><h2>${t('team')}</h2><div class="list">
      ${appState.employees.map(e => `<div class="item"><div class="row"><div><strong>${esc(e.name)}</strong> <span class="badge gray">${esc(e.rankLabel)}</span>
        <p class="muted">${esc(e.position || '')} · ${esc(locationName(e.locationId))}${e.active ? '' : ' · ⛔'}</p></div>
        ${appState.me.rank === 'owner' && e.hourlyRate != null ? `<span class="badge">${money(e.hourlyRate)}/ч</span>` : ''}
        </div>
        ${mgr && e.id !== appState.me.id ? `<details class="inline-edit"><summary>${t('change')}</summary><form data-emp-edit="${e.id}" class="stack">
          <div class="grid two"><label>${t('position')}<input name="position" value="${esc(e.position || '')}"></label>
          <label>${t('location')}<select name="locationId">${appState.locations.map(l => `<option value="${l.id}" ${l.id === e.locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label></div>
          ${appState.me.rank === 'owner' ? `<label>${t('rate')}<input name="hourlyRate" type="number" step="0.01" value="${e.hourlyRate ?? ''}"></label>` : ''}
          <label class="checkline"><input type="checkbox" name="active" ${e.active ? 'checked' : ''}> ${t('activeWord')}</label>
          <button class="primary" type="submit">${t('save')}</button></form></details>` : ''}
      </div>`).join('')}
    </div></div></section>
    ${mgr ? `<section class="section"><div class="card"><h2>${t('invites')}</h2>
      <form id="inviteForm" class="stack">
        <div class="form-grid">
          <label>${t('position')}<select name="position">${STANDARD_ROLES.map(r => `<option>${r}</option>`).join('')}</select></label>
          <label>${t('location')}<select name="locationId">${appState.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
          <label>${t('boundContact')}<input name="contact" placeholder="+1... или email"></label>
        </div>
        <button class="primary" type="submit">${t('createInvite')}</button>
      </form>
      <div class="list" style="margin-top:12px">${(appState.invites || []).map(i => `<div class="row"><span><code>${esc(i.code)}</code> · ${esc(i.position || i.rankLabel)} · ${esc(i.locationName || '')}${i.contact ? ` · ${esc(i.contact)}` : ''}</span><span class="badge ${i.active ? 'green' : 'gray'}">${i.active ? '✓' : '—'}</span></div>`).join('')}</div>
    </div></section>` : ''}
    <section class="section"><div class="card"><h2>${t('timesheet')}</h2><div id="timesheetBox" class="muted">…</div></div></section>`;
  $('#punchBtn').addEventListener('click', async () => {
    try { await api('/api/punches', { method: 'POST', body: JSON.stringify({ action: myOpen ? 'out' : 'in' }) }); await refresh(); }
    catch (error) { toast(error.message); }
  });
  $$('[data-emp-edit]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(form);
    const payload = { position: d.position, locationId: Number(d.locationId) || null, active: Boolean(d.active) };
    if (d.hourlyRate !== undefined && d.hourlyRate !== '') payload.hourlyRate = Number(d.hourlyRate);
    try { await api(`/api/employees/${form.dataset.empEdit}`, { method: 'PATCH', body: JSON.stringify(payload) }); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  const inviteForm = $('#inviteForm');
  if (inviteForm) inviteForm.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try {
      const result = await api('/api/invites', { method: 'POST', body: JSON.stringify({ position: d.position, locationId: Number(d.locationId), contact: d.contact || undefined }) });
      toast(result.invite.code);
      await refresh();
    } catch (error) { toast(error.message); }
  });
  try {
    const ts = await api('/api/timesheet');
    const showCost = appState.me.rank === 'owner';
    $('#timesheetBox').innerHTML = `<div class="table-wrap"><table><thead><tr><th>${t('name')}</th><th>${t('hours')}</th>${showCost ? `<th>${t('pay')}</th>` : ''}</tr></thead>
      <tbody>${ts.rows.map(r => `<tr><td>${esc(r.employeeName)}</td><td>${r.hours}</td>${showCost ? `<td>${money(r.cost || 0)}</td>` : ''}</tr>`).join('') || `<tr><td colspan="3">${t('empty')}</td></tr>`}</tbody></table></div>`;
  } catch { $('#timesheetBox').textContent = '—'; }
}

/* ---------------- Menu ---------------- */
function renderMenu(page) {
  const mgr = can('manager');
  const categories = [...new Set(appState.menu.map(m => m.category))];
  const locs = appState.locations || [];
  const bindingOf = (m, locId) => (m.cloverBindings || []).find(b => b.locationId === locId)?.cloverItemId || '';
  const catalogBar = mgr ? `<section class="section"><div class="card"><div class="row"><div>
      <h2 style="margin:0">${t('catPublish')}</h2>
      <p class="muted" style="margin:4px 0 0">${t('catVersion')}: ${appState.catalog?.version ?? 1}${appState.catalog?.publishedAt ? ` · ${esc(String(appState.catalog.publishedAt).slice(0, 16).replace('T', ' '))}` : ''} · ${t('catPriceNote')}</p></div>
      <button class="primary" id="catalogPublishBtn" type="button">${t('catPublish')}</button></div></div></section>` : '';
  page.innerHTML = `
    ${pageHead(t('menu'), `${appState.menu.length}`)}
    ${catalogBar}
    ${categories.map(cat => `<section class="section"><div class="card"><h2>${esc(cat)}</h2><div class="list">
      ${appState.menu.filter(m => m.category === cat).map(m => `<div class="item"><div class="row">
        ${m.photoUrl ? `<img src="${esc(m.photoUrl)}" alt="" loading="lazy" style="width:58px;height:58px;object-fit:cover;border-radius:12px;flex:0 0 auto">` : ''}
        <div style="flex:1;min-width:0"><strong>${esc(m.name)}</strong>
        <p class="muted">${money(m.price)} · ${t('cost')} ${money(m.cost)} · ${t('foodcost')} ${m.foodCostPct == null ? '—' : `${m.foodCostPct}%`}${m.cloverItemId ? ' · Clover ✓' : ''}</p>
        ${m.nameEn ? `<p class="muted"><b>${esc(m.nameEn)}</b>${m.descriptionEn ? ` — ${esc(m.descriptionEn)}` : ''}</p>` : (m.descriptionEn ? `<p class="muted">${esc(m.descriptionEn)}</p>` : '')}
        ${(m.tags && m.tags.length) || m.calories != null || m.proteinG != null ? `<p>${(m.tags || []).map(tag => `<span class="badge gray">${esc(tag)}</span>`).join(' ')}${m.calories != null ? ` <span class="badge">${m.calories} ${t('catKcal')}</span>` : ''}${m.proteinG != null ? ` <span class="badge">${m.proteinG}g ${t('catProtein')}</span>` : ''}</p>` : ''}
        <p class="muted">${locs.map(l => `${esc(l.name)}: ${bindingOf(m, l.id) ? 'Clover ✓' : '—'}`).join(' · ')}</p></div>
        <span style="display:grid;gap:6px;justify-items:end"><span class="badge ${m.stopped ? 'red' : 'green'}">${m.stopped ? t('stop') : t('activeWord')}</span>
        <span class="badge ${m.catalogPublished ? 'green' : 'gray'}">${m.catalogPublished ? t('catOnSite') : t('catNotOnSite')}</span></span></div>
        ${mgr ? `<details class="inline-edit"><summary>${t('change')}</summary><form data-menu-edit="${m.id}" class="stack">
          <div class="grid two"><label>${t('name')}<input name="name" value="${esc(m.name)}"></label><label>${t('catNameEn')}<input name="nameEn" value="${esc(m.nameEn || '')}"></label></div>
          <div class="grid two"><label>${t('category')}<input name="category" value="${esc(m.category || '')}"></label><p class="muted" style="margin:0;align-self:end">${t('catPriceNote')}</p></div>
          <label>${t('catDescEn')}<textarea name="descriptionEn">${esc(m.descriptionEn || '')}</textarea></label>
          <div class="grid two"><label>${t('catPhotoUrl')}<input name="photoUrl" value="${esc(m.photoSourceUrl || '')}" placeholder="https://…"></label>
          <label>${t('catUpload')}<input name="photoFile" type="file" accept="image/*"></label></div>
          ${m.hasUploadedPhoto ? `<label class="checkline"><input type="checkbox" name="clearPhoto" value="1"> ${t('catClearPhoto')}</label>` : ''}
          <div class="grid three"><label>${t('catTags')}<input name="tags" value="${esc((m.tags || []).join(', '))}"></label>
          <label>${t('catKcal')}<input name="calories" type="number" min="0" step="1" value="${m.calories ?? ''}"></label>
          <label>${t('catProtein')}<input name="proteinG" type="number" min="0" step="0.1" value="${m.proteinG ?? ''}"></label></div>
          <fieldset style="border:1px solid var(--line);border-radius:14px;padding:12px"><legend class="muted">${t('catBindings')}</legend>
            <div class="grid two">${locs.map(l => `<label>${esc(l.name)}<input name="clover_${l.id}" value="${esc(bindingOf(m, l.id))}" placeholder="—"></label>`).join('')}</div></fieldset>
          <label class="checkline"><input type="checkbox" name="catalogPublished" ${m.catalogPublished ? 'checked' : ''}> ${t('catPublishedFlag')}</label>
          <label class="checkline"><input type="checkbox" name="stopped" ${m.stopped ? 'checked' : ''}> ${t('stop')}</label>
          <button class="primary" type="submit">${t('save')}</button></form></details>` : ''}
      </div>`).join('')}
    </div></div></section>`).join('')}
    ${mgr ? `<section class="section"><div class="card"><h2>${t('addItem')}</h2><form id="menuForm" class="stack">
      <div class="form-grid"><label>${t('name')}<input name="name" required></label>
      <label>${t('category')}<input name="category" list="cats"><datalist id="cats">${categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label>${t('price')}<input name="price" type="number" step="0.01" required></label></div>
      <div class="grid two"><label>${t('catNameEn')}<input name="nameEn"></label><label>${t('catDescEn')}<input name="descriptionEn"></label></div>
      <label class="checkline"><input type="checkbox" name="catalogPublished"> ${t('catPublishedFlag')}</label>
      <button class="primary" type="submit">${t('save')}</button></form></div></section>` : ''}`;
  const publishBtn = $('#catalogPublishBtn');
  if (publishBtn) publishBtn.addEventListener('click', async () => {
    try {
      const r = await api('/api/catalog/publish', { method: 'POST' });
      toast(`${t('catPublishedOk')} · v${r.version} · ${r.items}`);
      await refresh();
    } catch (error) { toast(error.message); }
  });
  $$('[data-menu-edit]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(form);
    const cloverBindings = {};
    locs.forEach(l => { cloverBindings[l.id] = d[`clover_${l.id}`] || ''; });
    const payload = {
      name: d.name, nameEn: d.nameEn || '', category: d.category || '',
      stopped: Boolean(d.stopped), descriptionEn: d.descriptionEn || '', photoUrl: d.photoUrl || '',
      tags: d.tags || '', calories: d.calories === '' || d.calories === undefined ? null : Number(d.calories),
      proteinG: d.proteinG === '' || d.proteinG === undefined ? null : Number(d.proteinG),
      catalogPublished: Boolean(d.catalogPublished), cloverBindings
    };
    if (d.clearPhoto) payload.clearPhoto = true;
    try {
      const file = form.querySelector('input[name="photoFile"]')?.files?.[0];
      if (file) payload.photoData = (await fileToDownscaledJpeg(file, 1200)).photoJpeg;
      await api(`/api/menu/${form.dataset.menuEdit}`, { method: 'PATCH', body: JSON.stringify(payload) });
      await refresh();
    } catch (error) { toast(error.message); }
  }));
  const menuForm = $('#menuForm');
  if (menuForm) menuForm.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try { await api('/api/menu', { method: 'POST', body: JSON.stringify({ name: d.name, category: d.category, price: Number(d.price), nameEn: d.nameEn || '', descriptionEn: d.descriptionEn || '', catalogPublished: Boolean(d.catalogPublished) }) }); await refresh(); }
    catch (error) { toast(error.message); }
  });
}

/* ---------------- Settings ---------------- */
function renderSettings(page) {
  const owner = appState.me.rank === 'owner';
  const mgr = can('manager');
  page.innerHTML = `
    ${pageHead(t('settings'), '')}
    <div class="grid two">
      <div class="card"><h2>${t('myPassword')}</h2><form id="myPassForm" class="stack">
        <label>${t('newPassword')}<input name="password" type="password" minlength="6" placeholder="••••••"></label>
        <label>${t('kioskPin')}<input name="pin" inputmode="numeric" placeholder="PIN"></label>
        <button class="primary" type="submit">${t('save')}</button></form></div>
      ${owner ? `<div class="card"><h2>${t('company')}</h2><form id="companyForm" class="stack">
        <label>${t('name')}<input name="name" value="${esc(appState.companyName)}"></label>
        <button class="primary" type="submit">${t('save')}</button></form></div>` : ''}
    </div>
    ${owner ? `<section class="section"><div class="card"><h2>${t('clover')}</h2>
      <p class="muted">${t('cloverNote')}</p>
      <form id="cloverForm" class="stack">
        <label>${t('merchantId')}<input name="merchantId" value="${esc(appState.clover?.merchantId || '')}"></label>
        <label>${t('cloverToken')}<input name="token" type="password" placeholder="${appState.clover?.hasToken ? t('tokenSaved') : t('tokenNotSet')}"></label>
        <button class="primary" type="submit">${t('save')}</button></form></div></section>` : ''}
    ${owner ? `<section class="section"><div class="card"><h2>${t('cloverByLocation')}</h2>
      <p class="muted">${t('cloverLocNote')}</p>
      <div class="list">${(appState.clover?.locations || []).map(cs => `<div class="item">
        <div class="row"><div><strong>${esc(cs.name)}</strong>
          <p class="muted">${cs.lastSyncAt ? `${t('lastSync')}: ${fmtDay(cs.lastSyncAt)} ${fmtTime(cs.lastSyncAt)}` : ''}</p></div>
          ${cs.connected ? `<span class="badge green">${t('connectedWord')} · ${esc(cs.merchantName)}</span>`
            : cs.hasCreds ? `<span class="badge gray">${t('notChecked')}${cs.usingGlobal ? ` · ${t('usingGlobal')}` : ''}</span>`
            : `<span class="badge gray">${t('notConnectedWord')}</span>`}</div>
        ${cs.lastError ? `<p class="hint" style="color:#c0392b">${esc(cs.lastError)}</p>` : ''}
        <details class="inline-edit"><summary>${t('change')}</summary><form data-clover-loc="${cs.locationId}" class="stack">
          <label>${t('merchantId')}<input name="merchantId" value="${esc(cs.merchantId)}"></label>
          <label>${t('cloverToken')}<input name="token" type="password" placeholder="${cs.hasToken ? t('tokenSaved') : t('tokenNotSet')}"></label>
          <button class="primary" type="submit">${t('save')}</button></form></details>
        <div class="row" style="margin-top:8px">
          <button class="secondary" type="button" data-clover-test="${cs.locationId}">${t('checkClover')}</button>
          <button class="secondary" type="button" data-clover-sync="${cs.locationId}">${t('syncClover')}</button>
          <button class="secondary" type="button" data-clover-publish="${cs.locationId}">${t('publishMenuClover')}</button>
        </div></div>`).join('')}</div></div></section>` : ''}
    <section class="section"><div class="card"><h2>${t('locations')}</h2><div class="list">
      ${appState.allLocations.map(l => `<div class="item"><div class="row"><div><strong>${esc(l.name)}</strong> <span class="badge ${l.status === 'active' ? 'green' : 'gray'}">${esc(l.status)}</span>
        <p class="muted">${esc(l.address)}</p></div><button class="secondary" type="button" data-open3d="${l.id}">🧊 ${t('view3d')}</button></div>
        ${mgr ? `<details class="inline-edit"><summary>${t('change')}</summary><form data-loc-edit="${l.id}" class="stack">
          <label>${t('name')}<input name="name" value="${esc(l.name)}"></label>
          <label>${t('address')}<input name="address" value="${esc(l.address)}"></label>
          <label>${t('status')}<select name="status"><option value="active" ${l.status === 'active' ? 'selected' : ''}>active</option><option value="opening" ${l.status === 'opening' ? 'selected' : ''}>opening</option><option value="closed" ${l.status === 'closed' ? 'selected' : ''}>closed</option></select></label>
          <button class="primary" type="submit">${t('save')}</button></form></details>` : ''}
      </div>`).join('')}
    </div>
    ${mgr ? `<form id="locForm" class="stack" style="margin-top:14px"><div class="form-grid">
      <label>${t('name')}<input name="name" required></label><label>${t('address')}<input name="address"></label>
      <label>${t('status')}<select name="status"><option value="active">active</option><option value="opening">opening</option></select></label></div>
      <button class="primary" type="submit">${t('addLocation')}</button></form>` : ''}
    </div></section>`;
  $('#myPassForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    const payload = {};
    if (d.password) payload.password = d.password;
    if (d.pin) payload.pin = d.pin;
    try { await api(`/api/employees/${appState.me.id}`, { method: 'PATCH', body: JSON.stringify(payload) }); toast(t('saved')); }
    catch (error) { toast(error.message); }
  });
  const companyForm = $('#companyForm');
  if (companyForm) companyForm.addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/company', { method: 'POST', body: JSON.stringify({ name: formObject(e.target).name }) }); await refresh(); }
    catch (error) { toast(error.message); }
  });
  const cloverForm = $('#cloverForm');
  if (cloverForm) cloverForm.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try { await api('/api/settings/clover', { method: 'POST', body: JSON.stringify({ merchantId: d.merchantId, token: d.token || undefined }) }); toast(t('saved')); await refresh(); }
    catch (error) { toast(error.message); }
  });
  $$('[data-clover-loc]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(form);
    try { await api(`/api/locations/${form.dataset.cloverLoc}/clover`, { method: 'POST', body: JSON.stringify({ merchantId: d.merchantId, token: d.token || undefined }) }); toast(t('saved')); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-clover-test]').forEach(btn => btn.addEventListener('click', async () => {
    try { const r = await api(`/api/locations/${btn.dataset.cloverTest}/clover/test`, { method: 'POST' }); toast(`${t('checkedOk')}: ${r.merchantName}`); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-clover-sync]').forEach(btn => btn.addEventListener('click', async () => {
    try { const r = await api(`/api/locations/${btn.dataset.cloverSync}/clover/sync`, { method: 'POST' }); toast(`${t('syncedOk')}: +${r.imported} · ↻${r.updated}`); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  $$('[data-clover-publish]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      const r = await api(`/api/locations/${btn.dataset.cloverPublish}/clover/publish-menu`, { method: 'POST' });
      toast(`${t('publishedOk')}: +${r.created} · ↻${r.updated}${r.errors?.length ? ` · ⚠️ ${r.errors.length}: ${r.errors[0].item}` : ''}`);
      await refresh();
    } catch (error) { toast(error.message); }
  }));
  $$('[data-loc-edit]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(form);
    try { await api(`/api/locations/${form.dataset.locEdit}`, { method: 'PATCH', body: JSON.stringify({ name: d.name, address: d.address, status: d.status }) }); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  const locForm = $('#locForm');
  if (locForm) locForm.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formObject(e.target);
    try { await api('/api/locations', { method: 'POST', body: JSON.stringify({ name: d.name, address: d.address, status: d.status }) }); await refresh(); }
    catch (error) { toast(error.message); }
  });
}

/* ---------------- 3D location view ---------------- */
function destroyScene3D() {
  sceneMountSeq += 1;
  if (sceneApi) { try { sceneApi.destroy(); } catch {} sceneApi = null; }
  sceneData = null;
  sceneSelectedKey = null;
}
function openScene3D(locationId) {
  if (currentTab !== 'scene3d') sceneReturnTab = currentTab;
  sceneLocId = locationId;
  currentTab = 'scene3d';
  renderNav();
  render();
}
function sceneRoleTitle(s) { return lang === 'en' ? (s.roleTitleEn || s.roleTitle || '') : (s.roleTitle || ''); }
function sceneStatusChip(s) {
  if (s.status === 'on') return `<span class="s3-st s3-st-on">${t('sceneStatusOn')}</span>`;
  if (s.status === 'called') return `<span class="s3-st s3-st-called">${esc(t('sceneCalledWord').toLowerCase())} · ${fmtTime(s.calledAt)}</span>`;
  return `<span class="s3-st s3-st-off">${t('sceneStatusOff')}</span>`;
}
function sceneStars(points) {
  const n = Math.max(1, Math.min(5, Math.round(points / 90)));
  let out = '';
  for (let i = 0; i < 5; i++) out += i < n ? '★' : '☆';
  return out;
}
function sceneInitials(name) { return String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }

async function renderScene3D(page) {
  destroyScene3D();
  const mountId = sceneMountSeq;
  const loc = (appState.allLocations || appState.locations).find(l => l.id === Number(sceneLocId));
  if (!loc) { page.innerHTML = `${pageHead(t('view3d'), '')}<p class="muted">${t('sceneNotFound')}</p>`; return; }
  page.innerHTML = `
    <div class="s3-head">
      <button class="secondary" type="button" id="s3back">${t('sceneBack')}</button>
      <div><h1 style="font-size:1.7rem;margin:0">${esc(loc.name)}</h1><p class="muted" style="margin:2px 0 0">${esc(loc.address)}</p></div>
      <div class="s3-chips" id="s3chips"></div>
    </div>
    <div class="s3-main">
      <div class="s3-stage" id="s3stage">
        <div id="s3gl"><div class="s3-gl-fail">${t('sceneLoading')}</div></div>
        <div class="s3-cams">
          <button type="button" data-s3cam="hall" class="active">${t('sceneCamHall')}</button>
          <button type="button" data-s3cam="top">${t('sceneCamTop')}</button>
          <button type="button" data-s3cam="kitchen">${t('sceneCamKitchen')}</button>
          <button type="button" data-s3cam="tables">${t('sceneCamTables')}</button>
        </div>
        <div class="s3-legend" id="s3legend"></div>
        <div class="s3-hint">${t('sceneHint')}</div>
        <div class="s3-emp hidden" id="s3emp"></div>
      </div>
      <aside class="s3-side">
        <h3>${t('sceneStaff')}</h3>
        <div class="sub">${t('sceneStaffHint')}</div>
        <div class="s3-list" id="s3list"></div>
        <p class="s3-demo-note hidden" id="s3demo">${t('sceneDemo')}</p>
      </aside>
    </div>`;
  $('#s3back').addEventListener('click', () => { currentTab = sceneReturnTab || 'home'; renderNav(); render(); });
  $$('[data-s3cam]', page).forEach(btn => btn.addEventListener('click', () => {
    $$('[data-s3cam]', page).forEach(b => b.classList.toggle('active', b === btn));
    if (sceneApi) sceneApi.setCam(btn.dataset.s3cam);
  }));
  let data;
  try {
    data = await api(`/api/locations/${loc.id}/scene`);
  } catch (error) {
    if (mountId === sceneMountSeq) { $('#s3gl').innerHTML = `<div class="s3-gl-fail">${esc(error.message)}</div>`; }
    return;
  }
  if (mountId !== sceneMountSeq || currentTab !== 'scene3d') return;
  sceneData = data;
  renderSceneSummary();
  renderSceneSidebar();
  renderSceneLegend();
  $('#s3demo').classList.toggle('hidden', !data.demo);
  const ok = await ensureThree();
  if (mountId !== sceneMountSeq || currentTab !== 'scene3d') return;
  const holder = $('#s3gl');
  if (!holder) return;
  holder.innerHTML = '';
  sceneApi = mountScene3D(holder, { lang, layout: loc.id === 3 ? 'fort-lauderdale' : 'generic', onPick: (key) => selectSceneStaff(key) });
  if (ok) sceneApi.setStaff(data.staff);
}

function renderSceneSummary() {
  const holder = $('#s3chips');
  if (!holder || !sceneData) return;
  const sm = sceneData.summary;
  let html = `<span class="s3-chip">${t('sceneOnShift')}: <b>${sm.on}</b></span>`;
  if (sm.called) html += `<span class="s3-chip">${t('sceneCalledWord')}: <b>${sm.called}</b></span>`;
  if (sm.hoursToday != null) html += `<span class="s3-chip">${t('sceneHoursToday')}: <b>${fmtHours(sm.hoursToday)}</b></span>`;
  if (sm.payToday != null) html += `<span class="s3-chip pay">${t('scenePayrollDay')}: <b>${money(sm.payToday)}</b></span>`;
  holder.innerHTML = html;
}
function renderSceneLegend() {
  const holder = $('#s3legend');
  if (!holder || !sceneData) return;
  const seen = {};
  let html = `<b>${t('sceneWhoIsWho')}</b><br>`;
  for (const s of sceneData.staff) {
    if (seen[s.role]) continue;
    seen[s.role] = 1;
    html += `<i style="background:${(SCENE_ROLE_META[s.role] || {}).shirt || '#888'}"></i>${esc(sceneRoleTitle(s))}<br>`;
  }
  holder.innerHTML = html;
}
function renderSceneSidebar() {
  const list = $('#s3list');
  if (!list || !sceneData) return;
  const rank = { on: 0, called: 1, off: 2 };
  const sorted = sceneData.staff.slice().sort((a, b) => rank[a.status] - rank[b.status]);
  list.innerHTML = sorted.map(s => {
    const meta = SCENE_ROLE_META[s.role] || SCENE_ROLE_META.helper;
    const dot = s.status === 'on' ? '#2FA84F' : (s.status === 'called' ? '#E3A008' : '#B9AF9C');
    const right = ('payToday' in s)
      ? `<div class="meta">${money(s.payToday)}<span>${t('today').toLowerCase()} · ${fmtHours(s.hoursToday)}</span></div>`
      : `<div class="meta">${fmtHours(s.hoursToday)}<span>${t('today').toLowerCase()}${s.rating ? ` · ★ ${s.rating.points}` : ''}</span></div>`;
    const call = (sceneData.canCall && s.status === 'off')
      ? `<button class="s3-call-mini" type="button" data-s3call="${esc(s.key)}">${t('sceneCall')}</button>` : '';
    return `<div class="s3-row${sceneSelectedKey === s.key ? ' sel' : ''}" data-s3row="${esc(s.key)}" role="button" tabindex="0">
      <div class="s3-ava" style="background:${meta.shirt}">${esc(sceneInitials(s.name))}<span class="dot" style="background:${dot}"></span></div>
      <div class="info"><b>${esc(s.name)}</b><span>${esc(sceneRoleTitle(s))}</span><div style="margin-top:3px">${sceneStatusChip(s)}</div></div>
      ${right}${call}</div>`;
  }).join('');
  $$('[data-s3row]', list).forEach(row => row.addEventListener('click', () => selectSceneStaff(row.dataset.s3row)));
  $$('[data-s3call]', list).forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); callSceneStaff(btn.dataset.s3call); }));
}
function selectSceneStaff(key) {
  sceneSelectedKey = key;
  renderSceneSidebar();
  renderSceneEmpCard();
  if (sceneApi) sceneApi.highlight(key);
}
function closeSceneCard() {
  sceneSelectedKey = null;
  renderSceneSidebar();
  renderSceneEmpCard();
  if (sceneApi) sceneApi.highlight(null);
}
function renderSceneEmpCard() {
  const card = $('#s3emp');
  if (!card || !sceneData) return;
  const s = sceneData.staff.find(x => x.key === sceneSelectedKey);
  if (!s) { card.classList.add('hidden'); card.innerHTML = ''; return; }
  const meta = SCENE_ROLE_META[s.role] || SCENE_ROLE_META.helper;
  let html = `<button class="close" type="button" id="s3empClose">✕</button>
    <div class="s3-emp-head"><div class="s3-ava" style="background:${meta.shirt}">${esc(sceneInitials(s.name))}</div>
    <div><b>${esc(s.name)}</b><span>${esc(sceneRoleTitle(s))} · ${esc(sceneData.location.name)}</span><br>${sceneStatusChip(s)}</div></div>
    <div class="s3-emp-grid">
      <div class="s3-cell"><b>${fmtHours(s.hoursToday)}</b><span>${t('sceneWorkedToday')}</span></div>
      <div class="s3-cell"><b>${fmtHours(s.hoursWeek)}</b><span>${t('sceneHoursWeek')}</span></div>`;
  if (s.rating) {
    html += `<div class="s3-cell"><b><span class="s3-stars">${sceneStars(s.rating.points)}</span></b><span>${t('sceneRating')}</span></div>
      <div class="s3-cell"><b>${s.rating.points} ${t('scenePoints')}</b><span>MyTeam</span></div>`;
  }
  html += `</div>`;
  if (s.rating) {
    html += `<p class="s3-rate-line">${t('sceneCleanWeeks')}: <b>${s.rating.cleanWeeks}</b> (+${s.rating.cleanWeeks * 10}) · ${t('sceneAwards')}: <b>${s.rating.awards}</b> (+${s.rating.awards * 25})</p>`;
  }
  if ('payToday' in s) {
    html += `<div class="s3-emp-grid">
      <div class="s3-cell"><b>${money(s.payToday)}</b><span>${t('sceneEarnedToday')}</span></div>
      <div class="s3-cell"><b>${money(s.payWeek)}</b><span>${t('sceneEarnedWeek')}</span></div></div>`;
    if (s.rate != null) html += `<p class="s3-rate-line">${t('sceneRate')}: <b>${money(s.rate)}${t('scenePerHour')}</b></p>`;
  } else {
    html += `<p class="s3-rate-line">${t('scenePayHidden')}</p>`;
  }
  if (sceneData.canCall) {
    if (s.status === 'on') html += `<button class="s3-call-btn" disabled>${t('sceneAlreadyOn')}</button>`;
    else if (s.status === 'called') html += `<button class="s3-call-btn" disabled>${t('sceneCalledBtn')} · ${fmtTime(s.calledAt)}</button><button class="s3-cancel-btn" type="button" id="s3cancel">${t('sceneCancelCall')}</button>`;
    else html += `<button class="s3-call-btn" type="button" id="s3call">${t('sceneCall')}</button>`;
  }
  card.innerHTML = html;
  card.classList.remove('hidden');
  $('#s3empClose').addEventListener('click', closeSceneCard);
  const callBtn = $('#s3call');
  if (callBtn) callBtn.addEventListener('click', () => callSceneStaff(s.key));
  const cancelBtn = $('#s3cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => cancelSceneCall(s.key));
}
function applySceneUpdate(scene, { spawnKey = null, removeKey = null } = {}) {
  sceneData = scene;
  renderSceneSummary();
  renderSceneSidebar();
  renderSceneLegend();
  renderSceneEmpCard();
  const demoNote = $('#s3demo');
  if (demoNote) demoNote.classList.toggle('hidden', !scene.demo);
  if (!sceneApi) return;
  if (removeKey) sceneApi.remove(removeKey);
  if (spawnKey) {
    const person = scene.staff.find(x => x.key === spawnKey);
    if (person) sceneApi.spawn(person);
  }
  if (sceneSelectedKey) sceneApi.highlight(sceneSelectedKey);
}
async function callSceneStaff(key) {
  try {
    const result = await api(`/api/locations/${sceneLocId}/calls`, { method: 'POST', body: JSON.stringify({ key }) });
    sceneSelectedKey = key;
    applySceneUpdate(result.scene, { spawnKey: key });
    toast(t('sceneCalledBtn'));
  } catch (error) { toast(error.message); }
}
async function cancelSceneCall(key) {
  try {
    const result = await api(`/api/locations/${sceneLocId}/calls/cancel`, { method: 'POST', body: JSON.stringify({ key }) });
    applySceneUpdate(result.scene, { removeKey: key });
  } catch (error) { toast(error.message); }
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-open3d]');
  if (!btn || !appState) return;
  openScene3D(Number(btn.dataset.open3d));
});

/* ---------------- Auth wiring & boot ---------------- */
$('#showLogin').addEventListener('click', () => { $('#showLogin').classList.add('active'); $('#showRegister').classList.remove('active'); $('#loginForm').classList.remove('hidden'); $('#regStep1Form').classList.add('hidden'); $('#regCodeForm').classList.add('hidden'); $('#regStep2Form').classList.add('hidden'); $('#resetStep1Form').classList.add('hidden'); $('#resetStep2Form').classList.add('hidden'); });
$('#showRegister').addEventListener('click', () => { $('#showRegister').classList.add('active'); $('#showLogin').classList.remove('active'); $('#regStep1Form').classList.remove('hidden'); $('#regCodeForm').classList.add('hidden'); $('#regStep2Form').classList.add('hidden'); $('#loginForm').classList.add('hidden'); $('#resetStep1Form').classList.add('hidden'); $('#resetStep2Form').classList.add('hidden'); });
$('#loginForm').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(formObject(e.target)) }); token = result.token; localStorage.setItem(tokenKey, token); await loadState(); } catch (error) { setAuthError(error.message); } });
let resetContact = '';
function showResetStep(step) { $('#loginForm').classList.add('hidden'); $('#regStep1Form').classList.add('hidden'); $('#regCodeForm').classList.add('hidden'); $('#regStep2Form').classList.add('hidden'); $('#resetStep1Form').classList.toggle('hidden', step !== 1); $('#resetStep2Form').classList.toggle('hidden', step !== 2); }
$('#forgotLink').addEventListener('click', () => { setAuthError(''); showResetStep(1); });
$('#resetBack1').addEventListener('click', () => { $('#showLogin').click(); });
$('#resetBack2').addEventListener('click', () => { $('#showLogin').click(); });
$('#resetStep1Form').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { const d = formObject(e.target); resetContact = d.contact; const result = await api('/api/auth/reset/request', { method: 'POST', body: JSON.stringify(d) }); $('#resetCodeHint').textContent = `Код отправлен (${result.sentTo || ''}). Действует 10 минут.`; showResetStep(2); } catch (error) { setAuthError(error.message); } });
$('#resetStep2Form').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { const d = formObject(e.target); const result = await api('/api/auth/reset/confirm', { method: 'POST', body: JSON.stringify({ contact: resetContact, code: d.code, password: d.password }) }); token = result.token; localStorage.setItem(tokenKey, token); await loadState(); } catch (error) { setAuthError(error.message); } });
$('#logoutButton').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} showAuth(); });

let regStep1Data = {};
let regPendingId = null;
function showRegStep(which) {
  $('#regStep1Form').classList.toggle('hidden', which !== 1);
  $('#regCodeForm').classList.toggle('hidden', which !== 'code');
  $('#regStep2Form').classList.toggle('hidden', which !== 2);
}
$('#regStep1Form').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); regStep1Data = formObject(e.target); try {
  const start = await api('/api/auth/register/start', { method: 'POST', body: JSON.stringify(regStep1Data) });
  if (start.verificationRequired) {
    regPendingId = start.pendingId;
    $('#regCodeHint').textContent = lang === 'en' ? `We sent a 6-digit code to ${start.email}. It is valid for 10 minutes.` : `Мы отправили 6-значный код на ${start.email}. Код действует 10 минут.`;
    showRegStep('code'); $('#regCodeForm [name="code"]').focus();
  } else {
    regPendingId = null;
    showRegStep(2); $('#regStep2Form [name="password"]').focus();
  }
} catch (error) { setAuthError(error.message); } });
$('#regCodeForm').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { await api('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ pendingId: regPendingId, code: formObject(e.target).code }) }); showRegStep(2); $('#regStep2Form [name="password"]').focus(); } catch (error) { setAuthError(error.message); } });
$('#regResend').addEventListener('click', async () => { setAuthError(''); try { await api('/api/auth/register/resend', { method: 'POST', body: JSON.stringify({ pendingId: regPendingId }) }); toast('✓'); } catch (error) { setAuthError(error.message); } });
$('#regCodeBack').addEventListener('click', () => showRegStep(1));
$('#regBack').addEventListener('click', () => showRegStep(1));
$('#regStep2Form').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { const pw = formObject(e.target); const payload = regPendingId ? { pendingId: regPendingId, password: pw.password } : { ...regStep1Data, ...pw }; const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }); token = result.token; localStorage.setItem(tokenKey, token); await loadState(); } catch (error) { setAuthError(error.message); } });

$('#langToggle').addEventListener('click', () => { lang = lang === 'ru' ? 'en' : 'ru'; localStorage.setItem(langKey, lang); applyI18n(); if (appState) { renderNav(); render(); } });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; });
$('#installButton').addEventListener('click', async () => { if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); deferredInstallPrompt = null; } });
$('.brand').addEventListener('click', e => { e.preventDefault(); if (appState) { currentTab = 'home'; renderNav(); render(); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

applyI18n();
loadBootstrap().catch(() => {});
if (token) loadState().catch(() => showAuth());
