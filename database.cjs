const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
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
  CREATE TABLE IF NOT EXISTS sync_log (
    source TEXT PRIMARY KEY,
    last_synced_at TEXT,
    last_added_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS telegram_contacts (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    telegram_user_id TEXT NOT NULL UNIQUE, telegram_chat_id TEXT NOT NULL UNIQUE,
    username TEXT, first_name TEXT, last_name TEXT, linked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
    contact_id TEXT REFERENCES telegram_contacts(id), link_token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending', unread_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS telegram_messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')), sender_employee_id TEXT,
    telegram_message_id TEXT, telegram_update_id TEXT UNIQUE, message_type TEXT NOT NULL,
    text TEXT, file_name TEXT, mime_type TEXT, local_path TEXT, telegram_file_id TEXT,
    status TEXT NOT NULL, error_message TEXT, created_at TEXT NOT NULL, sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS telegram_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS telegram_messages_conversation_idx ON telegram_messages(conversation_id,created_at);
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    number TEXT NOT NULL UNIQUE, amount_kopecks INTEGER NOT NULL CHECK(amount_kopecks >= 0),
    description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
    pdf_path TEXT, telegram_message_id TEXT, created_by TEXT REFERENCES employees(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS invoices_lead_idx ON invoices(lead_id, created_at DESC);
`);

const leadColumns = new Set(db.prepare('PRAGMA table_info(leads)').all().map(x => x.name));
for (const [name, definition] of [
  ['phone', "TEXT NOT NULL DEFAULT ''"],
  ['telegram', "TEXT NOT NULL DEFAULT ''"],
  ['source', "TEXT NOT NULL DEFAULT 'manual'"],
  ['source_key', 'TEXT']
]) if (!leadColumns.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${definition}`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS leads_source_key_idx ON leads(source, source_key) WHERE source_key IS NOT NULL;');

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
    db.exec('DELETE FROM employee_terms; DELETE FROM payments;');
    const employee = db.prepare(`INSERT INTO employees VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET
      full_name=excluded.full_name,role=excluded.role,login=excluded.login,password_hash=excluded.password_hash,is_active=1`);
    state.users.forEach(u => employee.run(String(u.id), u.name, u.role, u.login, u.pass));
    const plan = db.prepare(`INSERT INTO plan_periods VALUES (?, ?, ?, ?) ON CONFLICT(period) DO UPDATE SET
      minimum_plan_kopecks=excluded.minimum_plan_kopecks,target_plan_kopecks=excluded.target_plan_kopecks,maximum_plan_kopecks=excluded.maximum_plan_kopecks`);
    Object.entries(state.plans).forEach(([period,p]) => plan.run(period,rubles(p.min),rubles(p.target),rubles(p.max)));
    const term = db.prepare('INSERT INTO employee_terms VALUES (?, ?, ?, ?, ?)');
    Object.entries(state.terms).forEach(([period,items]) => Object.entries(items).forEach(([id,t]) => term.run(id,period,rubles(t.salary),Math.round(t.rate*1000),rubles(t.actual))));
    const lead = db.prepare(`INSERT INTO leads(id,client_name,request_text,owner_id,stage_code,tariff_code,expected_amount_kopecks,comment,phone,telegram,source,source_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET client_name=excluded.client_name,request_text=excluded.request_text,owner_id=excluded.owner_id,stage_code=excluded.stage_code,tariff_code=excluded.tariff_code,expected_amount_kopecks=excluded.expected_amount_kopecks,comment=excluded.comment,phone=excluded.phone,telegram=excluded.telegram,source=excluded.source,source_key=excluded.source_key`);
    state.leads.forEach(l => lead.run(String(l.id),l.name,l.request||'',l.owner,l.status,l.tariff||null,rubles(l.sum),l.comment||'',l.phone||'',l.telegram||'',l.source||'manual',l.sourceKey||null));
    const byName = new Map(state.users.map(u => [u.name,u.id]));
    const payment = db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?)');
    state.payments.forEach(p => payment.run(String(p.id),p.name,byName.get(p.owner)||'u1',p.tariff,p.method,rubles(p.revenue),rubles(p.net),rubles(p.debt),p.date,p.month));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function getState() {
  const users=db.prepare('SELECT id,full_name name,login,password_hash pass,role FROM employees ORDER BY id').all();
  const leads=db.prepare('SELECT id,client_name name,request_text request,owner_id owner,stage_code status,tariff_code tariff,expected_amount_kopecks,comment,phone,telegram,source,source_key sourceKey FROM leads ORDER BY created_at DESC').all().map(x=>({...x,id:Number(x.id)||x.id,sum:fromKopecks(x.expected_amount_kopecks)}));
  const payments=db.prepare(`SELECT p.id,p.client_name name,p.tariff_code tariff,p.amount_kopecks,p.net_amount_kopecks,p.debt_amount_kopecks,p.method_code method,p.paid_at date,e.full_name owner,p.period month FROM payments p JOIN employees e ON e.id=p.employee_id ORDER BY p.paid_at`).all().map(x=>({...x,id:Number(x.id)||x.id,revenue:fromKopecks(x.amount_kopecks),net:fromKopecks(x.net_amount_kopecks),debt:fromKopecks(x.debt_amount_kopecks)}));
  const plans={}; db.prepare('SELECT * FROM plan_periods').all().forEach(p=>plans[p.period]={min:fromKopecks(p.minimum_plan_kopecks),target:fromKopecks(p.target_plan_kopecks),max:fromKopecks(p.maximum_plan_kopecks)});
  const terms={}; db.prepare('SELECT * FROM employee_terms').all().forEach(t=>{terms[t.period]??={};terms[t.period][t.employee_id]={salary:fromKopecks(t.salary_kopecks),rate:t.commission_rate_milli/1000,actual:fromKopecks(t.actual_amount_kopecks)}});
  return {users,leads,payments,plans,terms};
}

