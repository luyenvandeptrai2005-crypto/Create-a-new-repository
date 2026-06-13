require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require('openai');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');

// Khởi tạo Bot và API
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_ID = process.env.ADMIN_ID;

const userState = {}; 

let FB_COOKIE = process.env.FB_COOKIE || "";
let FB_TOKEN = process.env.FB_TOKEN || "";

// ==========================================
// 1. DATABASE SQLITE
// ==========================================
const db = new sqlite3.Database('./bot_data_v2.sqlite', (err) => {
    if (err) console.error('Lỗi mở database:', err.message);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS uids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT,
            uid TEXT,
            link TEXT,
            fb_name TEXT,
            note TEXT,
            price INTEGER,
            status TEXT,
            tracking_status INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_check DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log('✅ Đã kết nối Database SQLite. Phiên bản Bot Mới.');
    }
});

// ==========================================
// 2. SETUP MENU BOT
// ==========================================
bot.setMyCommands([
    { command: 'start', description: '🏠 Bảng điều khiển' },
    { command: 'add', description: '📘 Thêm UID Facebook' },
    { command: 'adds', description: '📝 Thêm UID hàng loạt' },
    { command: 'list', description: '📋 Xem list Facebook' }
]);

// Hàm Helper định dạng thời gian VN (Hà Nội)
const getVNTime = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const formatMoney = (amount) => amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " VNĐ";

// ==========================================
// 3. LOGIC CHECK UID FACEBOOK (CHỈ LIVE/DIE & LẤY TÊN)
// ==========================================
async function checkFacebookUID(uid) {
    let result = { uid: uid, status: 'DIE', fb_name: 'Không xác định' };

    try {
        // Dùng Graph API lấy Name & Status
        if (FB_TOKEN) {
            const apiRes = await axios.get(`https://graph.facebook.com/v18.0/${uid}?fields=id,name&access_token=${FB_TOKEN}`, { validateStatus: () => true });
            if (apiRes.status === 200 && apiRes.data.id) {
                return { uid: uid, status: 'LIVE', fb_name: apiRes.data.name || 'Không xác định' };
            } else if (apiRes.data.error) {
                return { uid: uid, status: 'DIE', fb_name: 'Không xác định' };
            }
        }

        // Dùng Cookie crawl html
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...(FB_COOKIE && { 'Cookie': FB_COOKIE })
        };
        const response = await axios.get(`https://www.facebook.com/profile.php?id=${uid}`, { headers, validateStatus: () => true });
        const html = response.data;

        if (response.status === 404 || html.includes("Trang này không khả dụng") || html.includes("This page isn't available")) {
            return { uid: uid, status: 'DIE', fb_name: 'Không xác định' };
        }

        if (html.includes("checkpoint") || html.includes("temporarily locked")) {
             return { uid: uid, status: 'DIE', fb_name: 'Không xác định' };
        }

        // Cố gắng trích xuất tên từ thẻ <title>
        const titleMatch = html.match(/<title>(.*?)<\/title>/);
        if (titleMatch && titleMatch[1]) {
            let name = titleMatch[1].replace(' | Facebook', '').trim();
            if(name !== 'Facebook') result.fb_name = name;
        }

        result.status = 'LIVE';
        return result;

    } catch (error) {
        return result;
    }
}

// Trích xuất UID từ Link
function extractUID(input) {
    const match = input.match(/(?:uid=|id=|share\/|profile\.php\?id=)(\d+)/) || input.match(/^\d+$/);
    return match ? match[1] : input.trim(); // Trả về regex bắt được, hoặc text gốc nếu là alias
}

// ==========================================
// 4. XỬ LÝ LỆNH (COMMANDS)
// ==========================================
bot.onText(/\/(start|menu)/, (msg) => {
    bot.sendMessage(msg.chat.id, "🏠 *Bảng Điều Khiển*\nVui lòng sử dụng menu bên dưới.", { parse_mode: "Markdown" });
});

