// Telegram 机器人配置
const TOKEN = ENV_BOT_TOKEN // 从 @BotFather 获取的 Bot Token
const WEBHOOK = '/endpoint' // Webhook 地址路径
const SECRET = ENV_BOT_SECRET // 用于验证 Telegram 回调的 Secret（只能包含 A-Z, a-z, 0-9, _ 和 -）
const ADMIN_UID = ENV_ADMIN_UID // 管理员的 Telegram UID，可以通过 https://t.me/username_to_id_bot 获取

// 通知相关配置
const NOTIFY_INTERVAL = 3600 * 1000; // 通知间隔时间，单位毫秒（这里是 1 小时）
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db'; // 诈骗用户列表
const notificationUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/notification.txt' // 提醒消息
const startMsgUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/startMessage.md'; // /start 时显示的欢迎消息

const enable_notification = true // 是否启用提醒功能

/**
 * 拼接 Telegram API 请求地址
 */
function apiUrl (methodName, params = null) {
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
  return fetch(apiUrl(methodName, params), body)
    .then(r => r.json())
}

/**
 * 生成标准请求体
 */
function makeReqBody(body){
  return {
    method:'POST',
    headers:{
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }
}

// 常用方法封装
function sendMessage(msg = {}){
  return requestTelegram('sendMessage', makeReqBody(msg))
}
function copyMessage(msg = {}){
  return requestTelegram('copyMessage', makeReqBody(msg))
}
function forwardMessage(msg){
  return requestTelegram('forwardMessage', makeReqBody(msg))
}

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
async function handleWebhook (event) {
  // 校验 Secret
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  // 获取 Telegram 传来的 Update 数据
  const update = await event.request.json()
  // 异步处理消息
  event.waitUntil(onUpdate(update))

  return new Response('Ok')
}

/**
 * 处理 Telegram Update
 */
async function onUpdate (update) {
  if ('message' in update) {
    await onMessage(update.message)
  }
}

/**
 * 处理消息
 */
async function onMessage (message) {
  // 处理 /start
  if(message.text === '/start'){
    let startMsg = await fetch(startMsgUrl).then(r => r.text())
    return sendMessage({
      chat_id:message.chat.id,
      text:startMsg,
    })
  }

  // 如果是管理员消息
  if(message.chat.id.toString() === ADMIN_UID){
    // 必须是回复一条消息才能执行 block/unblock 等命令
    if(!message?.reply_to_message?.chat){
      return sendMessage({
        chat_id:ADMIN_UID,
        text:'使用方法：回复转发的消息，并发送回复消息，或者 `/block`、`/unblock`、`/checkblock` 等指令'
      })
    }

    // 管理员指令
    if(/^\/block$/.exec(message.text)){
      return handleBlock(message)
    }
    if(/^\/unblock$/.exec(message.text)){
      return handleUnBlock(message)
    }
    if(/^\/checkblock$/.exec(message.text)){
      return checkBlock(message)
    }

    // 转发消息给访客
    let guestChantId = await nfd.get('msg-map-' + message?.reply_to_message.message_id,
                                      { type: "json" })
    return copyMessage({
      chat_id: guestChantId,
      from_chat_id:message.chat.id,
      message_id:message.message_id,
    })
  }

  // 普通访客消息
  return handleGuestMessage(message)
}

/**
 * 处理访客发来的消息
 */
async function handleGuestMessage(message){
  let chatId = message.chat.id;
  let isblocked = await nfd.get('isblocked-' + chatId, { type: "json" })
  
  // 被拉黑则提示
  if(isblocked){
    return sendMessage({
      chat_id: chatId,
      text:'You are blocked'
    })
  }

  // 转发访客消息给管理员
  let forwardReq = await forwardMessage({
    chat_id:ADMIN_UID,
    from_chat_id:message.chat.id,
    message_id:message.message_id
  })
  console.log(JSON.stringify(forwardReq))

  // 保存映射：管理员消息 ID -> 访客 chatId
  if(forwardReq.ok){
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId)
  }

  // 处理提醒逻辑（包括诈骗检测）
  return handleNotify(message)
}

/**
 * 提醒逻辑
 */
async function handleNotify(message){
  let chatId = message.chat.id;

  // 判断是否在诈骗名单
  if(await isFraud(chatId)){
    return sendMessage({
      chat_id: ADMIN_UID,
      text:`检测到骗子，UID ${chatId}`
    })
  }

  // 定时提醒（防止刷屏）
  if(enable_notification){
    let lastMsgTime = await nfd.get('lastmsg-' + chatId, { type: "json" })
    if(!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL){
      await nfd.put('lastmsg-' + chatId, Date.now())
      return sendMessage({
        chat_id: ADMIN_UID,
        text:await fetch(notificationUrl).then(r => r.text())
      })
    }
  }
}

/**
 * 屏蔽访客
 */
async function handleBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,
                                      { type: "json" })
  if(guestChantId === ADMIN_UID){
    return sendMessage({
      chat_id: ADMIN_UID,
      text:'不能屏蔽自己'
    })
  }
  await nfd.put('isblocked-' + guestChantId, true)

  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId} 屏蔽成功`,
  })
}

/**
 * 解除屏蔽
 */
async function handleUnBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,
  { type: "json" })

  await nfd.put('isblocked-' + guestChantId, false)

  return sendMessage({
    chat_id: ADMIN_UID,
    text:`UID:${guestChantId} 解除屏蔽成功`,
  })
}

/**
 * 检查屏蔽状态
 */
async function checkBlock(message){
  let guestChantId = await nfd.get('msg-map-' + message.reply_to_message.message_id,
  { type: "json" })
  let blocked = await nfd.get('isblocked-' + guestChantId, { type: "json" })

  return sendMessage({
    chat_id: ADMIN_UID,
    text: `UID:${guestChantId}` + (blocked ? ' 被屏蔽' : ' 没有被屏蔽')
  })
}

/**
 * 发送纯文本消息
 */
async function sendPlainText (chatId, text) {
  return sendMessage({
    chat_id: chatId,
    text
  })
}

/**
 * 注册 webhook
 */
async function registerWebhook (event, requestUrl, suffix, secret) {
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * 注销 webhook
 */
async function unRegisterWebhook (event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * 判断用户是否在诈骗名单
 */
async function isFraud(id){
  id = id.toString()
  let db = await fetch(fraudDb).then(r => r.text())
  let arr = db.split('\n').filter(v => v)
  console.log(JSON.stringify(arr))
  let flag = arr.filter(v => v === id).length !== 0
  console.log(flag)
  return flag
}
