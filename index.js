require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const PQueue = require('p-queue').default;
const express = require('express');

// ================= CONFIG & OPTIMIZATION =================
const CONFIG = {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    FB_COOKIE: process.env.FB_COOKIE,
    CHECK_INTERVAL: 15000, 
    // Danh sách User-Agent để giả lập trình duyệt thật
    USER_AGENTS: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ]
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./fb_pro_monitor.db');
const queue = new PQueue({ interval: CONFIG.CHECK_INTERVAL, intervalCap: 1 });

// ================= DATABASE SETUP =================
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
            start_date TEXT,
            last_check TEXT
        )
    `);
});

// ================= HELPERS =================
const formatTime = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

const getUA = () => CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];

const extractUID = (input) => {
    if (!input) return null;
    const match = input.trim().match(/(\d{8,20})/); // Tối ưu: Thường UID từ 8 số trở lên
    return match ? match[1] : null;
};

// ================= FB CORE CHECKER (REAL-TIME OPTIMIZED) =================
async function smartCheck(uid) {
    try {
        const res = await axios.get(`https://mbasic.facebook.com/${uid}`, {
            headers: {
                'cookie': CONFIG.FB_COOKIE || '',
                'user-agent': getUA(),
                'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 12000,
            maxRedirects: 0,
            validateStatus: () => true
        });

        const location = res.headers.location || '';
        const html = String(res.data).toLowerCase();

        // Kiểm tra nếu Cookie chính dùng để check bị die
        if (location.includes('login.php?next') && !uid.includes('profile.php')) {
             // Nếu bị đá ra login khi đang check 1 UID số, có thể cookie của bạn đã die
             console.log("⚠️ Cảnh báo: FB_COOKIE có dấu hiệu hết hạn!");
        }

        // 1. Dạng LIVE
        if (res.status === 200 && !html.includes('nội dung này hiện không khả dụng')) {
            return { status: 'LIVE' };
        }

        // 2. Dạng DIE/Checkpoint
        if (location.includes('checkpoint') || location.includes('help/contact') || location.includes('recover')) {
            let type = 'Bị khóa';
            if (location.includes('282')) type = 'Checkpoint 282';
            else if (location.includes('956')) type = 'Két sắt 956';
            return { status: 'DIE', dieType: type };
        }

        if (res.status === 404 || html.includes('không tìm thấy nội dung') || html.includes('this content isn\'t available')) {
            return { status: 'DIE', dieType: '583 / Acc Bay Màu' };
        }

        return { status: 'LIVE' }; // Mặc định là live nếu không rơi vào các case die rõ ràng
    } catch (e) {
        return { status: 'ERROR' };
    }
}

// ================= LỆNH ĐIỀU KHIỂN =================

// Menu chính
bot.onText(/\/start|\/menu/, (msg) => {
    const text = `🛡️ *FB MONITORING SYSTEM PRO* 🛡️\n\n` +
                 `🔵 *Quản lý UID:* \n` +
                 `• \`/addacc UID | Tên | Ghi chú\`\n` +
                 `• \`/listacc\` - Danh sách tài khoản\n` +
                 `• \`/delacc UID\` - Ngừng theo dõi\n\n` +
                 `📊 *Thống kê:* \n` +
                 `• \`/stats\` - Xem nhanh tổng quan LIVE/DIE\n\n` +
                 `💡 *Lưu ý:* Hệ thống tự động quét 1 phút/lần.`;
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// Lệnh thêm/sửa
bot.onText(/\/addacc (.+)/, async (msg, match) => {
    const parts = match[1].split('|').map(p => p.trim());
    const uid = extractUID(parts[0]);
    if (!uid) return bot.sendMessage(msg.chat.id, '❌ UID không hợp lệ.');

    bot.sendMessage(msg.chat.id, `⌛ Đang quét UID \`${uid}\`...`, { parse_mode: 'Markdown' });
    const check = await smartCheck(uid);
    const now = formatTime();

    db.run(`INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, start_date, last_check) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uid, msg.chat.id, parts[1] || 'Acc FB', parts[2] || '🦦', check.status, now, now], (err) => {
            if (err) return bot.sendMessage(msg.chat.id, '❌ Lỗi Database.');
            bot.sendMessage(msg.chat.id, `✅ *ĐÃ THÊM THEO DÕI*\n🆔 UID: \`${uid}\`\n👤 Tên: ${parts[1] || 'Chưa đặt'}\n📅 Bắt đầu: ${now}\n🌿 Trạng thái: ${check.status === 'LIVE' ? '✅ LIVE' : '❌ DIE'}`, { parse_mode: 'Markdown' });
        });
});

