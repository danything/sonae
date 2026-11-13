/**
 * スマホの形 (上のヘッダーを出さず、下のタブと dock に寄せる) にする条件。denpa の `#lib/phone-form.ts` と同じ 1000px 未満。
 * CSS は app.html が付ける `<html data-phone>` で書き分ける (同じ条件を app.html にも書いてある)
 */
export const PHONE_FORM = "(max-width: 999.98px)";
