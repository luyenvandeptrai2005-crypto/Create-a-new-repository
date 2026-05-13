require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const PQueue = require('p-queue').default;

// ================= CONFIG =================

const CONFIG = {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    FB_COOKIE: process.env.FB_COOKIE,
    FB_TOKEN: process.env.FB_TOKEN,
    ADMIN_ID: Number(process.env.ADMIN_ID),

    CHECK_INTERVAL: 15000,
    RETRY_COUNT: 3
};

if (
    !CONFIG.BOT_TOKEN ||
    !CONFIG.FB_COOKIE ||
    !CONFIG.FB_TOKEN
) {
    console.log('❌ THIẾU FILE .env');
    process.exit();
}

// ================= INIT =================

const bot = new TelegramBot(CONFIG.BOT_TOKEN, {
    polling: true
});

const db = new sqlite3.Database('./uid_monitor.db');

const queue = new PQueue({
    interval: CONFIG.CHECK_INTERVAL,
    intervalCap: 1
});

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Mozilla/5.0 (Linux; Android 13)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
];

// ================= DATABASE =================

db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            uid TEXT PRIMARY KEY,
            chat_id TEXT,
            status TEXT DEFAULT 'LIVE',
            fail_count INTEGER DEFAULT 0,
            created_at TEXT,
            last_check TEXT,
            die_time TEXT,
            live_back_time TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            chat_id TEXT PRIMARY KEY,
            joined_at TEXT
        )
    `);
});

// ================= FUNCTIONS =================

function getRandomUA() {
    return USER_AGENTS[
        Math.floor(Math.random() * USER_AGENTS.length)
    ];
}

function getTrackingDays(createdAt) {

    const start = new Date(createdAt);
    const now = new Date();

    const diff = now - start;

    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function formatTime() {

    return new Date().toLocaleString('vi-VN');
}

function extractUID(input) {

    const text = input.trim();

    if (/^\d+$/.test(text)) return text;

    const match = text.match(/(\d{5,20})/);

    if (match) return match[1];

    return text;
}

// ================= SMART CHECK =================

async function smartCheck(uid) {

    let liveScore = 0;
    let dieScore = 0;

    for (let retry = 0; retry < CONFIG.RETRY_COUNT; retry++) {

        try {

            // ===== GRAPH API =====

            try {

                const api = await axios.get(
                    `https://graph.facebook.com/${uid}`,
                    {
                        params: {
                            access_token: CONFIG.FB_TOKEN,
                            fields: 'id,name'
                        },
                        timeout: 8000
                    }
                );

                if (api.data?.id) {
                    liveScore += 2;
                }

            } catch (e) {

                const code = e.response?.data?.error?.code;

                if (code === 803 || code === 100) {
                    dieScore += 2;
                }
            }

            // ===== MBASIC =====

            const res = await axios.get(
                `https://mbasic.facebook.com/${uid}`,
                {
                    headers: {
                        cookie: CONFIG.FB_COOKIE,
                        'user-agent': getRandomUA(),
                        'accept-language': 'vi-VN,vi;q=0.9'
                    },
                    timeout: 12000,
                    maxRedirects: 0,
                    validateStatus: () => true
                }
            );

            const location = res.headers.location || '';

            // ===== COOKIE DIE =====

            if (
                location.includes('checkpoint') ||
                location.includes('login') ||
                location.includes('recover')
            ) {

                return {
                    status: 'COOKIE_DIE'
                };
            }

            const html = String(res.data).toLowerCase();

            // ===== RATE LIMIT =====

            const limitKeywords = [
                'temporarily blocked',
                'rate limit',
                'action blocked',
                'slow down'
            ];

            if (limitKeywords.some(v => html.includes(v))) {

                await new Promise(r =>
                    setTimeout(r, 5000)
                );

                continue;
            }

            // ===== DIE KEYWORDS =====

            const dieKeywords = [
                "this content isn't available",
                'nội dung này hiện không khả dụng',
                'không tìm thấy nội dung',
                'this page is not available',
                'liên kết bạn đã theo dõi có thể bị hỏng'
            ];

            if (dieKeywords.some(v => html.includes(v))) {
                dieScore += 3;
            } else {
                liveScore += 2;
            }

            // ===== LIVE KEYWORDS =====

            const liveKeywords = [
                'timeline',
                'cover photo',
                'profile.php',
                'message',
                'add friend'
            ];

            if (liveKeywords.some(v => html.includes(v))) {
                liveScore += 3;
            }

            // ===== RESULT =====

            if (dieScore >= 4 && dieScore > liveScore) {

                return {
                    status: 'DIE'
                };
            }

            return {
                status: 'LIVE'
            };

        } catch (e) {

            if (retry === CONFIG.RETRY_COUNT - 1) {

                return {
                    status: 'ERROR'
                };
            }

            await new Promise(r =>
                setTimeout(r, 4000)
            );
        }
    }
}