// Bắt đầu luồng /add
bot.onText(/\/add$/, (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = { step: 'WAITING_LINK' };
    
    const opts = { reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } };
    bot.sendMessage(chatId, "➕ *THÊM TÀI NGUYÊN MỚI*\n➖➖➖➖➖➖\nVui lòng gửi Link Facebook hoặc UID cần theo dõi.\n\n👇 Hoặc bấm nút bên dưới để quay lại.", Object.assign({ parse_mode: "Markdown" }, opts));
});

// Lệnh /list
bot.onText(/\/list/, (msg) => {
    const chatId = msg.chat.id;
    db.all(`SELECT * FROM uids WHERE chat_id = ? ORDER BY id DESC`, [chatId], (err, rows) => {
        if (err || rows.length === 0) {
            return bot.sendMessage(chatId, "📋 Danh sách trống.");
        }

        let msgText = `📋 *DANH SÁCH FACEBOOK* — Tổng: ${rows.length}\n📄 Trang 1/1\n\n➖ ➖ ➖ ➖ ➖ ➖ ➖ ➖\n`;
        let keyboardRows = [];
        let currentRow = [];

        rows.forEach((row, index) => {
            const stt = index + 1;
            const statusIcon = row.status === 'LIVE' ? '🟢 LIVE ✅' : '🔴 DIE ❌';
            
            msgText += `🔸 *#${stt}* 🆔 ${row.link}\n👤 Tên FB: ${row.fb_name}\n📝 Ghi chú: ${row.note}\n💰 Giá: ${row.price === 0 ? '0' : row.price}\n📊 Trạng thái: ${statusIcon}\n⏱ Check gần đây: ${row.last_check}\n➖ ➖ ➖ ➖ ➖ ➖ ➖ ➖\n`;
            
            // Xếp nút số (1, 2, 3...)
            currentRow.push({ text: `${stt}`, callback_data: `list_select_${row.id}` });
            if (currentRow.length === 3) {
                keyboardRows.push(currentRow);
                currentRow = [];
            }
        });
        
        if (currentRow.length > 0) keyboardRows.push(currentRow);
        msgText += `💡 Bấm số STT bên dưới để xoá hoặc sửa.`;

        keyboardRows.push([{ text: '📄 1/1', callback_data: 'noop' }]);
        keyboardRows.push([{ text: '🗑 Xóa list UID (nhập STT)', callback_data: 'del_prompt' }]);
        keyboardRows.push([{ text: '🔙 Quay lại', callback_data: 'back_menu' }]);

        bot.sendMessage(chatId, msgText, { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboardRows } });
    });
});

// ==========================================
// 5. XỬ LÝ TIN NHẮN (STATE MACHINE CHO /ADD)
// ==========================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return; 

    const state = userState[chatId];
    if (!state) return;

    // BƯỚC 1: NHẬN LINK/UID
    if (state.step === 'WAITING_LINK') {
        const uid = extractUID(text);
        state.uid = uid;
        state.link = text;
        state.step = 'WAITING_NOTE';

        const opts = { reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } };
        bot.sendMessage(chatId, `✅ Đã nhận: \`${uid}\`\n\n📝 Vui lòng nhập GHI CHÚ:\n_(Nhập 0 nếu không cần ghi chú)_`, Object.assign({ parse_mode: "Markdown" }, opts));
    }
    
    // BƯỚC 2: NHẬN GHI CHÚ
    else if (state.step === 'WAITING_NOTE') {
        state.note = text === '0' ? 'Không có' : text;
        state.step = 'WAITING_PRICE';

        const opts = { reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } };
        bot.sendMessage(chatId, `📝 Ghi chú: ${state.note}\n\n💰 Vui lòng nhập GIÁ TIỀN (VNĐ):\n_(Nhập 0 nếu không cần ghi chú)_`, Object.assign({ parse_mode: "Markdown" }, opts));
    }

    // BƯỚC 3: NHẬN GIÁ VÀ LƯU
    else if (state.step === 'WAITING_PRICE') {
        state.price = text === '0' ? 0 : parseInt(text.replace(/[^0-9]/g, '')) || 0;
        bot.sendMessage(chatId, "⏳ Đang kiểm tra trạng thái Facebook, vui lòng đợi...");

        const checkData = await checkFacebookUID(state.uid);
        const timeNow = getVNTime();
        
        db.run(`INSERT INTO uids (chat_id, uid, link, fb_name, note, price, status, created_at, last_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [chatId, state.uid, state.link, checkData.fb_name, state.note, state.price, checkData.status, timeNow, timeNow], function(err) {
            
            if (err) return bot.sendMessage(chatId, "❌ Lỗi lưu Database.");

            let msgSuccess = `✅ ĐÃ LÊN ĐƠN THÀNH CÔNG\n➖ ➖ ➖ ➖ ➖ ➖ ➖ ➖\n🆔 UID: \`${state.uid}\`\n👤 Tên FB: ${checkData.fb_name}\n📝 Ghi chú: ${state.note}\n💰 Giá: ${formatMoney(state.price)}\n📊 Trạng thái: ${checkData.status}\n⏰ Time: ${timeNow}`;
            
            bot.sendMessage(chatId, msgSuccess, { 
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } 
            });
            delete userState[chatId]; // Clear state
        });
    }
});

