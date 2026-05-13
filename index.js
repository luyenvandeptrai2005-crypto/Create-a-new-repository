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
    CHECK_INTERVAL: 10000,
    MAX_FAIL: 3,
    REQUEST_TIMEOUT: 15000
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./fb_pro_monitor.db');
const queue = new PQueue({
    interval: CONFIG.CHECK_INTERVAL,
    intervalCap: 1
});

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
            last_change TEXT
        )
    `);

});

// ================= HELPERS =================
const formatTime = () => {
    return new Date().toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh'
    });
};

const extractUID = (input) => {

    if (!input) return null;

    const clean = input.trim();

    const match = clean.match(/(\d{5,20})/);

    if (match) return match[1];

    return clean
        .replace('https://facebook.com/', '')
        .replace('https://www.facebook.com/', '')
        .replace('https://m.facebook.com/', '')
        .replace(/\//g, '');

};

const safeSend = async (chatId, text) => {
    try {
        await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown'
        });
    } catch (e) {}
};

const statusIcon = (status) => {
    return status === 'LIVE' ? '✅' : '❌';
};

// ================= FACEBOOK CHECKER =================
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
                        'cookie': CONFIG.FB_COOKIE || '',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                        'accept-language': 'vi-VN,vi;q=0.9'
                    },
                    timeout: CONFIG.REQUEST_TIMEOUT,
                    maxRedirects: 0,
                    validateStatus: () => true
                });

                const html = String(res.data).toLowerCase();
                const location = res.headers.location || '';

                // ===== LIVE =====
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

                // ===== CHECKPOINT =====
                if (
                    location.includes('checkpoint') ||
                    location.includes('recover') ||
                    location.includes('help')
                ) {

                    let type = 'Checkpoint';

                    if (location.includes('282')) type = '282';
                    if (location.includes('956')) type = '956';

                    finalResult = {
                        status: 'DIE',
                        dieType: type
                    };

                    break;
                }

                // ===== DIE =====
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
                        dieType: '404 / 583'
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
const sendHelpMenu = (chatId) => {

    const menu = `
📂 *FACEBOOK PRO MONITOR*

━━━━━━━━━━━━━━━

🔵 *QUẢN LÝ FACEBOOK*

/addacc UID | Tên | Note
/check UID
/listacc
/delacc UID

━━━━━━━━━━━━━━━

🛠 *CHỈNH SỬA*

/setname UID | Tên mới
/setnote UID | Note mới

━━━━━━━━━━━━━━━

📊 *THỐNG KÊ*

/info UID
/status

━━━━━━━━━━━━━━━

⚡ *HỆ THỐNG*

/menu
/help
/start

━━━━━━━━━━━━━━━

💡 *Ví dụ*

\`/addacc 100012345678 | Nick Chính | Acc MMO\`
`;

    bot.sendMessage(chatId, menu, {
        parse_mode: 'Markdown'
    });

};

bot.onText(/\/start|\/help|\/menu/, (msg) => {
    sendHelpMenu(msg.chat.id);
});

// ================= ADD ACCOUNT =================
bot.onText(/\/addacc (.+)/, async (msg, match) => {

    const chatId = msg.chat.id;

    const parts = match[1]
        .split('|')
        .map(v => v.trim());

    const uid = extractUID(parts[0]);

    const name = parts[1] || 'Chưa đặt tên';

    const note = parts[2] || '🦦';

    if (!uid) {
        return safeSend(chatId, '❌ UID không hợp lệ.');
    }

    safeSend(chatId, `🔎 Đang check realtime UID: \`${uid}\``);

    const check = await smartCheck(uid);

    const now = formatTime();

    db.run(`
        INSERT OR REPLACE INTO accounts
        (
            uid,
            chat_id,
            name,
            note,
            status,
            start_date,
            last_check,
            last_change
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
        uid,
        chatId,
        name,
        note,
        check.status,
        now,
        now,
        now
    ],
    async (err) => {

        if (err) {
            return safeSend(chatId, '❌ Database Error.');
        }

        await safeSend(chatId,
`✅ *ĐÃ THÊM THEO DÕI*

🆔 UID: \`${uid}\`
👤 Tên: *${name}*
📝 Note: ${note}

📅 Theo dõi từ:
${now}

🌿 Trạng thái:
${check.status === 'LIVE' ? '✅ LIVE' : '❌ DIE'}
`
        );

    });

});