// ================= START =================

bot.onText(/\/start/, (msg) => {

    db.run(
        `INSERT OR IGNORE INTO users VALUES (?, ?)`,
        [
            msg.chat.id,
            new Date().toISOString()
        ]
    );

    bot.sendMessage(
        msg.chat.id,
`🔥 FACEBOOK UID MONITOR BOT

✅ Theo dõi LIVE/DIE realtime
✅ Chống báo ảo
✅ Detect LIVE trở lại
✅ Theo dõi số ngày

📥 Gửi UID hoặc link Facebook để theo dõi.`
    );
});

// ================= ADD UID =================

bot.on('message', async (msg) => {

    if (!msg.text) return;

    if (msg.text.startsWith('/')) return;

    const uid = extractUID(msg.text);

    db.get(
        `SELECT * FROM accounts WHERE uid=?`,
        [uid],
        (err, row) => {

            if (row) {

                bot.sendMessage(
                    msg.chat.id,
                    '⚠️ UID đã tồn tại.'
                );

                return;
            }

            db.run(
                `INSERT INTO accounts (
                    uid,
                    chat_id,
                    status,
                    created_at,
                    last_check
                ) VALUES (?, ?, 'LIVE', ?, ?)`,
                [
                    uid,
                    msg.chat.id,
                    new Date().toISOString(),
                    new Date().toISOString()
                ]
            );

            bot.sendMessage(
                msg.chat.id,
`✅ ĐÃ THÊM UID

🆔 UID: ${uid}
🕒 Bắt đầu: ${formatTime()}
🔥 Trạng thái: MONITORING`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🔄 Check ngay',
                                    callback_data: `check_${uid}`
                                }
                            ],
                            [
                                {
                                    text: '❌ Xóa UID',
                                    callback_data: `delete_${uid}`
                                }
                            ]
                        ]
                    }
                }
            );
        }
    );
});

// ================= CALLBACK =================

bot.on('callback_query', async (query) => {

    const data = query.data;
    const chatId = query.message.chat.id;

    // ===== CHECK NOW =====

    if (data.startsWith('check_')) {

        const uid = data.replace('check_', '');

        bot.sendMessage(chatId, '⏳ ĐANG KIỂM TRA...');

        const result = await smartCheck(uid);

        if (result.status === 'LIVE') {

            bot.sendMessage(
                chatId,
`🟢 UID LIVE

🆔 UID: ${uid}
🕒 ${formatTime()}
🔥 Tài khoản đang hoạt động`
            );

        } else if (result.status === 'DIE') {

            bot.sendMessage(
                chatId,
`❌ UID DIE

🆔 UID: ${uid}
🕒 ${formatTime()}`
            );

        } else {

            bot.sendMessage(
                chatId,
                '⚠️ COOKIE FACEBOOK DIE'
            );
        }
    }

    // ===== DELETE =====

    if (data.startsWith('delete_')) {

        const uid = data.replace('delete_', '');

        db.run(
            `DELETE FROM accounts WHERE uid=?`,
            [uid]
        );

        bot.sendMessage(
            chatId,
            `🗑 ĐÃ XÓA UID ${uid}`
        );
    }
});

