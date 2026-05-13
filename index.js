require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const PQueue = require('p-queue').default;
const express = require('express');

// ================= CONFIG =================
const CONFIG = {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, // Điền token của bạn
    FB_COOKIE: process.env.FB_COOKIE, // Update Cookie mới nhất, nên dùng clone
    CHECK_INTERVAL: 10000,
    MAX_FAIL: 2, // Giảm xuống 2 để báo nhanh hơn
    REQUEST_TIMEOUT: 15000
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });

// ================= DATABASE =================
const db = new sqlite3.Database('./fb_pro_monitor.db');
const queue = new PQueue({ interval: CONFIG.CHECK_INTERVAL, intervalCap: 1 });

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
            is_tracking INTEGER DEFAULT 1, -- 1: Đang theo dõi, 0: Tạm dừng
            start_date TEXT,
            last_check TEXT,
            last_change TEXT
        )
    `);
});

// ================= HELPERS =================
const formatTime = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

const extractUID = (input) => {
    if (!input) return null;
    const clean = input.trim();
    const match = clean.match(/(\d{5,20})/);
    return match ? match[1] : clean.replace(/(https?:\/\/[^\/]+\/|\/)/g, '');
};

const safeSend = async (chatId, text, options = {}) => {
    try {
        return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...options });
    } catch (e) {
        console.error(`[Tele Error]`, e.message);
    }
};

// ================= FACEBOOK CHECKER NÂNG CẤP =================
async function smartCheck(uid) {
    try {
        // Bước 1: Check nhanh qua Avatar Graph (Tránh bị checkpoint IP)
        try {
            const graphRes = await axios.get(`https://graph.facebook.com/${uid}/picture?type=normal`, {
                maxRedirects: 0, validateStatus: () => true, timeout: 5000
            });
            if (graphRes.status === 302 && graphRes.headers.location) {
                const loc = graphRes.headers.location;
                // Nếu avatar trỏ về ảnh mặc định của FB -> Khả năng cao đã DIE/Vô hiệu hóa
                if (loc.includes('100514108_240892976722271_766548772093558784_n.jpg') || loc.includes('static.xx.fbcdn.net')) {
                    // Chờ check lại bằng mbasic để chắc chắn loại DIE
                } else {
                    return { status: 'LIVE' }; // Có avatar thật -> Sống 99%
                }
            }
        } catch (e) {}

        // Bước 2: Check sâu bằng mbasic nếu Graph báo Die hoặc lỗi
        const url = `https://mbasic.facebook.com/${uid}`;
        const res = await axios.get(url, {
            headers: {
                'cookie': CONFIG.FB_COOKIE || '',
                'user-agent': 'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
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

        // Xử lý báo ảo: Nếu trả về trang bắt đăng nhập (Cookie chết)
        if (html.includes('m_login_email') || html.includes('login.php') || location.includes('login')) {
            console.log("⚠️ COOKIE DIE HOẶC BỊ CHẶN!");
            return { status: 'ERROR', msg: 'Cookie lỗi/Bắt đăng nhập' };
        }

        // ===== CHECKPOINT =====
        if (location.includes('checkpoint') || location.includes('recover') || location.includes('help')) {
            let type = 'Checkpoint';
            if (location.includes('282')) type = '282';
            if (location.includes('956')) type = '956';
            return { status: 'DIE', dieType: type };
        }

        // ===== DIE =====
        const dieKeywords = [
            "nội dung này hiện không khả dụng", "không tìm thấy nội dung",
            "this content isn't available", "trang này hiện không khả dụng",
            "bị vô hiệu hóa", "disabled"
        ];
        if (dieKeywords.some(v => html.includes(v)) || res.status === 404) {
            return { status: 'DIE', dieType: '404 / 583' };
        }

        // ===== LIVE =====
        if (res.status === 200 && (html.includes('thêm bạn bè') || html.includes('nhắn tin') || html.includes('timeline') || html.includes('người theo dõi'))) {
            return { status: 'LIVE' };
        }

        return { status: 'ERROR', msg: 'Không rõ trạng thái' };

    } catch (e) {
        return { status: 'ERROR', msg: e.message };
    }
}

// ================= UI KEYBOARDS =================
const getActionKeyboard = (uid, isTracking = 1) => {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: isTracking ? "🔄 Tiếp tục theo dõi" : "▶️ Bắt đầu theo dõi", callback_data: `action_resume_${uid}` },
                    { text: "🛑 Dừng theo dõi", callback_data: `action_pause_${uid}` }
                ],
                [
                    { text: "❌ Xóa UID", callback_data: `action_delete_${uid}` }
                ]
            ]
        }
    };
};

