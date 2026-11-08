const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { dbPath, getState, replaceState, importGoogleLeads, recordSyncError, getSyncStatus,
  conversationForLead,messagesForConversation,linkTelegramContact,conversationByChat,saveIncomingMessage,
  createOutgoingMessage,finishOutgoingMessage,markConversationRead,telegramOffset,setTelegramOffset,
  invoicesForLead,allInvoices,invoiceById,createInvoice,updateInvoice,attachInvoicePdf,markInvoiceSent } = require('./database.cjs');
const { configured: telegramConfigured, botConfigured, notifyNewLead, sendChatMessage, sendChatDocument, getTelegramUpdates } = require('./telegram.cjs');

const root = path.join(__dirname, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8' };
const GOOGLE_SHEETS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQtMpUuOPhKwODFRWZpclCpeaJv3uVOHia_MJg8IuPYrdRYmN45-OyfyFxGe6h50d9jfBsGYSS6waEd/pub?gid=1863668531&single=true&output=csv';
const uploads=path.join(__dirname,'data','uploads');fs.mkdirSync(uploads,{recursive:true});
const invoiceDir=path.join(__dirname,'data','invoices');fs.mkdirSync(invoiceDir,{recursive:true});
const invoiceTemplate=path.join(__dirname,'data','templates','invoice-template.doc');
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
function readJson(req,limit=12_000_000){return new Promise((resolve,reject)=>{let body='';req.on('data',c=>{body+=c;if(body.length>limit){reject(new Error('Запрос слишком большой'));req.destroy()}});req.on('end',()=>{try{resolve(JSON.parse(body||'{}'))}catch(e){reject(new Error('Некорректный JSON'))}});req.on('error',reject)})}

function parseCsv(text) {
  const rows=[]; let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++) { const c=text[i],next=text[i+1];
    if(c==='"'&&quoted&&next==='"'){field+='"';i++} else if(c==='"'){quoted=!quoted}
    else if(c===','&&!quoted){row.push(field);field=''}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&next==='\n')i++;row.push(field);if(row.some(x=>x!==''))rows.push(row);row=[];field=''}
    else field+=c;
  }
  if(field||row.length){row.push(field);rows.push(row)}
  return rows;
}
const pdfEscape=value=>String(value||'').replace(/[^\x20-\x7E]/g,'?').replace(/[\\()]/g,'\\$&');
function invoicePdf(invoice) {
  const lines=['FINFLOW CRM','INVOICE',`Number: ${invoice.number}`,`Date: ${new Date(invoice.created_at).toLocaleDateString('ru-RU')}`,'',`Client: ${invoice.client_name}`,`Description: ${invoice.description||'-'}`,`Amount: ${Number(invoice.amount).toLocaleString('ru-RU',{minimumFractionDigits:2})} RUB`,'','Please use the invoice number when paying.'];
  const stream=['BT','/F1 20 Tf','50 790 Td',`(${pdfEscape(lines[0])}) Tj`,'/F1 14 Tf',...lines.slice(1).flatMap(line=>['0 -30 Td',`(${pdfEscape(line)}) Tj`]),'ET'].join('\n');
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n',offsets=[0]; objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`}); const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf,'utf8');
}
function wordPath(value) { return String(value).replaceAll("'","''"); }
function writeInvoicePdf(invoice) {
  const file=path.join(invoiceDir,`${invoice.number}.pdf`);
  if(fs.existsSync(invoiceTemplate)) {
    const payload=Buffer.from(JSON.stringify({number:invoice.number,date:new Date(invoice.created_at).toLocaleDateString('ru-RU'),client:invoice.client_name,description:invoice.description||'Услуги FinFlow CRM',amount:Number(invoice.amount).toLocaleString('ru-RU',{minimumFractionDigits:2})}),'utf8').toString('base64');
    const script=`$ErrorActionPreference='Stop';$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$w=New-Object -ComObject Word.Application;$w.Visible=$false;$doc=$null;try{$doc=$w.Documents.Open('${wordPath(invoiceTemplate)}',$false,$false);function Set-Cell($table,$row,$col,$value){$r=$doc.Tables.Item($table).Cell($row,$col).Range;$r.End=$r.End-1;$r.Text=[string]$value};Set-Cell 2 1 1 ('Счет № '+$d.number+' от '+$d.date+' г.');Set-Cell 3 1 2 'ИП ______________________________';Set-Cell 3 2 2 $d.client;Set-Cell 4 2 1 '1';Set-Cell 4 2 2 $d.description;Set-Cell 4 2 3 '1';Set-Cell 4 2 4 'шт.';Set-Cell 4 2 5 $d.amount;Set-Cell 4 2 6 $d.amount;Set-Cell 5 1 2 $d.amount;Set-Cell 5 2 2 'Без НДС';Set-Cell 5 3 2 $d.amount;Set-Cell 5 4 1 ('Всего наименований 1, на сумму '+$d.amount+' руб.');$doc.ExportAsFixedFormat('${wordPath(file)}',17)}finally{if($doc){$doc.Close(0)};$w.Quit()}`;
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',timeout:30000,windowsHide:true});
    if(!result.error&&!result.status&&fs.existsSync(file)) return file;
    console.error('Invoice template export:',result.error?.message||result.stderr||result.stdout);
  }
  fs.writeFileSync(file,invoicePdf(invoice)); return file;
}
async function syncGoogleSheets() {
  try {
    const response=await fetch(GOOGLE_SHEETS_CSV_URL,{headers:{'User-Agent':'FinFlow-CRM/1.0'},signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error(`Google Sheets вернул ${response.status}`);
    const table=parseCsv((await response.text()).replace(/^\uFEFF/,''));
    const expected=['Отметка времени','Выберите продукт','Как к вам обращаться','Ваш номер телефона для связи','Ваш никнейм в Telegram','Запрос'];
    if(!table.length||expected.some((name,i)=>String(table[0][i]||'').trim()!==name)) throw new Error('Структура колонок Google Sheets не совпадает с ожидаемой');
    const result=importGoogleLeads(table.slice(1).map(r=>({timestamp:r[0],product:r[1],name:r[2],phone:r[3],telegram:r[4],request:r[5]})));
    if(telegramConfigured()&&result.newLeads.length) {
      const sent=await Promise.allSettled(result.newLeads.map(notifyNewLead));
      result.telegramSent=sent.filter(x=>x.status==='fulfilled').length;
      result.telegramFailed=sent.filter(x=>x.status==='rejected').length;
      sent.filter(x=>x.status==='rejected').forEach(x=>console.error('Telegram:',x.reason.message));
    }
    delete result.newLeads;
    return result;
  } catch(error) { recordSyncError(error.message); throw error; }
}

async function processTelegramUpdate(update) {
  const message=update.message;if(!message)return;
  const start=message.text?.match(/^\/start(?:\s+([A-Za-z0-9_-]+))?/);
  if(start?.[1]) {
    const conversation=linkTelegramContact(start[1],message.from,message.chat.id);
    if(conversation) await sendChatMessage(message.chat.id,`Здравствуйте, ${message.from.first_name||''}! Вы подключены к FinFlow. Напишите сообщение — менеджер увидит его в CRM.`);
    else await sendChatMessage(message.chat.id,'Ссылка подключения недействительна. Запросите новую ссылку у менеджера.');
    return;
  }
  const conversation=conversationByChat(message.chat.id);
  if(conversation) saveIncomingMessage(conversation.id,update.update_id,message);
}
let telegramPolling=false;
async function pollTelegram() {
  if(telegramPolling||!botConfigured())return;telegramPolling=true;
  while(telegramPolling) try {
    const updates=await getTelegramUpdates(telegramOffset());
    for(const update of updates){await processTelegramUpdate(update);setTelegramOffset(update.update_id+1)}
  } catch(error){console.error('Telegram polling:',error.message);await new Promise(r=>setTimeout(r,3000))}
}

http.createServer((req, res) => {
  const url=new URL(req.url,'http://localhost');
  const leadConversation=url.pathname.match(/^\/api\/leads\/([^/]+)\/conversation$/);
  const conversationMessages=url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  const conversationRead=url.pathname.match(/^\/api\/conversations\/([^/]+)\/read$/);
  const leadInvoices=url.pathname.match(/^\/api\/leads\/([^/]+)\/invoices$/);
  const invoiceRoute=url.pathname.match(/^\/api\/invoices\/([^/]+)(?:\/(send|pdf))?$/);
  if(leadConversation&&req.method==='GET'){try{return json(res,200,conversationForLead(decodeURIComponent(leadConversation[1])))}catch(e){return json(res,404,{error:'Заявка не найдена'})}}
  if(conversationMessages&&req.method==='GET'){markConversationRead(conversationMessages[1]);return json(res,200,messagesForConversation(conversationMessages[1]))}
  if(conversationRead&&req.method==='POST'){markConversationRead(conversationRead[1]);return json(res,200,{ok:true})}
  if(url.pathname==='/api/invoices'&&req.method==='GET') return json(res,200,allInvoices());
  if(leadInvoices&&req.method==='GET') return json(res,200,invoicesForLead(decodeURIComponent(leadInvoices[1])));
  if(leadInvoices&&req.method==='POST') { readJson(req).then(body=>{let invoice=createInvoice(decodeURIComponent(leadInvoices[1]),body.employeeId,body);return json(res,201,attachInvoicePdf(invoice.id,writeInvoicePdf(invoice)))}).catch(e=>json(res,400,{error:e.message}));return; }
  if(invoiceRoute&&invoiceRoute[2]==='pdf'&&req.method==='GET') { const invoice=invoiceById(invoiceRoute[1]); if(!invoice||!invoice.pdf_path||!fs.existsSync(invoice.pdf_path)) return json(res,404,{error:'PDF ещё не сформирован'}); res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="${path.basename(invoice.pdf_path)}"`});fs.createReadStream(invoice.pdf_path).pipe(res);return; }
  if(invoiceRoute&&!invoiceRoute[2]&&req.method==='PUT') { readJson(req).then(body=>{let invoice=updateInvoice(invoiceRoute[1],body);return json(res,200,attachInvoicePdf(invoice.id,writeInvoicePdf(invoice)))}).catch(e=>json(res,400,{error:e.message}));return; }
  if(invoiceRoute&&invoiceRoute[2]==='send'&&req.method==='POST') { readJson(req).then(async body=>{let invoice=invoiceById(invoiceRoute[1]);if(!invoice)throw new Error('Счёт не найден');if(body.amount!==undefined)invoice=updateInvoice(invoice.id,body);const conversation=conversationForLead(invoice.lead_id);if(!conversation.telegram_chat_id)throw new Error('Клиент ещё не подключил Telegram-бота');const file=writeInvoicePdf(invoice);invoice=attachInvoicePdf(invoice.id,file);const saved=createOutgoingMessage(conversation.id,body.employeeId,{text:`Счёт ${invoice.number}`,fileName:path.basename(file),mimeType:'application/pdf',localPath:file});try{const result=await sendChatDocument(conversation.telegram_chat_id,path.basename(file),'application/pdf',fs.readFileSync(file),`Счёт ${invoice.number} на ${invoice.amount.toLocaleString('ru-RU')} ₽`);finishOutgoingMessage(saved.id,result);return json(res,200,markInvoiceSent(invoice.id,result.message_id))}catch(error){finishOutgoingMessage(saved.id,null,error.message);throw error}}).catch(e=>json(res,400,{error:e.message}));return; }
  if(conversationMessages&&req.method==='POST') {
    readJson(req).then(async body=>{
      const conversation=conversationForLead(body.leadId);
      if(conversation.id!==conversationMessages[1]||!conversation.telegram_chat_id)throw new Error('Клиент ещё не подключил Telegram-бота');
      let buffer=null,localPath=null;
      if(body.file){buffer=Buffer.from(body.file.data,'base64');if(buffer.length>10*1024*1024)throw new Error('Максимальный размер файла — 10 МБ');const safe=(body.file.name||'file').replace(/[^a-zA-Zа-яА-Я0-9._-]/g,'_');localPath=path.join(uploads,`${crypto.randomUUID()}-${safe}`);fs.writeFileSync(localPath,buffer)}
      const saved=createOutgoingMessage(conversation.id,body.employeeId,{text:body.text||'',fileName:body.file?.name,mimeType:body.file?.type,localPath});
      try{const result=body.file?await sendChatDocument(conversation.telegram_chat_id,body.file.name,body.file.type,buffer,body.text||''):await sendChatMessage(conversation.telegram_chat_id,body.text);finishOutgoingMessage(saved.id,result);return json(res,200,{ok:true,messageId:saved.id})}
      catch(error){finishOutgoingMessage(saved.id,null,error.message);throw error}
    }).catch(error=>json(res,400,{error:error.message}));return;
  }
  if (req.url === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getState()));
    return;
  }
  if (req.url === '/api/google-sheets/sync' && req.method === 'POST') {
    syncGoogleSheets().then(result=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result))}).catch(error=>{res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:error.message}))});
    return;
  }
  if (req.url === '/api/google-sheets/status' && req.method === 'GET') {
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(getSyncStatus()));return;
  }
  if (req.url === '/api/state' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      try { replaceState(JSON.parse(body)); res.writeHead(204).end(); }
      catch (error) { console.error(error); res.writeHead(400, {'Content-Type':'application/json'}).end(JSON.stringify({error:error.message})); }
    });
    return;
  }
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(root, requested));
  if (!file.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(3000, '127.0.0.1', () => {
  console.log('FinFlow CRM: http://localhost:3000'); console.log('SQLite:', dbPath);
  syncGoogleSheets().then(r=>console.log('Google Sheets:',r)).catch(e=>console.error('Google Sheets:',e.message));
  setInterval(()=>syncGoogleSheets().catch(e=>console.error('Google Sheets:',e.message)),60000).unref();
  pollTelegram();
});
