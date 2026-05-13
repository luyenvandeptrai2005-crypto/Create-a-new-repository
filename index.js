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
    MAX_FAIL: 2, // Check lỗi liên tiếp 2 lần mới báo DIE thật để chống báo ảo
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
            is_tracking INTEGER DEFAULT 1,
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
        console.error(`[Telegram Error] Không thể gửi tin nhắn đến ${chatId}:`, e.message);
    }
};

const statusIcon = (status) => status === 'LIVE' ? '✅' : '❌';

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

// ================= FACEBOOK CHECKER CHỐNG BÁO ẢO =================
async function smartCheck(uid) {
    try {
        // 1. Check nhanh qua Graph API lấy Avatar (Tốc độ cao, không tốn tài nguyên cookie)
        try {
            const graphRes = await axios.get(`https://graph.facebook.com/${uid}/picture?width=100&height=100`, {
                maxRedirects: 0, validateStatus: () => true, timeout: 5000
            });
            if (graphRes.status === 302 && graphRes.headers.location) {
                const loc = graphRes.headers.location;
                if (!loc.includes('static.xx.fbcdn.net') && !loc.includes('100514108_240892976722271')) {
                    return { status: 'LIVE', msg: 'Có Avatar' };
                }
            }
        } catch (e) {}

        // 2. Check sâu bằng giao diện Web PC nếu Graph không rõ kết quả
        const url = `https://www.facebook.com/${uid}`;
        const res = await axios.get(url, {
            headers: {
                'cookie': CONFIG.FB_COOKIE || '',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'accept-language': 'vi-VN,vi;q=0.9',
                'sec-fetch-site': 'none',
                'sec-fetch-mode': 'navigate'
            },
            timeout: CONFIG.REQUEST_TIMEOUT,
            maxRedirects: 0,
            validateStatus: () => true
        });

        const html = String(res.data).toLowerCase();
        const location = (res.headers.location || '').toLowerCase();

        // Check lỗi Cookie / Chặn IP mạng
        if (location.includes('login') || (res.status === 302 && location === 'https://www.facebook.com/')) {
            if (!CONFIG.FB_COOKIE) return { status: 'ERROR', msg: 'Chưa cấu hình Cookie' };
            return { status: 'ERROR', msg: 'Cookie hết hạn hoặc bị chặn IP' };
        }

        // Bị Checkpoint khóa tạm thời (956, 282,...)
        if (location.includes('checkpoint')) {
            let type = 'Checkpoint';
            if (location.includes('282')) type = '282';
            if (location.includes('956')) type = '956';
            return { status: 'DIE', dieType: type };
        }

        // Bị vô hiệu hóa vĩnh viễn (Dạng ẩn link profile / 404 / 583)
        if (res.status === 404 || html.includes("nội dung này hiện không khả dụng") || html.includes("this content isn't available")) {
            return { status: 'DIE', dieType: '404 / 583' };
        }

        // Tài khoản Hoạt động bình thường
        if (res.status === 200 && (html.includes('og:title') || html.includes('profile_id') || html.includes('al:android:url'))) {
            return { status: 'LIVE', msg: 'Profile Online' };
        }

        return { status: 'ERROR', msg: `Mã lỗi FB: ${res.status}` };

    } catch (e) {
        return { status: 'ERROR', msg: 'Lỗi kết nối / Timeout' };
    }
}

// ================= TELEGRAM MENU =================
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

// ================= LỆNH CHỨC NĂNG =================

// --- ADD ACC ---
bot.onText(/\/addacc(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!match[1]) {
        return safeSend(chatId, '📝 *Vui lòng nhập thêm thông số*\nCú pháp:\n`/addacc UID | Tên | Note`\n\n💡 *Ví dụ:* `/addacc 100012345678 | Nick Chính | Acc MMO`');
    }

    const parts = match[1].split('|').map(v => v.trim());
    const uid = extractUID(parts[0]);
    const name = parts[1] || 'Chưa đặt tên';
    const note = parts[2] || '🦦';

    if (!uid) return safeSend(chatId, '❌ UID không hợp lệ.');
    
    safeSend(chatId, `🔎 Đang check realtime UID: \`${uid}\``);
    const check = await smartCheck(uid);
    const now = formatTime();

    db.run(`
        INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, is_tracking, start_date, last_check, last_change)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `, [uid, chatId, name, note, check.status, now, now, now], 
    async (err) => {
        if (err) return safeSend(chatId, '❌ Lỗi Database.');
        await safeSend(chatId, `✅ *ĐÃ THÊM THEO DÕI*\n🆔 UID: \`${uid}\`\n👤 Tên: *${name}*\n📝 Note: ${note}\n📅 Theo dõi từ: ${now}\n🌿 Trạng thái: ${check.status === 'LIVE' ? '✅ LIVE' : '❌ DIE'}`, getActionKeyboard(uid, 1));
    });
});