// ================= LIST =================
bot.onText(/\/listacc/, (msg) => {

    db.all(`
        SELECT * FROM accounts
        WHERE chat_id = ?
        ORDER BY last_check DESC
    `,
    [msg.chat.id],
    async (err, rows) => {

        if (!rows || rows.length === 0) {
            return safeSend(msg.chat.id, '📭 Chưa có UID nào.');
        }

        let text = `📋 *DANH SÁCH THEO DÕI*\n\n`;

        rows.forEach((r, i) => {

            text += `
${i + 1}. ${statusIcon(r.status)} \`${r.uid}\`
👤 ${r.name}
📝 ${r.note}
📅 ${r.start_date}
⏱ ${r.last_check}

`;

        });

        safeSend(msg.chat.id, text);

    });

});

// ================= CHECK =================
bot.onText(/\/check (.+)/, async (msg, match) => {

    const uid = extractUID(match[1]);

    if (!uid) {
        return safeSend(msg.chat.id, '❌ UID không hợp lệ.');
    }

    safeSend(msg.chat.id, `🔎 Đang kiểm tra realtime: \`${uid}\``);

    const res = await smartCheck(uid);

    let resultText = '';

    if (res.status === 'LIVE') {
        resultText = '✅ LIVE';
    } else if (res.status === 'DIE') {
        resultText = `❌ DIE (${res.dieType})`;
    } else {
        resultText = '⚠️ ERROR';
    }

    safeSend(msg.chat.id,
`📊 *KẾT QUẢ CHECK*

🆔 UID:
\`${uid}\`

🌿 Trạng thái:
${resultText}

⏰ ${formatTime()}
`
    );

});

// ================= DELETE =================
bot.onText(/\/delacc (.+)/, (msg, match) => {

    const uid = extractUID(match[1]);

    db.run(`
        DELETE FROM accounts
        WHERE uid = ?
    `,
    [uid],
    function(err) {

        if (this.changes > 0) {

            safeSend(msg.chat.id,
`🗑 Đã xóa UID:

\`${uid}\`
`
            );

        } else {

            safeSend(msg.chat.id, '❌ UID không tồn tại.');

        }

    });

});

// ================= SET NOTE =================
bot.onText(/\/setnote (.+)/, (msg, match) => {

    const parts = match[1]
        .split('|')
        .map(v => v.trim());

    const uid = extractUID(parts[0]);

    const note = parts[1];

    if (!uid || !note) {
        return safeSend(msg.chat.id,
            '❌ /setnote UID | Note mới');
    }

    db.run(`
        UPDATE accounts
        SET note = ?
        WHERE uid = ?
    `,
    [note, uid],
    function(err) {

        if (this.changes > 0) {

            safeSend(msg.chat.id,
`✅ Đã cập nhật note

🆔 \`${uid}\`
📝 ${note}
`
            );

        } else {

            safeSend(msg.chat.id, '❌ Không tìm thấy UID.');

        }

    });

});

// ================= SET NAME =================
bot.onText(/\/setname (.+)/, (msg, match) => {

    const parts = match[1]
        .split('|')
        .map(v => v.trim());

    const uid = extractUID(parts[0]);

    const name = parts[1];

    if (!uid || !name) {
        return safeSend(msg.chat.id,
            '❌ /setname UID | Tên mới');
    }

    db.run(`
        UPDATE accounts
        SET name = ?
        WHERE uid = ?
    `,
    [name, uid],
    function(err) {

        if (this.changes > 0) {

            safeSend(msg.chat.id,
`✅ Đã cập nhật tên

🆔 \`${uid}\`
👤 ${name}
`
            );

        } else {

            safeSend(msg.chat.id, '❌ Không tìm thấy UID.');

        }

    });

});

