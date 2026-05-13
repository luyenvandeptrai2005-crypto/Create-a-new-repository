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
    CHECK_INTERVAL: 15000, // Tần suất check giữa các UID trong hàng đợi (15s)
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./fb_pro_monitor.db');
const queue = new PQueue({ interval: CONFIG.CHECK_INTERVAL, intervalCap: 1 });

// ================= DATABASE =================
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS fb_accounts (
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
    const match = input.trim().match(/(\d{5,20})/);
    return match ? match[1] : null;
};

// ================= FB CORE CHECKER (REAL-TIME) =================
async function fbCheck(uid) {
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

        // Check chuyển hướng đăng nhập (Cookie die hoặc bị block nhẹ)
        if (location.includes('login.php')) return { status: 'LIVE' }; 

        // Check các dạng Checkpoint
        if (location.includes('checkpoint') || location.includes('help') || location.includes('recover')) {
            let type = 'Bị khóa/Checkpoint';
            if (location.includes('282')) type = 'Checkpoint 282';
            if (location.includes('956')) type = 'Checkpoint 956';
            return { status: 'DIE', dieType: type };
        }
        
        // Check 404 hoặc Nội dung không khả dụng
        const dieKeywords = ["nội dung này hiện không khả dụng", "không tìm thấy nội dung", "this content isn't available"];
        if (dieKeywords.some(v => html.includes(v)) || res.status === 404) {
            return { status: 'DIE', dieType: 'Acc DIE / 583' };
        }

        return { status: 'LIVE' };
    } catch (e) {
        return { status: 'ERROR' };
    }
}

// ================= COMMANDS & MENU =================
const mainMenu = (chatId) => {
    const text = `🎯 *FB MONITORING SYSTEM* 🎯\n\n` +
                 `🔵 *Lệnh chính:* \n` +
                 `• \`/addacc UID | Tên | Ghi chú\`\n` +
                 `• \`/listacc\` - Xem danh sách đang theo dõi\n` +
                 `• \`/check UID\` - Kiểm tra nhanh trạng thái\n` +
                 `• \`/del UID\` - Xóa UID khỏi hệ thống\n\n` +
                 `ℹ️ *Hỗ trợ:* Mọi biến động LIVE/DIE sẽ được bot báo ngay lập tức theo thời gian thực.`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
};

bot.onText(/\/start|\/menu/, (msg) => mainMenu(msg.chat.id));

// Lệnh thêm UID (Hỗ trợ cấu trúc phân tách bằng dấu |)
bot.onText(/\/addacc (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].split('|').map(p => p.trim());
    const uid = extractUID(parts[0]);
    
    if (!uid) return bot.sendMessage(chatId, '❌ UID không đúng định dạng!');

    bot.sendMessage(chatId, `⏳ Đang quét trạng thái UID: ${uid}...`);
    const result = await fbCheck(uid);
    const now = formatTime();

    db.run(`INSERT OR REPLACE INTO fb_accounts (uid, chat_id, name, note, status, start_date, last_check) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uid, chatId, parts[1] || 'No Name', parts[2] || 'No Note', result.status, now, now], 
        (err) => {
            if (err) return bot.sendMessage(chatId, '❌ Lỗi lưu dữ liệu!');
            bot.sendMessage(chatId, `✅ *ĐÃ THÊM THEO DÕI*\n🆔 UID: \`${uid}\`\n👤 Tên: ${parts[1] || 'Chưa đặt'}\n📝 Ghi chú: ${parts[2] || 'Trống'}\n🌿 Trạng thái: ${result.status}\n📅 Bắt đầu: ${now}`, { parse_mode: 'Markdown' });
        }
    );
});

// Xem danh sách
bot.onText(/\/listacc/, (msg) => {
    db.all(`SELECT * FROM fb_accounts WHERE chat_id = ?`, [msg.chat.id], (err, rows) => {
        if (!rows || rows.length === 0) return bot.sendMessage(msg.chat.id, '📭 Danh sách theo dõi đang trống.');
        
        let report = `📋 *DANH SÁCH MONITOR FB (${rows.length})*\n\n`;
        rows.forEach((r, i) => {
            const icon = r.status === 'LIVE' ? '✅' : '❌';
            report += `${i+1}. ${icon} \`${r.uid}\` | *${r.name}*\n💬 Note: ${r.note}\n⏱ Check cuối: ${r.last_check}\n\n`;
        });
        bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
    });
});

// Xóa UID
bot.onText(/\/del (.+)/, (msg, match) => {
    const uid = extractUID(match[1]);
    db.run(`DELETE FROM fb_accounts WHERE uid = ? AND chat_id = ?`, [uid, msg.chat.id], function(err) {
        if (this.changes > 0) bot.sendMessage(msg.chat.id, `✅ Đã xóa UID \`${uid}\``, { parse_mode: 'Markdown' });
        else bot.sendMessage(msg.chat.id, `❌ Không tìm thấy UID này trong danh sách.`);
    });
});

// ================= AUTO MONITORING (CRON) =================
// Tự động quét 1 phút/lần
cron.schedule('*/1 * * * *', () => {
    db.all(`SELECT * FROM fb_accounts`, async (err, rows) => {
        if (!rows) return;
        for (const row of rows) {
            await queue.add(async () => {
                const res = await fbCheck(row.uid);
                const now = formatTime();

                if (res.status === 'ERROR') return;

                // Nếu từ LIVE sang DIE
                if (res.status === 'DIE' && row.status === 'LIVE') {
                    const fail = row.fail_count + 1;
                    if (fail >= 2) { // Xác nhận DIE sau 2 lần check để chắc chắn 100%
                        const text = `🍂 *CẢNH BÁO: UID ĐÃ DIE* ❌\n\n🆔 UID: \`${row.uid}\`\n👤 Tên: ${row.name}\n📝 Ghi chú: ${row.note}\n⚠️ Dạng: ${res.dieType}\n⏰ Lúc: ${now}\n📅 Theo dõi từ: ${row.start_date}`;
                        bot.sendMessage(row.chat_id, text, { parse_mode: 'Markdown' });
                        db.run(`UPDATE fb_accounts SET status='DIE', die_type=?, fail_count=0, last_check=? WHERE uid=?`, [res.dieType, now, row.uid]);
                    } else {
                        db.run(`UPDATE fb_accounts SET fail_count=? WHERE uid=?`, [fail, row.uid]);
                    }
                } 
                // Nếu từ DIE sang LIVE (Sống lại)
                else if (res.status === 'LIVE' && row.status === 'DIE') {
                    const text = `🌿 *TÍN HIỆU: UID ĐÃ LIVE LẠI* ✅\n\n🆔 UID: \`${row.uid}\`\n👤 Tên: ${row.name}\n⏰ Lúc: ${now}`;
                    bot.sendMessage(row.chat_id, text, { parse_mode: 'Markdown' });
                    db.run(`UPDATE fb_accounts SET status='LIVE', fail_count=0, last_check=? WHERE uid=?`, [now, row.uid]);
                } else {
                    // Cập nhật thời gian check để người dùng biết bot vẫn đang làm việc
                    db.run(`UPDATE fb_accounts SET last_check=? WHERE uid=?`, [now, row.uid]);
                }
            });
        }
    });
});

// ================= SERVER =================
const app = express();
app.get('/', (req, res) => res.send('Facebook Monitor is Running...'));
app.listen(process.env.PORT || 3000, () => console.log('FB Monitor System Ready!'));
