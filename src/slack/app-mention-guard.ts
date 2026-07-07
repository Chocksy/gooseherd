export interface AppMentionLike {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
}

export function shouldIgnoreAppMention(event: AppMentionLike): boolean {
  if (event.bot_id) return true;
  if (event.subtype === "bot_message") return true;
  if (!event.user) return true;
  return false;
}