const allowedTariffs = new Set(['Обучение с куратором','Самостоятельное обучение','Обучение с VIP-сопровождением от автора курса','Часовая консультация']);
function sheetDate(value) {
  const match = String(value || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]||'00'}:${match[5]||'00'}:${match[6]||'00'}+05:00` : new Date().toISOString();
}
function importGoogleLeads(rows, sourceId='google_sheets') {
  const insert = db.prepare(`INSERT OR IGNORE INTO leads
    (id,client_name,request_text,owner_id,stage_code,tariff_code,expected_amount_kopecks,comment,created_at,phone,telegram,source,source_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let added=0, skipped=0, newLeads=[];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const tariff=String(row.product||'').trim(), name=String(row.name||'').trim();
      if (!name || !allowedTariffs.has(tariff)) { skipped++; continue; }
      const raw=[row.timestamp,tariff,name,row.phone,row.telegram,row.request].map(x=>String(x||'').trim()).join('|');
      const key=crypto.createHash('sha256').update(raw).digest('hex');
      const result=insert.run('gs_'+key.slice(0,24),name,String(row.request||'').trim(),'u1','new',tariff,0,'Импортировано из Google Sheets',sheetDate(row.timestamp),String(row.phone||'').trim(),String(row.telegram||'').trim(),sourceId,key);
      if(result.changes){added++;newLeads.push({name,tariff,phone:row.phone,telegram:row.telegram,request:row.request,timestamp:row.timestamp})}else skipped++;
    }
    db.prepare(`INSERT INTO sync_log(source,last_synced_at,last_added_count,last_error) VALUES (?,?,?,NULL)
      ON CONFLICT(source) DO UPDATE SET last_synced_at=excluded.last_synced_at,last_added_count=excluded.last_added_count,last_error=NULL`).run(sourceId,new Date().toISOString(),added);
    db.exec('COMMIT');
    return {added,skipped,total:rows.length,syncedAt:new Date().toISOString(),newLeads};
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
function recordSyncError(message, sourceId='google_sheets') {
  db.prepare(`INSERT INTO sync_log(source,last_synced_at,last_added_count,last_error) VALUES (?,NULL,0,?)
    ON CONFLICT(source) DO UPDATE SET last_error=excluded.last_error`).run(sourceId,String(message));
}
function getSyncStatus(sourceId='google_sheets') { return db.prepare('SELECT * FROM sync_log WHERE source=?').get(sourceId)||null; }

