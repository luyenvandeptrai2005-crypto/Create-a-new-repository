require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const PQueue = require('p-queue').default;
const express = require('express');

// ================= CONFIG =================
const CONFIG = {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    FB_COOKIE: process.env.FB_COOKIE,
    ADMIN_IDS: process.env.ADMIN_IDS
        ? process.env.ADMIN_IDS.split(',').map(id => id.trim())
        : [],
    CHECK_INTERVAL: 10000,
    MAX_FAIL: 3,
    REQUEST_TIMEOUT: 15000
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, {
    polling: true
});

const db = new sqlite3.Database('./fb_pro_monitor.db');

const queue = new PQueue({
    interval: CONFIG.CHECK_INTERVAL,
    intervalCap: 1
});

// ================= MENU =================
bot.setMyCommands([
    { command: 'addacc', description: 'Thêm UID mới' },
    { command: 'check', description: 'Kiểm tra UID' },
    { command: 'listacc', description: 'Danh sách UID' },
    { command: 'delacc', description: 'Xóa UID' },
    { command: 'setname', description: 'Đổi tên UID' },
    { command: 'setnote', description: 'Đổi ghi chú UID' },
    { command: 'info', description: 'Thông tin UID' },
    { command: 'status', description: 'Thống kê hệ thống' },
    { command: 'menu', description: 'Menu bot' }
]);

// ================= DATABASE =================
db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            uid TEXT PRIMARY KEY,
            chat_id TEXT,
            name TEXT,
            note TEXT,
            status TEXT DEFAULT 'LIVE',
            die_type TEXT DEFAULT '',
            fail_count INTEGER DEFAULT 0,
            live_count INTEGER DEFAULT 0,
            start_date TEXT,
            last_check TEXT,
            last_change TEXT,
            is_active INTEGER DEFAULT 1
        )
    `);

});

// ================= HELPERS =================
const formatTime = () => {
    return new Date().toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false
    });
};

const statusIcon = (status) => {
    return status === 'LIVE'
        ? '✅'
        : '❌';
};

const isAdmin = (chatId) => {

    if (CONFIG.ADMIN_IDS.length === 0) {
        return true;
    }

    return CONFIG.ADMIN_IDS.includes(String(chatId));
};

const safeSend = async (chatId, text, opts = {}) => {

    try {

        return await bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            ...opts
        });

    } catch (e) {

        console.log(e.message);

    }

};

const extractUID = (input) => {

    if (!input) return null;

    const clean = input.trim();

    const match = clean.match(/(\d{5,20})/);

    if (match) return match[1];

    return clean
        .replace(/https?:\/\/(www\.|m\.|mbasic\.)?facebook\.com\//, '')
        .replace(/\//g, '');

};

// ================= FACEBOOK CHECK =================
async function smartCheck(uid) {

    try {

        const urls = [
            `https://mbasic.facebook.com/${uid}`,
            `https://m.facebook.com/${uid}`
        ];

        let finalResult = {
            status: 'ERROR'
        };

        for (const url of urls) {

            try {

                const res = await axios.get(url, {
                    headers: {
                        cookie: CONFIG.FB_COOKIE || '',
                        'user-agent':
                            'Mozilla/5.0'
                    },
                    timeout: CONFIG.REQUEST_TIMEOUT,
                    maxRedirects: 0,
                    validateStatus: () => true
                });

                const html = String(res.data).toLowerCase();

                const location = res.headers.location || '';

                // LIVE
                if (
                    res.status === 200 &&
                    (
                        html.includes('profile') ||
                        html.includes('facebook') ||
                        html.includes('timeline')
                    )
                ) {

                    finalResult = {
                        status: 'LIVE'
                    };

                    break;

                }

                // CHECKPOINT
                if (
                    location.includes('checkpoint') ||
                    location.includes('recover') ||
                    location.includes('help')
                ) {

                    let type = 'Checkpoint';

                    if (location.includes('282')) {
                        type = '282';
                    }

                    if (location.includes('956')) {
                        type = '956';
                    }

                    finalResult = {
                        status: 'DIE',
                        dieType: type
                    };

                    break;

                }

                // DIE
                const dieKeywords = [
                    "nội dung này hiện không khả dụng",
                    "không tìm thấy nội dung",
                    "this content isn't available",
                    "content isn't available",
                    "page isn't available",
                    "trang này hiện không khả dụng"
                ];

                if (
                    dieKeywords.some(v => html.includes(v)) ||
                    res.status === 404
                ) {

                    finalResult = {
                        status: 'DIE',
                        dieType: '583'
                    };

                    break;

                }

            } catch (e) {}

        }

        return finalResult;

    } catch (e) {

        return {
            status: 'ERROR'
        };

    }

}

