/** 推測できない文字列 (base64url)。state・nonce・PKCE の verifier・セッション ID に使う。 */
export const randomToken = (bytes = 32) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