// --- CHECK REALTIME CO NÚT BẤM ---
bot.onText(/\/check(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!match[1]) return safeSend(chatId, '📝 *Vui lòng nhập UID hoặc URL cần check*\nCú pháp: `/check UID`');

    const uid = extractUID(match[1]);
    if (!uid) return safeSend(chatId, '❌ UID không hợp lệ.');

    const sentMsg = await safeSend(chatId, `🔎 Đang kiểm tra realtime: \`${uid}\`...`);
    const res = await smartCheck(uid);
    
    let resultText = '';
    if (res.status === 'LIVE') resultText = `✅ UID \`${uid}\` đã được check.\n🌿 Trạng thái: **LIVE**\n\n📌 Bạn có muốn lưu UID này không?`;
    else if (res.status === 'DIE') resultText = `❌ UID \`${uid}\` đã được check.\n🌿 Trạng thái: **DIE**\n⚠️ Die Dạng: ${res.dieType}\n\n📌 Bạn có muốn lưu UID này không?`;
    else resultText = `⚠️ Lỗi khi check: ${res.msg}\n\n📌 Bạn có muốn lưu UID này không?`;

    bot.editMessageText(resultText, {
        chat_id: chatId,
        message_id: sentMsg.message_id,
        parse_mode: 'Markdown',
        ...getCheckKeyboard(uid)
    });
});

// --- LIST ACC ---
bot.onText(/\/listacc/, (msg) => {
    db.all(`SELECT * FROM accounts WHERE chat_id = ? ORDER BY last_check DESC`, [msg.chat.id], async (err, rows) => {
        if (!rows || rows.length === 0) return safeSend(msg.chat.id, '📭 Chưa có UID nào trong hệ thống.');
        let text = `📋 *DANH SÁCH THEO DÕI*\n\n`;
        rows.forEach((r, i) => {
            const trackStatus = r.is_tracking ? '🔄 Tracking' : '🛑 Đang Dừng';
            text += `${i + 1}. ${statusIcon(r.status)} \`${r.uid}\` | [${trackStatus}]\n👤 ${r.name}\n📝 ${r.note}\n⏱ Check cuối: ${r.last_check}\n\n`;
        });
        safeSend(msg.chat.id, text);
    });
});

// --- DELETE ---
bot.onText(/\/delacc(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!match[1]) return safeSend(chatId, '📝 Cú pháp: `/delacc UID`');
    const uid = extractUID(match[1]);
    db.run(`DELETE FROM accounts WHERE uid = ?`, [uid], function(err) {
        if (this.changes > 0) safeSend(chatId, `🗑 Đã xóa UID: \`${uid}\``);
        else safeSend(chatId, '❌ UID không tồn tại.');
    });
});

// --- SET NAME ---
bot.onText(/\/setname(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!match[1]) return safeSend(chatId, '📝 Cú pháp: `/setname UID | Tên mới`');
    const parts = match[1].split('|').map(v => v.trim());
    if (parts.length < 2) return safeSend(chatId, '❌ Thiếu dấu `|`. Cú pháp: `/setname UID | Tên mới`');
    const uid = extractUID(parts[0]);
    db.run(`UPDATE accounts SET name = ? WHERE uid = ?`, [parts[1], uid], function(err) {
        if (this.changes > 0) safeSend(chatId, `✅ Đã cập nhật tên\n🆔 \`${uid}\`\n👤 Tên mới: *${parts[1]}*`);
        else safeSend(chatId, '❌ Không tìm thấy UID.');
    });
});