// ================= MENU =================
function sendMenu(chatId) {

    if (!isAdmin(chatId)) {
        return;
    }

    const text = `
📂 <b>FACEBOOK PRO MONITOR</b>

🔹 /addacc UID | Tên | Note
🔹 /check UID
🔹 /listacc
🔹 /delacc UID
🔹 /setname UID Tên_Mới
🔹 /setnote UID Note_Mới
🔹 /info UID
🔹 /status
`;

    safeSend(chatId, text);

}

bot.onText(/\/start|\/help|\/menu/, (msg) => {
    sendMenu(msg.chat.id);
});

// ================= ADD ACCOUNT =================
async function addAccount(chatId, uid, name, note) {

    const wait = await safeSend(
        chatId,
        `🔎 Đang check UID:\n<code>${uid}</code>`
    );

    const check = await smartCheck(uid);

    const now = formatTime();

    db.run(`
        INSERT OR REPLACE INTO accounts (
            uid,
            chat_id,
            name,
            note,
            status,
            die_type,
            start_date,
            last_check,
            last_change,
            is_active
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `,
    [
        uid,
        chatId,
        name,
        note,
        check.status,
        check.dieType || '',
        now,
        now,
        now
    ],
    async (err) => {

        bot.deleteMessage(chatId, wait.message_id)
            .catch(() => {});

        if (err) {
            return safeSend(chatId, '❌ Lỗi database');
        }

        let text = '';

        if (check.status === 'LIVE') {

            text =
`✅ <code>${uid}</code> đang LIVE

👤 Tài Khoản: ${name}
📝 Ghi Chú: ${note}
⏰ ${now}`;

        } else {

            text =
`❌ <code>${uid}</code> đã DIE

⚠️ Die Dạng: ${check.dieType || '583'}

👤 Tài Khoản: ${name}
📝 Ghi Chú: ${note}
⏰ ${now}`;

        }

        safeSend(chatId, text, {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🔄 Tiếp tục theo dõi',
                            callback_data: `continue_${uid}`
                        },
                        {
                            text: '🛑 Dừng theo dõi',
                            callback_data: `pause_${uid}`
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
        });

    });

}

// ================= CHECK =================
bot.onText(/\/check$/, (msg) => {

    const chatId = msg.chat.id;

    if (!isAdmin(chatId)) return;

    bot.sendMessage(
        chatId,
        '📩 Vui lòng nhập UID Hoặc URL:',
        {
            reply_markup: {
                force_reply: true
            }
        }
    );

});

bot.onText(/\/check(?:\s+(.+))/, async (msg, match) => {

    const chatId = msg.chat.id;

    if (!isAdmin(chatId)) return;

    const uid = extractUID(match[1]);

    if (!uid) {
        return safeSend(chatId, '❌ UID không hợp lệ');
    }

    processCheck(chatId, uid);

});

async function processCheck(chatId, uid) {

    const wait = await safeSend(
        chatId,
        `🔎 Đang kiểm tra:\n<code>${uid}</code>`
    );

    const res = await smartCheck(uid);

    bot.deleteMessage(chatId, wait.message_id)
        .catch(() => {});

    let text = '';

    if (res.status === 'LIVE') {

        text =
`✅ UID <code>${uid}</code> đang LIVE

⏰ ${formatTime()}`;

    } else {

        text =
`❌ UID <code>${uid}</code> đã DIE.

⚠️ Die Dạng: ${res.dieType}

📌 Bạn có muốn lưu UID này không?`;

    }

    safeSend(chatId, text, {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '✅ Lưu UID',
                        callback_data: `save_${uid}`
                    },
                    {
                        text: '❌ Bỏ qua',
                        callback_data: `ignore_${uid}`
                    }
                ],
                [
                    {
                        text: '🔄 Check lại',
                        callback_data: `recheck_${uid}`
                    }
                ]
            ]
        }
    });

}