const getCheckKeyboard = (uid) => {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✅ Lưu UID", callback_data: `check_save_${uid}` },
                    { text: "❌ Bỏ qua", callback_data: `check_ignore_${uid}` }
                ],
                [
                    { text: "🔄 Check lại", callback_data: `check_recheck_${uid}` }
                ]
            ]
        }
    };
};

// ================= LỆNH /CHECK (CÓ NÚT BẤM) =================
bot.onText(/\/check(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!match[1]) return safeSend(chatId, '📭 *Vui lòng nhập UID hoặc URL cần check*\nVD: `/check 100012345678`');

    const uid = extractUID(match[1]);
    if (!uid) return safeSend(chatId, '❌ UID không hợp lệ.');

    const sentMsg = await safeSend(chatId, `🔎 Đang kiểm tra realtime: \`${uid}\`...`);
    const res = await smartCheck(uid);
    
    let resultText = '';
    if (res.status === 'LIVE') resultText = `✅ UID \`${uid}\` đang **LIVE**.\n\n📌 Bạn có muốn lưu UID này không?`;
    else if (res.status === 'DIE') resultText = `❌ UID \`${uid}\` đã **DIE**.\n⚠️ Die Dạng: ${res.dieType}\n\n📌 Bạn có muốn lưu UID này không?`;
    else resultText = `⚠️ Lỗi khi check: ${res.msg}\n\n📌 Bạn có muốn lưu UID này không?`;

    bot.editMessageText(resultText, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'Markdown',
        ...getCheckKeyboard(uid)
    });
});

