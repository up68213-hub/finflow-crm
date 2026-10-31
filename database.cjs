const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'finflow.sqlite');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','manager')),
    login TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS pipeline_stages (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS tariffs (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    request_text TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL REFERENCES employees(id),
    stage_code TEXT NOT NULL REFERENCES pipeline_stages(code),
    tariff_code TEXT REFERENCES tariffs(code),
    expected_amount_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (expected_amount_kopecks >= 0),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE TABLE IF NOT EXISTS payment_methods (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    tariff_code TEXT NOT NULL REFERENCES tariffs(code),
    method_code TEXT NOT NULL REFERENCES payment_methods(code),
    amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
    net_amount_kopecks INTEGER NOT NULL CHECK (net_amount_kopecks >= 0),
    debt_amount_kopecks INTEGER NOT NULL DEFAULT 0 CHECK (debt_amount_kopecks >= 0),
    paid_at TEXT NOT NULL,
    period TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plan_periods (
    period TEXT PRIMARY KEY,
    minimum_plan_kopecks INTEGER NOT NULL,
    target_plan_kopecks INTEGER NOT NULL,
    maximum_plan_kopecks INTEGER NOT NULL,
    CHECK (minimum_plan_kopecks <= target_plan_kopecks),
    CHECK (target_plan_kopecks <= maximum_plan_kopecks)
  );
  CREATE TABLE IF NOT EXISTS employee_terms (
    employee_id TEXT NOT NULL REFERENCES employees(id),
    period TEXT NOT NULL REFERENCES plan_periods(period),
    salary_kopecks INTEGER NOT NULL CHECK (salary_kopecks >= 0),
    commission_rate_milli INTEGER NOT NULL CHECK (commission_rate_milli BETWEEN 0 AND 100000),
    actual_amount_kopecks INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (employee_id, period)
  );
  CREATE INDEX IF NOT EXISTS leads_owner_stage_idx ON leads(owner_id, stage_code, created_at DESC);
  CREATE INDEX IF NOT EXISTS payments_employee_period_idx ON payments(employee_id, period);
  CREATE INDEX IF NOT EXISTS payments_filters_idx ON payments(tariff_code, method_code, paid_at DESC);
`);

const seed = {
  users:[{id:'u1',name:'Вася К.',login:'admin',pass:'Admin2026!',role:'admin'},{id:'u2',name:'Алина',login:'alina',pass:'Manager2026!',role:'manager'},{id:'u3',name:'Паша',login:'pasha',pass:'Manager2026!',role:'manager'}],
  leads:[{id:1,name:'Светлана',request:'Навести порядок в финансах и накопить на пенсию',status:'new',owner:'u2',sum:0,tariff:'Сам',comment:'Новый лид'},{id:2,name:'Яна',request:'Планировать крупные покупки',status:'paid',owner:'u2',sum:54990,tariff:'Куратор'},{id:3,name:'Майя',request:'Создать финансовую подушку',status:'work',owner:'u2',sum:54990,tariff:'Куратор',comment:'Созвон сегодня'},{id:4,name:'Лариса',request:'Система управления личными финансами',status:'proposal',owner:'u2',sum:34990,tariff:'Сам'},{id:5,name:'Екатерина',request:'Планирование на 10–15 лет',status:'paid',owner:'u3',sum:59900,tariff:'Куратор'},{id:6,name:'Таня',request:'Не могу планировать бюджет',status:'proposal',owner:'u3',sum:54990,tariff:'Куратор'},{id:7,name:'Мария',request:'Планирование и накопление',status:'work',owner:'u3',sum:0,tariff:'VIP'},{id:8,name:'Данил',request:'Хочу попасть на последний поток',status:'new',owner:'u3',sum:0,tariff:'Сам'},{id:9,name:'Валя',request:'Инвестиционный план',status:'closed',owner:'u1',sum:79990,tariff:'VIP'}],
  payments:[{id:1,name:'Дарья',tariff:'Куратор',revenue:44990,net:43415,debt:0,method:'Сразу',date:'05.01.2026',owner:'Алина',month:'2026-01'},{id:2,name:'Роман',tariff:'Сам',revenue:34990,net:28692,debt:0,method:'Рассрочка',date:'12.01.2026',owner:'Паша',month:'2026-01'},{id:3,name:'Ольга',tariff:'Куратор',revenue:44990,net:43415,debt:0,method:'Сразу',date:'21.01.2026',owner:'Алина',month:'2026-01'},{id:4,name:'Глеб',tariff:'Куратор',revenue:54990,net:45992,debt:9000,method:'Рассрочка',date:'02.02.2026',owner:'Паша',month:'2026-02'},{id:5,name:'Валентин',tariff:'VIP',revenue:79990,net:65592,debt:0,method:'Рассрочка',date:'06.02.2026',owner:'Алина',month:'2026-02'},{id:6,name:'Екатерина',tariff:'VIP',revenue:79990,net:69111,debt:10879,method:'Рассрочка',date:'10.02.2026',owner:'Вася К.',month:'2026-02'},{id:7,name:'Яна',tariff:'VIP',revenue:71990,net:69470,debt:0,method:'Сразу',date:'14.02.2026',owner:'Алина',month:'2026-02'},{id:8,name:'Наталья',tariff:'Сам',revenue:34990,net:33765,debt:0,method:'Сразу',date:'18.02.2026',owner:'Паша',month:'2026-02'}],
  plans:{'2026-01':{min:900000,target:1400000,max:1900000},'2026-02':{min:1000000,target:1500000,max:2100000},'2026-03':{min:1100000,target:1650000,max:2300000}},
  terms:{'2026-01':{u1:{salary:110000,rate:5,actual:720000},u2:{salary:70000,rate:4,actual:1085000},u3:{salary:70000,rate:4,actual:925000}},'2026-02':{u1:{salary:110000,rate:5,actual:820000},u2:{salary:75000,rate:4.5,actual:1319086},u3:{salary:75000,rate:4,actual:1451142}},'2026-03':{u1:{salary:115000,rate:5,actual:460000},u2:{salary:80000,rate:5,actual:840000},u3:{salary:80000,rate:4.5,actual:710000}}}
};

const rubles = value => Math.round(Number(value || 0) * 100);
const fromKopecks = value => Number(value || 0) / 100;

function replaceState(state) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM employee_terms; DELETE FROM payments; DELETE FROM leads; DELETE FROM plan_periods; DELETE FROM employees;');
    const employee = db.prepare('INSERT INTO employees VALUES (?, ?, ?, ?, ?, 1)');
    state.users.forEach(u => employee.run(String(u.id), u.name, u.role, u.login, u.pass));
    const plan = db.prepare('INSERT INTO plan_periods VALUES (?, ?, ?, ?)');
    Object.entries(state.plans).forEach(([period,p]) => plan.run(period,rubles(p.min),rubles(p.target),rubles(p.max)));
    const term = db.prepare('INSERT INTO employee_terms VALUES (?, ?, ?, ?, ?)');
    Object.entries(state.terms).forEach(([period,items]) => Object.entries(items).forEach(([id,t]) => term.run(id,period,rubles(t.salary),Math.round(t.rate*1000),rubles(t.actual))));
    const lead = db.prepare('INSERT INTO leads(id,client_name,request_text,owner_id,stage_code,tariff_code,expected_amount_kopecks,comment) VALUES (?,?,?,?,?,?,?,?)');
    state.leads.forEach(l => lead.run(String(l.id),l.name,l.request||'',l.owner,l.status,l.tariff||null,rubles(l.sum),l.comment||''));
    const byName = new Map(state.users.map(u => [u.name,u.id]));
    const payment = db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?)');
    state.payments.forEach(p => payment.run(String(p.id),p.name,byName.get(p.owner)||'u1',p.tariff,p.method,rubles(p.revenue),rubles(p.net),rubles(p.debt),p.date,p.month));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function getState() {
  const users=db.prepare('SELECT id,full_name name,login,password_hash pass,role FROM employees ORDER BY id').all();
  const leads=db.prepare('SELECT id,client_name name,request_text request,owner_id owner,stage_code status,tariff_code tariff,expected_amount_kopecks,comment FROM leads ORDER BY CAST(id AS INTEGER)').all().map(x=>({...x,id:Number(x.id)||x.id,sum:fromKopecks(x.expected_amount_kopecks)}));
  const payments=db.prepare(`SELECT p.id,p.client_name name,p.tariff_code tariff,p.amount_kopecks,p.net_amount_kopecks,p.debt_amount_kopecks,p.method_code method,p.paid_at date,e.full_name owner,p.period month FROM payments p JOIN employees e ON e.id=p.employee_id ORDER BY p.paid_at`).all().map(x=>({...x,id:Number(x.id)||x.id,revenue:fromKopecks(x.amount_kopecks),net:fromKopecks(x.net_amount_kopecks),debt:fromKopecks(x.debt_amount_kopecks)}));
  const plans={}; db.prepare('SELECT * FROM plan_periods').all().forEach(p=>plans[p.period]={min:fromKopecks(p.minimum_plan_kopecks),target:fromKopecks(p.target_plan_kopecks),max:fromKopecks(p.maximum_plan_kopecks)});
  const terms={}; db.prepare('SELECT * FROM employee_terms').all().forEach(t=>{terms[t.period]??={};terms[t.period][t.employee_id]={salary:fromKopecks(t.salary_kopecks),rate:t.commission_rate_milli/1000,actual:fromKopecks(t.actual_amount_kopecks)}});
  return {users,leads,payments,plans,terms};
}

db.exec(`INSERT OR IGNORE INTO pipeline_stages VALUES ('new','Новая заявка',1),('work','В работе',2),('proposal','КП отправлено',3),('paid','Оплата',4),('closed','Закрыта / отказ',5); INSERT OR IGNORE INTO tariffs VALUES ('Сам','Сам',1),('Куратор','Куратор',1),('VIP','VIP',1); INSERT OR IGNORE INTO payment_methods VALUES ('Сразу','Сразу'),('Рассрочка','Рассрочка');`);
if (db.prepare('SELECT COUNT(*) total FROM employees').get().total === 0) replaceState(seed);

module.exports = { dbPath, getState, replaceState };