// ================= INFO =================
bot.onText(/\/info (.+)/, (msg, match) => {

    const uid = extractUID(match[1]);

    db.get(`
        SELECT * FROM accounts
        WHERE uid = ?
    `,
    [uid],
    async (err, row) => {

        if (!row) {
            return safeSend(msg.chat.id, '❌ Không tìm thấy UID.');
        }

        safeSend(msg.chat.id,
`📊 *THÔNG TIN UID*

🆔 UID:
\`${row.uid}\`

👤 Tên:
${row.name}

📝 Note:
${row.note}

🌿 Trạng thái:
${statusIcon(row.status)} ${row.status}

⚠️ Dạng DIE:
${row.die_type || 'Không có'}

📅 Theo dõi:
${row.start_date}

⏱ Check cuối:
${row.last_check}

🔄 Đổi trạng thái:
${row.last_change}
`
        );

    });

});

// ================= STATUS =================
bot.onText(/\/status/, (msg) => {

    db.all(`
        SELECT status, COUNT(*) as total
        FROM accounts
        GROUP BY status
    `,
    [],
    async (err, rows) => {

        let live = 0;
        let die = 0;

        rows.forEach(r => {

            if (r.status === 'LIVE') live = r.total;
            if (r.status === 'DIE') die = r.total;

        });

        safeSend(msg.chat.id,
`📊 *THỐNG KÊ HỆ THỐNG*

✅ LIVE: ${live}
❌ DIE: ${die}

⏰ ${formatTime()}
`
        );

    });

});

// ================= AUTO MONITOR =================
cron.schedule('*/1 * * * * *', () => {

    db.all(`
        SELECT * FROM accounts
    `,
    async (err, rows) => {

        if (!rows) return;

        for (const row of rows) {

            await queue.add(async () => {

                const now = formatTime();

                const result = await smartCheck(row.uid);

                if (result.status === 'ERROR') return;

                // ===== LIVE -> DIE =====
                if (
                    result.status === 'DIE' &&
                    row.status === 'LIVE'
                ) {

                    const fail = row.fail_count + 1;

                    if (fail >= CONFIG.MAX_FAIL) {

                        await safeSend(row.chat_id,
`🍂 *FACEBOOK ĐÃ DIE*

🆔 UID:
\`${row.uid}\`

👤 ${row.name}

📝 ${row.note}

⚠️ Dạng:
${result.dieType}

📅 Theo dõi:
${row.start_date}

⏰ ${now}
`
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

                // ===== DIE -> LIVE =====
                else if (
                    result.status === 'LIVE' &&
                    row.status === 'DIE'
                ) {

                    const liveCount = row.live_count + 1;

                    if (liveCount >= 2) {

                        await safeSend(row.chat_id,
`🌿 *FACEBOOK ĐÃ LIVE LẠI*

🆔 UID:
\`${row.uid}\`

👤 ${row.name}

⏰ ${now}
`
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

                // ===== SAME STATUS =====
                else {

                    db.run(`
                        UPDATE accounts
                        SET
                            last_check=?,
                            fail_count=0
                        WHERE uid=?
                    `,
                    [
                        now,
                        row.uid
                    ]);

                }

            });

        }

    });

});

// ================= EXPRESS =================
const app = express();

app.get('/', (req, res) => {

    res.send(`
        <h2>Facebook Pro Monitor Running</h2>
        <p>Status: ONLINE</p>
    `);

});

app.get('/status', (req, res) => {

    db.all(`
        SELECT * FROM accounts
    `,
    [],
    (err, rows) => {

        res.json({
            total: rows.length,
            data: rows
        });

    });

});

app.listen(process.env.PORT || 3000, () => {

    console.log('Server Running');

});

console.log('================================');
console.log(' FACEBOOK PRO MONITOR ONLINE ');
console.log('================================');
