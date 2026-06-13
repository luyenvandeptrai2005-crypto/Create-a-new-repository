require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_ID = process.env.ADMIN_ID;
const userState = {}; 

let FB_COOKIE = process.env.FB_COOKIE || "";

// ==========================================
// 1. DATABASE SQLITE (Giữ nguyên như của bạn)
// ==========================================
const db = new sqlite3.Database('./bot_data_v2.sqlite', (err) => {
    if (err) console.error('Lỗi mở database:', err.message);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS uids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT, uid TEXT, link TEXT, fb_name TEXT, note TEXT, price INTEGER,
            status TEXT, tracking_status INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_check DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log('✅ Đã kết nối Database SQLite.');
    }
});

// Helper functions
const getVNTime = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const formatMoney = (amount) => amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " VNĐ";

// ==========================================
// 2. HÀM CÀO DỮ LIỆU FACEBOOK CHUẨN (LẤY UID, TÊN, AVATAR)
// ==========================================
async function fetchFacebookData(inputUrl) {
    let result = { uid: inputUrl, fb_name: 'Không xác định', status: 'DIE', avatar: null };
    
    // Nếu nhập thẳng số (UID cứng) thì check luôn, còn lại thêm https://
    let fetchUrl = inputUrl;
    if (!/^\d+$/.test(inputUrl)) {
        if (!inputUrl.startsWith('http')) fetchUrl = `https://${inputUrl}`;
    } else {
        fetchUrl = `https://www.facebook.com/profile.php?id=${inputUrl}`;
    }

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            ...(FB_COOKIE && { 'Cookie': FB_COOKIE })
        };

        const response = await axios.get(fetchUrl, { headers, validateStatus: () => true });
        const html = response.data;

        // Nếu FB block hoặc link chết thật
        if (response.status === 404 || html.includes("Trang này không khả dụng") || html.includes("This page isn't available")) {
            return result; 
        }

        // Cố gắng bắt UID từ các thẻ meta hoặc json ẩn của Facebook
        const uidMatch = html.match(/"userID":"(\d+)"/) || html.match(/fb:\/\/profile\/(\d+)/) || html.match(/profile_id=(\d+)/);
        if (uidMatch && uidMatch[1]) {
            result.uid = uidMatch[1];
        }

        // Bắt Tên thật từ thẻ meta Open Graph
        const nameMatch = html.match(/<meta property="og:title" content="(.*?)"/);
        if (nameMatch && nameMatch[1]) {
            let name = nameMatch[1].replace(' | Facebook', '').trim();
            if(name !== 'Facebook') result.fb_name = name;
        }

        // Bắt Avatar từ thẻ meta Open Graph
        const avatarMatch = html.match(/<meta property="og:image" content="(.*?)"/);
        if (avatarMatch && avatarMatch[1]) {
            // Thay thế mã HTML entity để link ảnh chuẩn
            result.avatar = avatarMatch[1].replace(/&amp;/g, '&');
        }

        result.status = 'LIVE';
        return result;

    } catch (error) {
        console.log("Lỗi fetch FB:", error.message);
        return result; // Mặc định trả về DIE nếu sập
    }
}

// ==========================================
// 3. XỬ LÝ LUỒNG /ADD (GIỐNG Y HỆT ẢNH)
// ==========================================
bot.onText(/\/add$/, (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = { step: 'WAITING_LINK' };
    
    bot.sendMessage(chatId, "➕ *THÊM TÀI NGUYÊN MỚI*\n➖➖➖➖➖➖\nVui lòng gửi Link Facebook hoặc UID cần theo dõi.\n\n👇 Hoặc bấm nút bên dưới để quay lại.", { 
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } 
    });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return; 

    const state = userState[chatId];
    if (!state) return;

    // BƯỚC 1: NHẬN LINK/UID -> PHÂN TÍCH NGAY LẬP TỨC
    if (state.step === 'WAITING_LINK') {
        const loadingMsg = await bot.sendMessage(chatId, "⏳ Đang trích xuất dữ liệu Facebook...");
        
        // Cào dữ liệu ngay tại bước này
        const fbData = await fetchFacebookData(text);
        
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});

        if (fbData.status === 'DIE') {
             return bot.sendMessage(chatId, "❌ Link không hợp lệ hoặc tài khoản đã DIE/Khóa. Vui lòng gửi lại link khác.", {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] }
             });
        }

        // Lưu tạm data vào state
        state.uid = fbData.uid;
        state.link = text;
        state.fb_name = fbData.fb_name;
        state.avatar = fbData.avatar;
        state.fb_status = fbData.status;
        state.step = 'WAITING_NOTE';

        // Trả lời giống y hệt ảnh 1 & 2
        bot.sendMessage(chatId, `✅ Đã nhận: \`${state.uid}\`\n👤 Tên: ${state.fb_name}\n\n📝 Vui lòng nhập GHI CHÚ:\n_(Nhập 0 nếu không cần ghi chú)_`, { 
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } 
        });
    }
    
    // BƯỚC 2: NHẬN GHI CHÚ
    else if (state.step === 'WAITING_NOTE') {
        state.note = text === '0' ? 'Không có' : text;
        state.step = 'WAITING_PRICE';

        bot.sendMessage(chatId, `📝 Ghi chú: ${state.note}\n\n💰 Vui lòng nhập GIÁ TIỀN (VNĐ):\n_(Nhập 0 nếu không cần ghi giá)_`, { 
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } 
        });
    }

    // BƯỚC 3: NHẬN GIÁ VÀ LÊN ĐƠN (KÈM ẢNH)
    else if (state.step === 'WAITING_PRICE') {
        state.price = text === '0' ? 0 : parseInt(text.replace(/[^0-9]/g, '')) || 0;
        
        const timeNow = getVNTime();
        
        db.run(`INSERT INTO uids (chat_id, uid, link, fb_name, note, price, status, created_at, last_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [chatId, state.uid, state.link, state.fb_name, state.note, state.price, state.fb_status, timeNow, timeNow], async function(err) {
            
            if (err) return bot.sendMessage(chatId, "❌ Lỗi lưu Database.");

            let msgSuccess = `✅ ĐÃ LÊN ĐƠN THÀNH CÔNG\n➖ ➖ ➖ ➖ ➖ ➖ ➖ ➖\n🆔 UID: \`${state.uid}\`\n👤 Tên FB: ${state.fb_name}\n📝 Ghi chú: ${state.note}\n💰 Giá: ${formatMoney(state.price)}\n📊 Trạng thái: ${state.fb_status}\n⏰ Time: ${timeNow}`;
            
            const opts = { 
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'back_menu' }]] } 
            };

            // Nếu cào được Avatar, gửi bằng sendPhoto (Giống ảnh 2). Nếu không, gửi text bình thường.
            if (state.avatar) {
                await bot.sendPhoto(chatId, state.avatar, { caption: msgSuccess, ...opts });
            } else {
                await bot.sendMessage(chatId, msgSuccess, opts);
            }
            
            delete userState[chatId]; // Clear state
        });
    }
});

// ... (Giữ nguyên các phần callback_query và Cronjob của bạn, lưu ý thay hàm checkFacebookUID trong cron thành fetchFacebookData) ...