// ==========================================
// 6. XỬ LÝ NÚT BẤM (CALLBACK QUERY)
// ==========================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    // Trả lời query để tắt icon loading trên Telegram
    bot.answerCallbackQuery(query.id);

    if (data === 'back_menu') {
        delete userState[chatId];
        bot.editMessageText("🏠 Bạn đã quay lại Menu chính.", { chat_id: chatId, message_id: messageId });
    }

    // Các nút Action trong thông báo DIE
    if (data.startsWith('hide_info_')) {
        bot.deleteMessage(chatId, messageId).catch(()=>{});
    }

    if (data.startsWith('cancel_deal_') || data.startsWith('done_deal_')) {
        const id = data.split('_')[2];
        const actionText = data.startsWith('cancel_deal_') ? "ĐÃ HỦY KÈO ❌" : "ĐÃ DONE KÈO ✅";
        
        db.run(`UPDATE uids SET tracking_status = 0, note = ? WHERE id = ?`, [actionText, id]);
        bot.editMessageText(`Trạng thái cập nhật: ${actionText}`, { chat_id: chatId, message_id: messageId });
    }

    // Nút chọn STT trong bảng /list
    if (data.startsWith('list_select_')) {
        const dbId = data.split('_')[2];
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Xóa UID này', callback_data: `del_uid_${dbId}` }],
                    [{ text: '🔙 Quay lại', callback_data: 'back_list' }]
                ]
            }
        };
        bot.sendMessage(chatId, `⚙️ Tùy chọn cho Database ID: ${dbId}`, opts);
    }

    if (data.startsWith('del_uid_')) {
        const dbId = data.split('_')[2];
        db.run(`DELETE FROM uids WHERE id = ?`, [dbId], () => {
            bot.editMessageText("✅ Đã xóa thành công!", { chat_id: chatId, message_id: messageId });
        });
    }
});

