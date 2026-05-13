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

// ================= CÀI ĐẶT MENU TELEGRAM =================
// Hàm này sẽ tạo nút "Menu" màu xanh ở góc trái ô nhập tin nhắn Telegram
bot.setMyCommands([
    { command: 'addacc', description: 'Thêm và theo dõi UID mới' },
    { command: 'check', description: 'Kiểm tra trạng thái UID' },
    { command: 'listacc', description: 'Xem danh sách đang theo dõi' },
    { command: 'delacc', description: 'Xóa UID khỏi hệ thống' },
    { command: 'setname', description: 'Đổi tên cho UID' },
    { command: 'setnote', description: 'Cập nhật ghi chú cho UID' },
    { command: 'info', description: 'Xem chi tiết một UID' },
    { command: 'status', description: 'Xem thống kê tổng quan' },
    { command: 'menu', description: 'Hiển thị bảng hướng dẫn' }
]).then(() => console.log('✅ Đã nạp Menu UI cho Telegram')).catch(console.error);

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
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(`[Telegram Error] Cannot send message to ${chatId}:`, e.message);
    }
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

        let finalResult = { status: 'ERROR' };

        for (const url of urls) {
            try {
                const res = await axios.get(url, {
                    headers: {
                        'cookie': CONFIG.FB_COOKIE || '',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                        'sec-fetch-site': 'none',
                        'sec-fetch-mode': 'navigate'
                    },
                    timeout: CONFIG.REQUEST_TIMEOUT,
                    maxRedirects: 0,
                    validateStatus: () => true
                });

                const html = String(res.data).toLowerCase();
                const location = res.headers.location || '';

                // ===== LIVE =====
                if (res.status === 200 && (html.includes('profile') || html.includes('facebook') || html.includes('timeline'))) {
                    finalResult = { status: 'LIVE' };
                    break;
                }

                // ===== CHECKPOINT =====
                if (location.includes('checkpoint') || location.includes('recover') || location.includes('help')) {
                    let type = 'Checkpoint';
                    if (location.includes('282')) type = '282';
                    if (location.includes('956')) type = '956';
                    finalResult = { status: 'DIE', dieType: type };
                    break;
                }

                // ===== DIE =====
                const dieKeywords = [
                    "nội dung này hiện không khả dụng", "không tìm thấy nội dung",
                    "this content isn't available", "content isn't available",
                    "page isn't available", "trang này hiện không khả dụng"
                ];

                if (dieKeywords.some(v => html.includes(v)) || res.status === 404) {
                    finalResult = { status: 'DIE', dieType: '404 / 583' };
                    break;
                }

            } catch (e) {
                console.error(`[Axios Error for ${uid}]:`, e.message);
            }
        }
        return finalResult;
    } catch (e) {
        return { status: 'ERROR' };
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
💡 *Ví dụ:* \`/addacc 100012345678 | Nick Chính | Acc MMO\`
`;
    bot.sendMessage(chatId, menu, { parse_mode: 'Markdown' });
};

bot.onText(/\/start|\/help|\/menu/, (msg) => sendHelpMenu(msg.chat.id));

// ================= ADD ACCOUNT =================
bot.onText(/\/addacc (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].split('|').map(v => v.trim());
    const uid = extractUID(parts[0]);
    const name = parts[1] || 'Chưa đặt tên';
    const note = parts[2] || '🦦';

    if (!uid) return safeSend(chatId, '❌ UID không hợp lệ.');
    
    safeSend(chatId, `🔎 Đang check realtime UID: \`${uid}\``);
    const check = await smartCheck(uid);
    const now = formatTime();

    db.run(`
        INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, start_date, last_check, last_change)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [uid, chatId, name, note, check.status, now, now, now], 
    async (err) => {
        if (err) return safeSend(chatId, '❌ Lỗi Database.');
        await safeSend(chatId, `✅ *ĐÃ THÊM THEO DÕI*\n🆔 UID: \`${uid}\`\n👤 Tên: *${name}*\n📝 Note: ${note}\n📅 Theo dõi từ: ${now}\n🌿 Trạng thái: ${check.status === 'LIVE' ? '✅ LIVE' : '❌ DIE'}`);
    });
});

// ================= LIST =================
bot.onText(/\/listacc/, (msg) => {
    db.all(`SELECT * FROM accounts WHERE chat_id = ? ORDER BY last_check DESC`, [msg.chat.id], async (err, rows) => {
        if (!rows || rows.length === 0) return safeSend(msg.chat.id, '📭 Chưa có UID nào.');
        let text = `📋 *DANH SÁCH THEO DÕI*\n\n`;
        rows.forEach((r, i) => {
            text += `${i + 1}. ${statusIcon(r.status)} \`${r.uid}\`\n👤 ${r.name}\n📝 ${r.note}\n⏱ Check cuối: ${r.last_check}\n\n`;
        });
        safeSend(msg.chat.id, text);
    });
});

// ================= CHECK =================
bot.onText(/\/check (.+)/, async (msg, match) => {
    const uid = extractUID(match[1]);
    if (!uid) return safeSend(msg.chat.id, '❌ UID không hợp lệ.');

    safeSend(msg.chat.id, `🔎 Đang kiểm tra realtime: \`${uid}\``);
    const res = await smartCheck(uid);
    let resultText = res.status === 'LIVE' ? '✅ LIVE' : (res.status === 'DIE' ? `❌ DIE (${res.dieType})` : '⚠️ ERROR');
    
    safeSend(msg.chat.id, `📊 *KẾT QUẢ CHECK*\n🆔 UID: \`${uid}\`\n🌿 Trạng thái: ${resultText}\n⏰ ${formatTime()}`);
});

