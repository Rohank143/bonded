// Finds the chat id for TELEGRAM_CHAT_ID (docs/SERVICES.md "Alerts"). Send the bot any message
// first, then run with the token in the environment:
//   TELEGRAM_BOT_TOKEN=... node apps/api/scripts/telegram-chat-id.mjs
// It prints chat ids and names only, never the token.
import process from "node:process";
import console from "node:console";
const { fetch } = globalThis;
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN first.");
  process.exit(1);
}
const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
if (!response.ok) {
  console.error(`Telegram answered ${response.status}. Check the token.`);
  process.exit(1);
}
const { result } = await response.json();
const chats = new Map();
for (const update of result ?? []) {
  const chat = (update.message ?? update.channel_post ?? update.my_chat_member)?.chat;
  if (chat) chats.set(chat.id, chat.title ?? [chat.first_name, chat.last_name].join(" ").trim());
}
if (chats.size === 0) console.log("No chats yet. Send the bot a message, then run this again.");
for (const [id, name] of chats) console.log(`${id}\t${name}`);
