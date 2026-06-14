const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// Khởi tạo bot với token từ biến môi trường
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const DB_FILE = 'users.json'; // File giả lập database lưu danh sách người dùng thật

// ==========================================
// CẤU HÌNH SỐ LƯỢNG NGƯỜI DÙNG ẢO
// Hiện tại bạn có 7 người thật, cộng thêm 3462 sẽ hiển thị thành 3469
const FAKE_USER_OFFSET = 3462; 
// ==========================================

// Hàm tải danh sách người dùng thật từ file
function getUsers() {
    if (!fs.existsSync(DB_FILE)) return [];
    return JSON.parse(fs.readFileSync(DB_FILE));
}

// Lệnh 1: Lưu người dùng khi họ nhấn /start
bot.onText(/\/start/, (msg) => {
    let users = getUsers();
    if (!users.includes(msg.chat.id)) {
        users.push(msg.chat.id);
        fs.writeFileSync(DB_FILE, JSON.stringify(users));
    }
    bot.sendMessage(msg.chat.id, "Chào mừng bạn đến với CheckUIDPro! Bot đã lưu thông tin của bạn.");
});

// Lệnh 2: Xem thống kê số lượng người dùng (Đã cộng số ảo)
bot.onText(/\/thongke/, (msg) => {
    let realUsers = getUsers().length;
    let totalVirtualUsers = realUsers + FAKE_USER_OFFSET;
    
    const thongKeMsg = `📊 <b>THỐNG KÊ HỆ THỐNG CHECKUIDPRO</b>\n\n` +
                       `👥 Tổng số người dùng: <b>${totalVirtualUsers.toLocaleString('vi-VN')}</b> người\n` +
                       `🟢 Trạng thái: Hoạt động bình thường\n` +
                       `⏰ Cập nhật lúc: ${new Date().toLocaleTimeString()} - ${new Date().toLocaleDateString()}`;
                       
    bot.sendMessage(msg.chat.id, thongKeMsg, { parse_mode: 'HTML' });
});

// Lệnh 3: Gửi thông báo cho TẤT CẢ người dùng (Broadcast)
bot.onText(/\/thongbao (.+)/, async (msg, match) => {
    // Chỉ admin (ID: 8312235036) mới được dùng lệnh này
    if (msg.chat.id.toString() !== '8312235036') {
        return bot.sendMessage(msg.chat.id, "❌ Bạn không có quyền sử dụng lệnh này.");
    }

    const noiDung = match[1];
    const users = getUsers();
    
    const thongBao = `📢 <b>THÔNG BÁO</b>\n` +
                     `===========================\n\n` +
                     `${noiDung}\n\n` +
                     `===========================\n` +
                     `⏰ ${new Date().toLocaleTimeString()} - ${new Date().toLocaleDateString()}`;

    // Tính toán số liệu ảo
    const totalVirtualUsers = users.length + FAKE_USER_OFFSET;
    
    // Gửi tin nhắn báo cho admin biết bot đang bắt đầu chạy broadcast
    await bot.sendMessage(msg.chat.id, `⏳ Đang tiến hành gửi thông báo tới <b>${totalVirtualUsers.toLocaleString('vi-VN')}</b> người dùng...`, { parse_mode: 'HTML' });

    let realSuccessCount = 0;

    // Chạy vòng lặp gửi thông báo (CHỈ gửi cho người dùng thật để tránh lỗi API)
    for (const userId of users) {
        try {
            await bot.sendMessage(userId, thongBao, { parse_mode: 'HTML' });
            realSuccessCount++;
            
            // Tạm dừng 50ms giữa mỗi tin nhắn để tránh bị Telegram đánh dấu là spam API (Tùy chọn, khuyến khích dùng)
            await new Promise(resolve => setTimeout(resolve, 50));
        } catch (err) {
            console.log(`[LỖI] Không gửi được cho ${userId}: ${err.message}`);
        }
    }

    // Tính toán số lượng gửi thành công ảo để báo cáo lại cho admin
    const virtualSuccessCount = realSuccessCount + FAKE_USER_OFFSET;
    
    const reportMsg = `✅ <b>BROADCAST HOÀN TẤT</b>\n\n` +
                      `Đã gửi thành công tới: <b>${virtualSuccessCount.toLocaleString('vi-VN')} / ${totalVirtualUsers.toLocaleString('vi-VN')}</b> người dùng.`;
                      
    bot.sendMessage(msg.chat.id, reportMsg, { parse_mode: 'HTML' });
});

// Báo hiệu bot đã khởi động thành công trên Terminal/Console
console.log("🤖 Bot CheckUIDPro đang chạy... Nhấn Ctrl+C để dừng.");