// ==========================================
// 7. CRON JOB: QUÉT THÔNG BÁO TÀI KHOẢN DIE (Mỗi 5 phút)
// ==========================================
cron.schedule('*/5 * * * *', () => {
    db.all(`SELECT * FROM uids WHERE tracking_status = 1`, [], async (err, rows) => {
        if (err || !rows) return;
        
        for (const row of rows) {
            const checkData = await checkFacebookUID(row.uid);
            const timeNow = getVNTime();
            
            // Cập nhật thời gian check
            db.run(`UPDATE uids SET last_check = ?, fb_name = ? WHERE id = ?`, [timeNow, checkData.fb_name, row.id]);

            // Nếu từ LIVE chuyển sang DIE
            if (row.status === 'LIVE' && checkData.status === 'DIE') {
                
                const msgAlert = `🔴 *Thông báo tài khoản DIE*\n➖ ➖ ➖ ➖ ➖ ➖ ➖ ➖\n🆔 UID: \`${row.uid}\`\n👤 Tên FB: ${checkData.fb_name}\n📝 Ghi chú: ${row.note}\n💰 Giá: ${formatMoney(row.price)}\n📊 Trạng thái mới: DIE ❌\n🆕 Tạo: ${row.created_at}\n🔎 Check gần đây: ${timeNow}`;
                
                const keyboard = {
                    inline_keyboard: [
                        [{ text: '🙈 Ẩn thông tin', callback_data: `hide_info_${row.id}` }],
                        [
                            { text: '❌ Hủy kèo', callback_data: `cancel_deal_${row.id}` },
                            { text: '✅ Done kèo', callback_data: `done_deal_${row.id}` }
                        ],
                        [{ text: '✏️ Cập nhật (Sửa)', callback_data: `edit_${row.id}` }],
                        [{ text: '🔙 Quay lại', callback_data: 'back_menu' }]
                    ]
                };

                bot.sendMessage(row.chat_id, msgAlert, { parse_mode: "Markdown", reply_markup: keyboard });
                
                // Đổi trạng thái trong DB để không thông báo lại
                db.run(`UPDATE uids SET status = 'DIE' WHERE id = ?`, [row.id]); 
            }
        }
    });
});

// ==========================================
// 8. CRON JOB: LÀM SẠCH DATABASE ĐỊNH KỲ (5 NGÀY / LẦN)
// ==========================================
// Chạy vào lúc 00:00 (nửa đêm) mỗi 5 ngày (Ngày 1, 6, 11, 16, 21, 26, 31 hàng tháng)
cron.schedule('0 0 */5 * *', () => {
    console.log("🔄 Bắt đầu tiến trình làm sạch Database định kỳ...");
    
    db.all(`SELECT * FROM uids ORDER BY chat_id`, [], async (err, rows) => {
        if (err || rows.length === 0) return;

        // 1. Gom nhóm dữ liệu theo từng user (chat_id)
        const userGroups = {};
        rows.forEach(row => {
            if (!userGroups[row.chat_id]) {
                userGroups[row.chat_id] = [];
            }
            userGroups[row.chat_id].push(row);
        });

        // 2. Gửi tin nhắn thông báo kèm danh sách backup cho từng user
        for (const chatId in userGroups) {
            const userUids = userGroups[chatId];
            
            // Xây dựng nội dung tin nhắn giống mẫu
            let msgText = `⚠️ *THÔNG BÁO: LÀM SẠCH DATABASE ĐỊNH KỲ*\n\n`;
            msgText += `Hệ thống vừa thực hiện reset dữ liệu để đảm bảo tốc độ mượt mà nhất.\n`;
            msgText += `Dưới đây là *Danh sách đã theo dõi* của riêng bạn. Hãy lưu lại nhé:\n\n`;
            msgText += `📘 *FACEBOOK:*\n`;

            userUids.forEach(row => {
                const noteText = row.note && row.note !== 'Không có' ? ` | ${row.note}` : '';
                msgText += `• ID: ${row.link || row.uid} | ${row.fb_name}${noteText} | Giá: ${row.price}\n`;
            });

            msgText += `\n👉 _Nếu muốn tiếp tục theo dõi, bạn vui lòng copy và thêm lại vào bot nha!_`;

            try {
                await bot.sendMessage(chatId, msgText, { 
                    parse_mode: "Markdown", 
                    disable_web_page_preview: true 
                });
            } catch (error) {
                console.log(`❌ Không thể gửi tin nhắn reset cho user ${chatId}`);
            }
        }

        // 3. Thực hiện làm sạch toàn bộ Database
        db.serialize(() => {
            db.run(`DELETE FROM uids`);
            db.run(`DELETE FROM sqlite_sequence WHERE name='uids'`, [], (err) => {
                if (!err) console.log("✅ Đã gửi backup, xóa toàn bộ dữ liệu và reset ID thành công!");
            });
        });
    });
});