// ================= AUTO CHECK =================

cron.schedule('*/1 * * * *', async () => {

    db.all(
        `SELECT * FROM accounts`,
        async (err, rows) => {

            if (!rows) return;

            for (const row of rows) {

                await queue.add(async () => {

                    const result = await smartCheck(row.uid);

                    // ===== COOKIE DIE =====

                    if (result.status === 'COOKIE_DIE') {

                        bot.sendMessage(
                            row.chat_id,
                            '⚠️ COOKIE FACEBOOK ĐÃ DIE'
                        );

                        return;
                    }

                    // ===== ERROR =====

                    if (result.status === 'ERROR') {
                        return;
                    }

                    // ===== UID DIE =====

                    if (
                        result.status === 'DIE' &&
                        row.status === 'LIVE'
                    ) {

                        const failCount =
                            row.fail_count + 1;

                        // anti báo ảo

                        if (failCount >= 3) {

                            const trackingDays =
                                getTrackingDays(
                                    row.created_at
                                );

                            bot.sendMessage(
                                row.chat_id,
`❌ UID ĐÃ DIE

🆔 UID: ${row.uid}
📅 Theo dõi: ${trackingDays} ngày
🕒 DIE lúc: ${formatTime()}
🔥 Trạng thái: DIE`,
                                {
                                    reply_markup: {
                                        inline_keyboard: [
                                            [
                                                {
                                                    text: '🔄 Theo dõi tiếp',
                                                    callback_data:
                                                        `check_${row.uid}`
                                                }
                                            ],
                                            [
                                                {
                                                    text: '❌ Xóa UID',
                                                    callback_data:
                                                        `delete_${row.uid}`
                                                }
                                            ]
                                        ]
                                    }
                                }
                            );

                            db.run(
                                `UPDATE accounts
                                 SET status='DIE',
                                 fail_count=0,
                                 die_time=?,
                                 last_check=?
                                 WHERE uid=?`,
                                [
                                    new Date().toISOString(),
                                    new Date().toISOString(),
                                    row.uid
                                ]
                            );

                        } else {

                            db.run(
                                `UPDATE accounts
                                 SET fail_count=?
                                 WHERE uid=?`,
                                [
                                    failCount,
                                    row.uid
                                ]
                            );
                        }

                        return;
                    }

                    // ===== UID LIVE LẠI =====

                    if (
                        result.status === 'LIVE' &&
                        row.status === 'DIE'
                    ) {

                        const trackingDays =
                            getTrackingDays(
                                row.created_at
                            );

                        bot.sendMessage(
                            row.chat_id,
`🟢 UID LIVE TRỞ LẠI

🆔 UID: ${row.uid}
📅 Theo dõi: ${trackingDays} ngày
🕒 LIVE lúc: ${formatTime()}
🔥 Tài khoản đã hoạt động lại`,
                            {
                                reply_markup: {
                                    inline_keyboard: [
                                        [
                                            {
                                                text: '🔄 Check ngay',
                                                callback_data:
                                                    `check_${row.uid}`
                                            }
                                        ],
                                        [
                                            {
                                                text: '❌ Xóa UID',
                                                callback_data:
                                                    `delete_${row.uid}`
                                            }
                                        ]
                                    ]
                                }
                            }
                        );

                        db.run(
                            `UPDATE accounts
                             SET status='LIVE',
                             fail_count=0,
                             live_back_time=?,
                             last_check=?
                             WHERE uid=?`,
                            [
                                new Date().toISOString(),
                                new Date().toISOString(),
                                row.uid
                            ]
                        );

                        return;
                    }

                    // ===== UPDATE LIVE =====

                    if (result.status === 'LIVE') {

                        db.run(
                            `UPDATE accounts
                             SET status='LIVE',
                             fail_count=0,
                             last_check=?
                             WHERE uid=?`,
                            [
                                new Date().toISOString(),
                                row.uid
                            ]
                        );
                    }
                });
            }
        }
    );
});

console.log('🔥 UID MONITOR BOT ONLINE');