// ================= DELETE =================
bot.onText(/\/delacc (.+)/, (msg, match) => {
    const uid = extractUID(match[1]);
    db.run(`DELETE FROM accounts WHERE uid = ?`, [uid], function(err) {
        if (this.changes > 0) safeSend(msg.chat.id, `🗑 Đã xóa UID: \`${uid}\``);
        else safeSend(msg.chat.id, '❌ UID không tồn tại.');
    });
});

// ================= SET NOTE =================
bot.onText(/\/setnote (.+)/, (msg, match) => {
    const parts = match[1].split('|').map(v => v.trim());
    if (parts.length < 2) return safeSend(msg.chat.id, '❌ Dùng lệnh: /setnote UID | Note mới');
    
    const uid = extractUID(parts[0]);
    db.run(`UPDATE accounts SET note = ? WHERE uid = ?`, [parts[1], uid], function(err) {
        if (this.changes > 0) safeSend(msg.chat.id, `✅ Đã cập nhật note\n🆔 \`${uid}\`\n📝 ${parts[1]}`);
        else safeSend(msg.chat.id, '❌ Không tìm thấy UID.');
    });
});

// ================= SET NAME =================
bot.onText(/\/setname (.+)/, (msg, match) => {
    const parts = match[1].split('|').map(v => v.trim());
    if (parts.length < 2) return safeSend(msg.chat.id, '❌ Dùng lệnh: /setname UID | Tên mới');

    const uid = extractUID(parts[0]);
    db.run(`UPDATE accounts SET name = ? WHERE uid = ?`, [parts[1], uid], function(err) {
        if (this.changes > 0) safeSend(msg.chat.id, `✅ Đã cập nhật tên\n🆔 \`${uid}\`\n👤 ${parts[1]}`);
        else safeSend(msg.chat.id, '❌ Không tìm thấy UID.');
    });
});

// ================= INFO =================
bot.onText(/\/info (.+)/, (msg, match) => {
    const uid = extractUID(match[1]);
    db.get(`SELECT * FROM accounts WHERE uid = ?`, [uid], async (err, row) => {
        if (!row) return safeSend(msg.chat.id, '❌ Không tìm thấy UID.');
        safeSend(msg.chat.id, `📊 *THÔNG TIN UID*\n🆔 UID: \`${row.uid}\`\n👤 Tên: ${row.name}\n📝 Note: ${row.note}\n🌿 Trạng thái: ${statusIcon(row.status)} ${row.status}\n⚠️ Dạng DIE: ${row.die_type || 'Không'}\n📅 Theo dõi: ${row.start_date}\n⏱ Check cuối: ${row.last_check}\n🔄 Đổi trạng thái: ${row.last_change}`);
    });
});

// ================= STATUS =================
bot.onText(/\/status/, (msg) => {
    db.all(`SELECT status, COUNT(*) as total FROM accounts GROUP BY status`, [], async (err, rows) => {
        let live = 0, die = 0;
        rows.forEach(r => {
            if (r.status === 'LIVE') live = r.total;
            if (r.status === 'DIE') die = r.total;
        });
        safeSend(msg.chat.id, `📊 *THỐNG KÊ HỆ THỐNG*\n✅ LIVE: ${live}\n❌ DIE: ${die}\n⏰ ${formatTime()}`);
    });
});

// ================= AUTO MONITOR =================
cron.schedule('*/1 * * * *', () => {
    db.all(`SELECT * FROM accounts`, async (err, rows) => {
        if (!rows) return;
        
        for (const row of rows) {
            await queue.add(async () => {
                const now = formatTime();
                const result = await smartCheck(row.uid);

                if (result.status === 'ERROR') return;

                // ===== LIVE -> DIE =====
                if (result.status === 'DIE' && row.status === 'LIVE') {
                    const fail = row.fail_count + 1;
                    if (fail >= CONFIG.MAX_FAIL) {
                        await safeSend(row.chat_id, `🍂 *FACEBOOK ĐÃ DIE*\n🆔 UID: \`${row.uid}\`\n👤 ${row.name}\n📝 ${row.note}\n⚠️ Dạng: ${result.dieType}\n📅 Theo dõi: ${row.start_date}\n⏰ ${now}`);
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0, last_check=?, last_change=? WHERE uid=?`, [result.dieType, now, now, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET fail_count=?, last_check=? WHERE uid=?`, [fail, now, row.uid]);
                    }
                } 
                // ===== DIE -> LIVE =====
                else if (result.status === 'LIVE' && row.status === 'DIE') {
                    const liveCount = row.live_count + 1;
                    if (liveCount >= 2) {
                        await safeSend(row.chat_id, `🌿 *FACEBOOK ĐÃ LIVE LẠI*\n🆔 UID: \`${row.uid}\`\n👤 ${row.name}\n⏰ ${now}`);
                        db.run(`UPDATE accounts SET status='LIVE', die_type='', live_count=0, last_check=?, last_change=? WHERE uid=?`, [now, now, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET live_count=?, last_check=? WHERE uid=?`, [liveCount, now, row.uid]);
                    }
                } 
                // ===== SAME STATUS =====
                else {
                    db.run(`UPDATE accounts SET last_check=?, fail_count=0, live_count=0 WHERE uid=?`, [now, row.uid]);
                }
            });
        }
    });
});

// ================= EXPRESS =================
const app = express();
app.get('/', (req, res) => res.send(`<h2>FB Pro Monitor Active</h2>`));
app.get('/status', (req, res) => {
    db.all(`SELECT * FROM accounts`, [], (err, rows) => res.json({ total: rows.length, data: rows }));
});
app.listen(process.env.PORT || 3000, () => console.log('✅ Server Running'));