// ================= MESSAGE HANDLER =================
bot.on('message', async (msg) => {

    const chatId = msg.chat.id;

    const text = msg.text;

    if (!text || !isAdmin(chatId)) return;

    if (text.startsWith('/')) return;

    // FORCE REPLY
    if (msg.reply_to_message) {

        // CHECK
        if (
            msg.reply_to_message.text.includes(
                'Vui lòng nhập UID Hoặc URL:'
            )
        ) {

            const uid = extractUID(text);

            if (!uid) {
                return safeSend(chatId, '❌ UID không hợp lệ');
            }

            return processCheck(chatId, uid);

        }

        // SAVE UID
        if (
            msg.reply_to_message.text.includes(
                'Lưu UID:'
            )
        ) {

            const uid = msg.reply_to_message.text
                .split('\n')[0]
                .replace('Lưu UID:', '')
                .trim();

            const parts = text
                .split('|')
                .map(v => v.trim());

            const name = parts[0] || 'Chưa đặt tên';

            const note = parts[1] || '🦦';

            return addAccount(
                chatId,
                uid,
                name,
                note
            );

        }

    }

});

// ================= BUTTONS =================
bot.on('callback_query', async (query) => {

    const chatId = query.message.chat.id;

    const msgId = query.message.message_id;

    const data = query.data;

    // SAVE
    if (data.startsWith('save_')) {

        const uid = data.replace('save_', '');

        await bot.answerCallbackQuery(query.id);

        return bot.sendMessage(
            chatId,
            `Lưu UID: ${uid}

Nhập theo dạng:
Tên | Ghi chú`,
            {
                reply_markup: {
                    force_reply: true
                }
            }
        );

    }

    // IGNORE
    if (data.startsWith('ignore_')) {

        await bot.answerCallbackQuery(query.id, {
            text: 'Đã bỏ qua'
        });

        return bot.deleteMessage(chatId, msgId)
            .catch(() => {});

    }

    // RECHECK
    if (data.startsWith('recheck_')) {

        const uid = data.replace('recheck_', '');

        await bot.answerCallbackQuery(query.id, {
            text: 'Đang check lại'
        });

        bot.deleteMessage(chatId, msgId)
            .catch(() => {});

        return processCheck(chatId, uid);

    }

    // CONTINUE
    if (data.startsWith('continue_')) {

        const uid = data.replace('continue_', '');

        db.run(
            `UPDATE accounts
             SET is_active = 1
             WHERE uid = ?`,
            [uid]
        );

        return bot.answerCallbackQuery(query.id, {
            text: '✅ Đã tiếp tục theo dõi',
            show_alert: true
        });

    }

    // PAUSE
    if (data.startsWith('pause_')) {

        const uid = data.replace('pause_', '');

        db.run(
            `UPDATE accounts
             SET is_active = 0
             WHERE uid = ?`,
            [uid]
        );

        return bot.answerCallbackQuery(query.id, {
            text: '🛑 Đã dừng theo dõi',
            show_alert: true
        });

    }

    // DELETE
    if (data.startsWith('delete_')) {

        const uid = data.replace('delete_', '');

        db.run(
            `DELETE FROM accounts
             WHERE uid = ?`,
            [uid]
        );

        await bot.answerCallbackQuery(query.id, {
            text: '🗑 Đã xóa UID',
            show_alert: true
        });

        return bot.deleteMessage(chatId, msgId)
            .catch(() => {});

    }

});

// ================= LIST =================
bot.onText(/\/listacc/, (msg) => {

    const chatId = msg.chat.id;

    db.all(
        `SELECT * FROM accounts
         ORDER BY last_check DESC`,
        [],
        (err, rows) => {

            if (!rows || rows.length === 0) {
                return safeSend(chatId, '📭 Chưa có UID');
            }

            let text = `📋 DANH SÁCH UID\n\n`;

            rows.forEach((r, i) => {

                const active =
                    r.is_active === 1
                        ? '▶️'
                        : '⏸';

                text +=
`${i + 1}. ${statusIcon(r.status)} <code>${r.uid}</code> ${active}
👤 ${r.name}
📝 ${r.note}
⏰ ${r.last_check}

`;

            });

            safeSend(chatId, text);

        }
    );

});