// Lệnh Thống kê (Mới)
bot.onText(/\/stats/, (msg) => {
    db.all(`SELECT status, count(*) as count FROM accounts GROUP BY status`, (err, rows) => {
        let live = 0, die = 0;
        rows.forEach(r => {
            if (r.status === 'LIVE') live = r.count;
            if (r.status === 'DIE') die = r.count;
        });
        bot.sendMessage(msg.chat.id, `📊 *THỐNG KÊ HỆ THỐNG*\n\n✅ Đang LIVE: ${live}\n❌ Đã DIE: ${die}\n📦 Tổng cộng: ${live + die}`, { parse_mode: 'Markdown' });
    });
});

// Lệnh Danh sách
bot.onText(/\/listacc/, (msg) => {
    db.all(`SELECT * FROM accounts WHERE chat_id = ?`, [msg.chat.id], (err, rows) => {
        if (!rows || rows.length === 0) return bot.sendMessage(msg.chat.id, '📭 Danh sách trống.');
        let message = `📋 *DANH SÁCH THEO DÕI*\n\n`;
        rows.forEach((r, i) => {
            const icon = r.status === 'LIVE' ? '✅' : '❌';
            message += `${i+1}. ${icon} \`${r.uid}\` | *${r.name}*\n⏱ Check cuối: ${r.last_check}\n\n`;
        });
        bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
    });
});

// Lệnh Xóa
bot.onText(/\/delacc (.+)/, (msg, match) => {
    const uid = extractUID(match[1]);
    db.run(`DELETE FROM accounts WHERE uid = ?`, [uid], function() {
        bot.sendMessage(msg.chat.id, this.changes > 0 ? `🗑 Đã xóa \`${uid}\`` : `❌ Không tìm thấy UID.`, { parse_mode: 'Markdown' });
    });
});

// ================= TỰ ĐỘNG QUÉT (CRON) =================
cron.schedule('*/1 * * * *', () => {
    db.all(`SELECT * FROM accounts`, async (err, rows) => {
        if (!rows) return;
        for (const row of rows) {
            await queue.add(async () => {
                const res = await smartCheck(row.uid);
                const now = formatTime();

                if (res.status === 'ERROR') return;

                // Case: Từ Sống sang Chết
                if (res.status === 'DIE' && row.status === 'LIVE') {
                    const fail = row.fail_count + 1;
                    if (fail >= 2) { 
                        const alert = `🍂 *THÔNG BÁO: UID ĐÃ DIE* ❌\n\n🆔 UID: \`${row.uid}\`\n👤 Tên: ${row.name}\n📝 Ghi chú: ${row.note}\n⚠️ Dạng: ${res.dieType}\n⏰ Lúc: ${now}\n📅 Theo dõi từ: ${row.start_date}`;
                        bot.sendMessage(row.chat_id, alert, { parse_mode: 'Markdown' });
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0, last_check=? WHERE uid=?`, [res.dieType, now, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET fail_count=? WHERE uid=?`, [fail, row.uid]);
                    }
                } 
                // Case: Từ Chết sang Sống (Sống lại)
                else if (res.status === 'LIVE' && row.status === 'DIE') {
                    bot.sendMessage(row.chat_id, `🌿 *TÍN HIỆU: UID ĐÃ LIVE LẠI* ✅\n🆔 UID: \`${row.uid}\`\n👤 Tên: ${row.name}\n⏰ Lúc: ${now}`, { parse_mode: 'Markdown' });
                    db.run(`UPDATE accounts SET status='LIVE', fail_count=0, last_check=? WHERE uid=?`, [now, row.uid]);
                } else {
                    // Luôn cập nhật thời gian check cuối để người dùng yên tâm bot vẫn chạy
                    db.run(`UPDATE accounts SET last_check=? WHERE uid=?`, [now, row.uid]);
                }
            });
        }
    });
});

// ================= START =================
const app = express();
app.get('/', (req, res) => res.send('FB Monitor Pro Running...'));
app.listen(process.env.PORT || 3000, () => console.log('Hệ thống đã sẵn sàng, Mạnh nhé!'));