// --- SET NOTE ---
bot.onText(/\/setnote(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!match[1]) return safeSend(chatId, '📝 Cú pháp: `/setnote UID | Note mới`');
    const parts = match[1].split('|').map(v => v.trim());
    if (parts.length < 2) return safeSend(chatId, '❌ Thiếu dấu `|`. Cú pháp: `/setnote UID | Note mới`');
    const uid = extractUID(parts[0]);
    db.run(`UPDATE accounts SET note = ? WHERE uid = ?`, [parts[1], uid], function(err) {
        if (this.changes > 0) safeSend(chatId, `✅ Đã cập nhật note\n🆔 \`${uid}\`\n📝 Note mới: ${parts[1]}`);
        else safeSend(chatId, '❌ Không tìm thấy UID.');
    });
});

// --- INFO ---
bot.onText(/\/info(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!match[1]) return safeSend(chatId, '📝 Cú pháp: `/info UID`');
    const uid = extractUID(match[1]);
    db.get(`SELECT * FROM accounts WHERE uid = ?`, [uid], async (err, row) => {
        if (!row) return safeSend(chatId, '❌ Không tìm thấy UID.');
        const trackState = row.is_tracking ? '🟢 Đang Auto Check' : '🔴 Đang Dừng Tự Động';
        safeSend(chatId, `📊 *THÔNG TIN UID*\n🆔 UID: \`${row.uid}\`\n👤 Tên: ${row.name}\n📝 Note: ${row.note}\n⚙️ Giám Sát: *${trackState}*\n🌿 Trạng thái: ${statusIcon(row.status)} ${row.status}\n⚠️ Dạng DIE: ${row.die_type || 'Không'}\n📅 Theo dõi từ: ${row.start_date}\n⏱ Check cuối: ${row.last_check}`);
    });
});

// --- STATUS ---
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

// ================= XỬ LÝ NÚT BẤM (CALLBACK QUERY) TOÀN DIỆN =================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    // Gửi tín hiệu xử lý ngay lập tức để Telegram tắt xoay tròn loading ở nút bấm
    try {
        await bot.answerCallbackQuery(query.id);
    } catch (e) {
        console.error('Lỗi answerCallbackQuery:', e.message);
    }

    try {
        // --- 1. NHÓM NÚT KHI SỬ DỤNG LỆNH CHECK ---
        if (data.startsWith('check_')) {
            const parts = data.split('_');
            const action = parts[1]; 
            const uid = parts[2];

            if (action === 'ignore') {
                await bot.editMessageText(`Đã bỏ qua UID: \`${uid}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            }
            else if (action === 'save') {
                const now = formatTime();
                db.run(`INSERT OR REPLACE INTO accounts (uid, chat_id, name, note, status, is_tracking, start_date, last_check, last_change) VALUES (?, ?, 'Chưa đặt tên', '🦦', 'LIVE', 1, ?, ?, ?)`, 
                [uid, chatId, now, now, now], async (err) => {
                    if (err) return bot.sendMessage(chatId, "❌ Lỗi khi lưu vào Database.");
                    
                    await bot.editMessageText(`✅ Đã lưu UID vào hệ thống thành công: \`${uid}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                    await bot.sendMessage(chatId, `Bảng điều khiển cho UID: \`${uid}\``, getActionKeyboard(uid, 1));
                });
            }
            else if (action === 'recheck') {
                await bot.editMessageText(`🔄 Đang kiểm tra lại trạng thái UID \`${uid}\`...`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                const res = await smartCheck(uid);
                let resultText = res.status === 'LIVE' ? `✅ UID \`${uid}\` đang **LIVE**.` : (res.status === 'DIE' ? `❌ UID \`${uid}\` đã **DIE** (${res.dieType}).` : `⚠️ Lỗi: ${res.msg}`);
                
                await bot.editMessageText(`${resultText}\n⏰ Cập nhật lúc: ${formatTime()}\n\n📌 Bạn có muốn lưu UID này không?`, {
                    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', ...getCheckKeyboard(uid)
                });
            }
        }

        // --- 2. NHÓM NÚT TRÊN MENU ĐIỀU KHIỂN AUTO MONITOR ---
        else if (data.startsWith('action_')) {
            const parts = data.split('_');
            const action = parts[1]; 
            const uid = parts[2];

            if (action === 'delete') {
                db.run(`DELETE FROM accounts WHERE uid = ?`, [uid], async () => {
                    await bot.editMessageText(`🗑 Đã xóa vĩnh viễn UID khỏi hệ thống giám sát: \`${uid}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                });
            }
            else if (action === 'pause') {
                db.run(`UPDATE accounts SET is_tracking = 0 WHERE uid = ?`, [uid], async () => {
                    // Cập nhật lại giao diện nút bấm thành "Bắt đầu theo dõi"
                    await bot.editMessageReplyMarkup({
                        inline_keyboard: [
                            [{ text: "▶️ Bắt đầu theo dõi", callback_data: `action_resume_${uid}` }], 
                            [{ text: "❌ Xóa UID", callback_data: `action_delete_${uid}` }]
                        ]
                    }, { chat_id: chatId, message_id: messageId });
                    
                    bot.sendMessage(chatId, `🛑 Đã tạm DỪNG tiến trình quét tự động của UID: \`${uid}\``);
                });
            }
            else if (action === 'resume') {
                db.run(`UPDATE accounts SET is_tracking = 1 WHERE uid = ?`, [uid], async () => {
                    // Cập nhật lại giao diện nút bấm thành "Dừng theo dõi"
                    await bot.editMessageReplyMarkup({
                        inline_keyboard: [
                            [
                                { text: "🔄 Tiếp tục theo dõi", callback_data: `action_resume_${uid}` }, 
                                { text: "🛑 Dừng theo dõi", callback_data: `action_pause_${uid}` }
                            ], 
                            [{ text: "❌ Xóa UID", callback_data: `action_delete_${uid}` }]
                        ]
                    }, { chat_id: chatId, message_id: messageId });
                    
                    bot.sendMessage(chatId, `▶️ Đã TIẾP TỤC bật tiến trình quét tự động cho UID: \`${uid}\``);
                });
            }
        }
    } catch (error) {
        console.error("Lỗi xử lý click nút bấm:", error);
    }
});

