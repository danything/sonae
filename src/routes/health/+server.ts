/** k8s のプローブ。いまは起きていることだけを返す (受信の状態は /status に出す予定) */
export const GET = () => new Response("ok");
