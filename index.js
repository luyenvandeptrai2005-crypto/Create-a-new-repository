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
    CHECK_INTERVAL: 15000, 
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./fb_pro_monitor.db');
const queue = new PQueue({ interval: CONFIG.CHECK_INTERVAL, intervalCap: 1 });

// ================= DATABASE (BỔ SUNG NGÀY THEO DÕI) =================
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
const formatTime = () => {
    return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
};

const extractUID = (input) => {
    if (!input) return null;
    const match = input.trim().match(/(\d{5,20})/);
    return match ? match[1] : null;
};

// ================= FACEBOOK CORE CHECKER =================
async function smartCheck(uid) {
    try {
        const res = await axios.get(`https://mbasic.facebook.com/${uid}`, {
            headers: {
                'cookie': CONFIG.FB_COOKIE || '',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept-language': 'vi-VN,vi;q=0.9'
            },
            timeout: 10000,
            maxRedirects: 0,
            validateStatus: () => true
        });

        const location = res.headers.location || '';
        const html = String(res.data).toLowerCase();

        if (location.includes('login.php')) return { status: 'LIVE' }; 

        if (location.includes('checkpoint') || location.includes('help') || location.includes('recover')) {
            let type = 'Checkpoint';
            if (location.includes('282')) type = '282';
            if (location.includes('956')) type = '956';
            return { status: 'DIE', dieType: type };
        }
        
        const dieKeywords = ["nội dung này hiện không khả dụng", "không tìm thấy nội dung", "this content isn't available"];
        if (dieKeywords.some(v => html.includes(v)) || res.status === 404) {
            return { status: 'DIE', dieType: '583 / 404' };
        }

        return { status: 'LIVE' };
    } catch (e) {
        return { status: 'ERROR' };
    }
}

// ================= LỆNH MENU (CẬP NHẬT HOẠT ĐỘNG 100%) =================
const sendHelpMenu = (chatId) => {
    const menu = `📂 *HỆ THỐNG QUẢN LÝ FACEBOOK PRO*

🔵 *Facebook:*
/addacc \`UID | Tên | Ghi chú\` - Thêm & Theo dõi
/listacc - Danh sách tài khoản
/check \`UID\` - Check nhanh trạng thái
/delacc \`UID\` - Xóa theo dõi

🎁 *Tiện ích:*
/info - Thông tin cá nhân
/menu - Hiển thị menu này

💡 *Ví dụ:* \`/addacc 10001234567 | Nick Game | Acc mua 200k\``;
    bot.sendMessage(chatId, menu, { parse_mode: 'Markdown' });
};

bot.onText(/\/start|\/menu|\/help/, (msg) => sendHelpMenu(msg.chat.id));

// 1. Lệnh Add Acc (Hỗ trợ đổi Tên/Note linh hoạt)
bot.onText(/\/addacc (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].split('|').map(p => p.trim());
    const uid = extractUID(parts[0]);
    const name = parts[1] || 'Chưa xác định';
    const note = parts[2] || '🦦';

    if (!uid) return bot.sendMessage(chatId, '❌ Lỗi: UID không hợp lệ.');

    bot.sendMessage(chatId, `⏳ Đang kiểm tra thực tế UID: ${uid}...`);
    const check = await smartCheck(uid);
    const now = formatTime();

    db.run(`INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, start_date, last_check) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uid, chatId, name, note, check.status, now, now], (err) => {
            if (err) return bot.sendMessage(chatId, '❌ Lỗi Database.');
            bot.sendMessage(chatId, `✅ *BẮT ĐẦU THEO DÕI*\n🆔 UID: \`${uid}\`\n👤 Tên: ${name}\n📝 Ghi chú: ${note}\n📅 Ngày bắt đầu: ${now}\n🌿 Trạng thái hiện tại: ${check.status}`, { parse_mode: 'Markdown' });
        });
});

