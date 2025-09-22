// Telegram 机器人配置
const TOKEN = ENV_BOT_TOKEN // 从 @BotFather 获取的 Bot Token
const WEBHOOK = '/endpoint' // Webhook 地址路径
const SECRET = ENV_BOT_SECRET // 用于验证 Telegram 回调的 Secret
const ADMIN_UID = ENV_ADMIN_UID // 管理员的 Telegram UID
const startMsgUrl = 'https://raw.githubusercontent.com/kunfx/TG-bot-Message/refs/heads/main/data/startMessage.md'; // /start 欢迎消息
const keywordsUrl = 'https://raw.githubusercontent.com/kunfx/TG-bot-Message/refs/heads/main/data/keywords.txt' // 每行一个关键字
const autoReplyUrl = 'https://raw.githubusercontent.com/kunfx/TG-bot-Message/refs/heads/main/data/autoreply.md' // 自动回复内容

/**
 * 拼接 Telegram API 请求地址
 */
function apiUrl(methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

/**
 * 向 Telegram API 发送请求
 */
function requestTelegram(methodName, body, params = null){
  return fetch(apiUrl(methodName, params), body).then(r => r.json())
}

/**
 * 生成请求体
 */
function makeReqBody(body){
  return {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  }
}

// 常用方法封装
function sendMessage(msg = {}){ return requestTelegram('sendMessage', makeReqBody(msg)) }
function copyMessage(msg = {}){ return requestTelegram('copyMessage', makeReqBody(msg)) }
function forwardMessage(msg){ return requestTelegram('forwardMessage', makeReqBody(msg)) }

/**
 * Worker 主监听
 */
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } else {
    event.respondWith(new Response('No handler for this request'))
  }
})

/**
 * Webhook 回调处理
 */
async function handleWebhook(event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }
  const update = await event.request.json()
  event.waitUntil(onUpdate(update))
  return new Response('Ok')
}

/**
 * 处理 Telegram Update
 */
async function onUpdate(update) {
  if ('message' in update) {
    await onMessage(update.message)
  }
}

/**
 * 处理消息
 */
async function onMessage(message) {
  if(message.text === '/start'){
    let startMsg = await fetch(startMsgUrl).then(r => r.text())
    return sendMessage({ chat_id:message.chat.id, text:startMsg })
  }

  // 管理员消息
  if(message.chat.id.toString() === ADMIN_UID){
    if(!message?.reply_to_message?.chat){
      return sendMessage({
        chat_id:ADMIN_UID,
        text:'使用方法：回复转发的消息，并发送回复消息\n或者 `/block`、`/unblock`、`/checkblock` 等指令'
      })
    }
    if(/^\/block$/.exec(message.text)) return handleBlock(message)
    if(/^\/unblock$/.exec(message.text)) return handleUnBlock(message)
    if(/^\/checkblock$/.exec(message.text)) return checkBlock(message)

    let guestChantId = await nfd.get('msg-map-' + message?.reply_to_message.message_id,{ type: "json" })
    return copyMessage({ chat_id: guestChantId, from_chat_id:message.chat.id, message_id:message.message_id })
  }

  // 访客消息
  return handleGuestMessage(message)
}


/**
 * 处理访客消息（只转发给管理员）
 */
async function handleGuestMessage(message){
  let chatId = message.chat.id
  let isblocked = await nfd.get('isblocked-' + chatId, { type: "json" })

  if(isblocked){
    return sendMessage({ chat_id: chatId, text:'You are blocked' })
  }

  // 新访客通知管理员
  let isFirstMessage = !(await nfd.get('msg-map-first-' + chatId, { type: "json" }))
  if(isFirstMessage){
    await nfd.put('msg-map-first-' + chatId, true)
    let username = message.from?.username ? '@' + message.from.username : '(没有用户名)'
    let userId = message.from?.id || chatId

    await sendMessage({
      chat_id: ADMIN_UID,
      text: `新访客消息\n用户名: ${username}\n用户ID: ${userId}`
    })
  }

  // 自动回复逻辑
if (message.text) {
  const text = message.text;

  // 获取关键字列表
  const lines = (await fetch(keywordsUrl).then(r => r.text()))
                  .split(/\r?\n/)
                  .map(l => l.trim())
                  .filter(l => l !== '');

  // 获取回复内容
  const autoReply = await fetch(autoReplyUrl).then(r => r.text());

  // 遍历关键字
  let triggered = false;
  for (const line of lines) {
    const keywords = line.split('|').map(k => k.trim()).filter(k => k);
    if (keywords.some(kw => text.includes(kw))) {
      triggered = true;
      break; // 匹配到一次立即停止循环
    }
  }
  // 如果触发，则发送回复
  if (triggered) {
    await sendMessage({ chat_id: chatId, text: autoReply });
  }
}
  
  // 转发消息给管理员
  let forwardReq = await forwardMessage({
    chat_id: ADMIN_UID,
    from_chat_id: chatId,
    message_id: message.message_id
  })

  if(forwardReq.ok){
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId)
  }
}

/**
 * 屏蔽访客
 */
async function handleBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,{ type: "json" })
  if(guestChantId === ADMIN_UID){
    return sendMessage({ chat_id: ADMIN_UID, text:'不能屏蔽自己' })
  }
  await nfd.put('isblocked-' + guestChantId, true)
  return sendMessage({ chat_id: ADMIN_UID, text:`UID:${guestChantId} 屏蔽成功` })
}

/**
 * 解除屏蔽
 */
async function handleUnBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,{ type: "json" })
  await nfd.put('isblocked-' + guestChantId, false)
  return sendMessage({ chat_id: ADMIN_UID, text:`UID:${guestChantId} 解除屏蔽成功` })
}

/**
 * 检查屏蔽状态
 */
async function checkBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,{ type: "json" })
  let blocked = await nfd.get('isblocked-' + guestChantId,{ type: "json" })
  return sendMessage({ chat_id: ADMIN_UID, text:`UID:${guestChantId}` + (blocked ? ' 被屏蔽' : ' 没有被屏蔽') })
}

/**
 * 设置 webhook
 */
async function registerWebhook(event, requestUrl, suffix, secret){
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * 注销 webhook
 */
async function unRegisterWebhook(event){
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}
