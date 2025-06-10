// 导入依赖
const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const cors = require('cors');
const dayjs = require('dayjs');

// 创建 Express 应用
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('.'));
app.use(bodyParser.json());

const port = 3000; // 端口

// 创建MySQL连接池
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '123456',
    database: '旅行团信息',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 检查驱动配置
const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '123456',
    database: '旅行团信息',
    typeCast: function (field, next) {
        if (field.type === 'TINY' && field.length === 1) {
            return field.string() === '1' ? 1 : 0;
        }
        return next();
    }
});

// 日志中间件
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// 统一响应格式
const sendResponse = (res, status, success, data) => {
    res.status(status).json({ success, data });
};

// 异步错误处理中间件
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 1. 提交申请
app.post('/submit', asyncHandler(async (req, res) => {
    const data = req.body;
    const query = `
        INSERT INTO travel_application (
            tour_code, departure_date, route_name, applicant_name, gender, birth_date, 
            phone_number, email, address, postal_code, 
            emergency_contact_name, emergency_contact_relation, 
            emergency_contact_phone, emergency_contact_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const values = [
        data.tour_code, data.departure_date, data.route_name, data.applicant_name, data.gender, data.birth_date,
        data.phone_number, data.email, data.address, data.postal_code,
        data.emergency_contact_name, data.emergency_contact_relation,
        data.emergency_contact_phone, data.emergency_contact_address
    ];
    try {
        const [result] = await pool.execute(query, values);
        sendResponse(res, 200, true, { message: '操作成功', id: result.insertId });
    } catch (err) {
        console.error('数据库写入失败:', err);
        sendResponse(res, 500, false, '数据库写入失败');
    }
}));

// 2. 计算负责人总费用
app.get('/calculate-fee', asyncHandler(async (req, res) => {
    const { name } = req.query;
    const query = `
        SELECT t.price, r.people_count, r.deposit
        FROM registrations r
        JOIN tours t ON r.tour_id = t.id
        WHERE r.name = ?
    `;
    try {
        const [results] = await pool.execute(query, [name]);
        if (results.length === 0) {
            sendResponse(res, 404, false, '未找到相关记录');
        } else {
            const { price, people_count, deposit } = results[0];
            const totalFee = price * people_count - deposit;
            sendResponse(res, 200, true, { totalFee });
        }
    } catch (err) {
        console.error('查询失败:', err);
        sendResponse(res, 500, false, '计算费用失败');
    }
}));

// 3. 写入支付信息
app.post('/payment', asyncHandler(async (req, res) => {
    const data = req.body;
    const query = `
        INSERT INTO payment (payment_code, tour_code, departure_date, applicant_name, is_paid)
        VALUES (?, ?, ?, ?, ?)
    `;
    const values = [
        data.payment_code, data.tour_code, data.departure_date, data.applicant_name, data.is_paid
    ];
    try {
        const [result] = await pool.execute(query, values);
        sendResponse(res, 200, true, { message: '支付信息写入成功', id: result.insertId });
    } catch (err) {
        console.error('支付信息写入失败:', err);
        sendResponse(res, 500, false, '支付信息写入失败');
    }
}));

// 4. 更新 payment 表中的支付状态
app.put('/payment/:paymentCode', asyncHandler(async (req, res) => {
    const paymentCode = req.params.paymentCode;
    const { is_paid } = req.body;
    const query = `
        UPDATE payment
        SET is_paid = ?
        WHERE payment_code = ?
    `;
    try {
        const [result] = await pool.execute(query, [is_paid, paymentCode]);
        if (result.affectedRows === 0) {
            sendResponse(res, 404, false, '未找到对应的支付单号');
        } else {
            sendResponse(res, 200, true, '支付状态更新成功');
        }
    } catch (err) {
        console.error('更新支付状态失败:', err);
        sendResponse(res, 500, false, '更新支付状态失败');
    }
}));

// 5. 条件查询接口
app.post('/api/query', asyncHandler(async (req, res) => {
    const { route, date, people } = req.body;
    if (!route || !date || !people) {
        return sendResponse(res, 400, false, 'Invalid input');
    }
    try {
        const query = `
            SELECT id, route, date, max_people, price
            FROM tours
            WHERE route = ? AND date = ? AND max_people >= ?
        `;
        const [rows] = await pool.execute(query, [route, date, people]);
        if (rows.length === 0) {
            const alternativeQuery = `
                SELECT id, route, date, max_people, price
                FROM tours
                WHERE max_people >= ?
                ORDER BY date ASC
                LIMIT 5
            `;
            const [alternativeRows] = await pool.execute(alternativeQuery, [people]);
            return sendResponse(res, 404, false, {
                message: '没有匹配的旅行团',
                alternatives: alternativeRows,
            });
        }
        sendResponse(res, 200, true, rows);
    } catch (err) {
        console.error(err);
        sendResponse(res, 500, false, 'Database error');
    }
}));

// 6. 报名接口，含事务和订金计算
app.post('/api/register', asyncHandler(async (req, res) => {
    const { tourId, name, phone, signupPeople } = req.body;
    if (!tourId || !name || !phone || !signupPeople) {
        return sendResponse(res, 400, false, 'Invalid input');
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 检查当前 max_people 和获取出发日期
        const [tourRows] = await connection.execute(
            `SELECT max_people, date, price FROM tours WHERE id = ?`,
            [tourId]
        );
        if (tourRows.length === 0) {
            await connection.rollback();
            connection.release();
            return sendResponse(res, 404, false, '旅行团不存在');
        }
        const currentMaxPeople = tourRows[0].max_people;
        const departureDate = tourRows[0].date;
        const pricePerPerson = tourRows[0].price;
        if (currentMaxPeople < signupPeople) {
            await connection.rollback();
            connection.release();
            return sendResponse(res, 400, false, '报名人数超过剩余名额');
        }

        // 更新 max_people
        const newMaxPeople = currentMaxPeople - signupPeople;
        await connection.execute(
            `UPDATE tours SET max_people = ? WHERE id = ?`,
            [newMaxPeople, tourId]
        );

        // 计算订金金额
        const deposit = calculateDeposit(departureDate, pricePerPerson, signupPeople);

        // 插入报名记录，包括订金信息
        const insertQuery = `
            INSERT INTO registrations (tour_id, name, phone, people_count, deposit)
            VALUES (?, ?, ?, ?, ?)
        `;
        await connection.execute(insertQuery, [tourId, name, phone, signupPeople, deposit]);

        await connection.commit();
        connection.release();
        sendResponse(res, 200, true, { 
            message: '报名成功！',
            remainingSlots: newMaxPeople,
            departureDate: departureDate,
            pricePerPerson: pricePerPerson,
            deposit: deposit
        });
    } catch (err) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        console.error(err);
        sendResponse(res, 500, false, 'Database error');
    }
}));

// 订金计算函数
function calculateDeposit(departureDate, pricePerPerson, signupPeople) {
    const currentDate = new Date();
    const departure = new Date(departureDate);
    const diffTime = departure - currentDate;
    const diffDays = diffTime / (1000 * 60 * 60 * 24);

    let depositRate = 0;
    if (diffDays > 60) {
        depositRate = 0.1;
    } else if (diffDays > 30 && diffDays <= 60) {
        depositRate = 0.2;
    } else if (diffDays <= 30) {
        depositRate = 1;
    }
    return pricePerPerson * signupPeople * depositRate;
}

// 7. 支付订单
app.post('/api/payment/:payment_code/pay', asyncHandler(async (req, res) => {
    const paymentCode = req.params.payment_code;
    const [rows] = await pool.execute(
        'SELECT tour_code, applicant_name, is_paid FROM payment WHERE payment_code = ?',
        [paymentCode]
    );
    if (rows.length === 0) {
        return sendResponse(res, 404, false, '订单不存在');
    }
    if (rows[0].is_paid === 1) {
        return sendResponse(res, 400, false, '订单已支付');
    }
    await pool.execute(
        'UPDATE payment SET is_paid = 1 WHERE payment_code = ?',
        [paymentCode]
    );
    sendResponse(res, 200, true, {
        tour_code: rows[0].tour_code,
        applicant_name: rows[0].applicant_name,
        is_paid: 1
    });
}));

// 8. 查询订单接口，返回所有报名人id
app.get('/api/payment/:payment_code', asyncHandler(async (req, res) => {
    const paymentCode = req.params.payment_code;

    // 查订单基本信息
    const [paymentRows] = await pool.execute(
        'SELECT applicant_name, tour_code, is_paid FROM payment WHERE payment_code = ?', [paymentCode]
    );
    if (paymentRows.length === 0) {
        return sendResponse(res, 404, false, '订单不存在');
    }
    const { applicant_name, tour_code, is_paid } = paymentRows[0];

    // 查 registrations 表，获取人数
    const [regRows] = await pool.execute(
        'SELECT people_count FROM registrations WHERE name = ?', [applicant_name]
    );
    if (regRows.length === 0) {
        return sendResponse(res, 404, false, '负责人姓名未在registrations表找到');
    }
    const people_count = regRows[0].people_count;

    // 查参与人id
    const [taRows] = await pool.execute(
        'SELECT id FROM travel_application WHERE applicant_name = ? ORDER BY id DESC LIMIT 1', [applicant_name]
    );
    if (taRows.length === 0) {
        return sendResponse(res, 404, false, 'travel_application表未找到对应负责人');
    }
    const leaderId = taRows[0].id;
    const ids = [];
    for (let i = people_count - 1; i >= 0; i--) {
        ids.push(leaderId - i);
    }

    sendResponse(res, 200, true, {
        tour_code,
        applicant_name,
        is_paid,
        ids,
        people_count
    });
}));

// 9. 取消订单
app.post('/api/payment/:payment_code/cancel', asyncHandler(async (req, res) => {
    const paymentCode = req.params.payment_code;
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return sendResponse(res, 400, false, '缺少需要删除的id列表');
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // 查 payment、registrations、tours 信息
        const [paymentRows] = await conn.execute(
            'SELECT applicant_name, tour_code FROM payment WHERE payment_code = ?', [paymentCode]
        );
        if (paymentRows.length === 0) {
            await conn.rollback();
            conn.release();
            return sendResponse(res, 404, false, '订单不存在');
        }
        const applicantName = paymentRows[0].applicant_name;
        const tourCode = paymentRows[0].tour_code;

        const [regRows] = await conn.execute(
            'SELECT people_count FROM registrations WHERE name = ?', [applicantName]
        );
        if (regRows.length === 0) {
            await conn.rollback();
            conn.release();
            return sendResponse(res, 404, false, '负责人姓名未在registrations表找到');
        }
        const peopleCount = regRows[0].people_count;

        const [tourRows] = await conn.execute(
            'SELECT price, date FROM tours WHERE id = ?', [tourCode]
        );
        if (tourRows.length === 0) {
            await conn.rollback();
            conn.release();
            return sendResponse(res, 404, false, 'tours未找到');
        }
        const { price, date } = tourRows[0];

        // 计算退款金额
        const now = dayjs();
        const dep = dayjs(date);
        const daysDiff = dep.diff(now, 'day');
        let a = 0;
        if (daysDiff > 30) {
            a = 0;
        } else if (daysDiff > 10) {
            a = 0.2;
        } else if (daysDiff >= 1) {
            a = 0.5;
        } else {
            a = 1;
        }
        const refund = ((1 - a) * (price * peopleCount)).toFixed(2);

        // 更新 tours 表人数
        await conn.execute(
            'UPDATE tours SET max_people = max_people + ? WHERE id = ?', [peopleCount, tourCode]
        );
        await conn.execute(
            `DELETE FROM travel_application WHERE id IN (${ids.map(() => '?').join(',')})`, ids
        );
        await conn.execute('DELETE FROM payment WHERE payment_code = ?', [paymentCode]);
        await conn.execute('DELETE FROM registrations WHERE name = ?', [applicantName]);

        await conn.commit();
        conn.release();
        sendResponse(res, 200, true, {
            message: `已取消订单，退款${refund}元，相关记录已删除`,
            refund: refund
        });
    } catch (err) {
        console.error('取消订单接口出错:', err);
        await conn.rollback();
        conn.release();
        sendResponse(res, 500, false, '服务器内部错误');
    }
}));

// 10. 查询当前负责人
app.get('/api/travel_application/leader/:payment_code', asyncHandler(async (req, res) => {
    const paymentCode = req.params.payment_code;
    const [rows] = await pool.execute(
        'SELECT applicant_name AS leader_name FROM payment WHERE payment_code = ? LIMIT 1',
        [paymentCode]
    );
    if (rows.length === 0) {
        return sendResponse(res, 404, false, '未找到该订单的负责人');
    }
    sendResponse(res, 200, true, rows[0]);
}));

// 11. 查询指定申请人信息
app.get('/api/travel_application/applicant/:name', asyncHandler(async (req, res) => {
    const name = req.params.name;
    const [rows] = await pool.execute('SELECT * FROM travel_application WHERE applicant_name = ?', [name]);
    if (rows.length === 0) {
        return sendResponse(res, 404, false, '系统无该用户信息');
    }
    sendResponse(res, 200, true, rows[0]);
}));

// 12. 更新指定申请人信息
app.put('/api/travel_application/applicant/:name', asyncHandler(async (req, res) => {
    const name = req.params.name;
    const data = req.body;
    const fields = [
        'tour_code','departure_date','route_name','applicant_name','gender','birth_date','phone_number','email','address','postal_code',
        'emergency_contact_name','emergency_contact_relation','emergency_contact_phone','emergency_contact_address'
    ];
    const setClause = fields.map(f => `${f}=?`).join(', ');
    const values = fields.map(f => data[f]);
    values.push(name);

    const [result] = await pool.execute(
        `UPDATE travel_application SET ${setClause} WHERE applicant_name = ?`,
        values
    );
    if (result.affectedRows === 0) {
        return sendResponse(res, 404, false, '未找到该申请人');
    }
    sendResponse(res, 200, true, '修改成功');
}));

// 13. 更换负责人
app.post('/api/travel_application/change_leader', asyncHandler(async (req, res) => {
    const { old_leader, new_leader } = req.body;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [phoneRows] = await conn.execute(
            'SELECT phone_number FROM travel_application WHERE applicant_name = ?',
            [new_leader]
        );
        if (phoneRows.length === 0) throw new Error('新负责人不存在，无法获取手机号');
        const newLeaderPhone = phoneRows[0].phone_number;

        const [regUpdate] = await conn.execute(
            'UPDATE registrations SET name = ?, phone = ? WHERE name = ?',
            [new_leader, newLeaderPhone, old_leader]
        );
        if (regUpdate.affectedRows === 0) throw new Error('负责人更换失败或原负责人不存在');

        await conn.execute(
            'UPDATE payment SET applicant_name = ? WHERE applicant_name = ?',
            [new_leader, old_leader]
        );
        await conn.execute(
            'DELETE FROM travel_application WHERE applicant_name = ?',
            [old_leader]
        );
        await conn.commit();
        sendResponse(res, 200, true, '负责人更换成功，相关表负责人信息（含手机号）已同步更新');
    } catch (e) {
        await conn.rollback();
        sendResponse(res, 500, false, '更换负责人时出错: ' + (e.message || '未知错误'));
    } finally {
        conn.release();
    }
}));

// 14. 删除申请人，并更新团人数
app.delete('/api/travel_application/applicant/:name', asyncHandler(async (req, res) => {
    const name = req.params.name;
    const conn = await pool.getConnection();
    try {
        const [regRows] = await conn.execute('SELECT tour_id FROM registrations WHERE name=?', [name]);
        if (!regRows.length) return res.status(404).json({success:false, data:'未找到报名信息'});
        const tourCode = regRows[0].tour_id;

        const [tourRows] = await conn.execute('SELECT price, date FROM tours WHERE id=?', [tourCode]);
        if (!tourRows.length) return res.status(404).json({success:false, data:'未找到团信息'});
        const {price, date} = tourRows[0];

        const now = dayjs();
        const dep = dayjs(date);
        const days = dep.diff(now, 'day');
        let a = 0;
        if (days > 30) a = 0;
        else if (days > 10) a = 0.2;
        else if (days >= 1) a = 0.5;
        else a = 1;
        const refund = ((1 - a) * price).toFixed(2);

        await conn.execute('DELETE FROM registrations WHERE name=?', [name]);
        // 你自己的其他删除逻辑...

        res.json({success:true, data: {refund}});
    } catch (err) {
        console.error('取消订单接口出错:', err);
        res.status(500).json({success:false, data:'服务器出错'});
    } finally {
        conn.release();
    }
}));

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error('错误详情:', err);
    sendResponse(res, 500, false, '服务器内部错误');
});

// 启动服务器
app.listen(port, () => {
    console.log(`服务器运行在 http://localhost:${port}`);
});