// ================= CRON JOB (QUÉT TỰ ĐỘNG MỖI 2 PHÚT) =================
cron.schedule('*/2 * * * *', () => {
    // Chỉ quét các tài khoản có trạng thái đang bật tracking (is_tracking = 1)
    db.all(`SELECT * FROM accounts WHERE is_tracking = 1`, async (err, rows) => {
        if (!rows || rows.length === 0) return;
        
        for (const row of rows) {
            await queue.add(async () => {
                const now = formatTime();
                const result = await smartCheck(row.uid);

                if (result.status === 'ERROR') return; // Lỗi mạng/cookie tạm thời thì bỏ qua, không báo bậy

                // Đang LIVE chuyển thành DIE
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
                // Đang DIE đột ngột SỐNG LẠI (LIVE)
                else if (result.status === 'LIVE' && row.status === 'DIE') {
                    const liveCount = row.live_count + 1;
                    if (liveCount >= 2) { 
                        const msg = `🌿 \`${row.uid}\` đã SỐNG LẠI ✅\n👤 Tài Khoản: ${row.name}\n📝 Ghi Chú: ${row.note}\n⏰ Thời Gian: ${now}`;
                        await safeSend(row.chat_id, msg, getActionKeyboard(row.uid, 1));
                        db.run(`UPDATE accounts SET status='LIVE', die_type='', live_count=0, last_check=?, last_change=? WHERE uid=?`, [now, now, row.uid]);
                    } else {
                        db.run(`UPDATE accounts SET live_count=?, last_check=? WHERE uid=?`, [liveCount, now, row.uid]);
                    }
                } 
                // Trạng thái giữ nguyên ổn định
                else {
                    db.run(`UPDATE accounts SET last_check=?, fail_count=0, live_count=0 WHERE uid=?`, [now, row.uid]);
                }
            });
        }
    });
});

// ================= EXPRESS SERVER (GIỮ BOT ONLINE) =================
const app = express();
app.get('/', (req, res) => res.send(`<h2>FB Pro Monitor Engine - Is Active</h2>`));
app.listen(process.env.PORT || 3000, () => console.log('✅ Hệ thống server đã khởi tạo thành công'));
