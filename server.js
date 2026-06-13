const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ========== 1. إعداد SQLite (قاعدة بيانات المستخدمين المركزية) ==========
let db;

async function initDatabase() {
    db = await open({
        filename: './usersramz.db',
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ SQLite server database ready (usersramz.db)');

    // ========== إضافة المستخدمين التجريبيين (رمزي، شعلان) ==========
    const testUsers = [
        { username: 'رمزي', password: '654321' },
        { username: 'شعلان', password: '654321' }
    ];
    for (const user of testUsers) {
        const existing = await db.get('SELECT id FROM users WHERE username = ?', [user.username]);
        if (!existing) {
            const hashedPassword = await bcrypt.hash(user.password, 10);
            await db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [user.username, hashedPassword]);
            console.log(`✅ تم إنشاء مستخدم تجريبي: ${user.username}`);
        } else {
            console.log(`ℹ️ المستخدم التجريبي موجود بالفعل: ${user.username}`);
        }
    }
}
initDatabase().catch(err => console.error('❌ Database init error:', err));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== 2. واجهات API لتسجيل الدخول والتسجيل ==========
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hashedPassword]);
        res.json({ success: true });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
        } else {
            console.error(err);
            res.status(500).json({ error: 'خطأ في الخادم' });
        }
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.get('SELECT password_hash FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(401).json({ error: 'اسم المستخدم غير صحيح' });
        }
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
        }
        res.json({ success: true, username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// ========== 3. Socket.io (وسيط لنقل الرسائل فقط، لا تخزين) ==========
io.on('connection', (socket) => {
    console.log('✅ مستخدم متصل:', socket.id);

    socket.on('send_message', (data) => {
        io.emit('receive_message', data);
    });

    socket.on('disconnect', () => {
        console.log('❌ مستخدم غادر:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
});