// ================= DELETE =================
bot.onText(/\/delacc(?:\s+(.+))?/, (msg, match) => {

    const chatId = msg.chat.id;

    if (!match[1]) {
        return safeSend(
            chatId,
            '❌ /delacc UID'
        );
    }

    const uid = extractUID(match[1]);

    db.run(
        `DELETE FROM accounts WHERE uid = ?`,
        [uid],
        function () {

            if (this.changes > 0) {

                safeSend(
                    chatId,
                    `🗑 Đã xóa:\n<code>${uid}</code>`
                );

            } else {

                safeSend(chatId, '❌ UID không tồn tại');

            }

        }
    );

});

// ================= STATUS =================
bot.onText(/\/status/, (msg) => {

    const chatId = msg.chat.id;

    db.all(`
        SELECT status, COUNT(*) as total
        FROM accounts
        GROUP BY status
    `,
    [],
    (err, rows) => {

        let live = 0;
        let die = 0;

        rows.forEach(r => {

            if (r.status === 'LIVE') {
                live = r.total;
            }

            if (r.status === 'DIE') {
                die = r.total;
            }

        });

        safeSend(
            chatId,
`📊 THỐNG KÊ

✅ LIVE: ${live}
❌ DIE: ${die}

⏰ ${formatTime()}`
        );

    });

});

// ================= AUTO MONITOR =================
let isCronRunning = false;

