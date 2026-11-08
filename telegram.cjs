const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (error) { if (error.code !== 'ENOENT') console.error('Не удалось загрузить .env:', error.message); }

function configured() { return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_NOTIFICATION_CHAT_ID); }
function botConfigured() { return Boolean(process.env.TELEGRAM_BOT_TOKEN); }
function escapeHtml(value) { return String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

async function sendTelegramMessage(text) {
  if (!configured()) return { skipped:true, reason:'Telegram не настроен' };
  const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:process.env.TELEGRAM_NOTIFICATION_CHAT_ID,text,parse_mode:'HTML',disable_web_page_preview:true}),
    signal:AbortSignal.timeout(15000)
  });
  const data=await response.json();
  if(!response.ok||!data.ok) throw new Error(data.description||`Telegram вернул ${response.status}`);
  return data.result;
}

async function telegramRequest(method,body={},multipart=false) {
  if(!botConfigured()) throw new Error('Telegram-бот не настроен');
  const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,{
    method:'POST',headers:multipart?{}:{'Content-Type':'application/json'},body:multipart?body:JSON.stringify(body),signal:AbortSignal.timeout(35000)
  });
  const data=await response.json();
  if(!response.ok||!data.ok) throw new Error(data.description||`Telegram вернул ${response.status}`);
  return data.result;
}
const sendChatMessage=(chatId,text)=>telegramRequest('sendMessage',{chat_id:chatId,text});
async function sendChatDocument(chatId,fileName,mimeType,buffer,caption='') {
  const form=new FormData();form.append('chat_id',String(chatId));if(caption)form.append('caption',caption);
  form.append('document',new Blob([buffer],{type:mimeType||'application/octet-stream'}),fileName);
  return telegramRequest('sendDocument',form,true);
}
const getTelegramUpdates=(offset)=>telegramRequest('getUpdates',{offset,timeout:25,allowed_updates:['message']});

async function notifyNewLead(lead) {
  const text=[
    '🟢 <b>Новая заявка из Google Sheets</b>', '',
    `<b>Клиент:</b> ${escapeHtml(lead.name)}`,
    `<b>Продукт:</b> ${escapeHtml(lead.tariff)}`,
    `<b>Телефон:</b> ${escapeHtml(lead.phone||'—')}`,
    `<b>Telegram:</b> ${escapeHtml(lead.telegram||'—')}`,
    `<b>Запрос:</b> ${escapeHtml(lead.request||'—')}`,
    `<b>Время:</b> ${escapeHtml(lead.timestamp||'—')}`
  ].join('\n');
  return sendTelegramMessage(text);
}

module.exports={configured,botConfigured,sendTelegramMessage,notifyNewLead,sendChatMessage,sendChatDocument,getTelegramUpdates};