// 2. Lệnh Danh Sách (Hiển thị thời gian check cuối)
bot.onText(/\/listacc/, (msg) => {
    db.all(`SELECT * FROM accounts WHERE chat_id = ?`, [msg.chat.id], (err, rows) => {
        if (!rows || rows.length === 0) return bot.sendMessage(msg.chat.id, '📭 Danh sách theo dõi trống.');
        
        let message = `📋 *DANH SÁCH THEO DÕI FB*\n\n`;
        rows.forEach((r, i) => {
            const icon = r.status === 'LIVE' ? '✅' : '❌';
            message += `${i+1}. ${icon} \`${r.uid}\` | *${r.name}*\n💬 ${r.note}\n⏱ Check cuối: ${r.last_check}\n\n`;
        });
        bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
    });
});

// 3. Lệnh Check nhanh
bot.onText(/\/check (.+)/, async (msg, match) => {
    const uid = extractUID(match[1]);
    if (!uid) return bot.sendMessage(msg.chat.id, '❌ Vui lòng nhập UID.');
    
    bot.sendMessage(msg.chat.id, `🔎 Đang check nhanh UID ${uid}...`);
    const res = await smartCheck(uid);
    const statusText = res.status === 'LIVE' ? '✅ LIVE' : `❌ DIE (Dạng: ${res.dieType})`;
    bot.sendMessage(msg.chat.id, `Trạng thái hiện tại của \`${uid}\`: *${statusText}*`, { parse_mode: 'Markdown' });
});

// 4. Lệnh Xóa
bot.onText(/\/delacc (.+)/, (msg, match) => {
    const uid = extractUID(match[1]);
    db.run(`DELETE FROM accounts WHERE uid = ?`, [uid], function(err) {
        if (this.changes > 0) bot.sendMessage(msg.chat.id, `🗑 Đã xóa UID \`${uid}\` khỏi danh sách.`);
        else bot.sendMessage(msg.chat.id, `❌ Không tìm thấy UID này.`);
    });
});

// ================= AUTO MONITORING (CRON) =================
cron.schedule('*/1 * * * *', () => {
    db.all(`SELECT * FROM accounts`, async (err, rows) => {
        if (!rows) return;
        for (const row of rows) {
            await queue.add(async () => {
                const res = await smartCheck(row.uid);
                const now = formatTime();

                if (res.status === 'ERROR') return;

                // Từ LIVE sang DIE
                if (res.status === 'DIE' && row.status === 'LIVE') {
                    const fail = row.fail_count + 1;
                    if (fail >= 2) { // Xác nhận sau 2 lần check để bám sát thực tế, tránh lag
                        const alert = `🍂 *THÔNG BÁO: UID ĐÃ DIE* ❌\n\n🆔 UID: \`${row.uid}\`\n👤 Tài khoản: ${row.name}\n📝 Ghi chú: ${row.note}\n⚠️ Dạng: ${res.dieType}\n⏰ Lúc: ${now}\n📅 Theo dõi từ: ${row.start_date}`;
                        bot.sendMessage(row.chat_id, alert, { parse_mode: 'Markdown' });
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0, last_check=? WHERE uid=?`, [res.dieType, now, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET fail_count=? WHERE uid=?`, [fail, row.uid]);
                    }
                } 
                // Từ DIE sang LIVE
                else if (res.status === 'LIVE' && row.status === 'DIE') {
                    const alert = `🌿 *THÔNG BÁO: UID ĐÃ LIVE LẠI* ✅\n\n🆔 UID: \`${row.uid}\`\n👤 Tài khoản: ${row.name}\n⏰ Lúc: ${now}`;
                    bot.sendMessage(row.chat_id, alert, { parse_mode: 'Markdown' });
                    db.run(`UPDATE accounts SET status='LIVE', fail_count=0, last_check=? WHERE uid=?`, [now, row.uid]);
                } else {
                    db.run(`UPDATE accounts SET last_check=? WHERE uid=?`, [now, row.uid]);
                }
            });
        }
    });
});

// ================= WEB SERVER =================
const app = express();
app.get('/', (req, res) => res.send('Facebook Monitoring Active'));
app.listen(process.env.PORT || 3000);