function conversationForLead(leadId) {
  let item=db.prepare(`SELECT c.*,l.client_name,tc.telegram_chat_id,tc.username FROM conversations c
    JOIN leads l ON l.id=c.lead_id LEFT JOIN telegram_contacts tc ON tc.id=c.contact_id WHERE c.lead_id=?`).get(String(leadId));
  if(!item) {
    const id=crypto.randomUUID(),token=crypto.randomBytes(18).toString('base64url'),now=new Date().toISOString();
    db.prepare('INSERT INTO conversations(id,lead_id,link_token,created_at) VALUES (?,?,?,?)').run(id,String(leadId),token,now);
    item=db.prepare(`SELECT c.*,l.client_name,NULL telegram_chat_id,NULL username FROM conversations c JOIN leads l ON l.id=c.lead_id WHERE c.id=?`).get(id);
  }
  return {...item,botLink:`https://t.me/FinFlowCRMBot?start=${item.link_token}`};
}
function messagesForConversation(id) {
  return db.prepare('SELECT * FROM telegram_messages WHERE conversation_id=? ORDER BY created_at,id').all(String(id));
}
function linkTelegramContact(token,from,chatId) {
  const conversation=db.prepare('SELECT * FROM conversations WHERE link_token=?').get(token);
  if(!conversation) return null;
  const contactId='tg_'+String(from.id),now=new Date().toISOString();
  db.prepare(`INSERT INTO telegram_contacts(id,lead_id,telegram_user_id,telegram_chat_id,username,first_name,last_name,linked_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET lead_id=excluded.lead_id,telegram_chat_id=excluded.telegram_chat_id,username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name`).run(contactId,conversation.lead_id,String(from.id),String(chatId),from.username||null,from.first_name||null,from.last_name||null,now);
  db.prepare("UPDATE conversations SET contact_id=?,status='active' WHERE id=?").run(contactId,conversation.id);
  return conversationForLead(conversation.lead_id);
}
function conversationByChat(chatId) {
  return db.prepare(`SELECT c.* FROM conversations c JOIN telegram_contacts tc ON tc.id=c.contact_id WHERE tc.telegram_chat_id=?`).get(String(chatId));
}
function saveIncomingMessage(conversationId,updateId,message) {
  const id=crypto.randomUUID(),now=new Date((message.date||Math.floor(Date.now()/1000))*1000).toISOString();
  const document=message.document,photo=message.photo?.at(-1),file=document||photo;
  const type=document?'document':photo?'photo':'text';
  const result=db.prepare(`INSERT OR IGNORE INTO telegram_messages(id,conversation_id,direction,telegram_message_id,telegram_update_id,message_type,text,file_name,mime_type,telegram_file_id,status,created_at,sent_at)
    VALUES (?,?, 'incoming',?,?,?,?,?,?,?,?,?,?)`).run(id,conversationId,String(message.message_id),String(updateId),type,message.text||message.caption||'',document?.file_name||null,document?.mime_type||null,file?.file_id||null,'received',now,now);
  if(result.changes) db.prepare("UPDATE conversations SET unread_count=unread_count+1,last_message_at=?,status='active' WHERE id=?").run(now,conversationId);
  return result.changes>0;
}
function createOutgoingMessage(conversationId,employeeId,{text='',fileName=null,mimeType=null,localPath=null}) {
  const id=crypto.randomUUID(),now=new Date().toISOString(),type=fileName?'document':'text';
  db.prepare(`INSERT INTO telegram_messages(id,conversation_id,direction,sender_employee_id,message_type,text,file_name,mime_type,local_path,status,created_at)
    VALUES (?,?, 'outgoing',?,?,?,?,?,?, 'pending',?)`).run(id,conversationId,employeeId||null,type,text,fileName,mimeType,localPath,now);
  db.prepare('UPDATE conversations SET last_message_at=? WHERE id=?').run(now,conversationId);
  return db.prepare('SELECT * FROM telegram_messages WHERE id=?').get(id);
}
function finishOutgoingMessage(id,result,error=null) {
  if(error) db.prepare("UPDATE telegram_messages SET status='failed',error_message=? WHERE id=?").run(String(error),id);
  else db.prepare("UPDATE telegram_messages SET status='sent',telegram_message_id=?,telegram_file_id=?,sent_at=? WHERE id=?").run(String(result.message_id),result.document?.file_id||null,new Date().toISOString(),id);
}
function invoicesForLead(leadId) {
  return db.prepare('SELECT * FROM invoices WHERE lead_id=? ORDER BY created_at DESC').all(String(leadId)).map(x=>({...x,amount:fromKopecks(x.amount_kopecks)}));
}
function allInvoices() {
  return db.prepare(`SELECT i.*,l.client_name,l.owner_id FROM invoices i JOIN leads l ON l.id=i.lead_id ORDER BY i.created_at DESC`).all().map(x=>({...x,amount:fromKopecks(x.amount_kopecks)}));
}
function invoiceById(id) {
  const x=db.prepare(`SELECT i.*,l.client_name,l.phone,l.telegram FROM invoices i JOIN leads l ON l.id=i.lead_id WHERE i.id=?`).get(String(id));
  return x&&{...x,amount:fromKopecks(x.amount_kopecks)};
}
function createInvoice(leadId, employeeId, {amount,description=''}) {
  if(!db.prepare('SELECT 1 FROM leads WHERE id=?').get(String(leadId))) throw new Error('Заявка не найдена');
  const value=Math.round(Number(amount)*100); if(!Number.isFinite(value)||value<=0) throw new Error('Укажите сумму счёта больше нуля');
  const id=crypto.randomUUID(),now=new Date().toISOString(),number=`FF-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  db.prepare(`INSERT INTO invoices(id,lead_id,number,amount_kopecks,description,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?)`).run(id,String(leadId),number,value,String(description).trim(),employeeId||null,now,now);
  return invoiceById(id);
}
function updateInvoice(id,{amount,description}) {
  const value=Math.round(Number(amount)*100); if(!Number.isFinite(value)||value<=0) throw new Error('Укажите сумму счёта больше нуля');
  const result=db.prepare("UPDATE invoices SET amount_kopecks=?,description=?,status='draft',pdf_path=NULL,updated_at=? WHERE id=?").run(value,String(description||'').trim(),new Date().toISOString(),String(id));
  if(!result.changes) throw new Error('Счёт не найден'); return invoiceById(id);
}
function attachInvoicePdf(id,pdfPath) { db.prepare("UPDATE invoices SET pdf_path=?,status='ready',updated_at=? WHERE id=?").run(pdfPath,new Date().toISOString(),String(id)); return invoiceById(id); }
function markInvoiceSent(id,telegramMessageId) { db.prepare("UPDATE invoices SET status='sent',telegram_message_id=?,sent_at=?,updated_at=? WHERE id=?").run(String(telegramMessageId||''),new Date().toISOString(),new Date().toISOString(),String(id)); return invoiceById(id); }
function markConversationRead(id) { db.prepare('UPDATE conversations SET unread_count=0 WHERE id=?').run(String(id)); }
function telegramOffset() { return Number(db.prepare("SELECT value FROM telegram_state WHERE key='offset'").get()?.value||0); }
function setTelegramOffset(value) { db.prepare("INSERT INTO telegram_state(key,value) VALUES ('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value)); }

db.exec(`INSERT OR IGNORE INTO pipeline_stages VALUES ('new','Новая заявка',1),('work','В работе',2),('proposal','КП отправлено',3),('paid','Оплата',4),('closed','Закрыта / отказ',5);
INSERT OR IGNORE INTO tariffs VALUES
 ('Обучение с куратором','Обучение с куратором',1),
 ('Самостоятельное обучение','Самостоятельное обучение',1),
 ('Обучение с VIP-сопровождением от автора курса','Обучение с VIP-сопровождением от автора курса',1),
 ('Часовая консультация','Часовая консультация',1),
 ('Сам','Сам',0),('Куратор','Куратор',0),('VIP','VIP',0);
INSERT OR IGNORE INTO payment_methods VALUES ('Сразу','Сразу'),('Рассрочка','Рассрочка');`);
if (db.prepare('SELECT COUNT(*) total FROM employees').get().total === 0) replaceState(seed);

module.exports = { dbPath, getState, replaceState, importGoogleLeads, recordSyncError, getSyncStatus,
  conversationForLead,messagesForConversation,linkTelegramContact,conversationByChat,saveIncomingMessage,
  createOutgoingMessage,finishOutgoingMessage,markConversationRead,telegramOffset,setTelegramOffset,
  invoicesForLead,allInvoices,invoiceById,createInvoice,updateInvoice,attachInvoicePdf,markInvoiceSent };