// ================= XỬ LÝ NÚT BẤM (CALLBACK QUERY) =================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    // --- CÁC NÚT TỪ LỆNH CHECK ---
    if (data.startsWith('check_')) {
        const action = data.split('_')[1];
        const uid = data.split('_')[2];

        if (action === 'ignore') {
            bot.editMessageText(`Đã bỏ qua UID: \`${uid}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        }
        else if (action === 'save') {
            const now = formatTime();
            db.run(`INSERT OR IGNORE INTO accounts (uid, chat_id, name, note, status, is_tracking, start_date, last_check, last_change) VALUES (?, ?, 'Chưa đặt tên', '🦦', 'LIVE', 1, ?, ?, ?)`, 
            [uid, chatId, now, now, now], (err) => {
                bot.editMessageText(`✅ Đã lưu UID vào hệ thống: \`${uid}\`\nSử dụng /setname hoặc /setnote để cập nhật thông tin.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                bot.sendMessage(chatId, `Bảng điều khiển cho UID: \`${uid}\``, getActionKeyboard(uid, 1));
            });
        }
        else if (action === 'recheck') {
            bot.answerCallbackQuery(query.id, { text: 'Đang check lại...' });
            const res = await smartCheck(uid);
            let resultText = res.status === 'LIVE' ? `✅ UID \`${uid}\` đang **LIVE**.` : (res.status === 'DIE' ? `❌ UID \`${uid}\` đã **DIE** (${res.dieType}).` : `⚠️ Lỗi.`);
            bot.editMessageText(`${resultText}\n⏰ Time: ${formatTime()}\n📌 Bạn có muốn lưu UID này không?`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', ...getCheckKeyboard(uid)
            });
        }
    }

    // --- CÁC NÚT TỪ BẢNG ĐIỀU KHIỂN ---
    if (data.startsWith('action_')) {
        const action = data.split('_')[1];
        const uid = data.split('_')[2];

        if (action === 'delete') {
            db.run(`DELETE FROM accounts WHERE uid = ?`, [uid], () => {
                bot.editMessageText(`🗑 Đã xóa UID khỏi hệ thống: \`${uid}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            });
        }
        else if (action === 'pause') {
            db.run(`UPDATE accounts SET is_tracking = 0 WHERE uid = ?`, [uid], () => {
                bot.answerCallbackQuery(query.id, { text: 'Đã DỪNG theo dõi UID này' });
                bot.editMessageReplyMarkup({
                    inline_keyboard: [[{ text: "▶️ Bắt đầu theo dõi", callback_data: `action_resume_${uid}` }], [{ text: "❌ Xóa UID", callback_data: `action_delete_${uid}` }]]
                }, { chat_id: chatId, message_id: messageId });
            });
        }
        else if (action === 'resume') {
            db.run(`UPDATE accounts SET is_tracking = 1 WHERE uid = ?`, [uid], () => {
                bot.answerCallbackQuery(query.id, { text: 'Đã TIẾP TỤC theo dõi UID này' });
                bot.editMessageReplyMarkup({
                    inline_keyboard: [[{ text: "🔄 Tiếp tục theo dõi", callback_data: `action_resume_${uid}` }, { text: "🛑 Dừng theo dõi", callback_data: `action_pause_${uid}` }], [{ text: "❌ Xóa UID", callback_data: `action_delete_${uid}` }]]
                }, { chat_id: chatId, message_id: messageId });
            });
        }
    }
});

// ================= CRON JOB (AUTO MONITOR) =================
// Cứ 2 phút chạy 1 lần để tránh bị FB quét block IP
cron.schedule('*/2 * * * *', () => {
    // Chỉ check những nick có is_tracking = 1
    db.all(`SELECT * FROM accounts WHERE is_tracking = 1`, async (err, rows) => {
        if (!rows || rows.length === 0) return;
        
        for (const row of rows) {
            await queue.add(async () => {
                const now = formatTime();
                const result = await smartCheck(row.uid);

                if (result.status === 'ERROR') return; // Bỏ qua nếu lỗi cookie/mạng để tránh báo ảo

                // LIVE -> DIE
                if (result.status === 'DIE' && row.status === 'LIVE') {
                    const fail = row.fail_count + 1;
                    if (fail >= CONFIG.MAX_FAIL) {
                        const msg = `🍂 \`${row.uid}\` đã DIE ❌\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${now}\n⚠️ Dạng: ${result.dieType}`;
                        await safeSend(row.chat_id, msg, getActionKeyboard(row.uid, 1));
                        db.run(`UPDATE accounts SET status='DIE', die_type=?, fail_count=0, last_check=?, last_change=? WHERE uid=?`, [result.dieType, now, now, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET fail_count=?, last_check=? WHERE uid=?`, [fail, now, row.uid]);
                    }
                } 
                // DIE -> LIVE (Về lại / Mở khóa)
                else if (result.status === 'LIVE' && row.status === 'DIE') {
                    const liveCount = row.live_count + 1;
                    if (liveCount >= 2) { // Phải check Live 2 lần mới báo để tránh ảo
                        const msg = `🌿 \`${row.uid}\` đã SỐNG LẠI ✅\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${now}`;
                        await safeSend(row.chat_id, msg, getActionKeyboard(row.uid, 1));
                        db.run(`UPDATE accounts SET status='LIVE', die_type='', live_count=0, last_check=?, last_change=? WHERE uid=?`, [now, now, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET live_count=?, last_check=? WHERE uid=?`, [liveCount, now, row.uid]);
                    }
                } 
                // Không đổi
                else {
                    db.run(`UPDATE accounts SET last_check=?, fail_count=0, live_count=0 WHERE uid=?`, [now, row.uid]);
                }
            });
        }
    });
});

// Server Express giữ bot sống
const app = express();
app.get('/', (req, res) => res.send(`<h2>Bot is running</h2>`));
app.listen(process.env.PORT || 3000, () => console.log('✅ Bot and Server Started'));