cron.schedule('*/1 * * * *', () => {

    if (queue.size > 0 || isCronRunning) {
        return;
    }

    isCronRunning = true;

    db.all(
        `SELECT * FROM accounts
         WHERE is_active = 1`,
        async (err, rows) => {

            if (!rows || rows.length === 0) {
                isCronRunning = false;
                return;
            }

            for (const row of rows) {

                queue.add(async () => {

                    const now = formatTime();

                    const result = await smartCheck(row.uid);

                    if (result.status === 'ERROR') {
                        return;
                    }

                    // LIVE -> DIE
                    if (
                        result.status === 'DIE' &&
                        row.status === 'LIVE'
                    ) {

                        const fail =
                            row.fail_count + 1;

                        if (fail >= CONFIG.MAX_FAIL) {

                            safeSend(
                                row.chat_id,
`🍂 <code>${row.uid}</code> đã DIE ❌

👤 Tài Khoản: ${row.name}
📝 Ghi Chú: ${row.note}

⏰ ${now}`,
{
    reply_markup: {
        inline_keyboard: [
            [
                {
                    text: '🔄 Tiếp tục theo dõi',
                    callback_data:
                        `continue_${row.uid}`
                },
                {
                    text: '🛑 Dừng theo dõi',
                    callback_data:
                        `pause_${row.uid}`
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

                            db.run(`
                                UPDATE accounts
                                SET
                                    status='DIE',
                                    die_type=?,
                                    fail_count=0,
                                    last_check=?,
                                    last_change=?
                                WHERE uid=?
                            `,
                            [
                                result.dieType,
                                now,
                                now,
                                row.uid
                            ]);

                        } else {

                            db.run(`
                                UPDATE accounts
                                SET
                                    fail_count=?,
                                    last_check=?
                                WHERE uid=?
                            `,
                            [
                                fail,
                                now,
                                row.uid
                            ]);

                        }

                    }

                    // DIE -> LIVE
                    else if (
                        result.status === 'LIVE' &&
                        row.status === 'DIE'
                    ) {

                        const liveCount =
                            row.live_count + 1;

                        if (liveCount >= 2) {

                            safeSend(
                                row.chat_id,
`🌿 FACEBOOK ĐÃ LIVE LẠI

<code>${row.uid}</code>

👤 ${row.name}
📝 ${row.note}

⏰ ${now}`
                            );

                            db.run(`
                                UPDATE accounts
                                SET
                                    status='LIVE',
                                    die_type='',
                                    live_count=0,
                                    last_check=?,
                                    last_change=?
                                WHERE uid=?
                            `,
                            [
                                now,
                                now,
                                row.uid
                            ]);

                        } else {

                            db.run(`
                                UPDATE accounts
                                SET
                                    live_count=?,
                                    last_check=?
                                WHERE uid=?
                            `,
                            [
                                liveCount,
                                now,
                                row.uid
                            ]);

                        }

                    }

                    else {

                        db.run(`
                            UPDATE accounts
                            SET
                                last_check=?,
                                fail_count=0,
                                live_count=0
                            WHERE uid=?
                        `,
                        [
                            now,
                            row.uid
                        ]);

                    }

                });

            }

            queue.onIdle().then(() => {
                isCronRunning = false;
            });

        }
    );

});

// ================= ADDACC =================
bot.onText(/\/addacc(?:\s+(.+))?/, async (msg, match) => {

    const chatId = msg.chat.id;

    if (!match[1]) {

        return safeSend(
            chatId,
            '/addacc UID | Tên | Note'
        );

    }

    const parts = match[1]
        .split('|')
        .map(v => v.trim());

    const uid = extractUID(parts[0]);

    if (!uid) {
        return safeSend(chatId, '❌ UID lỗi');
    }

    addAccount(
        chatId,
        uid,
        parts[1] || 'Chưa đặt tên',
        parts[2] || '🦦'
    );

});

// ================= INFO =================
bot.onText(/\/info(?:\s+(\d+))?/, (msg, match) => {

    const chatId = msg.chat.id;

    if (!match[1]) {
        return safeSend(chatId, '/info UID');
    }

    db.get(
        `SELECT * FROM accounts
         WHERE uid = ?`,
        [match[1]],
        (err, row) => {

            if (!row) {
                return safeSend(chatId, '❌ Không tồn tại');
            }

            const text =
`ℹ️ THÔNG TIN UID

🆔 <code>${row.uid}</code>

👤 ${row.name}
📝 ${row.note}

📌 ${row.status}

⏰ ${row.last_check}`;

            safeSend(chatId, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🔄 Tiếp tục theo dõi',
                                callback_data:
                                    `continue_${row.uid}`
                            },
                            {
                                text: '🛑 Dừng theo dõi',
                                callback_data:
                                    `pause_${row.uid}`
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
            });

        }
    );

});

// ================= SETNAME =================
bot.onText(
/\/setname(?:\s+(\d+)\s+(.+))?/,
(msg, match) => {

    const chatId = msg.chat.id;

    if (!match[1] || !match[2]) {

        return safeSend(
            chatId,
            '/setname UID Tên_Mới'
        );

    }

    db.run(
        `UPDATE accounts
         SET name = ?
         WHERE uid = ?`,
        [
            match[2],
            match[1]
        ],
        function () {

            if (this.changes > 0) {

                safeSend(
                    chatId,
                    '✅ Đã đổi tên'
                );

            } else {

                safeSend(
                    chatId,
                    '❌ UID không tồn tại'
                );

            }

        }
    );

});

// ================= SETNOTE =================
bot.onText(
/\/setnote(?:\s+(\d+)\s+(.+))?/,
(msg, match) => {

    const chatId = msg.chat.id;

    if (!match[1] || !match[2]) {

        return safeSend(
            chatId,
            '/setnote UID Note_Mới'
        );

    }

    db.run(
        `UPDATE accounts
         SET note = ?
         WHERE uid = ?`,
        [
            match[2],
            match[1]
        ],
        function () {

            if (this.changes > 0) {

                safeSend(
                    chatId,
                    '✅ Đã đổi ghi chú'
                );

            } else {

                safeSend(
                    chatId,
                    '❌ UID không tồn tại'
                );

            }

        }
    );

});

// ================= EXPRESS =================
const app = express();

app.get('/', (req, res) => {

    res.send('FB PRO MONITOR ACTIVE');

});

app.get('/status', (req, res) => {

    db.all(
        `SELECT * FROM accounts`,
        [],
        (err, rows) => {

            res.json({
                total: rows.length,
                data: rows
            });

        }
    );

});

app.listen(
    process.env.PORT || 3000,
    () => {

        console.log('✅ Server Running');

    }
);
